"""Actual local MLflow registry promotion through the existing native release API."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import sys
import time
import uuid

os.environ.setdefault("MLFLOW_DISABLE_TELEMETRY", "true")
os.environ.setdefault("DO_NOT_TRACK", "true")
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")

try:
    from footprint_ml_promotion import MlflowModelPublisher
    from footprint_ml_workflow import WorkflowCapture
except ModuleNotFoundError as error:
    if error.name not in ("footprint_ml_workflow", "footprint_ml_promotion"):
        raise
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
    from footprint_ml_promotion import MlflowModelPublisher
    from footprint_ml_workflow import WorkflowCapture

import mlflow
from mlflow import MlflowClient
import numpy as np

from numerical import FORMAT, METHOD, LiveModels, dataset, digest, encode, predict, train, write_json


def now():
    return int(time.time() * 1000)


class ObservedClient:
    """Delegate to the real client; inject only an explicitly declared reply fault."""
    def __init__(self, client, *, timeout_after_alias=None):
        self.client, self.timeout_after_alias = client, timeout_after_alias
        self.alias_calls = []
        self.downloads = []

    def __getattr__(self, key):
        return getattr(self.client, key)

    def set_registered_model_alias(self, name, alias, version):
        self.alias_calls.append({"name": name, "alias": alias, "version": str(version)})
        result = self.client.set_registered_model_alias(name, alias, version)
        if alias == self.timeout_after_alias:
            self.timeout_after_alias = None
            raise TimeoutError("Injected timeout after the real MLflow alias setter completed")
        return result

    def download_artifacts(self, run_id, artifact_path, dst_path=None):
        path = self.client.download_artifacts(run_id, artifact_path, dst_path=dst_path)
        content = Path(path).read_bytes()
        self.downloads.append({"runId": run_id, "artifactPath": artifact_path,
                               "sha256": digest(content), "bytes": len(content)})
        return path


class LostOuterReply:
    def __init__(self, publisher):
        self.publisher, self.committed_result = publisher, None

    def lookup(self, request):
        return self.publisher.lookup(request)

    def publish(self, request):
        result = self.publisher.publish(request)
        if result["status"] == "published" and self.committed_result is None:
            self.committed_result = copy.deepcopy(result)
            raise TimeoutError("Injected lost outer reply after publisher returned its committed journal receipt")
        return result


def alias_version(client, name, alias):
    try:
        return str(client.get_model_version_by_alias(name, alias).version)
    except mlflow.exceptions.MlflowException as error:
        if error.error_code == "RESOURCE_DOES_NOT_EXIST":
            return None
        if (error.error_code == "INVALID_PARAMETER_VALUE"
                and alias not in client.get_registered_model(name).aliases):
            return None
        raise


def summarize(result):
    # Full native objects remain at their stage's individual scope keys.
    return {key: result[key] for key in ("allowed", "status", "reasons", "preparedRef", "publisherReceipt")
            if key in result}


def run(out, runtime_dir=None):
    root = Path(out).resolve()
    root.mkdir(parents=True, exist_ok=False)
    store_root, journal_root = root / "release-store", root / "publication-journals"
    tracking = "sqlite:///" + str(root / "mlflow.db")
    client = MlflowClient(tracking_uri=tracking, registry_uri=tracking)
    observed = ObservedClient(client, timeout_after_alias="uncertain")
    experiment = client.create_experiment("footprint-checked-promotion", artifact_location=(root / "mlflow-artifacts").as_uri())
    run_id = client.create_run(experiment).info.run_id
    name, registry_id = "footprint-linear-predictor", "local-proof-registry"
    client.create_registered_model(name)
    session = "numpy-promotion-" + uuid.uuid4().hex
    backend = LiveModels(session)
    x, y, vx, vy = dataset()
    bindings = {}
    model_refs = {}
    numerical = {"training": {"x": x.tolist(), "y": y.tolist()},
                 "validation": {"x": vx.tolist(), "y": vy.tolist()}, "models": {}}
    configs = [{"candidateId": "A", "configuration": {"algorithm": "least-squares"}},
               {"candidateId": "B", "configuration": {"algorithm": "gradient-descent", "steps": 2, "learningRate": .1}}]

    def publisher(scope, label):
        # These are the actual consumed coordinates, not an equivalent label for
        # a publisher object previously configured from closure-held inputs.
        configured = scope[label + "PublisherConfiguration"]
        return MlflowModelPublisher(observed, store_root=store_root,
                    journal_dir=journal_root / configured["journalKey"],
                    registry_id=configured["registryId"], model_name=configured["modelName"],
                    alias=configured["alias"], binding=configured["binding"])

    def consumed_json(reference):
        content = (store_root / reference["path"]).read_bytes()
        if len(content) != reference["bytes"] or digest(content) != reference["sha256"]:
            raise RuntimeError("A numerical input changed after its reference was captured")
        return json.loads(content)

    def put(capture, value, label, format="application/json"):
        return capture.put_release_artifact(write_json(root / "evidence-inputs" / (label + ".json"), value),
                                            store_root=store_root, format=format)

    try:
        with WorkflowCapture(root / "recording.json", runtime_dir=runtime_dir) as capture:
            with capture.stage("declare-comparison", name="Pin two configurations and the independent validation rule") as s:
                s["trainingDatasetArtifact"] = put(capture, {"x": x.tolist(), "y": y.tolist()}, "training")
                data_artifact = put(capture, {"x": vx.tolist(), "y": vy.tolist()}, "validation")
                s["datasetRef"] = {"kind": "dataset", "sessionId": session, "handle": 10,
                    "artifact": data_artifact, "rows": len(vx), "shape": [len(vx), 1], "role": "validation"}
                s["candidateConfigurations"] = configs
                s["qualityPolicy"] = {"metric": "mse", "operator": "lte", "threshold": .01}
                s["comparison"] = {"datasetRef": s["datasetRef"], "preprocessingVersion": "train-only-standard-scaler/v1",
                                   "evaluationMethodVersion": METHOD, "parameters": {}}
                s["mlflowRun"] = {"runId": run_id, "modelName": name, "registryId": registry_id,
                                  "tracking": "local SQLite and local artifacts"}
            with capture.stage("train-register-candidates", name="Train A and B and register their actual predictor bundles") as s:
                actual_training = consumed_json(s["trainingDatasetArtifact"])
                actual_validation = consumed_json(s["datasetRef"]["artifact"])
                tx, ty = (np.asarray(actual_training[key], dtype=np.float64) for key in ("x", "y"))
                actual_x, actual_y = (np.asarray(actual_validation[key], dtype=np.float64) for key in ("x", "y"))
                results = []
                for handle, declaration in enumerate(s["candidateConfigurations"], 1):
                    candidate = declaration["candidateId"]
                    bundle = train(tx, ty, declaration["configuration"])
                    file = write_json(root / "models" / candidate / "bundle.json", bundle)
                    artifact = capture.put_release_artifact(file, store_root=store_root, format=FORMAT)
                    model = backend.retain(handle, bundle, artifact)
                    prediction = predict(bundle, actual_x)
                    metric = float(np.mean((prediction - actual_y) ** 2))
                    receipt = capture.create_evaluation_receipt({**s["comparison"], "modelRef": model,
                        "evaluationId": "evaluation-" + candidate, "createdAt": now(), "metrics": {"mse": metric}})
                    client.log_artifact(run_id, str(file), artifact_path="predictors/" + candidate)
                    version = client.create_model_version(name, source=f"runs:/{run_id}/predictors/{candidate}", run_id=run_id)
                    bindings[candidate] = {"version": str(version.version), "runId": str(version.run_id),
                        "source": str(version.source), "artifactPath": f"predictors/{candidate}/bundle.json"}
                    client.log_metric(run_id, "validation_mse_" + candidate, metric)
                    model_refs[candidate] = model
                    results.append({**declaration, "modelRef": model, "evaluation": receipt})
                    numerical["models"][candidate] = {"bundle": bundle, "predictions": prediction.tolist(), "mse": metric,
                                                     "artifact": artifact}
                s["candidateResults"] = results
                s["modelARef"], s["modelBRef"] = model_refs["A"], model_refs["B"]
                s["mlflowBindings"] = bindings
            with capture.stage("pin-selection", name="Persist complete comparison evidence and select the measured winner") as s:
                manifest = capture.read_selection_manifest({"kind": "selection-manifest", "schemaVersion": 1,
                    "experimentId": "two-linear-candidates", "candidates": s["candidateConfigurations"],
                    "comparison": s["comparison"], "policy": {"metric": "mse", "direction": "min", "tieBreak": "candidate-id-ascending"}})
                selection = capture.create_selection_receipt({"selectionId": "select-A", "createdAt": now(),
                                        "manifest": manifest, "results": s["candidateResults"]})
                if selection["selectedCandidateId"] != "A":
                    raise RuntimeError("The measured declared comparison did not select A")
                s["manifestRef"] = put(capture, manifest, "manifest")
                s["resultsRef"] = put(capture, s["candidateResults"], "results")
                s["selectionReceiptRef"] = put(capture, selection, "selection")
            with capture.stage("check-stale-receipt", name="Refuse A's evidence when B is proposed") as s:
                receipt_a = next(r["evaluation"] for r in s["candidateResults"] if r["candidateId"] == "A")
                s["staleDecision"] = capture.check_release({**s["comparison"], "modelRef": s["modelBRef"],
                    "receipt": receipt_a, "policy": s["qualityPolicy"], "now": now()})
                if s["staleDecision"]["allowed"]:
                    raise RuntimeError("Stale A evidence approved B")

            def declare_publisher(label, alias, candidate):
                with capture.stage("bind-" + label + "-publisher", name="Choose the actual registered-version binding for " + label) as s:
                    registry = s["mlflowRun"]
                    s[label + "PublisherConfiguration"] = {"modelName": registry["modelName"],
                        "registryId": registry["registryId"], "alias": alias, "journalKey": label,
                        "binding": s["mlflowBindings"][candidate]}

            def prepare(label, proposed_key="modelARef", expected_revision=None):
                with capture.stage("prepare-" + label, name="Pin and check the exact " + label + " promotion") as s:
                    pub = publisher(s, label)
                    plan = capture.read_model_release_plan({"kind": "model-release-plan", "schemaVersion": 1,
                        "releaseId": "release-" + label, "idempotencyKey": "promotion-" + label,
                        "target": {"name": pub.target_name, "expectedRevision": expected_revision},
                        "modelArtifact": s["modelARef"]["originArtifact"], "manifestRef": s["manifestRef"],
                        "resultsRef": s["resultsRef"], "selectionReceiptRef": s["selectionReceiptRef"], "qualityPolicy": s["qualityPolicy"]})
                    s[label + "PlanRef"] = put(capture, plan, "plan-" + label)
                    start = len(backend.observations)
                    result = capture.prepare_model_release({"planRef": s[label + "PlanRef"], "modelRef": s[proposed_key], "now": now()},
                                                     store_root=store_root, verify_model=backend.verify)
                    s[label + "Preparation"] = result
                    s[label + "VerificationObservations"] = backend.observations[start:]
                    if result["preparedRef"] is not None:
                        s[label + "PreparedRef"] = result["preparedRef"]
                return result

            def publish(label, *, historical=False, result_key=None, lose_outer_reply=False):
                with capture.stage("publish-" + (result_key or label), name="Attempt the " + (result_key or label) + " checked handoff") as s:
                    pub = publisher(s, label)
                    wrapper = LostOuterReply(pub) if lose_outer_reply else None
                    request = {"planRef": s[label + "PlanRef"], "preparedRef": s[label + "PreparedRef"], "now": now()}
                    if not historical:
                        request["modelRef"] = s["modelARef"]
                    start = len(backend.observations)
                    result = capture.publish_model_release(request, store_root=store_root, publisher=wrapper or pub,
                                                        verify_model=None if historical else backend.verify)
                    s[(result_key or label) + "Publication"] = result
                    s[(result_key or label) + "VerificationObservations"] = backend.observations[start:]
                    s[(result_key or label) + "AliasCalls"] = copy.deepcopy(observed.alias_calls)
                    s[(result_key or label) + "DownloadedArtifactObservations"] = copy.deepcopy(observed.downloads)
                    s[(result_key or label) + "JournalObservation"] = pub.read_state()
                    if wrapper is not None:
                        s[(result_key or label) + "CommittedBeforeOuterLoss"] = wrapper.committed_result
                return result

            declare_publisher("wrong", "wrong-version", "B")
            prepare("wrong")
            wrong_result = publish("wrong")
            declare_publisher("swapped", "swapped", "A")
            swapped = prepare("swapped", proposed_key="modelBRef")
            declare_publisher("main", "champion", "A")
            prepare("main")
            lost = publish("main", result_key="lostReply", lose_outer_reply=True)
            recovered = publish("main", historical=True, result_key="recovered")
            with capture.stage("retain-confirmed-promotion", name="Handoff only the acknowledged exact A promotion") as s:
                publication = s["recoveredPublication"]
                if not publication["allowed"]:
                    raise RuntimeError("The committed publication was not acknowledged")
                s["approvedMlflowPromotion"] = publication["publisherReceipt"]
            declare_publisher("uncertain", "uncertain", "A")
            prepare("uncertain")
            uncertain_first = publish("uncertain", result_key="uncertainFirst")
            uncertain_retry = publish("uncertain", historical=True, result_key="uncertainRetry")
            with capture.stage("external-alias-writer", name="An uncoordinated writer occupies a separate alias") as s:
                binding = s["mlflowBindings"]["B"]
                observed.set_registered_model_alias(name, "occupied", binding["version"])
                s["externalAliasObservation"] = {"alias": "occupied", "version": alias_version(client, name, "occupied"),
                                                  "writer": "explicit example client outside publisher coordination"}
            declare_publisher("occupied", "occupied", "A")
            prepare("occupied")
            occupied_result = publish("occupied")
            with capture.stage("record-promotion-findings", name="Retain exact promotion and uncertain retry outcomes") as s:
                current_aliases = {alias: alias_version(client, name, alias)
                                   for alias in ("wrong-version", "champion", "uncertain", "occupied")}
                per_alias = {alias: sum(call["alias"] == alias for call in observed.alias_calls) for alias in current_aliases}
                outcomes = {label: summarize(s[label + "Publication"]) for label in
                            ("wrong", "lostReply", "recovered", "uncertainFirst", "uncertainRetry", "occupied")}
                checks = {"staleAReceiptForBDenied": s["staleDecision"]["status"] == "deny",
                    "BForIndependentAPlanDenied": s["swappedPreparation"]["status"] == "deny" and swapped["preparedRef"] is None,
                    "wrongRegisteredBundleDeniedBeforeAlias": wrong_result["status"] == "deny" and per_alias["wrong-version"] == 0,
                    "independentAPlanPrepared": s["mainPreparation"]["allowed"],
                    "outerReplyLostAfterCommittedPublication": lost["status"] == "unknown" and s["lostReplyCommittedBeforeOuterLoss"] is not None,
                    "matchingRetryAcknowledgesCommittedJournal": recovered["status"] == "already-published",
                    "committedJournalRetained": s["recoveredJournalObservation"]["entries"][0]["status"] == "committed",
                    "approvedAIsActualChampion": current_aliases["champion"] == s["mlflowBindings"]["A"]["version"],
                    "oneMainAliasMutation": per_alias["champion"] == 1,
                    "innerSetterTimeoutRemainsUnknown": uncertain_first["status"] == uncertain_retry["status"] == "unknown",
                    "innerTimeoutDidNotRepeatAliasMutation": per_alias["uncertain"] == 1,
                    "pendingJournalRetained": s["uncertainRetryJournalObservation"]["entries"][0]["status"] == "pending",
                    "innerTimeoutMayHaveChangedAlias": current_aliases["uncertain"] == s["mlflowBindings"]["A"]["version"],
                    "uncoordinatedAliasNotOverwritten": not occupied_result["allowed"] and current_aliases["occupied"] == s["mlflowBindings"]["B"]["version"] and per_alias["occupied"] == 1,
                    "AAndBMeasuredDifferentBytes": s["modelARef"]["originArtifact"]["sha256"] != s["modelBRef"]["originArtifact"]["sha256"]}
                if not all(checks.values()):
                    raise RuntimeError("Promotion controls failed: " + ", ".join(key for key, passed in checks.items() if not passed))
                summary = {"schema": "footprint-ml-mlflow-promotion-outcome/v1", "checks": checks,
                    "versions": {"mlflow": mlflow.__version__, "numpy": np.__version__}, "bindings": s["mlflowBindings"],
                    "models": {"A": s["modelARef"], "B": s["modelBRef"]}, "outcomes": outcomes,
                    "aliases": current_aliases, "aliasMutations": s["occupiedAliasCalls"],
                    "mainCommittedReceipt": s["approvedMlflowPromotion"],
                    "execution": {"orchestration": "Python with native foottrace scope capture", "trainingCalls": 2,
                        "numericalEvaluations": 2, "realLocalMlflow": True, "hostedServing": False,
                        "remoteRegistry": False, "scopeContainsModelArrays": False},
                    "boundaries": ["One complete safe JSON predictor profile, not arbitrary MLflow flavors or serving.",
                        "The application controls Python stages/retries and supplies trusted numerical/live-model observations.",
                        "Alias coordination is one-host cooperating writers with a shared journal, not MLflow compare-and-swap or distributed exactly-once.",
                        "An alias setter timeout remains unknown even when a later alias read matches. Pending intent is not proof of commit.",
                        "Backend/model/registry observations are consistency evidence, not producer authentication or proof of numerical correctness."]}
                s["outcome"] = summary
        client.set_terminated(run_id, status="FINISHED")
    except BaseException:
        client.set_terminated(run_id, status="FAILED")
        raise
    write_json(root / "outcome.json", summary)
    write_json(root / "numerical-observations.json", numerical)
    print(json.dumps({"out": str(root), "checks": checks, "candidateMse": {k: v["mse"] for k, v in numerical["models"].items()},
                      "aliases": summary["aliases"]}, indent=2))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="New local proof directory; never reuse an existing run")
    parser.add_argument("--runtime-dir", help="Explicit installed native helper directory")
    args = parser.parse_args()
    run(args.out, runtime_dir=args.runtime_dir)
