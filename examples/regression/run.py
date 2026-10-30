"""A pooled model improves average error while harming a predefined population."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

try:
    from footprint_ml_workflow import WorkflowCapture
    if not hasattr(WorkflowCapture, "check_regression"):
        raise ModuleNotFoundError("Source example needs the matching SDK", name="footprint_ml_workflow")
except ModuleNotFoundError as error:
    if error.name != "footprint_ml_workflow":
        raise
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
    sys.modules.pop("footprint_ml_workflow", None)
    from footprint_ml_workflow import WorkflowCapture

import numpy as np
from numerical import DATA_FORMAT, FORMAT, METHOD, PREPROCESSING, LiveModels, bundle, digest, encode, generate, train, write_json


def now():
    return int(time.time() * 1000)


def scoped_summary(value):
    """Keep exact decisions; pin duplicated native bindings/records separately."""
    if isinstance(value, list):
        return [scoped_summary(item) for item in value]
    if isinstance(value, dict):
        omitted = {"bindings"} if str(value.get("kind", "")).endswith("-decision") else set()
        if value.get("kind") == "model-release-publication": omitted.add("record")
        return {key: scoped_summary(item) for key, item in value.items() if key not in omitted}
    return value


class NativeLocalPublisher:
    """Example adapter to the existing Node receiver, with no Python CAS clone."""
    def __init__(self, configuration):
        self.configuration, self.calls = configuration, []

    def _call(self, operation, request):
        self.calls.append(operation)
        result = subprocess.run([shutil.which("node") or "node", str(Path(__file__).with_name("local-publisher.mjs")),
            operation, self.configuration["storeRoot"], self.configuration["publisherRoot"]],
            input=json.dumps(request, allow_nan=False), capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise RuntimeError("Local receiver failed: " + result.stderr[-2000:])
        return json.loads(result.stdout)

    def lookup(self, request):
        return self._call("lookup", request)

    def publish(self, request):
        return self._call("publish", request)

    def read_state(self):
        return self._call("state", {})


def run(out, runtime_dir=None):
    root = Path(out).resolve()
    root.mkdir(parents=True, exist_ok=False)
    store = root / "release-store"
    backend = LiveModels("regression-proof-" + uuid.uuid4().hex)
    numerical = {"schema": "footprint-ml-regression-numerical-observations/v1", "models": {}, "evaluations": {}}

    def put(capture, value, name, format="application/json"):
        return capture.put_release_artifact(write_json(root / "inputs" / (name + ".json"), value), store_root=store, format=format)

    def read(reference):
        content = (store / reference["path"]).read_bytes()
        if len(content) != reference["bytes"] or digest(content) != reference["sha256"]:
            raise RuntimeError("A numerical operand changed after it was referenced")
        return json.loads(content)

    def dataset_ref(artifact, document, handle):
        return {"kind": "dataset", "sessionId": backend.session, "handle": handle,
                "artifact": artifact, "rows": len(document["rows"]), "shape": [len(document["rows"]), 1], "role": "validation"}

    with WorkflowCapture(root / "recording.json", runtime_dir=runtime_dir) as capture:
        with capture.stage("declare-before-training", name="Declare populations, data protocol and acceptance limits before evaluation") as s:
            s["dataProtocol"] = {"schema": "footprint-ml-regression-data-protocol/v1", "populations": ["majority", "rare"],
                "slope": 2., "intercepts": {"majority": 4., "rare": 1.}, "gridPoints": 10,
                "splits": {"training": {"xRange": [-2., 2.], "rows": {"majority": 90, "rare": 10}},
                           "validation": {"xRange": [-1.8, 1.8], "rows": {"majority": 90, "rare": 10}}}}
            s["protocolArtifact"] = put(capture, s["dataProtocol"], "protocol")
            s["expectedGroupRows"] = {"majority": 90, "rare": 10}
            s["predeclaredPolicies"] = [{"groupId": group, "metric": "mse", "direction": "min", "maxDeterioration": .1, "minSamples": 5}
                                        for group in ("majority", "rare")]
            s["candidateConfigurations"] = [{"candidateId": "baseline", "configuration": {"algorithm": "least-squares", "weighting": "equal-population-mass"}},
                                             {"candidateId": "pooled", "configuration": {"algorithm": "least-squares", "weighting": "equal-row-mass"}}]
            s["qualityPolicy"] = {"metric": "mse", "operator": "lte", "threshold": 3.}
            s["groupDefinitions"] = [{"groupId": group, "definitionRef": put(capture,
                {"schema": "footprint-ml-regression-group-definition/v1", "groupId": group,
                 "rule": {"field": "population", "operator": "eq", "value": group}}, "definition-" + group)} for group in ("majority", "rare")]
            s["publisherConfiguration"] = {"storeRoot": str(store), "publisherRoot": str(root / "local-publication"), "targetName": "regression-proof"}
        with capture.stage("generate-declared-data", name="Generate the fixed populations and retain actual membership artifacts") as s:
            protocol = s["dataProtocol"]
            training, validation = generate(protocol, "training"), generate(protocol, "validation")
            s["trainingArtifact"] = put(capture, training, "training", DATA_FORMAT)
            validation_artifact = put(capture, validation, "validation", DATA_FORMAT)
            s["validationDatasetRef"] = dataset_ref(validation_artifact, validation, 20)
            groups = []
            for index, declaration in enumerate(s["groupDefinitions"], 21):
                definition = read(declaration["definitionRef"])
                rows = [r for r in validation["rows"] if r[definition["rule"]["field"]] == definition["rule"]["value"]]
                subset = {"schema": validation["schema"], "rows": rows}
                subset_ref = put(capture, subset, "subset-" + declaration["groupId"], DATA_FORMAT)
                membership = {"schema": "footprint-ml-regression-membership/v1", "parentArtifact": validation_artifact,
                              "groupId": declaration["groupId"], "rowIds": [r["rowId"] for r in rows]}
                groups.append({**declaration, "membershipRef": put(capture, membership, "membership-" + declaration["groupId"]),
                    "datasetRef": dataset_ref(subset_ref, subset, index), "expectedRows": s["expectedGroupRows"][declaration["groupId"]]})
            s["groups"] = groups
            s["comparison"] = {"datasetRef": s["validationDatasetRef"], "preprocessingVersion": PREPROCESSING,
                                "evaluationMethodVersion": METHOD, "parameters": {"predictionMode": "numeric"}}
        with capture.stage("train-two-models", name="Fit the predeclared group-balanced and pooled least-squares models") as s:
            training = read(s["trainingArtifact"])
            for handle, declaration in enumerate(s["candidateConfigurations"], 1):
                weights = train(training, declaration["configuration"])
                document = bundle(weights)
                artifact = put(capture, document, "model-" + declaration["candidateId"], FORMAT)
                reference = backend.retain(handle, weights, artifact)
                key = "baselineModelRef" if declaration["candidateId"] == "baseline" else "candidateModelRef"
                s[key] = reference
                numerical["models"][declaration["candidateId"]] = {"bundle": document, "artifact": artifact}

        def evaluate(label, model_key):
            with capture.stage("evaluate-" + label, name="Measure actual overall and predefined-group errors for " + label) as s:
                proposed = s[model_key]
                comparison = s["comparison"]
                tables = [("overall", s["validationDatasetRef"])] + [(g["groupId"], g["datasetRef"]) for g in s["groups"]]
                receipts = {}
                numerical["evaluations"][label] = {}
                for group, ref in tables:
                    data = read(ref["artifact"])
                    model, predictions, mse = backend.evaluate(proposed, data)
                    actual_ref = {**ref, "rows": len(data["rows"]), "shape": [len(data["rows"]), 1]}
                    receipt = capture.create_evaluation_receipt({**comparison, "datasetRef": actual_ref, "modelRef": model,
                        "evaluationId": label + "-" + group, "createdAt": now(), "metrics": {"mse": mse}})
                    receipts[group] = {"receipt": receipt, "rows": len(predictions)}
                    numerical["evaluations"][label][group] = {"modelRef": model, "datasetRef": actual_ref,
                        "rowIds": [r["rowId"] for r in data["rows"]], "predictions": predictions, "mse": mse}
                s[label + "Receipts"] = receipts

        evaluate("baseline", "baselineModelRef")
        evaluate("pooled", "candidateModelRef")
        evaluate("unchanged", "baselineModelRef")

        def regression(label, candidate_key, candidate_receipts):
            with capture.stage("check-" + label + "-regression", name="Compare " + label + " to the independently retained baseline") as s:
                manifest = capture.read_regression_manifest({"kind": "regression-manifest", "schemaVersion": 1,
                    "comparisonId": label + "-against-baseline", "baselineModelRef": s["baselineModelRef"],
                    "candidateModelRef": s[candidate_key], "comparison": s["comparison"], "groups": s["groups"],
                    "policies": s["predeclaredPolicies"], "maxAgeMs": 300000})
                baseline, offered = s["baselineReceipts"], s[candidate_receipts]
                observations = [{"groupId": group["groupId"], "definitionRef": group["definitionRef"],
                    "membershipRef": group["membershipRef"], "rows": offered[group["groupId"]]["rows"],
                    "baseline": baseline[group["groupId"]]["receipt"], "candidate": offered[group["groupId"]]["receipt"]}
                    for group in s["groups"]]
                s[label + "Manifest"] = manifest
                s[label + "Observations"] = observations
                s[label + "Receipt"] = capture.create_regression_receipt({"regressionId": label + "-regression", "createdAt": now(),
                    "manifest": s[label + "Manifest"], "observations": s[label + "Observations"]})
                decision = capture.check_regression({"receipt": s[label + "Receipt"], "manifest": s[label + "Manifest"],
                    "observations": s[label + "Observations"], "modelRef": s[candidate_key], "now": now()})
                s[label + "DecisionRef"] = put(capture, decision, label + "-native-decision")
                s[label + "Decision"] = scoped_summary(decision)
                s[label + "ManifestRef"] = put(capture, s[label + "Manifest"], label + "-regression-manifest")
                s[label + "ObservationsRef"] = put(capture, s[label + "Observations"], label + "-regression-observations")
                s[label + "ReceiptRef"] = put(capture, s[label + "Receipt"], label + "-regression-receipt")

        regression("pooled", "candidateModelRef", "pooledReceipts")
        regression("unchanged", "baselineModelRef", "unchangedReceipts")
        with capture.stage("derived-negative-controls", name="Keep mismatch and unavailable-coverage controls separate from the original declaration") as s:
            manifest, observations, receipt = s["pooledManifest"], s["pooledObservations"], s["pooledReceipt"]
            s["wrongModelDecision"] = capture.check_regression({"manifest": manifest, "observations": observations,
                "receipt": receipt, "modelRef": s["baselineModelRef"], "now": now()})
            s["missingReceiptDecision"] = capture.check_regression({"manifest": manifest, "observations": observations,
                "receipt": None, "modelRef": s["candidateModelRef"], "now": now()})
            changed = copy.deepcopy(observations)
            changed[0]["candidate"]["evaluationMethodVersion"] = "derived-wrong-protocol/v1"
            changed_receipt = capture.create_regression_receipt({"regressionId": "derived-wrong-protocol", "createdAt": now(), "manifest": manifest, "observations": changed})
            s["wrongProtocolDecision"] = capture.check_regression({"manifest": manifest, "observations": changed,
                "receipt": changed_receipt, "modelRef": s["candidateModelRef"], "now": now()})
            # What-if policy, explicitly not a retrospective change to the original release requirement.
            coverage = copy.deepcopy(s["unchangedManifest"])
            coverage["comparisonId"] = "derived-insufficient-coverage-control"
            for policy in coverage["policies"]:
                if policy["groupId"] == "rare": policy["minSamples"] = 11
            retained = s["unchangedObservations"]
            coverage_receipt = capture.create_regression_receipt({"regressionId": "derived-coverage", "createdAt": now(), "manifest": coverage, "observations": retained})
            s["insufficientCoverageDecision"] = capture.check_regression({"manifest": coverage, "observations": retained,
                "receipt": coverage_receipt, "modelRef": s["baselineModelRef"], "now": now()})
            s["derivedControlNotice"] = "Wrong metadata and minSamples11 are derived negative/what-if controls. Original population definitions and minSamples5 were pinned before data generation/training."

        def release(label, model_key, candidates, regression_label, receipts):
            with capture.stage("release-" + label, name="Compose overall selection, quality and required group checks for " + label) as s:
                configurations = s["candidateConfigurations"]
                selected = [entry for entry in configurations if entry["candidateId"] in candidates]
                manifest = capture.read_selection_manifest({"kind": "selection-manifest", "schemaVersion": 1,
                    "experimentId": label + "-declared-candidates", "candidates": selected, "comparison": s["comparison"],
                    "policy": {"metric": "mse", "direction": "min", "tieBreak": "candidate-id-ascending"}})
                results = [{**entry, "modelRef": s["baselineModelRef" if entry["candidateId"] == "baseline" else "candidateModelRef"],
                    "evaluation": s[receipts[entry["candidateId"]]]["overall"]["receipt"]} for entry in selected]
                selection = capture.create_selection_receipt({"selectionId": label + "-selection", "createdAt": now(), "manifest": manifest, "results": results})
                configured = s["publisherConfiguration"]
                plan = capture.read_model_release_plan({"kind": "model-release-plan", "schemaVersion": 1,
                    "releaseId": label + "-release", "idempotencyKey": label + "-publication", "target": {"name": configured["targetName"], "expectedRevision": None},
                    "modelArtifact": s[model_key]["originArtifact"], "manifestRef": put(capture, manifest, label + "-selection-manifest"),
                    "resultsRef": put(capture, results, label + "-selection-results"), "selectionReceiptRef": put(capture, selection, label + "-selection-receipt"),
                    "qualityPolicy": s["qualityPolicy"], "regression": {"manifestRef": s[regression_label + "ManifestRef"],
                        "observationsRef": s[regression_label + "ObservationsRef"], "receiptRef": s[regression_label + "ReceiptRef"]}})
                s[label + "PlanRef"] = put(capture, plan, label + "-release-plan")
                publisher = NativeLocalPublisher(configured)
                start = len(backend.verifications)
                result = capture.release_model({"planRef": s[label + "PlanRef"], "modelRef": s[model_key]},
                    store_root=store, publisher=publisher, verify_model=backend.verify)
                s[label + "ReleaseRef"] = put(capture, result, label + "-native-release-response")
                s[label + "Release"] = scoped_summary(result)
                s[label + "PublisherCalls"] = publisher.calls
                s[label + "LiveObservations"] = backend.verifications[start:]
                if result["allowed"]:
                    s["approvedPublication"] = result["publisherReceipt"]

        release("blocked", "candidateModelRef", ["baseline", "pooled"], "pooled", {"baseline": "baselineReceipts", "pooled": "pooledReceipts"})
        release("retained", "baselineModelRef", ["baseline"], "unchanged", {"baseline": "unchangedReceipts"})
        with capture.stage("acknowledge-local-publication", name="Retry the exact committed publication without a new numerical or publication effect") as s:
            publisher = NativeLocalPublisher(s["publisherConfiguration"])
            retry = capture.publish_model_release({"planRef": s["retainedPlanRef"], "preparedRef": s["retainedRelease"]["preparedRef"]},
                store_root=store, publisher=publisher)
            s["retryReleaseRef"] = put(capture, retry, "retry-native-release-response")
            s["retryRelease"] = scoped_summary(retry)
            s["localPublicationState"] = publisher.read_state()
        with capture.stage("record-regression-findings", name="Retain the average-versus-group result and exact release decision") as s:
            baseline, pooled, unchanged = s["baselineReceipts"], s["pooledReceipts"], s["unchangedReceipts"]
            blocked, retained = s["blockedRelease"], s["retainedRelease"]
            checks = {"overallMseImproves": pooled["overall"]["receipt"]["metrics"]["mse"] < baseline["overall"]["receipt"]["metrics"]["mse"],
                "rareGroupMseWorsens": pooled["rare"]["receipt"]["metrics"]["mse"] > baseline["rare"]["receipt"]["metrics"]["mse"],
                "mainRegressionDenied": s["pooledDecision"]["status"] == "deny", "unchangedControlAllowed": s["unchangedDecision"]["allowed"],
                "wrongModelDenied": s["wrongModelDecision"]["status"] == "deny", "wrongProtocolDenied": s["wrongProtocolDecision"]["status"] == "deny",
                "missingReceiptUnknown": s["missingReceiptDecision"]["status"] == "unknown", "insufficientCountUnknown": s["insufficientCoverageDecision"]["status"] == "unknown",
                "overallQualityAllowsBlockedCandidate": blocked["decision"]["checks"]["quality"]["allowed"],
                "overallSelectionAllowsBlockedCandidate": blocked["decision"]["checks"]["selection"]["allowed"],
                "composedRegressionBlocksCandidate": blocked["status"] == "deny" and not blocked["decision"]["checks"]["regression"]["allowed"],
                "blockedCandidateNeverCallsPublisher": "publish" not in s["blockedPublisherCalls"],
                "unchangedModelPublished": retained["status"] == "published", "matchingRetryAcknowledged": s["retryRelease"]["status"] == "already-published",
                "oneActualLocalPublication": len(s["localPublicationState"]["publications"]) == 1,
                "publishedExactBaseline": s["approvedPublication"]["artifact"]["sha256"] == s["baselineModelRef"]["originArtifact"]["sha256"]}
            if not all(checks.values()): raise RuntimeError("Regression proof failed: " + ", ".join(k for k,v in checks.items() if not v))
            outcome = {"schema": "footprint-ml-regression-proof-outcome/v1", "checks": checks,
                "metrics": {"baseline": {k:v["receipt"]["metrics"]["mse"] for k,v in baseline.items()},
                            "pooled": {k:v["receipt"]["metrics"]["mse"] for k,v in pooled.items()},
                            "unchanged": {k:v["receipt"]["metrics"]["mse"] for k,v in unchanged.items()}},
                "groupCounts": {g["groupId"]:g["expectedRows"] for g in s["groups"]},
                "models": {"baseline": s["baselineModelRef"], "pooled": s["candidateModelRef"]},
                "regression": {"pooled": s["pooledDecision"], "unchanged": s["unchangedDecision"]},
                "fullNativeResponses": {key: s[key + "Ref"] for key in ("pooledDecision", "unchangedDecision", "blockedRelease", "retainedRelease", "retryRelease")},
                "publication": s["approvedPublication"], "execution": {"orchestration": "Python with native foottrace capture", "uniqueModelsTrained": 2,
                    "evaluatedModels": 3, "predictionTables": 9, "numpy": np.__version__, "rawArraysInScope": False},
                "boundaries": ["Fixed synthetic 90/10 population protocol; no statistical significance, protected-class fairness or production representativeness claim.",
                    "Groups and main limits were declared before data generation, training and evaluation. Negative/coverage controls are explicitly derived what-if inputs.",
                    "An unchanged baseline is a separately evaluated no-regression control, not a new improved model.",
                    "Group membership and numerical observations remain trusted application evidence; identities do not authenticate a producer or prove arbitrary semantics.",
                    "Python owns stages and retry; this is not native FootPrint executor control or a distributed scheduler.",
                    "The existing local Node publisher supplies one-host locking/CAS/idempotency, without power-loss or distributed exactly-once guarantees."]}
            s["outcome"] = outcome
    write_json(root / "outcome.json", outcome)
    write_json(root / "numerical-observations.json", numerical)
    print(json.dumps({"out": str(root), "checks": checks, "metrics": outcome["metrics"]}, indent=2))
    return outcome


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--runtime-dir")
    args = parser.parse_args()
    run(args.out, runtime_dir=args.runtime_dir)
