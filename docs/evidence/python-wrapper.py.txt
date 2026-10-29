"""Opt-in capture around the same scope-free Python evaluator."""
from footprint_ml_workflow import MlflowArtifacts, WorkflowCapture
from existing_evaluator import evaluate_predictor
from baseline import ARTIFACTS
from numerical import MODEL_FORMAT, SCALER_FORMAT, DATA_FORMAT

FORMATS = {"weights": MODEL_FORMAT, "s1": SCALER_FORMAT,
           "s2": SCALER_FORMAT, "validation": DATA_FORMAT}


def evaluate(capture, artifacts, stage_id, score_key):
    with capture.stage(stage_id) as scope:
        weights = artifacts.read_bytes(scope["weightsBinding"])
        scaler = artifacts.read_bytes(scope["activePreprocessorBinding"])
        validation = artifacts.read_bytes(scope["validationBinding"])
        score = evaluate_predictor(weights, scaler, validation)
        scope[score_key] = score


def run(client, run_id, cache_dir, recording_path, runtime_dir=None):
    artifacts = MlflowArtifacts(client, cache_dir)
    refs = {name: artifacts.bind_artifact(run_id, path, format=FORMATS[name])
            for name, path in ARTIFACTS.items()}
    arguments = {} if runtime_dir is None else {"runtime_dir": runtime_dir}
    capture = WorkflowCapture(recording_path, **arguments)
    with capture:
        worker = {"command": list(capture.command), "pid": capture._process.pid}
        with capture.stage("retain-existing-artifacts") as scope:
            scope["weightsBinding"] = refs["weights"]
            scope["validationBinding"] = refs["validation"]
            scope["scaler1Binding"] = refs["s1"]
            scope["scaler2Binding"] = refs["s2"]
            scope["activePreprocessorBinding"] = scope["scaler1Binding"]
        evaluate(capture, artifacts, "evaluate-baseline", "baselineScore")
        failed_attempt = None
        try:
            with capture.stage("select-preprocessor", attempt=1) as scope:
                failed_attempt = scope.runtime_stage_id
                scope["activePreprocessorBinding"] = scope["scaler1Binding"]
                scope["uncommittedAttemptMarker"] = "must be discarded"
                raise RuntimeError("Injected first selection attempt failure")
        except RuntimeError as error:
            if str(error) != "Injected first selection attempt failure":
                raise
        with capture.stage("select-preprocessor", attempt=2, retry_of=failed_attempt) as scope:
            scope["activePreprocessorBinding"] = scope["scaler2Binding"]
        evaluate(capture, artifacts, "evaluate-faulty", "faultyScore")
        with capture.stage("restore-preprocessor") as scope:
            scope["activePreprocessorBinding"] = scope["scaler1Binding"]
        evaluate(capture, artifacts, "evaluate-corrected", "correctedScore")
        with capture.stage("record-results") as scope:
            outcome = {"schema": "footprint-python-adoption-evaluation/v1", "retryAttempts": 2,
                       "baselineScore": scope["baselineScore"], "faultyScore": scope["faultyScore"],
                       "correctedScore": scope["correctedScore"]}
            scope["outcome"] = outcome
    worker["exitCode"] = capture._process.returncode
    return outcome, worker
