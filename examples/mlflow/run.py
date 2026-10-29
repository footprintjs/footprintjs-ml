"""Python owns training, retry and control flow; FootPrint records live reads/writes."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
import uuid

# Keep this local proof from contacting MLflow's optional usage telemetry.
os.environ.setdefault("MLFLOW_DISABLE_TELEMETRY", "true")
os.environ.setdefault("DO_NOT_TRACK", "true")

# This is the installed package's optional Python directory, not a JS workflow.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import mlflow
from mlflow import MlflowClient
import numpy as np
import sklearn
from sklearn.datasets import load_digits
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

from footprint_ml_workflow import WorkflowCapture, MlflowArtifacts
from numerical import (DATA_FORMAT, EVALUATION_METHOD, MODEL_FORMAT, SCALER_FORMAT,
                       data_document, digest, encode, model_document, predictor_identity,
                       read_data, read_model, read_scaler, scaler_document, write_json)


def milliseconds():
    return int(time.time() * 1000)


def measured_predictor(scope, artifacts):
    # Each actual consumer obtains its business references through native scope.
    weights_ref = scope["modelWeightsBinding"]
    scaler_ref = scope["activePreprocessorBinding"]
    data_ref = scope["validationBinding"]
    weights_bytes = artifacts.read_bytes(weights_ref)
    scaler_bytes = artifacts.read_bytes(scaler_ref)
    data_bytes = artifacts.read_bytes(data_ref)
    weights_sha, scaler_sha, data_sha = map(digest, (weights_bytes, scaler_bytes, data_bytes))
    identity, specification = predictor_identity(weights_sha, scaler_sha)
    model_ref = {"kind": "model", "sessionId": scope["backendSessionId"],
                 "handle": 1 if scaler_sha == scope["scaler1Binding"]["artifact"]["sha256"] else 2,
                 "originArtifact": weights_ref["artifact"], "inferenceIdentity": identity}
    x, y = read_data(data_bytes)
    dataset_ref = {"kind": "dataset", "sessionId": scope["backendSessionId"], "handle": 1,
                   "artifact": data_ref["artifact"], "rows": len(x), "shape": list(x.shape), "role": "validation"}
    consumption = {"modelWeightsBinding": weights_ref, "preprocessorBinding": scaler_ref,
                   "datasetBinding": data_ref, "modelWeightsSha256": weights_sha,
                   "preprocessorSha256": scaler_sha, "rawValidationSha256": data_sha,
                   "predictorSpecification": specification}
    return model_ref, dataset_ref, consumption, read_model(weights_bytes), read_scaler(scaler_bytes), x, y


def evaluate(scope, artifacts, client, capture, prefix):
    model_ref, dataset_ref, actual, model, scaler, x, y = measured_predictor(scope, artifacts)
    prediction = model.predict(scaler.transform(x))
    accuracy = float(accuracy_score(y, prediction))
    # The receipt reports measured consumed identities; it does not copy an old
    # requested model label or an MLflow tag into numerical evidence.
    receipt = capture.create_evaluation_receipt({"evaluationId": str(uuid.uuid4()), "createdAt": milliseconds(),
               "modelRef": model_ref, "datasetRef": dataset_ref,
               "preprocessingVersion": "measured-scaler/sha256:" + actual["preprocessorSha256"],
               "evaluationMethodVersion": EVALUATION_METHOD, "parameters": {},
               "metrics": {"accuracy": accuracy}})
    scope["modelRef"] = model_ref
    scope["datasetRef"] = dataset_ref
    scope["actualConsumption"] = actual
    scope["evaluationReceipt"] = receipt
    scope[prefix + "Receipt"] = receipt
    scope[prefix + "Consumption"] = actual
    client.log_metric(scope["mlflowRun"]["runId"], prefix + "_accuracy", accuracy,
                      timestamp=receipt["createdAt"], step=0, synchronous=True,
                      dataset_name="digits-fixed-validation", dataset_digest=actual["rawValidationSha256"])


def guard(scope, capture, receipt_key):
    receipt = scope[receipt_key]
    request = {"modelRef": scope["modelRef"], "datasetRef": scope["datasetRef"],
               "preprocessingVersion": "measured-scaler/sha256:" + scope["actualConsumption"]["preprocessorSha256"],
               "evaluationMethodVersion": EVALUATION_METHOD, "parameters": {},
               "receipt": receipt, "policy": scope["qualityPolicy"], "now": milliseconds()}
    decision = capture.check_release(request)
    scope["offeredReceipt"] = receipt
    scope["releaseDecision"] = decision
    scope["releaseAllowed"] = decision["allowed"]
    return decision


def run(out):
    root = Path(out).resolve()
    root.mkdir(parents=True, exist_ok=False)
    source_dir = root / "source-artifacts"
    artifact_dir = root / "mlflow-artifacts"
    artifact_dir.mkdir()
    tracking_uri = "sqlite:///" + str(root / "tracking.db")
    client = MlflowClient(tracking_uri=tracking_uri, registry_uri=tracking_uri)
    experiment_id = client.create_experiment("footprint-digits-preprocessing-proof", artifact_location=artifact_dir.as_uri())
    mlflow_run = client.create_run(experiment_id, run_name="digits-preprocessing-retry")
    run_id = mlflow_run.info.run_id
    artifacts = MlflowArtifacts(client, root / "verified-cache")
    summary = None
    try:
        with WorkflowCapture(root / "recording.json") as capture:
            with capture.stage("load-digits", name="Load and pin the fixed digits split") as s:
                x, y = load_digits(return_X_y=True)
                train_x, validation_x, train_y, validation_y = train_test_split(
                    x, y, test_size=0.25, random_state=19, stratify=y)
                for role, xx, yy in (("train", train_x, train_y), ("validation", validation_x, validation_y)):
                    path = write_json(source_dir / "data" / (role + ".json"), data_document(xx, yy, role))
                    client.log_artifact(run_id, str(path), artifact_path="data")
                    s[role + "Binding"] = artifacts.bind_artifact(run_id, "data/" + role + ".json", DATA_FORMAT)
                s["mlflowRun"] = {"runId": run_id, "experimentId": experiment_id,
                                   "artifactUri": mlflow_run.info.artifact_uri}
                s["backendSessionId"] = str(uuid.uuid4())
                s["qualityPolicy"] = {"metric": "accuracy", "operator": "gte", "threshold": 0.90}
                s["evaluationMethodVersion"] = EVALUATION_METHOD
                s["modelRef"] = None
                s["approvedModel"] = None

            with capture.stage("train-classifier", name="Fit scaler S1 and train the digit classifier once") as s:
                train_binding = s["trainBinding"]
                train_bytes = artifacts.read_bytes(train_binding)
                train_x, train_y = read_data(train_bytes)
                scaler1 = StandardScaler().fit(train_x)
                # S2 is deliberately incompatible. Its definition uses training
                # data only and is fixed before any validation score is observed.
                scaler2 = StandardScaler().fit(train_x + 16.0)
                scaler1_doc = scaler_document(scaler1, digest(train_bytes), "S1/training-pixels")
                scaler2_doc = scaler_document(scaler2, digest(data_document(train_x + 16.0, train_y, "deliberately-shifted-train")),
                                             "S2/incorrect-shifted-training-pixels")
                scaler_paths = [("scaler1Binding", "s1.json", scaler1_doc), ("scaler2Binding", "s2.json", scaler2_doc)]
                for key, name, document in scaler_paths:
                    path = write_json(source_dir / "preprocessing" / name, document)
                    client.log_artifact(run_id, str(path), artifact_path="preprocessing")
                    s[key] = artifacts.bind_artifact(run_id, "preprocessing/" + name, SCALER_FORMAT)
                model = LogisticRegression(solver="lbfgs", C=1.0, max_iter=1000).fit(scaler1.transform(train_x), train_y)
                weights = model_document(model, digest(train_bytes), digest(encode(scaler1_doc)))
                weights_path = write_json(source_dir / "model" / "weights.json", weights)
                client.log_artifact(run_id, str(weights_path), artifact_path="model")
                s["modelWeightsBinding"] = artifacts.bind_artifact(run_id, "model/weights.json", MODEL_FORMAT)
                name = "footprint-digits-local-" + run_id[:12]
                client.create_registered_model(name, description="Local proof: safe numeric classifier source; preprocessing is bound separately in evidence.")
                version = client.create_model_version(name, source="runs:/" + run_id + "/model", run_id=run_id)
                s["mlflowModelVersion"] = {"name": version.name, "version": str(version.version),
                                           "runId": version.run_id, "source": version.source, "status": version.status}
                s["activePreprocessorBinding"] = s["scaler1Binding"]
                s["versions"] = {"mlflow": mlflow.__version__, "sklearn": sklearn.__version__, "numpy": np.__version__}

            with capture.stage("evaluate-baseline", name="Validate the original S1 predictor") as s:
                evaluate(s, artifacts, client, capture, "baseline")

            with capture.stage("guard-baseline", name="Approve matching baseline evaluation evidence") as s:
                baseline = guard(s, capture, "baselineReceipt")
                s["baselineDecision"] = baseline
                if not baseline["allowed"]:
                    raise RuntimeError("The fixed baseline did not meet the declared proof policy")

            failed_attempt = None
            try:
                with capture.stage("select-preprocessor", name="First attempt to select preprocessing", attempt=1) as s:
                    failed_attempt = s.runtime_stage_id
                    s["activePreprocessorBinding"] = s["scaler1Binding"]
                    s["uncommittedAttemptMarker"] = "must be discarded"
                    raise RuntimeError("Injected temporary selection failure before stage commit")
            except RuntimeError as error:
                if "Injected temporary" not in str(error):
                    raise
            with capture.stage("select-preprocessor", name="Retry mistakenly selects incompatible scaler S2", attempt=2,
                               retry_of=failed_attempt) as s:
                s["activePreprocessorBinding"] = s["scaler2Binding"]
                s["preprocessingSelection"] = {"attempt": 2, "retryOf": failed_attempt,
                                                "reason": "Injected wrong retry fallback chooses S2"}

            with capture.stage("observe-retry-inputs", name="Measure the predictor actually selected by retry") as s:
                model_ref, dataset_ref, actual, *_ = measured_predictor(s, artifacts)
                s["modelRef"] = model_ref
                s["datasetRef"] = dataset_ref
                s["actualConsumption"] = actual

            with capture.stage("guard-stale-baseline", name="Reject S1 evaluation evidence for the selected S2 predictor") as s:
                decision = guard(s, capture, "baselineReceipt")
                s["staleDecision"] = decision
                if decision["allowed"]:
                    raise RuntimeError("Stale baseline evidence incorrectly approved the S2 predictor")

            with capture.stage("evaluate-faulty", name="Measure S2 accuracy using unchanged weights and validation data") as s:
                evaluate(s, artifacts, client, capture, "faulty")
            with capture.stage("guard-faulty", name="Check S2 against its own actual evaluation") as s:
                s["faultyDecision"] = guard(s, capture, "faultyReceipt")

            with capture.stage("restore-preprocessor", name="Restore S1 without retraining the classifier") as s:
                s["activePreprocessorBinding"] = s["scaler1Binding"]
                s["preprocessingSelection"] = {"reason": "Controlled correction restores original S1"}
            with capture.stage("evaluate-corrected", name="Re-evaluate the restored S1 predictor") as s:
                evaluate(s, artifacts, client, capture, "corrected")
            with capture.stage("guard-corrected", name="Approve the restored predictor and matching fresh evidence") as s:
                decision = guard(s, capture, "correctedReceipt")
                s["correctedDecision"] = decision
                if not decision["allowed"]:
                    raise RuntimeError("Corrected predictor failed the declared policy")
            with capture.stage("record-local-approval", name="Record the exact locally approved predictor") as s:
                if s["correctedDecision"]["allowed"]:
                    s["approvedModel"] = s["modelRef"]
                    s["releaseStatus"] = "approved-locally-no-deployment"
                baseline = s["baselineConsumption"]
                faulty = s["faultyConsumption"]
                corrected = s["correctedConsumption"]
                summary = {"schema": "footprint-ml-mlflow-proof-outcome/v1", "versions": s["versions"],
                           "mlflowRun": s["mlflowRun"], "mlflowModelVersion": s["mlflowModelVersion"],
                           "baseline": {"receipt": s["baselineReceipt"], "consumption": baseline, "decision": s["baselineDecision"]},
                           "faulty": {"receipt": s["faultyReceipt"], "consumption": faulty, "decision": s["faultyDecision"]},
                           "corrected": {"receipt": s["correctedReceipt"], "consumption": corrected, "decision": s["correctedDecision"]},
                           "staleDecision": s["staleDecision"], "approvedModel": s["approvedModel"], "releaseStatus": s["releaseStatus"],
                           "retry": {"failedAttempt": failed_attempt, "orchestratedBy": "ordinary Python try/except", "attempts": 2},
                           "checks": {"weightsUnchanged": baseline["modelWeightsSha256"] == faulty["modelWeightsSha256"] == corrected["modelWeightsSha256"],
                                      "rawValidationUnchanged": baseline["rawValidationSha256"] == faulty["rawValidationSha256"] == corrected["rawValidationSha256"],
                                      "scalerChangedOnRetry": baseline["preprocessorSha256"] != faulty["preprocessorSha256"],
                                      "scalerRestored": baseline["preprocessorSha256"] == corrected["preprocessorSha256"],
                                      "staleReceiptDenied": not s["staleDecision"]["allowed"],
                                      "correctedApproved": s["correctedDecision"]["allowed"]},
                           "execution": {"pythonOrchestration": True, "liveFootprintCapture": True,
                                         "modelTrainingCalls": 1, "evaluationCalls": 3, "remoteServicesUsed": False,
                                         "registryAliasChanged": False, "modelDeployment": False},
                           "boundaries": ["Controlled preprocessing mismatch, not a discovered production incident.",
                                          "A local MLflow registered version identifies safe weight artifacts; the composite predictor identity also binds fitted preprocessing.",
                                          "The Python application supplies numerical observations. The capture library does not prove their completeness or correctness.",
                                          "The controlled correction re-evaluates S1; saved evidence can subsequently be investigated without repeating any training or evaluation."]}
                s["outcome"] = summary
        client.set_terminated(run_id, status="FINISHED")
    except BaseException:
        client.set_terminated(run_id, status="FAILED")
        raise
    write_json(root / "outcome.json", summary)
    client.log_artifact(run_id, str(root / "recording.json"), artifact_path="footprint-evidence")
    client.log_artifact(run_id, str(root / "outcome.json"), artifact_path="footprint-evidence")
    print(json.dumps({"out": str(root), "mlflowRunId": run_id, "modelVersion": summary["mlflowModelVersion"],
                      "accuracy": {name: summary[name]["receipt"]["metrics"]["accuracy"] for name in ("baseline", "faulty", "corrected")},
                      "checks": summary["checks"]}, indent=2))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="A new output directory; existing runs are never overwritten")
    run(parser.parse_args().out)
