"""Measure a local capture integration without repeating model fitting."""
from __future__ import annotations

import argparse
import ast
from collections import Counter
import difflib
import hashlib
import json
import os
from pathlib import Path
import sys

os.environ.setdefault("MLFLOW_DISABLE_TELEMETRY", "true")
os.environ.setdefault("DO_NOT_TRACK", "true")
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "true")

from mlflow import MlflowClient
import footprint_ml_workflow as capture_module
import baseline
import wrapped

HERE = Path(__file__).resolve().parent


def sha(value):
    return hashlib.sha256(value).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n")


class ReadOnlyClient:
    """Count caller-level client operations and refuse MLflow mutations."""
    def __init__(self, client):
        self.client = client
        self.calls = Counter()

    def get_run(self, *args, **kwargs):
        self.calls["get_run"] += 1
        return self.client.get_run(*args, **kwargs)

    def download_artifacts(self, *args, **kwargs):
        self.calls["download_artifacts"] += 1
        return self.client.download_artifacts(*args, **kwargs)


def source_measurements():
    def measure(name):
        file = HERE / name
        source = file.read_text()
        tree = ast.parse(source)
        stage_calls, reads, writes, sdk_imports = 0, 0, 0, []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "footprint_ml_workflow":
                sdk_imports.extend(alias.name for alias in node.names)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "stage":
                stage_calls += 1
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == "scope":
                reads += isinstance(node.ctx, ast.Load)
                writes += isinstance(node.ctx, ast.Store)
        return {"file": name, "sha256": sha(file.read_bytes()), "physicalLines": len(source.splitlines()),
                "nonblankLines": sum(bool(line.strip()) for line in source.splitlines()),
                "sdkImportedSymbols": sdk_imports, "stageContextCallSites": stage_calls,
                "scopeReadSites": reads, "scopeWriteSites": writes}
    old, new = (HERE / name for name in ("baseline.py", "wrapped.py"))
    patch = list(difflib.unified_diff(old.read_text().splitlines(), new.read_text().splitlines(),
                                   fromfile="baseline.py", tofile="wrapped.py", lineterm=""))
    return {"baseline": measure("baseline.py"), "wrapper": measure("wrapped.py"),
            "unchangedEvaluator": measure("existing_evaluator.py"), "retainedNumericalHelper": measure("numerical.py"),
            "literalDiff": {"addedLines": sum(line.startswith("+") and not line.startswith("+++") for line in patch),
                            "removedLines": sum(line.startswith("-") and not line.startswith("---") for line in patch)},
            "definition": "Physical/nonblank source lines and AST call/access sites. These are integration inventory, not effort or semantic edit distance."}, "\n".join(patch) + "\n"


def run(source_run, out, runtime_dir=None, forbid_sdk_root=None):
    source_run = Path(source_run).resolve()
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    module_path = Path(capture_module.__file__).resolve()
    if forbid_sdk_root is not None and module_path.is_relative_to(Path(forbid_sdk_root).resolve()):
        raise RuntimeError("The capture module came from the source checkout rather than the installed wheel")
    original_recording = (source_run / "recording.json").read_bytes()
    original_outcome = (source_run / "outcome.json").read_bytes()
    recording, source_outcome = map(json.loads, (original_recording, original_outcome))
    if source_outcome != recording["snapshot"]["sharedState"]["outcome"]:
        raise ValueError("Source outcome does not match its saved recording")
    run_id = source_outcome["mlflowRun"]["runId"]
    client = MlflowClient(tracking_uri="sqlite:///" + str(source_run / "tracking.db"))
    baseline_client, captured_client = ReadOnlyClient(client), ReadOnlyClient(client)
    plain = baseline.run(baseline_client, run_id, out / "baseline-cache")
    captured, worker = wrapped.run(captured_client, run_id, out / "captured-cache", out / "recording.json", runtime_dir)
    worker_paths = [Path(argument).resolve() for argument in worker["command"]
                    if str(argument).endswith("capture-worker.js")]
    if forbid_sdk_root is not None:
        forbidden = Path(forbid_sdk_root).resolve()
        if len(worker_paths) != 1 or worker_paths[0].is_relative_to(forbidden):
            raise RuntimeError("The capture worker did not come from a runtime outside the source checkout")
    if plain != captured:
        raise AssertionError("Capture changed the evaluator's returned metrics or consumed identities")
    saved = json.loads((out / "recording.json").read_bytes())
    if saved["snapshot"]["sharedState"]["outcome"] != captured:
        raise AssertionError("The captured outcome does not match the returned outcome")
    stages = saved["supplemental"]["pythonCapture"]["stages"]
    checks = {
        "sameEvaluatorFunction": baseline.evaluate_predictor is wrapped.evaluate_predictor,
        "sameReturnedResults": plain == captured,
        "sameWeights": len({captured[key]["modelWeightsSha256"] for key in ("baselineScore", "faultyScore", "correctedScore")}) == 1,
        "sameRawValidation": len({captured[key]["rawValidationSha256"] for key in ("baselineScore", "faultyScore", "correctedScore")}) == 1,
        "wrongScalerChangesThenRestores": captured["baselineScore"]["preprocessorSha256"] != captured["faultyScore"]["preprocessorSha256"] and captured["baselineScore"]["preprocessorSha256"] == captured["correctedScore"]["preprocessorSha256"],
        "sourceScoresRetained": all(captured[pilot]["accuracy"] == source_outcome[original]["receipt"]["metrics"]["accuracy"] for pilot, original in (("baselineScore", "baseline"), ("faultyScore", "faulty"), ("correctedScore", "corrected"))),
        "sourceArtifactIdentitiesRetained": all(captured[pilot][field] == source_outcome[original]["consumption"][field]
            for pilot, original in (("baselineScore", "baseline"), ("faultyScore", "faulty"), ("correctedScore", "corrected"))
            for field in ("modelWeightsSha256", "preprocessorSha256", "rawValidationSha256")),
        "capturedOutcomeMatches": saved["snapshot"]["sharedState"]["outcome"] == captured,
        "oneDiscardedAttempt": sum(stage["status"] == "discarded" for stage in stages) == 1,
        "retryLinksDiscardedAttempt": any(stage.get("attempt") == 2 and stage.get("retryOf") in {row["runtimeStageId"] for row in stages if row["status"] == "discarded"} for stage in stages),
        "failedWritesAbsent": "uncommittedAttemptMarker" not in saved["snapshot"]["sharedState"],
        "originalEvidenceUnchanged": original_recording == (source_run / "recording.json").read_bytes() and original_outcome == (source_run / "outcome.json").read_bytes(),
        "captureWorkerExited": worker["exitCode"] == 0,
    }
    if not all(checks.values()):
        raise AssertionError("Pilot checks failed: " + ", ".join(key for key, value in checks.items() if not value))
    inventory, diff = source_measurements()
    helper_source = (HERE.parent / "mlflow" / "numerical.py")
    retained_helper = inventory["retainedNumericalHelper"]["sha256"]
    helper_comparison = (sha(helper_source.read_bytes()) == retained_helper) if helper_source.is_file() else None
    if helper_comparison is False:
        raise AssertionError("The copied numerical helper changed from the retained MLflow helper")
    report = {"schema": "footprint-python-adoption-pilot/v1", "passed": True, "checks": checks,
              "source": {"runId": run_id, "recordingSha256": sha(original_recording), "outcomeSha256": sha(original_outcome), "sourceOutcomeMatchesCaptured": True},
              "results": captured, "integration": inventory,
              "runtime": {"python": sys.version.split()[0], "captureModule": str(module_path), "captureWorker": worker,
                          "outsideForbiddenSourceRoot": forbid_sdk_root is not None,
                          "captureWorkerPath": str(worker_paths[0]) if len(worker_paths) == 1 else None,
                          "stageAttempts": len(stages), "committedStages": sum(stage["status"] == "committed" for stage in stages),
                          "recordingBytes": (out / "recording.json").stat().st_size,
                          "recordingSha256": sha((out / "recording.json").read_bytes())},
              "clientCalls": {"baseline": dict(baseline_client.calls), "captured": dict(captured_client.calls),
                              "definition": "Calls through the injected client facade, not internal HTTP or storage request counts."},
              "provenance": {"numericalHelperSource": "examples/mlflow/numerical.py", "numericalHelperCopyMatches": helper_comparison,
                             "copiedHelperSha256": retained_helper},
              "execution": {"newModelFits": 0, "baselineEvaluations": 3, "capturedEvaluations": 3,
                            "mlflowWritesRequested": False, "registryAliasesChanged": False, "investigationQueriesRun": False},
              "boundaries": ["An extracted local evaluator and one controlled retry fault, not independent developer adoption.",
                             "The same numerical evaluator runs in both paths. Each path recomputes three metrics from retained artifacts; no model fitting runs.",
                             "Source line/access counts and literal diffs are code inventory, not developer time or a universal integration estimate.",
                             "Python controls workflow and retry. Explicit whole-key scope operations record selected values through a Node foottrace helper.",
                             "No human speed, root-cause superiority, throughput or performance-overhead claim is measured.",
                             "This pilot adds no release receipt/guard calls; the preceding MLflow proof separately checks those contracts."]}
    write_json(out / "baseline-outcome.json", plain)
    write_json(out / "captured-outcome.json", captured)
    write_json(out / "adoption-report.json", report)
    (out / "integration.patch").write_text(diff)
    print(json.dumps({"passed": True, "out": str(out), "accuracy": {name: captured[name]["accuracy"] for name in ("baselineScore", "faultyScore", "correctedScore")},
                      "integration": inventory, "runtime": report["runtime"]}, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-run", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--runtime-dir")
    parser.add_argument("--forbid-sdk-root", help="Fail if capture imports from this SDK checkout")
    options = parser.parse_args()
    run(options.source_run, options.out, options.runtime_dir, options.forbid_sdk_root)
