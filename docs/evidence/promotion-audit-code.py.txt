"""Read saved artifacts with the standard library; no MLflow or trainer import."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re


PROFILE = "footprint-ml-promotion/standardized-linear/v1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def finite(value, label):
    require(type(value) in (int, float) and math.isfinite(value), label + " must be finite numeric data")
    return value


def vector(value, label, rows=None):
    require(type(value) is list and len(value) > 0, label + " must retain every nonempty row")
    if rows is not None:
        require(len(value) == rows, label + " length differs from the recorded row count")
    return [finite(item, label) for item in value]


def parse(content):
    def invalid(value):
        raise ValueError("Nonfinite JSON constant: " + value)
    return json.loads(content, parse_constant=invalid)


def managed_json(root, reference):
    require(type(reference) is dict and set(reference) == {"kind", "path", "sha256", "bytes", "format"}, "Invalid managed reference")
    require(reference["kind"] == "artifact" and type(reference["bytes"]) is int and reference["bytes"] >= 0, "Invalid artifact size")
    require(type(reference["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", reference["sha256"]), "Invalid artifact digest")
    require(type(reference["format"]) is str and bool(reference["format"]), "Invalid artifact format")
    expected = "sha256-" + reference["sha256"] + "-" + hashlib.sha256(reference["format"].encode()).hexdigest() + ".bin"
    require(reference["path"] == expected, "Managed artifact path differs from its content identity")
    path = root / "release-store" / expected
    require(not path.is_symlink() and path.is_file() and path.stat().st_size == reference["bytes"], "Managed artifact type or size differs")
    content = path.read_bytes()
    require(len(content) == reference["bytes"] and hashlib.sha256(content).hexdigest() == reference["sha256"], "Managed artifact bytes differ")
    return parse(content)


def paired_data(value, label, rows=None):
    require(type(value) is dict and set(value) == {"x", "y"}, label + " must contain paired x/y observations")
    x = vector(value["x"], label + ".x", rows)
    y = vector(value["y"], label + ".y", len(x))
    return x, y


def verify(directory):
    root = Path(directory).resolve()
    load = lambda name: parse((root / name).read_bytes())
    recording, outcome, numerical = (load(name) for name in ("recording.json", "outcome.json", "numerical-observations.json"))
    state = recording["snapshot"]["sharedState"]
    checks = {"outcomeMatchesCapturedValue": state["outcome"] == outcome,
              "workflowChecksPass": all(outcome["checks"].values()),
              "allCasesRetained": set(outcome["outcomes"]) == {"wrong", "lostReply", "recovered", "uncertainFirst", "uncertainRetry", "occupied"}}
    dataset = state["datasetRef"]
    rows = dataset["rows"]
    require(type(rows) is int and rows > 0 and dataset["shape"] == [rows, 1], "Recorded validation rows/shape differ from this profile")
    actual_validation = managed_json(root, dataset["artifact"])
    x, y = paired_data(actual_validation, "managed validation", rows)
    paired_data(numerical["validation"], "sidecar validation", rows)
    checks["validationBoundToCapturedArtifact"] = numerical["validation"] == actual_validation
    actual_training = managed_json(root, state["trainingDatasetArtifact"])
    paired_data(actual_training, "managed training")
    paired_data(numerical["training"], "sidecar training")
    checks["trainingBoundToCapturedArtifact"] = numerical["training"] == actual_training
    saved_results = {item["candidateId"]: item for item in state["candidateResults"]}
    require(len(state["candidateResults"]) == 2 and set(numerical["models"]) == set(saved_results) == {"A", "B"}, "The complete A/B observations must be retained")
    for candidate, observed in numerical["models"].items():
        bundle, ref = observed["bundle"], observed["artifact"]
        actual_bundle = managed_json(root, ref)
        model = saved_results[candidate]["modelRef"]
        checks[candidate + "ManagedBundleMatches"] = (actual_bundle == bundle and ref == model["originArtifact"]
            and ref == outcome["models"][candidate]["originArtifact"]
            and model["inferenceIdentity"]["profile"] == PROFILE and model["inferenceIdentity"]["sha256"] == ref["sha256"])
        require(bundle["schema"] == "footprint-ml-promotion-predictor/v1" and bundle["profile"] == PROFILE, "Unsupported predictor profile")
        for key in ("coefficient", "intercept"):
            finite(bundle["weights"][key], "weights." + key)
        finite(bundle["scaler"]["mean"], "scaler.mean")
        require(finite(bundle["scaler"]["scale"], "scaler.scale") > 0, "The fitted scale must be positive")
        observed_predictions = vector(observed["predictions"], candidate + " predictions", rows)
        predictions = [((value - bundle["scaler"]["mean"]) / bundle["scaler"]["scale"]
                        * bundle["weights"]["coefficient"] + bundle["weights"]["intercept"]) for value in x]
        vector(predictions, candidate + " scalar predictions", rows)
        mse = sum((a - b) ** 2 for a, b in zip(predictions, y)) / len(y)
        finite(mse, candidate + " scalar MSE")
        sidecar_mse = finite(observed["mse"], candidate + " sidecar MSE")
        receipt_mse = finite(saved_results[candidate]["evaluation"]["metrics"]["mse"], candidate + " receipt MSE")
        checks[candidate + "SavedPredictionsMatchScalarArithmetic"] = all(abs(a-b) <= 1e-12 for a,b in zip(predictions, observed_predictions))
        checks[candidate + "MeasuredMetricMatchesReceipt"] = abs(mse - receipt_mse) <= 1e-12 and abs(mse - sidecar_mse) <= 1e-12
    checks["AIsMeasuredMinimum"] = numerical["models"]["A"]["mse"] < numerical["models"]["B"]["mse"]
    checks["ConfirmedReceiptBindsExactA"] = outcome["mainCommittedReceipt"]["artifact"] == outcome["models"]["A"]["originArtifact"]
    checks["ConfirmedReceiptBindsActualRegisteredA"] = outcome["mainCommittedReceipt"]["registry"]["version"] == outcome["bindings"]["A"]["version"]
    checks["RecordedWrongBindingActuallyChoosesB"] = state["wrongPublisherConfiguration"]["binding"] == outcome["bindings"]["B"]
    checks["WrongBindingDownloadedActualB"] = any(item["sha256"] == outcome["models"]["B"]["originArtifact"]["sha256"]
        for item in state["wrongDownloadedArtifactObservations"])
    checks["CommittedJournalHasOneEntry"] = len(state["recoveredJournalObservation"]["entries"]) == 1
    checks["PendingJournalHasNoReceipt"] = state["uncertainRetryJournalObservation"]["entries"][0]["receipt"] is None
    checks["NoRawCoefficientsInScope"] = '"coefficient"' not in json.dumps(state) and '"intercept"' not in json.dumps(state)
    report = {"schema": "footprint-ml-mlflow-promotion-saved-verification/v1", "passed": all(checks.values()), "checks": checks,
        "sources": {name: {"sha256": hashlib.sha256((root/name).read_bytes()).hexdigest(), "bytes": (root/name).stat().st_size}
                    for name in ("recording.json", "outcome.json", "numerical-observations.json")},
        "execution": {"savedJsonOnly": True, "scalarArithmeticAudit": True, "mlflowImported": False,
                      "trainingRepeated": False, "registryContacted": False, "guardRecomputed": False},
        "boundary": "Checks saved prediction arithmetic, identities and journal observations; does not prove training or authenticate the original producer."}
    if not report["passed"]:
        raise RuntimeError("Saved verification failed: " + ", ".join(key for key, value in checks.items() if not value))
    target = root / "saved-verification.json"
    with target.open("x") as output:
        json.dump(report, output, indent=2, allow_nan=False)
    print(json.dumps({"passed": True, "checks": len(checks), "report": str(target)}, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    args = parser.parse_args()
    verify(args.run)
