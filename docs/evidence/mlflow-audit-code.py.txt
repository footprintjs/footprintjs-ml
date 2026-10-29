"""Independently check the saved prediction arithmetic using only Python stdlib.

Run with ``python -I -S audit.py --run DIR``. This script does not import the
capture client, MLflow, NumPy, scikit-learn or the example's numerical helpers.
It reads retained JSON and creates a new audit.json without changing evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import sys


def sha256(blob):
    return hashlib.sha256(blob).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def finite(value, label):
    require(type(value) in (int, float) and math.isfinite(value), label + " must be a finite number")
    return float(value)


def artifact_bytes(root, binding):
    relative = PurePosixPath(binding["artifactPath"])
    require(not relative.is_absolute() and ".." not in relative.parts, "Unsafe source artifact path")
    blob = (root / "source-artifacts" / Path(*relative.parts)).read_bytes()
    expected = binding["artifact"]
    require(len(blob) == expected["bytes"], "Artifact size differs: " + str(relative))
    require(sha256(blob) == expected["sha256"], "Artifact bytes differ: " + str(relative))
    return blob


def read_numerical(weights_bytes, scaler_bytes, data_bytes):
    weights, scaler, data = map(json.loads, (weights_bytes, scaler_bytes, data_bytes))
    require(weights["schema"] == "footprint-ml/sklearn-logistic-numeric-json/v1", "Unsupported weights format")
    require(scaler["schema"] == "footprint-ml/sklearn-standard-scaler-json/v1", "Unsupported scaler format")
    require(data["schema"] == "footprint-ml/digits-split-json/v1", "Unsupported dataset format")
    require(weights["features"] == scaler["features"] == 64, "Expected 64 digit features")
    require(weights["classes"] == list(range(10)), "Expected the original ordered digit classes")
    require(len(weights["coef"]) == len(weights["intercept"]) == 10, "Invalid classifier shape")
    coef = [[finite(v, "coefficient") for v in row] for row in weights["coef"]]
    intercept = [finite(v, "intercept") for v in weights["intercept"]]
    require(all(len(row) == 64 for row in coef), "Invalid coefficient feature count")
    mean = [finite(v, "mean") for v in scaler["mean"]]
    scale = [finite(v, "scale") for v in scaler["scale"]]
    variance = [finite(v, "variance") for v in scaler["variance"]]
    require(len(mean) == len(scale) == len(variance) == 64, "Invalid scaler shape")
    require(all(v > 0 for v in scale) and all(v >= 0 for v in variance), "Invalid scaler statistics")
    require(scaler["withMean"] is True and scaler["withStd"] is True, "This audit supports the recorded centering/scaling profile")
    x = [[finite(v, "raw feature") for v in row] for row in data["x"]["values"]]
    y = data["y"]["values"]
    require(len(x) > 0 and all(len(row) == 64 for row in x), "Invalid raw feature shape")
    require(data["x"]["shape"] == [len(x), 64] and data["y"]["shape"] == [len(x)], "Dataset shape metadata disagrees")
    require(len(y) == len(x) and all(type(v) is int and 0 <= v <= 9 for v in y), "Invalid digit targets")
    return coef, intercept, mean, scale, x, y


def independent_predictions(coef, intercept, mean, scale, x, y):
    predictions = []
    max_scaled = max_score = max_product = max_absolute_sum = 0.0
    smallest_margin = math.inf
    for row in x:
        # StandardScaler: z[j] = (raw[j] - fitted_mean[j]) / fitted_scale[j].
        scaled = [(value - center) / divisor for value, center, divisor in zip(row, mean, scale)]
        require(all(math.isfinite(v) for v in scaled), "A transformed feature is nonfinite")
        max_scaled = max(max_scaled, *(abs(v) for v in scaled))
        scores = []
        for coefficients, bias in zip(coef, intercept):
            products = [weight * value for weight, value in zip(coefficients, scaled)]
            score = math.fsum(products) + bias
            require(all(math.isfinite(v) for v in products) and math.isfinite(score), "A class score is nonfinite")
            max_product = max(max_product, *(abs(v) for v in products))
            max_absolute_sum = max(max_absolute_sum, math.fsum(abs(v) for v in products) + abs(bias))
            scores.append(score)
        # Python's stable first maximum matches the class-order argmax rule.
        winner = max(range(10), key=scores.__getitem__)
        predictions.append(winner)
        ordered = sorted(scores, reverse=True)
        smallest_margin = min(smallest_margin, ordered[0] - ordered[1])
        max_score = max(max_score, *(abs(v) for v in scores))
    correct = sum(predicted == expected for predicted, expected in zip(predictions, y))
    return {"rows": len(y), "correct": correct, "accuracy": correct / len(y),
            "predictionLabelsSha256": sha256(canonical(predictions)),
            "finiteBounds": {"maximumAbsoluteRawFeature": max(abs(v) for row in x for v in row),
                             "maximumAbsoluteCoefficient": max(abs(v) for row in coef for v in row),
                             "maximumAbsoluteIntercept": max(abs(v) for v in intercept),
                             "maximumAbsoluteScaledFeature": max_scaled,
                             "maximumAbsoluteProduct": max_product, "maximumAbsoluteClassScore": max_score,
                             "maximumSumOfAbsoluteTerms": max_absolute_sum,
                             "minimumWinningClassMargin": smallest_margin, "allComputedValuesFinite": True}}


def audit(root):
    root = Path(root).resolve()
    recording_before = (root / "recording.json").read_bytes()
    outcome_before = (root / "outcome.json").read_bytes()
    outcome = json.loads(outcome_before)
    require(outcome["schema"] == "footprint-ml-mlflow-proof-outcome/v1", "Unsupported proof outcome")
    checks = []
    cases = {}
    for name in ("baseline", "faulty", "corrected"):
        recorded = outcome[name]
        consumed, receipt = recorded["consumption"], recorded["receipt"]
        weights_bytes = artifact_bytes(root, consumed["modelWeightsBinding"])
        scaler_bytes = artifact_bytes(root, consumed["preprocessorBinding"])
        data_bytes = artifact_bytes(root, consumed["datasetBinding"])
        hashes = {"modelWeightsSha256": sha256(weights_bytes), "preprocessorSha256": sha256(scaler_bytes),
                  "rawValidationSha256": sha256(data_bytes)}
        for key, actual in hashes.items():
            require(consumed[key] == actual, name + " consumed digest disagrees: " + key)
        require(receipt["modelRef"]["originArtifact"] == consumed["modelWeightsBinding"]["artifact"], "Receipt model artifact differs")
        require(receipt["checkpointForAudit"]["artifact"] == consumed["modelWeightsBinding"]["artifact"], "Receipt audit artifact differs")
        require(receipt["datasetRef"]["artifact"] == consumed["datasetBinding"]["artifact"], "Receipt validation artifact differs")
        require(receipt["preprocessingVersion"] == "measured-scaler/sha256:" + hashes["preprocessorSha256"], "Receipt preprocessing identity differs")
        specification = consumed["predictorSpecification"]
        require(specification["weightsArtifactSha256"] == hashes["modelWeightsSha256"], "Predictor specification weights differ")
        require(specification["fittedScalerArtifactSha256"] == hashes["preprocessorSha256"], "Predictor specification preprocessing differs")
        require(sha256(canonical(specification)) == receipt["inferenceIdentity"]["sha256"], "Composite predictor identity differs")
        require(receipt["inferenceIdentity"] == receipt["modelRef"]["inferenceIdentity"], "Receipt identities disagree")
        result = independent_predictions(*read_numerical(weights_bytes, scaler_bytes, data_bytes))
        recorded_accuracy = finite(receipt["metrics"]["accuracy"], "recorded accuracy")
        require(abs(result["accuracy"] - recorded_accuracy) <= 1e-15, name + " independently computed accuracy differs")
        require(result["rows"] == receipt["datasetRef"]["rows"], "Receipt row count differs")
        cases[name] = {**result, "recordedAccuracy": recorded_accuracy, "accuracyMatchesReceipt": True,
                       "measuredArtifactHashes": hashes, "artifactAndCompositeIdentitiesMatch": True}
        checks.extend([name + ":artifact-bytes", name + ":receipt-bindings", name + ":composite-identity", name + ":finite-predictions", name + ":accuracy"])
    require(cases["baseline"]["measuredArtifactHashes"]["modelWeightsSha256"] == cases["faulty"]["measuredArtifactHashes"]["modelWeightsSha256"] == cases["corrected"]["measuredArtifactHashes"]["modelWeightsSha256"], "Weights changed across cases")
    require(cases["baseline"]["measuredArtifactHashes"]["rawValidationSha256"] == cases["faulty"]["measuredArtifactHashes"]["rawValidationSha256"] == cases["corrected"]["measuredArtifactHashes"]["rawValidationSha256"], "Raw validation changed across cases")
    require(cases["baseline"]["predictionLabelsSha256"] == cases["corrected"]["predictionLabelsSha256"], "Correction did not restore independent predictions")
    require((root / "recording.json").read_bytes() == recording_before and (root / "outcome.json").read_bytes() == outcome_before, "Original evidence changed during audit")
    checks.extend(["weights-unchanged", "raw-validation-unchanged", "corrected-predictions-restored", "original-evidence-unchanged"])
    report = {"schema": "footprint-ml-mlflow-numerical-audit/v1", "passed": True,
              "implementation": {"python": sys.version.split()[0], "standardLibraryOnly": True,
                                 "isolatedFlag": bool(sys.flags.isolated), "siteDisabled": bool(sys.flags.no_site),
                                 "method": "Explicit StandardScaler arithmetic, Python math.fsum dense linear scores and ordered class argmax"},
              "inputs": {"recordingSha256": sha256(recording_before), "outcomeSha256": sha256(outcome_before)},
              "cases": cases, "checksPassed": len(checks), "checks": checks,
              "execution": {"modelTrainingRepeated": False, "sklearnEvaluationRepeated": False,
                            "independentSavedParameterPredictionRepeated": True, "mlflowStarted": False},
              "boundaries": ["This independently checks inference from the retained parameters and raw validation data; it does not re-run or verify the training algorithm.",
                             "The original numerical backend emitted matrix multiplication warnings. Their cause has not been diagnosed or suppressed by this audit.",
                             "The saved independent scores and matching aggregate accuracies are finite; individual original backend logits were not retained for per-logit comparison.",
                             "This audit reads saved numerical artifacts. A later JSON-only provenance investigation does not need to repeat this calculation."]}
    with (root / "audit.json").open("x", encoding="utf-8") as stream:
        json.dump(report, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    result = audit(parser.parse_args().run)
    print(json.dumps({"schema": result["schema"], "passed": result["passed"], "checksPassed": result["checksPassed"],
                      "accuracy": {name: value["accuracy"] for name, value in result["cases"].items()}}, indent=2))
