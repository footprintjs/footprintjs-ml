"""Independent saved inference arithmetic, using Python's standard library only."""
import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import sys


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value)).hexdigest()


def require(condition, message):
    if not condition: raise ValueError(message)


def artifact(root, ref):
    relative = PurePosixPath(ref["path"])
    require(not relative.is_absolute() and ".." not in relative.parts, "Unsafe retained artifact path")
    blob = (root / Path(*relative.parts)).read_bytes()
    require(len(blob) == ref["bytes"] and digest(blob) == ref["sha256"], "Retained artifact bytes differ: " + ref["path"])
    return blob


def finite(value):
    require(type(value) in (int, float) and math.isfinite(value), "Nonfinite or nonnumeric saved parameter")
    return float(value)


def predict(state, rows, order):
    classifier, scaler = state["classifier"], state["preprocessing"]
    coefficients = [[finite(value) for value in row] for row in classifier["coef"]]
    intercept = [finite(value) for value in classifier["intercept"]]
    mean, scale = ([finite(value) for value in scaler[key]] for key in ("mean", "scale"))
    require(classifier["features"] == scaler["features"] == 64, "Wrong measured feature count")
    require(classifier["classes"] == list(range(10)) and len(coefficients) == len(intercept) == 10, "Wrong class order/shape")
    require(len(mean) == len(scale) == 64 and all(len(row) == 64 for row in coefficients), "Wrong parameter shape")
    require(scaler["withMean"] is True and scaler["withStd"] is True and all(value > 0 for value in scale), "Unsupported scaler state")
    require(sorted(order) == list(range(64)), "Actual field order is not a feature permutation")
    labels = []
    maximum_scaled = maximum_product = maximum_score = maximum_sum = 0.0
    minimum_margin = math.inf
    for row in rows:
        require(len(row) == 64, "Wrong raw input shape")
        scaled = [(finite(row[index]) - mean[column]) / scale[column] for column, index in enumerate(order)]
        require(all(math.isfinite(value) for value in scaled), "Nonfinite transformed feature")
        maximum_scaled = max(maximum_scaled, *(abs(value) for value in scaled))
        scores = []
        for weights, bias in zip(coefficients, intercept):
            products = [weight * value for weight, value in zip(weights, scaled)]
            score = math.fsum(products) + bias
            require(all(math.isfinite(value) for value in products) and math.isfinite(score), "Nonfinite independent score")
            maximum_product = max(maximum_product, *(abs(value) for value in products))
            maximum_sum = max(maximum_sum, math.fsum(abs(value) for value in products) + abs(bias))
            scores.append(score)
        winner = max(range(10), key=scores.__getitem__)
        labels.append(classifier["classes"][winner])
        ordered = sorted(scores, reverse=True)
        minimum_margin = min(minimum_margin, ordered[0] - ordered[1])
        maximum_score = max(maximum_score, *(abs(value) for value in scores))
    return labels, {"allComputedValuesFinite": True, "maximumAbsoluteScaledFeature": maximum_scaled,
                    "maximumAbsoluteProduct": maximum_product, "maximumAbsoluteClassScore": maximum_score,
                    "maximumSumOfAbsoluteTerms": maximum_sum, "minimumWinningClassMargin": minimum_margin}


def audit(path):
    root = Path(path).resolve()
    recording_blob = (root / "recording.json").read_bytes()
    outcome_blob = (root / "outcome.json").read_bytes()
    recording, outcome = json.loads(recording_blob), json.loads(outcome_blob)
    require(outcome["schema"] == "footprint-ml-inference-proof-outcome/v1", "Unsupported inference proof")
    require(recording["snapshot"]["sharedState"]["outcome"] == outcome, "Outcome is not the captured scope value")
    checks = ["outcome-equals-captured-scope"]
    cases, calculated, states = {}, {}, {}
    expected_input = outcome["backend"]["inputRef"]
    batch = json.loads(artifact(root, expected_input))
    raw_rows = batch["x"]["values"]
    require(batch["x"]["shape"] == [64, 64] and len(raw_rows) == 64, "Wrong fixed batch shape")
    validation = json.loads(artifact(root, batch["sourceValidation"]))
    require(raw_rows == validation["x"]["values"][:64], "The prediction batch differs from the fixed validation prefix")
    checks.append("fixed-first-64-input-prefix")
    for name in ("stale", "corrected", "reversed"):
        case = outcome["cases"][name]
        receipt, observation = case["receipt"], case["backendObservation"]
        require(receipt["inputRef"] == expected_input, "Receipt input differs from the independently pinned batch")
        artifact(root, receipt["inputRef"])
        output = json.loads(artifact(root, receipt["outputRef"]))
        exported = json.loads(artifact(root, observation["actualStateArtifact"]))
        before, after = exported["before"], exported["after"]
        require(before == after, "Actual predictor changed during prediction")
        identity = receipt["modelRef"]["inferenceIdentity"]
        require(digest(before) == digest(after) == identity["sha256"], "Actual exported memory differs from its observed identity")
        require(identity["profile"] == before["profile"], "Measured inference profile differs")
        require(observation["beforeModelRef"] == observation["afterModelRef"] == receipt["modelRef"], "Before/after observed model refs disagree")
        source_model = json.loads(artifact(root, receipt["modelRef"]["originArtifact"]))
        for source_key, measured_key in (("coef", "coef"), ("intercept", "intercept"), ("classes", "classes"), ("features", "features")):
            require(source_model[source_key] == before["classifier"][measured_key], "Measured parameters disagree with the separately verified source artifact")
        source_scaler = json.loads(artifact(root, outcome["backend"]["scalerRef"]))
        for key in ("withMean", "withStd", "mean", "scale", "variance", "features"):
            require(source_scaler[key] == before["preprocessing"][key], "Measured scaler disagrees with its separately verified source artifact")
        require(receipt["contract"]["preprocessingVersion"] == "standardscaler-state/sha256:" + digest(before["preprocessing"]),
                "Observed preprocessing contract differs from actual memory")
        order = output["actualFieldOrder"]
        require([field["name"] for field in receipt["contract"]["input"]["fields"]] == ["pixel_" + str(index) for index in order],
                "Observed contract field order differs from the actual computation order")
        require(output["inferenceId"] == receipt["inferenceId"] and output["inputSha256"] == receipt["inputRef"]["sha256"],
                "Output invocation/input binding differs")
        require(output["actualModelIdentity"] == identity, "Output model binding differs")
        require(receipt["inputRows"] == receipt["outputRows"] == len(output["labels"]) == 64, "Output row count differs")
        labels, bounds = predict(before, raw_rows, order)
        require(labels == output["labels"], "Independent scalar predictions disagree with actual backend labels: " + name)
        cases[name] = {"rows": len(labels), "allLabelsMatchBackend": True,
                       "predictionLabelsSha256": digest(labels), "actualStateSha256": digest(before),
                       "sourceModelSha256": receipt["modelRef"]["originArtifact"]["sha256"],
                       "beforeAfterStateEqual": True, "artifactAndInvocationBindingsVerified": True,
                       "fieldOrderVerified": True, "finiteBounds": bounds}
        calculated[name], states[name] = labels, before
        checks.extend([name + ":input-output-bytes", name + ":before-after-memory-fingerprint",
                       name + ":source-parameter-agreement", name + ":actual-field-order",
                       name + ":invocation-and-row-bindings", name + ":all-scalar-labels-match"])
    different = sum(a != b for a, b in zip(calculated["stale"], calculated["corrected"]))
    require(different == outcome["observedOutputComparison"]["differentLabels"], "Recorded label-difference count differs")
    checks.append("observed-B-versus-A-difference-count")
    require(outcome["releasedPredictionRef"] == outcome["cases"]["corrected"]["receipt"]["outputRef"], "Wrong output reference was handed off")
    checks.append("handoff-ref-matches-accepted-A-output")
    evaluation = outcome["evaluationReceipt"]
    evaluation_data = json.loads(artifact(root, evaluation["datasetRef"]["artifact"]))
    require(states["corrected"]["profile"] == evaluation["modelRef"]["inferenceIdentity"]["profile"]
            and digest(states["corrected"]) == evaluation["modelRef"]["inferenceIdentity"]["sha256"], "A validation did not bind the same measured state")
    labels, bounds = predict(states["corrected"], evaluation_data["x"]["values"], list(range(64)))
    targets = evaluation_data["y"]["values"]
    require(len(labels) == len(targets) == evaluation["datasetRef"]["rows"], "Validation row count differs")
    correct = sum(a == b for a, b in zip(labels, targets))
    accuracy = correct / len(labels)
    require(abs(accuracy - evaluation["metrics"]["accuracy"]) <= 1e-15, "Independent A validation accuracy differs")
    validation_report = {"rows": len(labels), "correct": correct, "accuracy": accuracy,
                         "recordedAccuracy": evaluation["metrics"]["accuracy"], "accuracyMatchesReceipt": True,
                         "finiteBounds": bounds}
    checks.append("A-full-validation-accuracy")
    warning_blob = artifact(root, outcome["backendLifecycle"]["stderrArtifact"])
    checks.append("original-warning-log-bytes")
    require((root / "recording.json").read_bytes() == recording_blob and (root / "outcome.json").read_bytes() == outcome_blob,
            "Original evidence changed during independent audit")
    checks.append("original-recording-and-outcome-unchanged")
    report = {"schema": "footprint-ml-inference-numerical-audit/v1", "passed": True,
              "checksPassed": len(checks), "checks": checks,
              "implementation": {"python": sys.version.split()[0], "standardLibraryOnly": True,
                                 "isolatedFlag": bool(sys.flags.isolated), "siteDisabled": bool(sys.flags.no_site),
                                 "method": "Explicit StandardScaler arithmetic, math.fsum dense scores and ordered class argmax"},
              "inputs": {"recordingSha256": digest(recording_blob), "outcomeSha256": digest(outcome_blob)},
              "cases": cases, "validationA": validation_report, "observedDifferentLabels": different,
              "backendWarnings": {"retainedBytes": len(warning_blob), "causeDiagnosed": False, "suppressedByAudit": False},
              "execution": {"modelTrainingRepeated": False, "sklearnPredictionRepeated": False,
                            "independentSavedParameterPredictionRepeated": True, "mlflowStarted": False},
              "boundaries": ["This checks inference from retained actual memory exports and raw inputs, not how either model was trained.",
                             "All saved backend labels match independent scalar calculations. Original backend logits were not retained; per-logit equality is not claimed.",
                             "The original matrix-multiplication warnings remain undiagnosed and are not suppressed by this audit.",
                             "Model identity/contract approval is checked by native guards elsewhere; this numerical audit does not replace or duplicate those guards."]}
    with (root / "audit.json").open("x") as stream:
        json.dump(report, stream, sort_keys=True, indent=2, allow_nan=False); stream.write("\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    report = audit(parser.parse_args().run)
    print(json.dumps({"schema": report["schema"], "passed": report["passed"], "checksPassed": report["checksPassed"],
                      "allBackendLabelsMatch": all(case["allLabelsMatchBackend"] for case in report["cases"].values()),
                      "validationAccuracy": report["validationA"]["accuracy"], "differentLabels": report["observedDifferentLabels"]}, indent=2))

