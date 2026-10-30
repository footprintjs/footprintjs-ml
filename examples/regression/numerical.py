"""Fixed synthetic population experiment; NumPy owns the numerical work."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

FORMAT = "footprint-ml-regression/linear-predictor-json/v1"
DATA_FORMAT = "footprint-ml-regression/rows-json/v1"
PROFILE = "footprint-ml-regression/raw-linear/v1"
PREPROCESSING = "raw-x-float64/v1"
METHOD = "predefined-population-mse/v1"


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(content):
    return hashlib.sha256(content).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode(value))
    return path


def generate(protocol, split):
    declared = protocol["splits"][split]
    rows = []
    for population in protocol["populations"]:
        grid = np.linspace(*declared["xRange"], protocol["gridPoints"], dtype=np.float64)
        repeat = declared["rows"][population] // len(grid)
        if repeat * len(grid) != declared["rows"][population]:
            raise ValueError("Rows must be a whole number of the independently declared grids")
        for index, x in enumerate(np.tile(grid, repeat)):
            rows.append({"rowId": f"{split}-{population}-{index:03}", "population": population,
                         "x": float(x), "y": float(protocol["slope"] * x + protocol["intercepts"][population])})
    return {"schema": "footprint-ml-regression-data/v1", "rows": rows}


def train(document, configuration):
    rows = document["rows"]
    design = np.asarray([[row["x"], 1.] for row in rows], dtype=np.float64)
    target = np.asarray([row["y"] for row in rows], dtype=np.float64)
    if configuration["weighting"] == "equal-population-mass":
        counts = {group: sum(row["population"] == group for row in rows) for group in {r["population"] for r in rows}}
        weights = np.sqrt(np.asarray([1. / counts[row["population"]] for row in rows], dtype=np.float64))
    elif configuration["weighting"] == "equal-row-mass":
        weights = np.ones(len(rows), dtype=np.float64)
    else:
        raise ValueError("Unsupported fixed weighting configuration")
    return np.linalg.lstsq(design * weights[:, None], target * weights, rcond=None)[0]


def bundle(weights):
    return {"schema": "footprint-ml-regression-predictor/v1", "profile": PROFILE,
            "weights": {"slope": float(weights[0]), "intercept": float(weights[1])},
            "semantics": {"input": [{"name": "x", "dtype": "float64"}],
                          "output": [{"name": "y", "dtype": "float64"}], "preprocessingVersion": PREPROCESSING}}


class LiveModels:
    def __init__(self, session):
        self.session, self.models, self.verifications = session, {}, []

    def retain(self, handle, weights, artifact):
        self.models[handle] = {"weights": np.array(weights, dtype=np.float64, copy=True), "artifact": artifact}
        return self.measure(handle)

    def measure(self, handle):
        record = self.models[handle]
        content = encode(bundle(record["weights"]))
        return {"kind": "model", "sessionId": self.session, "handle": handle,
                "originArtifact": {**record["artifact"], "sha256": digest(content), "bytes": len(content)},
                "inferenceIdentity": {"kind": "inference-identity", "schemaVersion": 1,
                                      "profile": PROFILE, "sha256": digest(content)}}

    def verify(self, request):
        proposed = request["modelRef"]
        if proposed["sessionId"] != self.session:
            raise ValueError("A different numerical session was requested")
        actual = self.measure(proposed["handle"])
        self.verifications.append(actual)
        return actual

    def evaluate(self, model_ref, document):
        if model_ref["sessionId"] != self.session:
            raise ValueError("A different numerical session was requested")
        weights = self.models[model_ref["handle"]]["weights"]
        x = np.asarray([row["x"] for row in document["rows"]], dtype=np.float64)
        y = np.asarray([row["y"] for row in document["rows"]], dtype=np.float64)
        prediction = x * weights[0] + weights[1]
        return self.measure(model_ref["handle"]), prediction.tolist(), float(np.mean((prediction-y) ** 2))
