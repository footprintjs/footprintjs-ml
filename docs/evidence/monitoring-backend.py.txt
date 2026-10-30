"""One held linear model, closed input windows, and actual keyed label joins."""
from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path
import uuid

import numpy as np

FORMAT = "footprint-ml-monitoring/linear-json/v1"
PROFILE = "footprint-ml-monitoring/raw-linear/v1"
JOIN_MODE = "row-id-window-time/v1"
PREPROCESSING = "raw-x-float64/v1"
METHOD = "joined-label-mse/v1"


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(content):
    return hashlib.sha256(content).hexdigest()


def write_json(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode(value)); return path


def require(condition, message):
    if not condition: raise ValueError(message)


def finite(value):
    require(type(value) in (int, float) and math.isfinite(value), "A finite non-boolean number is required")
    return value


def fit(document):
    rows = document["rows"]
    return np.linalg.lstsq(np.asarray([[r["x"], 1.] for r in rows], dtype=np.float64),
                           np.asarray([r["y"] for r in rows], dtype=np.float64), rcond=None)[0]


def predictor(weights, contract):
    return {"schema": "footprint-ml-monitoring-predictor/v1", "profile": PROFILE,
            "weights": {"slope": float(weights[0]), "intercept": float(weights[1])}, "contract": copy.deepcopy(contract)}


class Backend:
    def __init__(self):
        self.session = "monitoring-backend-" + uuid.uuid4().hex
        self.models, self.verifications = {}, []

    def retain(self, weights, contract, artifact):
        handle = len(self.models) + 1
        self.models[handle] = {"weights": np.array(weights, dtype=np.float64, copy=True), "contract": copy.deepcopy(contract), "artifact": artifact}
        return self.measure(handle)

    def load(self, content, artifact):
        require(len(content) == artifact["bytes"] and digest(content) == artifact["sha256"], "Published artifact bytes differ")
        document = json.loads(content)
        require(document["schema"] == "footprint-ml-monitoring-predictor/v1" and document["profile"] == PROFILE, "Unsupported published predictor")
        weights = [finite(document["weights"][key]) for key in ("slope", "intercept")]
        actual = self.retain(weights, document["contract"], artifact)
        require(actual["originArtifact"]["sha256"] == artifact["sha256"], "Restored predictor does not serialize to the published bytes")
        return actual

    def measure(self, handle):
        held = self.models[handle]
        content = encode(predictor(held["weights"], held["contract"]))
        return {"kind": "model", "sessionId": self.session, "handle": handle,
                "originArtifact": {**held["artifact"], "sha256": digest(content), "bytes": len(content)},
                "inferenceIdentity": {"kind": "inference-identity", "schemaVersion": 1, "profile": PROFILE, "sha256": digest(content)}}

    def verify(self, request):
        actual = self.actual(request["modelRef"])
        self.verifications.append(actual)
        return actual

    def actual(self, model):
        require(model["sessionId"] == self.session and model["handle"] in self.models, "Unknown numerical session/handle")
        return self.measure(model["handle"])

    def predict(self, model, document):
        actual = self.actual(model)
        held = self.models[actual["handle"]]
        data = document["rows"]
        require(len(data) > 0, "The input window must be nonempty")
        ids = [row["rowId"] for row in data]
        require(len(ids) == len(set(ids)), "Input row IDs must be unique")
        for row in data:
            require(document["window"]["startAt"] <= row["eventTime"] < document["window"]["endAt"], "Input row outside its declared window")
        values = np.asarray([finite(row["x"]) for row in data], dtype=np.float64)
        predicted = values * held["weights"][0] + held["weights"][1]
        return {"schema": "footprint-ml-monitoring-predictions/v1", "modelRef": actual, "contract": copy.deepcopy(held["contract"]),
            "window": copy.deepcopy(document["window"]), "rows": [{"rowId": row["rowId"], "eventTime": row["eventTime"],
                "prediction": float(value)} for row,value in zip(data, predicted)]}


def joined(predictions, labels):
    """Measure matching facts. Invalid mappings are reported, never repaired."""
    source = predictions["rows"]
    require(len(source) > 0, "Predictions must be nonempty")
    actual_window = predictions["window"]
    ids = [row["rowId"] for row in source]
    require(len(ids) == len(set(ids)), "Duplicate prediction IDs")
    incoming = [] if labels is None else labels["rows"]
    keys = [(row["rowId"], row["eventTime"]) for row in incoming]
    seen, duplicates = set(), 0
    for key in keys:
        if key in seen: duplicates += 1
        seen.add(key)
    predicted = {(row["rowId"], row["eventTime"]): row for row in source}
    matched, unmatched, cross = [], 0, 0
    for row in incoming:
        finite(row["label"])
        belongs = labels["window"] == actual_window and actual_window["startAt"] <= row["eventTime"] < actual_window["endAt"]
        if not belongs: cross += 1
        if (row["rowId"], row["eventTime"]) not in predicted: unmatched += 1
    valid = duplicates == unmatched == cross == 0
    if valid:
        # Keyed join is intentionally insensitive to incoming label order.
        label_map = {(r["rowId"], r["eventTime"]): r for r in incoming}
        matched = [{"rowId": r["rowId"], "eventTime": r["eventTime"], "prediction": r["prediction"],
                    "label": label_map[(r["rowId"], r["eventTime"])]["label"]}
                   for r in source if (r["rowId"], r["eventTime"]) in label_map]
    mse = float(np.mean([(r["prediction"]-r["label"])**2 for r in matched])) if matched else None
    return {"schema": "footprint-ml-monitoring-joined-rows/v1", "window": copy.deepcopy(actual_window), "rows": matched,
            "facts": {"mode": JOIN_MODE, "predictionRows": len(source), "labelRows": len(incoming), "matchedRows": len(matched),
                      "unmatchedRows": unmatched, "duplicateRows": duplicates, "crossWindowRows": cross}, "mse": mse}
