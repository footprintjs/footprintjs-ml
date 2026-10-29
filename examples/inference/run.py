"""Python-owned stale-cache inference proof over the native ML contracts."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid

try:
    from footprint_ml_workflow import WorkflowCapture
except ModuleNotFoundError as error:
    if error.name != "footprint_ml_workflow": raise
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
    from footprint_ml_workflow import WorkflowCapture

from backend_client import PersistentBackend


def now():
    return int(time.time() * 1000)


def sha256(blob):
    return hashlib.sha256(blob).hexdigest()


def decision_summary(value):
    return {key: item for key, item in value.items() if key != "bindings"}


def predict(scope, capture, backend, prefix, *, reverse=False):
    scope[prefix + "InferenceId"] = str(uuid.uuid4())
    observed = backend.call("predict", {"inferenceId": scope[prefix + "InferenceId"],
                                       "inputRef": scope["predictionInputRef"], "reverseFields": reverse})
    cache_observation = scope["cacheObservation"]
    actual = observed["observation"]
    if (actual["workerPid"] != cache_observation["workerPid"]
            or actual["sessionId"] != cache_observation["sessionId"]
            or actual["cacheGeneration"] != cache_observation["cacheGeneration"]
            or actual["beforeModelRef"]["inferenceIdentity"] != cache_observation["modelRef"]["inferenceIdentity"]):
        raise RuntimeError("The actual prediction does not belong to the recorded cache-load observation")
    actual_contract = capture.create_prediction_contract(observed["contract"])
    # All receipt observations come from the worker's actual operation. The
    # application-owned approvedModelRef/expectedContract are not sent to it.
    receipt = capture.create_inference_receipt({key: observed[key] for key in
        ("inferenceId", "createdAt", "inputRef", "outputRef", "inputRows", "outputRows", "modelRef")} | {"contract": actual_contract})
    scope[prefix + "Receipt"] = receipt
    scope[prefix + "BackendObservation"] = observed["observation"]


def check(scope, capture, prefix):
    decision = capture.check_inference({"receipt": scope[prefix + "Receipt"],
        "modelRef": scope["approvedModelRef"], "contract": scope["expectedContract"],
        "inputRef": scope["predictionInputRef"], "rows": scope["predictionRows"],
        "inferenceId": scope[prefix + "InferenceId"], "now": now()})
    scope[prefix + "Decision"] = decision
    return decision


def run(out, runtime_dir=None, fixtures=None):
    root = Path(out).resolve()
    root.mkdir(parents=True, exist_ok=False)
    fixtures = Path(fixtures).resolve() if fixtures else Path(__file__).with_name("fixtures")
    fixture_blob = (fixtures / "source.json").read_bytes()
    backend = None
    outcome = None
    try:
        with WorkflowCapture(root / "recording.json", runtime_dir=runtime_dir) as capture:
            with capture.stage("declare-inference-plan", name="Pin the model, input and contract proof settings before evaluation") as s:
                s["backendPlan"] = {"modelBC": 0.0001, "predictionRows": 64, "fixtureManifestSha256": sha256(fixture_blob)}
                s["fixtureSource"] = json.loads(fixture_blob)
                s["qualityPolicy"] = {"metric": "accuracy", "operator": "gte", "threshold": 0.90}
                s["releasedPredictionRef"] = None
            with capture.stage("start-persistent-backend", name="Load retained A and fit distinct B once in one long-lived worker") as s:
                backend = PersistentBackend(root / "backend", fixtures)
                actual = backend.call("initialize", s["backendPlan"])
                s["backend"] = actual
                s["modelARef"], s["modelBRef"] = actual["modelARef"], actual["modelBRef"]
                s["predictionInputRef"], s["predictionRows"] = actual["inputRef"], s["backendPlan"]["predictionRows"]
                s["expectedContract"] = capture.create_prediction_contract({
                    "profile": "digits-64-named-pixels-to-class-label/v1",
                    "input": {"fields": [{"name": "pixel_" + str(index), "dtype": "float64", "unit": "intensity-0-to-16"} for index in range(64)]},
                    "output": {"fields": [{"name": "digit", "dtype": "int64"}]},
                    "preprocessingVersion": "standardscaler-state/sha256:" + actual["scalerStateSha256"],
                    "classLabels": list(range(10)), "parameters": {"method": "ordered-class-argmax"}})
            with capture.stage("load-A-for-validation", name="Load A and observe its actual in-memory state") as s:
                s["cacheBinding"] = s["modelARef"]
                s["cacheObservation"] = backend.call("load_cache", {"modelRef": s["cacheBinding"]})
            with capture.stage("evaluate-A", name="Run a fresh real validation of A using S1") as s:
                observed = backend.call("evaluate")
                receipt = capture.create_evaluation_receipt({key: observed[key] for key in
                    ("modelRef", "datasetRef", "preprocessingVersion", "evaluationMethodVersion", "parameters", "metrics", "evaluationId", "createdAt")})
                s["evaluationReceipt"] = receipt
                s["validationBackendObservation"] = {key: observed[key] for key in ("workerPid", "sessionId")}
            with capture.stage("approve-A", name="Approve A only against its own fresh evaluation and fixed policy") as s:
                receipt = s["evaluationReceipt"]
                decision = capture.check_release({"modelRef": s["modelARef"], "datasetRef": receipt["datasetRef"],
                    "preprocessingVersion": s["expectedContract"]["preprocessingVersion"],
                    "evaluationMethodVersion": receipt["evaluationMethodVersion"], "parameters": {},
                    "receipt": receipt, "policy": s["qualityPolicy"], "now": now()})
                s["approvalDecision"] = decision
                if not decision["allowed"]: raise RuntimeError("A did not pass the fixed validation policy")
                s["approvedModelRef"] = s["modelARef"]
            with capture.stage("load-wrong-cache", name="Inject the stale-cache mistake: cache B while A remains approved") as s:
                s["cacheBinding"] = s["modelBRef"]
                s["cacheObservation"] = backend.call("load_cache", {"modelRef": s["cacheBinding"]})
            with capture.stage("predict-from-stale-cache", name="Request the fixed input; the worker actually predicts with cached B") as s:
                predict(s, capture, backend, "stale")
            with capture.stage("guard-stale-output", name="Block B's actual output from the independently approved A request") as s:
                decision = check(s, capture, "stale")
                if decision["allowed"]: raise RuntimeError("The stale B prediction was incorrectly allowed")
                s["staleOutputExposed"] = False
                if s["releasedPredictionRef"] is not None: raise RuntimeError("An unapproved output reference escaped")
            with capture.stage("repair-cache-with-A", name="Repair the same worker's cache using approved A") as s:
                s["cacheBinding"] = s["approvedModelRef"]
                s["cacheObservation"] = backend.call("load_cache", {"modelRef": s["cacheBinding"]})
            with capture.stage("predict-after-repair", name="Produce a new prediction with actual cached A") as s:
                predict(s, capture, backend, "corrected")
            with capture.stage("guard-corrected-output", name="Expose only the new A output whose observations match the request") as s:
                decision = check(s, capture, "corrected")
                if not decision["allowed"]: raise RuntimeError("The repaired A prediction was refused")
                s["releasedPredictionRef"] = s["correctedReceipt"]["outputRef"]
            with capture.stage("predict-with-reversed-fields", name="Keep actual A but deliberately reverse the columns sent to it") as s:
                predict(s, capture, backend, "reversed", reverse=True)
            with capture.stage("guard-reversed-fields", name="Reject A output produced with the wrong observed field order") as s:
                decision = check(s, capture, "reversed")
                if decision["allowed"]: raise RuntimeError("Reversed actual input fields were incorrectly allowed")
                if s["releasedPredictionRef"] != s["correctedReceipt"]["outputRef"]:
                    raise RuntimeError("A refused output replaced the previously approved handoff")
            with capture.stage("check-missing-observation", name="Keep a derived missing-model-observation control unknown") as s:
                recorded = s["correctedReceipt"]
                missing = {key: value for key, value in recorded.items() if key not in ("kind", "schemaVersion", "modelRef")}
                s["missingReceipt"] = capture.create_inference_receipt(missing)
                s["missingDecision"] = capture.check_inference({"receipt": s["missingReceipt"], "modelRef": s["approvedModelRef"],
                    "contract": s["expectedContract"], "inputRef": s["predictionInputRef"], "rows": s["predictionRows"],
                    "inferenceId": s["correctedInferenceId"], "now": now()})
                s["missingObservationControl"] = "Derived by removing actual model evidence; this was not another backend prediction"
                if s["missingDecision"]["status"] != "unknown": raise RuntimeError("Missing actual model evidence was not unknown")
            with capture.stage("compare-observed-labels", name="Count observed B-versus-A label differences without exposing the blocked labels") as s:
                s["observedOutputComparison"] = backend.call("compare_outputs", {"left": s["staleReceipt"]["outputRef"],
                                                                               "right": s["correctedReceipt"]["outputRef"]})
            with capture.stage("close-numerical-backend", name="Close the worker after recording its same-session repair") as s:
                backend.close()
                blob = backend.stderr_path.read_bytes()
                s["backendLifecycle"] = {"closed": True, "workerPid": backend.process.pid,
                    "stderrArtifact": {"kind": "artifact", "path": "backend.stderr.log", "sha256": sha256(blob),
                                       "bytes": len(blob), "format": "text/plain"}, "stderrTruncated": backend.stderr_truncated}
            with capture.stage("record-inference-findings", name="Retain the observed identities, decisions and permitted handoff") as s:
                cases = {name: {"receipt": s[name + "Receipt"], "decision": decision_summary(s[name + "Decision"]),
                                "backendObservation": s[name + "BackendObservation"]} for name in ("stale", "corrected", "reversed")}
                observations = [value["backendObservation"] for value in cases.values()]
                backend_info = s["backend"]
                checks = {"AApprovedByFreshEvaluation": s["approvalDecision"]["allowed"],
                    "distinctModelParameters": s["modelARef"]["inferenceIdentity"] != s["modelBRef"]["inferenceIdentity"],
                    "staleActualB": cases["stale"]["receipt"]["modelRef"]["inferenceIdentity"] == s["modelBRef"]["inferenceIdentity"],
                    "staleOutputBlocked": not cases["stale"]["decision"]["allowed"] and not s["staleOutputExposed"],
                    "correctedActualA": cases["corrected"]["receipt"]["modelRef"]["inferenceIdentity"] == s["approvedModelRef"]["inferenceIdentity"],
                    "correctedOutputAccepted": cases["corrected"]["decision"]["allowed"],
                    "reorderedFieldsBlocked": not cases["reversed"]["decision"]["allowed"],
                    "sameAStateForReorderedFields": cases["reversed"]["receipt"]["modelRef"]["inferenceIdentity"] == cases["corrected"]["receipt"]["modelRef"]["inferenceIdentity"],
                    "missingObservationUnknown": s["missingDecision"]["status"] == "unknown",
                    "sameWorkerAcrossRepair": all(item["workerPid"] == backend_info["workerPid"] and item["sessionId"] == backend_info["sessionId"] for item in observations),
                    "stateMeasuredBeforeAndAfter": all(item["stateUnchangedDuringPrediction"] for item in observations),
                    "onlyApprovedOutputExposed": s["releasedPredictionRef"] == s["correctedReceipt"]["outputRef"],
                    "workerClosed": s["backendLifecycle"]["closed"]}
                if not all(checks.values()): raise RuntimeError("An inference proof check failed")
                outcome = {"schema": "footprint-ml-inference-proof-outcome/v1", "source": s["fixtureSource"],
                    "backendPlan": s["backendPlan"], "backend": backend_info, "expectedContract": s["expectedContract"],
                    "approvedModelRef": s["approvedModelRef"], "evaluationReceipt": s["evaluationReceipt"],
                    "approvalDecision": decision_summary(s["approvalDecision"]), "cases": cases,
                    "missingObservation": {"receipt": s["missingReceipt"], "decision": decision_summary(s["missingDecision"]),
                                           "control": s["missingObservationControl"]},
                    "releasedPredictionRef": s["releasedPredictionRef"], "observedOutputComparison": s["observedOutputComparison"],
                    "backendLifecycle": s["backendLifecycle"], "checks": checks,
                    "execution": {"pythonOrchestration": True, "backendModelTrainingCalls": 1, "freshValidationCalls": 1,
                                  "realPredictionCalls": 3, "persistentNumericalWorker": True,
                                  "hostedInferencePlatform": False, "registryWrites": False},
                    "boundaries": ["Controlled stale-cache and field-order failures in one local numerical worker, not a deployed serving system.",
                                   "A's configured evaluation approval and the prediction-observation check are separate decisions; passing either does not establish general model suitability.",
                                   "Model source file hashes are checked on load. Prediction identity is separately measured from the actual in-memory classifier/scaler before and after computation.",
                                   "Blocked output artifacts remain private debugging evidence. Only the accepted A output reference is exposed by the application's handoff scope key.",
                                   "Label differences are an observed result of the fixed models/batch, not a precondition for denying the wrong model.",
                                   "Numerical warnings are retained and forwarded, not suppressed or automatically diagnosed."]}
                s["outcome"] = outcome
        with (root / "outcome.json").open("x") as stream:
            json.dump(outcome, stream, sort_keys=True, indent=2, allow_nan=False); stream.write("\n")
    finally:
        if backend is not None and not backend.closed: backend.close()
    print(json.dumps({"schema": outcome["schema"], "out": str(root), "validationAccuracy": outcome["evaluationReceipt"]["metrics"]["accuracy"],
        "predictionRows": outcome["backend"]["rows"], "observedDifferentLabels": outcome["observedOutputComparison"]["differentLabels"],
        "decisions": {name: value["decision"]["status"] for name, value in outcome["cases"].items()},
        "missingObservation": outcome["missingObservation"]["decision"]["status"], "checks": checks}, indent=2))
    return outcome


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--runtime-dir")
    parser.add_argument("--fixtures")
    args = parser.parse_args()
    run(args.out, args.runtime_dir, args.fixtures)
