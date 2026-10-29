"""Ordinary Python evaluation over an existing MLflow run, without capture."""
from pathlib import Path
from existing_evaluator import evaluate_predictor

ARTIFACTS = {"weights": "model/weights.json", "s1": "preprocessing/s1.json",
             "s2": "preprocessing/s2.json", "validation": "data/validation.json"}


def run(client, run_id, cache_dir):
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=False)
    if client.get_run(run_id).info.run_id != run_id:
        raise ValueError("MLflow returned another run")
    paths = {name: Path(client.download_artifacts(run_id, artifact_path, dst_path=str(cache)))
             for name, artifact_path in ARTIFACTS.items()}

    def evaluate(preprocessor):
        return evaluate_predictor(paths["weights"].read_bytes(),
                                  paths[preprocessor].read_bytes(), paths["validation"].read_bytes())

    active_preprocessor = "s1"
    baseline_score = evaluate(active_preprocessor)
    try:
        active_preprocessor = "s1"
        raise RuntimeError("Injected first selection attempt failure")
    except RuntimeError as error:
        if str(error) != "Injected first selection attempt failure":
            raise
    active_preprocessor = "s2"
    faulty_score = evaluate(active_preprocessor)
    active_preprocessor = "s1"
    corrected_score = evaluate(active_preprocessor)
    return {"schema": "footprint-python-adoption-evaluation/v1", "retryAttempts": 2,
            "baselineScore": baseline_score, "faultyScore": faulty_score,
            "correctedScore": corrected_score}
