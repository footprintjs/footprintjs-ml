"""Small numerical work stays in Python/NumPy, outside workflow scope."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

FORMAT = "footprint-ml-promotion/predictor-json/v1"
PROFILE = "footprint-ml-promotion/standardized-linear/v1"
METHOD = "synthetic-held-out-mse/v1"


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(content):
    return hashlib.sha256(content).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode(value))
    return path


def dataset():
    # Synthetic, deterministic observations; no downloaded data or test tuning.
    training_x = np.linspace(-2, 2, 32, dtype=np.float64)
    validation_x = np.linspace(-1.9, 1.9, 12, dtype=np.float64)
    return (training_x, 2 * training_x + 1 + .03 * np.sin(3 * training_x),
            validation_x, 2 * validation_x + 1 + .03 * np.sin(3 * validation_x))


def train(x, y, configuration):
    mean, scale = float(np.mean(x)), float(np.std(x))
    z = (x - mean) / scale
    if configuration["algorithm"] == "least-squares":
        coefficient, intercept = np.linalg.lstsq(np.column_stack((z, np.ones(len(z)))), y, rcond=None)[0]
    else:
        coefficient, intercept = 0., 0.
        for _ in range(configuration["steps"]):
            error = coefficient * z + intercept - y
            coefficient -= configuration["learningRate"] * float(2 * np.mean(error * z))
            intercept -= configuration["learningRate"] * float(2 * np.mean(error))
    # Every predictor dependency in this deliberately narrow profile is here.
    return {"schema": "footprint-ml-promotion-predictor/v1", "profile": PROFILE,
            "weights": {"coefficient": float(coefficient), "intercept": float(intercept)},
            "scaler": {"mean": mean, "scale": scale},
            "semantics": {"input": [{"name": "x", "dtype": "float64"}],
                          "output": [{"name": "y", "dtype": "float64"}],
                          "method": "standardized-linear/v1"}}


def predict(bundle, x):
    return ((x - bundle["scaler"]["mean"]) / bundle["scaler"]["scale"]
            * bundle["weights"]["coefficient"] + bundle["weights"]["intercept"])


class LiveModels:
    """Trusted example backend; verification measures its held predictor state."""
    def __init__(self, session):
        self.session = session
        self.models = {}
        self.observations = []

    def retain(self, handle, bundle, artifact):
        self.models[handle] = {"bundle": bundle, "artifact": artifact}
        return self.measure(handle)

    def measure(self, handle):
        record = self.models[handle]
        content = encode(record["bundle"])
        # Metadata identifies the actual held state, never the requested digest.
        artifact = {**record["artifact"], "sha256": digest(content), "bytes": len(content)}
        return {"kind": "model", "sessionId": self.session, "handle": handle,
                "originArtifact": artifact,
                "inferenceIdentity": {"kind": "inference-identity", "schemaVersion": 1,
                                      "profile": PROFILE, "sha256": digest(content)}}

    def verify(self, request):
        proposed = request["modelRef"]
        if proposed["sessionId"] != self.session:
            raise ValueError("The supplied model belongs to a different live session")
        observed = self.measure(proposed["handle"])
        self.observations.append({"requestedHandle": proposed["handle"], "observedModelRef": observed})
        return observed
