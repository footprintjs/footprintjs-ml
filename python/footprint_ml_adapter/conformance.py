"""Reusable contract exercises; numerical meaning remains the plugin's contract."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Callable
import numpy as np

from .identity import canonical_json, json_object, normalize_snapshot
from .runtime import AdapterRuntime, ContractError


LIMITATIONS = [
    "The plugin is trusted executable Python; this runner is not a sandbox.",
    "Structural conformance cannot prove the plugin included every inference component, schema or code dependency in its declared profile.",
    "Numerical checks exercise only the supplied plan and datasets; they are not a general proof of trainer correctness or model quality.",
    "Fingerprint inspection is an operation-boundary observation, not continuous attestation, an atomic serving lease, or cryptographic authentication.",
    "This report is adapter conformance evidence. It does not fabricate a FootPrint execution trace or replace a native FootPrint recording.",
]


def run_conformance(plugin: str, config: dict[str, Any], plan: dict[str, Any], out: Path) -> dict[str, Any]:
    out = out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    runtime = AdapterRuntime()
    initialized = runtime.initialize({"root": str(out / "runtime"), "pluginPath": str(Path(plugin).resolve()), "config": config})
    cases: list[dict[str, Any]] = []
    artifacts: dict[str, Any] = {}
    observations: dict[str, Any] = {}

    def result(name: str, passed: bool | None, category: str, details: Any = None, required: bool = True) -> None:
        cases.append({"name": name, "passed": None if passed is None else bool(passed),
                      "status": "skipped" if passed is None else "passed" if passed else "failed",
                      "required": required, "category": category, "details": details or {}})

    def rejects(name: str, operation: Callable[[], Any], expected: str) -> None:
        try:
            operation()
        except ContractError as error:
            result(name, error.code == expected, "structural", {"code": error.code, "message": str(error), "evidence": error.details})
        except Exception as error:
            result(name, False, "structural", {"type": type(error).__name__, "message": str(error)})
        else:
            result(name, False, "structural", {"error": "Operation unexpectedly succeeded"})

    try:
        first = runtime.train(json_object(plan.get("train"), "plan.train"))
        a = first["modelRef"]
        artifacts["A"] = first["checkpoint"]
        inspected = runtime.inspect({"modelRef": a})["modelRef"]
        result("actual-live-inspection", inspected == a, "structural")
        evaluation_role = plan.get("evaluationDatasetRole", "validation")
        validation = initialized["datasets"].get(evaluation_role)
        if validation is None:
            raise ValueError(f"Conformance dataset role {evaluation_role!r} is unavailable")
        eval_a = runtime.evaluate({"modelRef": a, "datasetRef": validation, "parameters": {}})
        observations["evaluationA"] = eval_a

        loaded = runtime.load({"checkpoint": {"kind": "checkpoint", "artifact": first["checkpoint"]}})
        reload_ref = loaded["modelRef"]
        result("exact-checkpoint-reload-new-handle", reload_ref["handle"] != a["handle"]
               and loaded["actualArtifact"] == first["checkpoint"]
               and reload_ref["inferenceIdentity"] == a["inferenceIdentity"], "structural")
        reload_eval = runtime.evaluate({"modelRef": reload_ref, "datasetRef": validation, "parameters": {}})
        result("reload-metrics-agree", all(np.isclose(value, reload_eval["metrics"].get(name, np.nan), rtol=1e-6, atol=1e-8)
               for name, value in eval_a["metrics"].items()), "numerical")

        second = runtime.train({**json_object(plan.get("continue"), "plan.continue"), "modelRef": a})
        b = second["modelRef"]
        artifacts["B"] = second["checkpoint"]
        result("continuation-source-remains-immutable", runtime.inspect({"modelRef": a})["modelRef"] == a, "structural")
        result("changed-training-changes-inference", a["inferenceIdentity"] != b["inferenceIdentity"], "numerical",
               {"before": a["inferenceIdentity"], "after": b["inferenceIdentity"]})
        eval_b = runtime.evaluate({"modelRef": b, "datasetRef": validation, "parameters": {}})
        observations["evaluationB"] = eval_b
        if plan.get("trainingOnly") is None:
            result("training-only-numerical-change-preserves-inference", None, "numerical",
                   {"reason": "No trainingOnly request was supplied; optimizer/training-only identity coverage was not exercised."}, False)
        else:
            training_only = runtime.train({**json_object(plan["trainingOnly"], "plan.trainingOnly"), "modelRef": b})
            reset_ref = training_only["modelRef"]
            artifacts["trainingOnly"] = training_only["checkpoint"]
            before = runtime._intact(runtime._models[b["handle"]])["snapshot"]
            after = runtime._intact(runtime._models[reset_ref["handle"]])["snapshot"]
            changed_arrays = [name for name in before["arrays"] if name not in after["arrays"] or
                              not np.array_equal(before["arrays"][name], after["arrays"][name])]
            result("training-only-numerical-change-preserves-inference", bool(changed_arrays)
                   and reset_ref["inferenceIdentity"] == b["inferenceIdentity"]
                   and training_only["checkpoint"]["sha256"] != second["checkpoint"]["sha256"], "numerical",
                   {"changedTrainingArrays": changed_arrays, "inferenceIdentity": reset_ref["inferenceIdentity"]}, False)

        forged = {**a, "inferenceIdentity": {**a["inferenceIdentity"], "sha256": "f" * 64}}
        rejects("forged-inference-identity-refused", lambda: runtime.inspect({"modelRef": forged}), "forged-reference")
        stale = {**a, "originArtifact": {**a["originArtifact"], "sha256": "e" * 64}}
        rejects("stale-checkpoint-identity-refused", lambda: runtime.inspect({"modelRef": stale}), "forged-reference")
        runtime.dispose({"modelRef": reload_ref})
        rejects("disposed-handle-refused", lambda: runtime.inspect({"modelRef": reload_ref}), "invalid-handle")

        fresh = AdapterRuntime()
        fresh_init = fresh.initialize({"root": str(out / "runtime"), "pluginPath": str(Path(plugin).resolve()), "config": config})
        rejects("foreign-session-refused", lambda: fresh.inspect({"modelRef": a}), "foreign-session")
        fresh_model = fresh.load({"checkpoint": {"kind": "checkpoint", "artifact": first["checkpoint"]}})["modelRef"]
        result("fresh-session-reloads-same-inference", fresh_model["sessionId"] != a["sessionId"]
               and fresh.inspect({"modelRef": fresh_model})["modelRef"]["inferenceIdentity"] == a["inferenceIdentity"], "structural")
        fresh_eval = fresh.evaluate({"modelRef": fresh_model, "datasetRef": fresh_init["datasets"][evaluation_role], "parameters": {}})
        result("fresh-session-metrics-agree", all(np.isclose(value, fresh_eval["metrics"].get(name, np.nan), rtol=1e-6, atol=1e-8)
               for name, value in eval_a["metrics"].items()), "numerical")

        # Deliberate fault injection is local to this conformance harness. There
        # is no protocol command allowing a client to replace registered state.
        victim = runtime.load({"checkpoint": {"kind": "checkpoint", "artifact": second["checkpoint"]}})["modelRef"]
        record = runtime._models[victim["handle"]]
        measured = runtime._intact(record)
        snapshot = normalize_snapshot(measured["snapshot"])
        candidates = sorted(snapshot["arrays"], key=lambda name: (name in measured["inference"]["arrays"], name))
        injected = False
        injection_error = None
        for name in candidates:
            array = snapshot["arrays"][name]
            if not array.size:
                continue
            proposed = normalize_snapshot(snapshot)
            flat = proposed["arrays"][name].reshape(-1)
            flat[0] = (not bool(flat[0])) if array.dtype.kind == "b" else (0 if flat[0] != 0 else 1)
            try:
                state = runtime.plugin.restore(proposed)
                observed = runtime._capture(state)
                if observed["full"] == measured["full"]:
                    continue
                record["state"] = state
                injected = True
                observations["mutationInjection"] = {"array": name,
                    "inferenceChanged": observed["identity"] != measured["identity"]}
                break
            except Exception as error:
                injection_error = str(error)
        if injected:
            rejects("mutated-actual-state-refused", lambda: runtime.inspect({"modelRef": victim}), "immutable-state-changed")
        else:
            result("mutated-actual-state-refused", False, "structural", {"notTested": True,
                   "reason": injection_error or "No mutable numeric snapshot component was available"})

        metric = plan.get("metric")
        operator, threshold = plan.get("operator"), plan.get("threshold")
        if type(metric) is not str or operator not in ("gte", "lte") or type(threshold) not in (int, float) or not np.isfinite(threshold):
            raise ValueError("Plan requires metric, operator gte/lte, and finite threshold")
        score = eval_b["metrics"].get(metric)
        passed = score is not None and (score >= threshold if operator == "gte" else score <= threshold)
        result("predeclared-numerical-threshold", passed, "numerical", {"metric": metric, "operator": operator,
               "threshold": threshold, "actual": score})
    except Exception as error:
        result("plan-completed", False, "structural", {"type": type(error).__name__, "message": str(error)})

    structural = [case for case in cases if case["category"] == "structural"]
    numerical = [case for case in cases if case["category"] == "numerical"]
    failures = sum(case["status"] == "failed" for case in cases)
    skipped = sum(case["status"] == "skipped" for case in cases)
    report = {"schema": "footprint-ml-adapter-conformance/v1", "passed": all(case["passed"] is True for case in cases),
              "status": "failed" if failures else "partial" if skipped else "passed",
              "requiredPassed": all(case["passed"] is True for case in cases if case["required"]),
              "counts": {"passed": sum(case["status"] == "passed" for case in cases), "failed": failures, "skipped": skipped},
              "structuralPassed": bool(structural) and all(case["passed"] is True for case in structural),
              "numericalPassed": bool(numerical) and all(case["passed"] is True for case in numerical),
              "coverage": {"trainingOnly": "skipped" if plan.get("trainingOnly") is None else "tested",
                           "evaluationDatasetRole": plan.get("evaluationDatasetRole", "validation"),
                           "componentCompleteness": "not-proven"},
              "backend": initialized["backend"], "plan": plan, "cases": cases, "observations": observations,
              "artifacts": artifacts, "limitations": LIMITATIONS}
    (out / "conformance-report.json").write_bytes(canonical_json(report) + b"\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin", required=True)
    parser.add_argument("--config", required=True, help="JSON object text")
    parser.add_argument("--plan", required=True, help="JSON object text")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    import json
    report = run_conformance(args.plugin, json_object(json.loads(args.config), "config"),
                             json_object(json.loads(args.plan), "plan"), Path(args.out))
    print(canonical_json(report).decode("utf-8"))
    raise SystemExit(0 if report["requiredPassed"] and report["counts"]["failed"] == 0 else 1)


if __name__ == "__main__":
    main()
