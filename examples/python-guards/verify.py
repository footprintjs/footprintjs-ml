"""Read-only acceptance checks for the saved Python guard proof, stdlib only."""
import argparse
import json
from pathlib import Path


def verify(root):
    root = Path(root)
    recording_bytes = (root / "recording.json").read_bytes()
    outcome_bytes = (root / "outcome.json").read_bytes()
    recording, outcome = map(json.loads, (recording_bytes, outcome_bytes))
    state = recording["snapshot"]["sharedState"]
    assert outcome["schema"] == "footprint-ml-python-guards-outcome/v1"
    assert state["outcome"] == outcome
    checks = ["outcome-equals-captured-scope"]
    for name, expected_allowed, expected_candidate in (("wrong", False, "steps-30"),
                                                       ("reversed", False, "steps-30"),
                                                       ("correct", True, "steps-100")):
        attempt = outcome["selection"]["attempts"][name]
        assert attempt["candidateId"] == expected_candidate
        assert attempt["qualityDecision"]["allowed"] is True
        assert attempt["selectionDecision"]["allowed"] is expected_allowed
        checks.append(name + "-quality-and-selection")
    assert outcome["selection"]["manifest"]["policy"]["direction"] == "min"
    assert len(outcome["selection"]["results"]) == 3
    checks.append("complete-independent-minimum-comparison")
    for mode, expected_allowed, expected_overlap in (("clean", True, 0), ("faulty", False, 288)):
        case = outcome["lineage"][mode]
        assert case["metricDecision"]["allowed"] is True
        assert case["decision"]["allowed"] is expected_allowed
        assert case["membershipAudit"]["passed"] is True
        assert case["membershipAudit"]["preprocessingEvaluationRows"] == expected_overlap
        checks.append(mode + "-actual-membership-and-lineage")
    for name in ("receiptMissing", "overlapMissing"):
        assert outcome["missingEvidence"][name]["status"] == "unknown"
        assert outcome["missingEvidence"][name]["allowed"] is False
        checks.append(name + "-stays-unknown")
    assert outcome["execution"]["numericalTrainingRepeated"] is False
    assert outcome["execution"]["numericalEvaluationRepeated"] is False
    assert outcome["execution"]["modelPublication"] is False
    checks.append("no-repeated-numerical-or-publication-work")
    assert (root / "recording.json").read_bytes() == recording_bytes
    assert (root / "outcome.json").read_bytes() == outcome_bytes
    checks.append("original-output-files-unchanged")
    return {"schema": "footprint-ml-python-guards-verification/v1", "passed": True,
            "checksPassed": len(checks), "checks": checks,
            "execution": {"savedJsonOnly": True, "nativeGuardRepeated": False, "numericalWorkRepeated": False}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    print(json.dumps(verify(parser.parse_args().run), indent=2))
