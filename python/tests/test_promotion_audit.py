"""Synthetic saved-audit fixtures; no trainer, capture host or MLflow is run."""
from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "examples" / "mlflow-promotion" / "verify.py"
SPEC = importlib.util.spec_from_file_location("promotion_saved_audit", SOURCE)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def fixture(root):
    """Minimal internally consistent audit input, explicitly not a real run."""
    store = root / "release-store"
    store.mkdir()
    def artifact(value):
        content, format = encode(value), "synthetic-audit-json/v1"
        sha = hashlib.sha256(content).hexdigest()
        path = "sha256-" + sha + "-" + hashlib.sha256(format.encode()).hexdigest() + ".bin"
        (store / path).write_bytes(content)
        return {"kind": "artifact", "path": path, "sha256": sha, "bytes": len(content), "format": format}
    validation, training = {"x": [0., 1.], "y": [1., 3.]}, {"x": [-1., 2.], "y": [-1., 5.]}
    refs, models, numeric, results = {}, {}, {}, []
    for name, weight, predictions, mse in [("A", 2., [1., 3.], 0.), ("B", 1., [1., 2.], .5)]:
        bundle = {"schema": "footprint-ml-promotion-predictor/v1", "profile": audit.PROFILE,
                  "weights": {"coefficient": weight, "intercept": 1.}, "scaler": {"mean": 0., "scale": 1.},
                  "semantics": {"input": [{"name": "x", "dtype": "float64"}],
                                "output": [{"name": "y", "dtype": "float64"}], "method": "standardized-linear/v1"}}
        refs[name] = artifact(bundle)
        models[name] = {"kind": "model", "sessionId": "synthetic", "handle": len(models) + 1,
                       "originArtifact": refs[name],
                       "inferenceIdentity": {"kind": "inference-identity", "schemaVersion": 1,
                                             "profile": audit.PROFILE, "sha256": refs[name]["sha256"]}}
        numeric[name] = {"bundle": bundle, "artifact": refs[name], "predictions": predictions, "mse": mse}
        results.append({"candidateId": name, "modelRef": models[name], "evaluation": {"metrics": {"mse": mse}}})
    bindings = {"A": {"version": "1"}, "B": {"version": "2"}}
    outcome = {"checks": {"syntheticFixture": True}, "models": models, "bindings": bindings,
        "outcomes": {key: {} for key in ("wrong", "lostReply", "recovered", "uncertainFirst", "uncertainRetry", "occupied")},
        "mainCommittedReceipt": {"artifact": refs["A"], "registry": {"version": "1"}}}
    state = {"outcome": outcome, "datasetRef": {"artifact": artifact(validation), "rows": 2, "shape": [2, 1]},
        "trainingDatasetArtifact": artifact(training), "candidateResults": results,
        "wrongPublisherConfiguration": {"binding": bindings["B"]},
        "wrongDownloadedArtifactObservations": [{"sha256": refs["B"]["sha256"]}],
        "recoveredJournalObservation": {"entries": [{"status": "committed"}]},
        "uncertainRetryJournalObservation": {"entries": [{"status": "pending", "receipt": None}]}}
    docs = {"recording.json": {"schema": "synthetic-audit-fixture/v1", "snapshot": {"sharedState": state}},
            "outcome.json": outcome, "numerical-observations.json": {"training": training, "validation": validation, "models": numeric}}
    return docs


class SavedPromotionAuditTests(unittest.TestCase):
    def exercise(self, mutate=None, valid=False):
        with tempfile.TemporaryDirectory(prefix="promotion-audit-") as directory:
            root = Path(directory)
            documents = fixture(root)
            if mutate:
                mutate(documents)
            for name, value in documents.items():
                (root / name).write_bytes(encode(value))
            with contextlib.redirect_stdout(io.StringIO()):
                if valid:
                    self.assertTrue(audit.verify(root)["passed"])
                else:
                    with self.assertRaises((ValueError, RuntimeError)):
                        audit.verify(root)
                    self.assertFalse((root / "saved-verification.json").exists())

    def test_complete_bound_observations_pass_without_optional_dependencies(self):
        self.exercise(valid=True)

    def test_empty_truncated_or_extra_prediction_rows_are_rejected(self):
        for candidate in ("A", "B"):
            for predictions in ([], [1.], [1., 3., 5.]):
                with self.subTest(candidate=candidate, predictions=predictions):
                    self.exercise(lambda docs: docs["numerical-observations.json"]["models"][candidate].update(predictions=predictions))

    def test_mismatched_empty_or_rewritten_validation_sidecars_are_rejected(self):
        for validation in ({"x": [], "y": []}, {"x": [0., 1.], "y": [1.]},
                           {"x": [9., 1.], "y": [1., 3.]}, {"x": [0., 1.], "y": [2., 4.]}):
            with self.subTest(validation=validation):
                self.exercise(lambda docs: docs["numerical-observations.json"].update(validation=validation))

    def test_recorded_row_counts_must_be_positive_and_match_shape_and_artifact(self):
        for rows, shape in [(0, [0, 1]), (3, [3, 1]), (True, [True, 1]), (2, [2, 2])]:
            with self.subTest(rows=rows, shape=shape):
                self.exercise(lambda docs: docs["recording.json"]["snapshot"]["sharedState"]["datasetRef"].update(rows=rows, shape=shape))

    def test_nonfinite_or_boolean_observations_cannot_pass(self):
        for field, value in [("predictions", [float("nan"), 3.]), ("predictions", [float("inf"), 3.]),
                             ("predictions", [True, 3.]), ("mse", float("nan")), ("mse", True)]:
            with self.subTest(field=field, value=value):
                self.exercise(lambda docs: docs["numerical-observations.json"]["models"]["A"].update({field: value}))

    def test_sidecar_mse_must_agree_with_receipt_and_actual_scalar_error(self):
        self.exercise(lambda docs: docs["numerical-observations.json"]["models"]["A"].update(mse=.5))

    def test_bundle_reference_must_match_the_recorded_candidate(self):
        def substitute(docs):
            models = docs["numerical-observations.json"]["models"]
            models["A"]["artifact"] = copy.deepcopy(models["B"]["artifact"])
        self.exercise(substitute)


if __name__ == "__main__":
    unittest.main()
