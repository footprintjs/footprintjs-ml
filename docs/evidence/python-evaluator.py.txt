"""Scope-free evaluator extracted from the retained MLflow example.

Both pilot drivers call this same function. It imports no FootPrint code and
performs no training, MLflow writes, selection or workflow recording.
"""
from __future__ import annotations

import hashlib
from sklearn.metrics import accuracy_score
from numerical import read_data, read_model, read_scaler, predictor_identity


def evaluate_predictor(weights_bytes, scaler_bytes, validation_bytes):
    model = read_model(weights_bytes)
    scaler = read_scaler(scaler_bytes)
    x, y = read_data(validation_bytes)
    prediction = model.predict(scaler.transform(x))
    accuracy = float(accuracy_score(y, prediction))
    weights_sha, scaler_sha, validation_sha = (
        hashlib.sha256(value).hexdigest()
        for value in (weights_bytes, scaler_bytes, validation_bytes)
    )
    identity, _ = predictor_identity(weights_sha, scaler_sha)
    return {"accuracy": accuracy, "modelWeightsSha256": weights_sha,
            "preprocessorSha256": scaler_sha, "rawValidationSha256": validation_sha,
            "inferenceIdentity": identity}
