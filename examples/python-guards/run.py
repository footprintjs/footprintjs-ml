"""Python orchestration over native selection/lineage contracts and retained facts."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys

try:
    from footprint_ml_workflow import WorkflowCapture
except ModuleNotFoundError as error:
    if error.name != "footprint_ml_workflow":
        raise
    # Source-checkout fallback only; an installed wheel takes precedence.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
    from footprint_ml_workflow import WorkflowCapture


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def observations(path):
    blob = path.read_bytes()
    value = json.loads(blob)
    if value["schema"] != "footprint-ml-python-guard-observations/v1":
        raise ValueError("Unsupported retained observations")
    payload = {key: value[key] for key in ("selection", "lineageCases")}
    if digest(canonical(payload)) != value["projection"]["sha256"]:
        raise ValueError("Retained observations changed after projection")
    return value, {"path": path.name, "sha256": digest(blob), "bytes": len(blob), "projection": value["projection"]}


def membership_audit(evidence, observed, folder):
    documents, identities = {}, {}
    for label, retained in evidence.items():
        relative = PurePosixPath(retained["retainedFile"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Invalid retained membership path")
        blob = (folder / Path(*relative.parts)).read_bytes()
        ref = retained["artifact"]
        if len(blob) != ref["bytes"] or digest(blob) != ref["sha256"]:
            raise ValueError("Retained membership bytes changed: " + label)
        documents[label], identities[label] = json.loads(blob), ref
    split, memberships, overlap = (documents[key] for key in ("split", "memberships", "overlap"))
    train_ids, evaluation_ids = (set(split["partitions"][role]) for role in ("train", "validation"))
    fit_ids = set(memberships["fitRowIds"])
    actual_train_overlap = sorted(train_ids & evaluation_ids)
    actual_fit_overlap = sorted(fit_ids & evaluation_ids)
    expected_fit_ids = set().union(*(set(split["partitions"][ref["role"]]) for ref in observed["preprocessing"]["fitDatasetRefs"]))
    if (len(train_ids) != observed["trainingDatasetRef"]["rows"] or len(evaluation_ids) != observed["datasetRef"]["rows"]
            or fit_ids != expected_fit_ids or len(fit_ids) != memberships["rowCount"]
            or actual_train_overlap != overlap["trainEvaluationRowIds"]
            or actual_fit_overlap != overlap["preprocessingEvaluationRowIds"]
            or len(actual_train_overlap) != observed["overlap"]["trainEvaluationRows"]
            or len(actual_fit_overlap) != observed["overlap"]["preprocessingEvaluationRows"]):
        raise ValueError("Retained row memberships disagree with the observed lineage facts")
    if identities["split"] != observed["splitManifest"] or identities["overlap"] != observed["overlap"]["evidenceArtifact"]:
        raise ValueError("Lineage receipt references different retained membership evidence")
    return {"schema": "footprint-ml-retained-membership-audit/v1", "passed": True,
            "trainingRows": len(train_ids), "validationRows": len(evaluation_ids), "fitRows": len(fit_ids),
            "trainEvaluationRows": len(actual_train_overlap), "preprocessingEvaluationRows": len(actual_fit_overlap),
            "artifactIdentities": identities,
            "boundary": "Recomputed set intersections from retained original row IDs; no data split, fitting or numerical evaluation was repeated."}


def quality_check(capture, model, receipt, comparison, policy, now):
    return capture.check_release({"modelRef": model, **comparison, "receipt": receipt, "policy": policy, "now": now})


def decision_summary(decision):
    # Full native decisions remain under their individual recorded scope keys.
    # The outcome keeps their policy/status/reasons without duplicating all
    # nested expected/receipt bindings into one transport value.
    return {key: value for key, value in decision.items() if key != "bindings"}


def run(out, runtime_dir=None, source=None):
    fixture_path = Path(source) if source else Path(__file__).with_name("observations.json")
    fixture, source_ref = observations(fixture_path)
    root = Path(out).resolve()
    root.mkdir(parents=True, exist_ok=False)
    outcome = None
    with WorkflowCapture(root / "recording.json", runtime_dir=runtime_dir) as capture:
        # Authority is declared before any offered selection/lineage receipt.
        with capture.stage("declare-guard-plans", name="Pin the independent comparison and data-use declarations") as s:
            s["selectionManifest"] = capture.read_selection_manifest(fixture["selection"]["manifest"])
            s["selectionQualityPolicy"] = fixture["selection"]["qualityPolicy"]
            s["selectionCheckTime"] = fixture["selection"]["checkTime"]
            s["comparisonCases"] = [
                {"name": "wrong", "direction": "min", "proposedCandidateId": "steps-30"},
                {"name": "reversed", "direction": "max", "proposedCandidateId": None},
                {"name": "correct", "direction": "min", "proposedCandidateId": None}]
            for mode in ("clean", "faulty"):
                s[mode + "LineageDeclaration"] = fixture["lineageCases"][mode]["declaration"]
                s[mode + "LineageQualityPolicy"] = fixture["lineageCases"][mode]["qualityPolicy"]
            s["sourceObservationArtifact"] = source_ref
        with capture.stage("retain-candidate-observations", name="Retain the three actual JAX evaluations") as s:
            s["candidateResults"] = fixture["selection"]["candidateResults"]
            s["selectionSource"] = fixture["selection"]["source"]
        with capture.stage("unrelated-note", name="Record an unrelated note outside the guard inputs") as s:
            s["unrelatedNote"] = "This should not appear in selection dependency slices"

        for index, name in enumerate(("wrong", "reversed", "correct")):
            with capture.stage("offer-" + name + "-selection", name="Construct the " + name + " selection proposal") as s:
                case = s["comparisonCases"][index]
                expected = s["selectionManifest"]
                offered_manifest = copy.deepcopy(expected)
                offered_manifest["policy"]["direction"] = case["direction"]
                receipt = capture.create_selection_receipt({"selectionId": "python-" + name,
                    "createdAt": s["selectionCheckTime"], "manifest": offered_manifest, "results": s["candidateResults"]})
                receipt = capture.read_selection_receipt(receipt)
                proposed_id = case["proposedCandidateId"] or receipt["selectedCandidateId"]
                proposed = next(result for result in s["candidateResults"] if result["candidateId"] == proposed_id)
                s[name + "SelectionReceipt"] = receipt
                s[name + "ProposedResult"] = proposed
            with capture.stage("check-" + name + "-selection", name="Check quality and selection independently for " + name) as s:
                result = s[name + "ProposedResult"]
                manifest = s["selectionManifest"]
                quality = quality_check(capture, result["modelRef"], result["evaluation"], manifest["comparison"],
                                        s["selectionQualityPolicy"], s["selectionCheckTime"])
                selection = capture.check_selection({"receipt": s[name + "SelectionReceipt"], "manifest": manifest,
                    "results": s["candidateResults"], "modelRef": result["modelRef"], "now": s["selectionCheckTime"]})
                quality_key = "qualityDecision" if name == "correct" else name + "QualityDecision"
                selection_key = "selectionDecision" if name == "correct" else name + "SelectionDecision"
                s[quality_key], s[selection_key] = quality, selection
                s[name + "Attempt"] = {"candidateId": result["candidateId"], "qualityDecision": s[quality_key],
                                       "selectionDecision": s[selection_key]}
                if not quality["allowed"] or selection["allowed"] != (name == "correct"):
                    raise RuntimeError("Selection proof did not produce the intended checked outcomes")

        for mode in ("clean", "faulty"):
            case = fixture["lineageCases"][mode]
            with capture.stage("retain-" + mode + "-lineage", name="Retain the actual " + mode + " digits data-use observation") as s:
                s[mode + "LineageObservation"] = case["observed"]
                s[mode + "EvaluationReceipt"] = capture.read_evaluation_receipt(case["evaluation"])
                s[mode + "MembershipEvidence"] = case["membershipEvidence"]
                s[mode + "LineageSource"] = case["source"]
            with capture.stage("audit-" + mode + "-memberships", name="Check original retained " + mode + " row memberships") as s:
                s[mode + "MembershipAudit"] = membership_audit(s[mode + "MembershipEvidence"],
                                                              s[mode + "LineageObservation"], fixture_path.parent)
            with capture.stage("check-" + mode + "-lineage", name="Apply the native data-use guard to " + mode + " observations") as s:
                observed = s[mode + "LineageObservation"]
                audited = s[mode + "MembershipAudit"]
                if (not audited["passed"] or audited["trainEvaluationRows"] != observed["overlap"]["trainEvaluationRows"]
                        or audited["preprocessingEvaluationRows"] != observed["overlap"]["preprocessingEvaluationRows"]):
                    raise RuntimeError("The measured membership audit does not support the offered lineage counts")
                receipt = capture.create_data_lineage_receipt({key: value for key, value in observed.items()
                                                               if key not in ("kind", "schemaVersion")})
                receipt = capture.read_data_lineage_receipt(receipt)
                declaration = s[mode + "LineageDeclaration"]
                s[mode + "LineageReceipt"] = receipt
                decision = capture.check_data_lineage({**declaration, "receipt": s[mode + "LineageReceipt"]})
                evaluation = s[mode + "EvaluationReceipt"]
                comparison = {key: evaluation[key] for key in ("datasetRef", "preprocessingVersion", "evaluationMethodVersion", "parameters")}
                metric_decision = quality_check(capture, declaration["modelRef"], evaluation, comparison,
                                               s[mode + "LineageQualityPolicy"], evaluation["createdAt"] + 1)
                s[mode + "LineageDecision"] = decision
                s[mode + "MetricDecision"] = metric_decision
                if not metric_decision["allowed"] or decision["allowed"] != (mode == "clean"):
                    raise RuntimeError("Actual retained data-use observations disagreed with the intended proof")

        with capture.stage("check-missing-lineage", name="Keep removed lineage evidence unknown") as s:
            declaration = s["cleanLineageDeclaration"]
            s["missingLineageDecision"] = capture.check_data_lineage({**declaration, "receipt": None})
            incomplete = copy.deepcopy(s["cleanLineageObservation"])
            incomplete.pop("overlap")
            incomplete["lineageId"] = "derived-control/missing-overlap"
            receipt = capture.create_data_lineage_receipt(incomplete)
            s["missingOverlapLineageReceipt"] = receipt
            s["missingOverlapLineageDecision"] = capture.check_data_lineage({**declaration, "receipt": s["missingOverlapLineageReceipt"]})
            s["missingEvidenceControl"] = {"derivedFrom": "cleanLineageObservation",
                                           "operation": "Remove evidence only; do not invent zero counts or a historical observation"}
            if s["missingLineageDecision"]["status"] != "unknown" or s["missingOverlapLineageDecision"]["status"] != "unknown":
                raise RuntimeError("Missing evidence was not kept unknown")

        with capture.stage("record-guard-outcomes", name="Retain the separate selection and data-use findings") as s:
            attempts = {}
            for name in ("wrong", "reversed", "correct"):
                attempt = s[name + "Attempt"]
                attempts[name] = {"candidateId": attempt["candidateId"],
                                  "qualityDecision": decision_summary(attempt["qualityDecision"]),
                                  "selectionDecision": decision_summary(attempt["selectionDecision"])}
            outcome = {"schema": "footprint-ml-python-guards-outcome/v1", "sourceObservationArtifact": s["sourceObservationArtifact"],
                       "selection": {"source": s["selectionSource"], "manifest": s["selectionManifest"],
                                     "results": s["candidateResults"], "attempts": attempts},
                       "lineage": {mode: {"source": s[mode + "LineageSource"], "receipt": s[mode + "LineageReceipt"],
                                          "declaration": s[mode + "LineageDeclaration"],
                                          "membershipAudit": s[mode + "MembershipAudit"], "decision": decision_summary(s[mode + "LineageDecision"]),
                                          "metricDecision": decision_summary(s[mode + "MetricDecision"])} for mode in ("clean", "faulty")},
                       "missingEvidence": {"receiptMissing": decision_summary(s["missingLineageDecision"]),
                                           "overlapMissing": decision_summary(s["missingOverlapLineageDecision"]),
                                           "control": s["missingEvidenceControl"]},
                       "fullNativeDecisionScopeKeys": ["wrongSelectionDecision", "reversedSelectionDecision", "selectionDecision",
                                                       "cleanLineageDecision", "faultyLineageDecision", "missingLineageDecision", "missingOverlapLineageDecision"],
                       "execution": {"pythonOrchestration": True, "liveFootprintCapture": True,
                                     "numericalTrainingRepeated": False, "numericalEvaluationRepeated": False,
                                     "selectionAndGuardCalculationsRepeated": True, "retainedMembershipIntersectionsRecomputed": True,
                                     "registryWrites": False, "modelPublication": False},
                       "boundaries": ["Selection uses three actual retained JAX Gaussian-process evaluations. Their numerical results are observations, not new evaluations.",
                                      "Lineage uses separate actual retained scikit-learn digit-classifier runs; it is not evidence about the JAX candidates.",
                                      "Only core typed references and original metrics/data-use facts were projected. Original numerical artifact bytes were verified during extraction but are not bundled.",
                                      "Retained row-membership bytes are verified again and their set intersections recomputed; this does not verify the original trainer or split semantics.",
                                      "Missing-evidence cases are derived controls, not claims that the original backend observed missing data.",
                                      "Python owns orchestration; every guard and receipt operation delegates to the existing TypeScript contract, with no numerical runtime or registry started."]}
            s["guardProofPassed"] = True
            s["outcome"] = outcome
    with (root / "outcome.json").open("x") as stream:
        json.dump(outcome, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"schema": outcome["schema"], "out": str(root),
        "selection": {name: {"candidateId": attempt["candidateId"], "quality": attempt["qualityDecision"]["status"],
                             "selection": attempt["selectionDecision"]["status"]} for name, attempt in outcome["selection"]["attempts"].items()},
        "lineage": {mode: {"quality": value["metricDecision"]["status"], "lineage": value["decision"]["status"],
                           "preprocessingEvaluationRows": value["membershipAudit"]["preprocessingEvaluationRows"]} for mode, value in outcome["lineage"].items()},
        "missingEvidence": {name: value["status"] for name, value in outcome["missingEvidence"].items() if name != "control"}}, indent=2))
    return outcome


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--runtime-dir")
    parser.add_argument("--observations", help="An extracted observations.json with retained evidence/ files beside it")
    args = parser.parse_args()
    run(args.out, args.runtime_dir, args.observations)
