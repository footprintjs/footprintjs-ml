"""Numerical example code, deliberately outside the stdlib capture library.

Only finite numeric JSON is serialized. No pickle, joblib or executable model
loader is used. Prediction objects are reconstructed from the bytes measured at
the evaluation boundary.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

MODEL_FORMAT = "footprint-ml/sklearn-logistic-numeric-json/v1"
SCALER_FORMAT = "footprint-ml/sklearn-standard-scaler-json/v1"
DATA_FORMAT = "footprint-ml/digits-split-json/v1"
PREDICTION_PROFILE = "digits-standard-scaler-logistic/sklearn-predict/v1"
EVALUATION_METHOD = "sklearn-accuracy/raw-heldout-digits/v1"


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else encode(value)).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(encode(value))
    return path


def data_document(x, y, role):
    return {"schema": DATA_FORMAT, "role": role, "featureOrder": "digits-8x8-row-major/v1",
            "x": {"dtype": "float64", "shape": list(x.shape), "values": np.asarray(x, dtype=np.float64).tolist()},
            "y": {"dtype": "int64", "shape": list(y.shape), "values": np.asarray(y, dtype=np.int64).tolist()}}


def read_data(blob):
    value = json.loads(blob)
    if value["schema"] != DATA_FORMAT:
        raise ValueError("Wrong dataset format")
    x = np.asarray(value["x"]["values"], dtype=np.float64)
    y = np.asarray(value["y"]["values"], dtype=np.int64)
    if (list(x.shape) != value["x"]["shape"] or list(y.shape) != value["y"]["shape"]
            or x.ndim != 2 or x.shape[1] != 64 or y.shape != (len(x),) or not np.isfinite(x).all()):
        raise ValueError("Invalid digit dataset shape or values")
    return x, y


def scaler_document(scaler, fit_data_sha256, label):
    return {"schema": SCALER_FORMAT, "label": label, "fitDataSha256": fit_data_sha256,
            "sklearnVersion": sklearn.__version__, "withMean": scaler.with_mean, "withStd": scaler.with_std,
            "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(), "variance": scaler.var_.tolist(),
            "features": int(scaler.n_features_in_), "samplesSeen": int(scaler.n_samples_seen_)}


def read_scaler(blob):
    value = json.loads(blob)
    if value["schema"] != SCALER_FORMAT or value["features"] != 64:
        raise ValueError("Wrong scaler format or feature count")
    scaler = StandardScaler(with_mean=value["withMean"], with_std=value["withStd"])
    scaler.mean_ = np.asarray(value["mean"], dtype=np.float64)
    scaler.scale_ = np.asarray(value["scale"], dtype=np.float64)
    scaler.var_ = np.asarray(value["variance"], dtype=np.float64)
    scaler.n_features_in_ = value["features"]
    scaler.n_samples_seen_ = value["samplesSeen"]
    if any(array.shape != (64,) or not np.isfinite(array).all() for array in (scaler.mean_, scaler.scale_, scaler.var_)):
        raise ValueError("Invalid fitted scaler arrays")
    if np.any(scaler.scale_ <= 0) or np.any(scaler.var_ < 0):
        raise ValueError("Invalid scaler scale or variance")
    return scaler


def model_document(model, training_data_sha256, scaler_sha256):
    return {"schema": MODEL_FORMAT, "sklearnVersion": sklearn.__version__,
            "trainingDataSha256": training_data_sha256, "trainedWithScalerSha256": scaler_sha256,
            "architecture": "64-input-10-class-linear-logits/v1", "solver": "lbfgs", "C": 1.0,
            "coef": model.coef_.tolist(), "intercept": model.intercept_.tolist(),
            "classes": model.classes_.tolist(), "features": int(model.n_features_in_)}


def read_model(blob):
    value = json.loads(blob)
    if value["schema"] != MODEL_FORMAT or value["features"] != 64:
        raise ValueError("Wrong model format or feature count")
    model = LogisticRegression(solver="lbfgs", C=1.0, max_iter=1000)
    model.coef_ = np.asarray(value["coef"], dtype=np.float64)
    model.intercept_ = np.asarray(value["intercept"], dtype=np.float64)
    model.classes_ = np.asarray(value["classes"], dtype=np.int64)
    model.n_features_in_ = value["features"]
    if (model.coef_.shape != (10, 64) or model.intercept_.shape != (10,)
            or not np.array_equal(model.classes_, np.arange(10))
            or not np.isfinite(model.coef_).all() or not np.isfinite(model.intercept_).all()):
        raise ValueError("Invalid classifier arrays")
    return model


def predictor_identity(weights_sha256, scaler_sha256):
    specification = {"profile": PREDICTION_PROFILE, "weightsArtifactSha256": weights_sha256,
                     "fittedScalerArtifactSha256": scaler_sha256,
                     "featureOrder": "digits-8x8-row-major/v1", "classes": list(range(10)),
                     "inferenceMethod": "sklearn.LogisticRegression.predict(StandardScaler.transform(raw_pixels))",
                     "sklearnVersion": sklearn.__version__, "numpyVersion": np.__version__}
    return {"kind": "inference-identity", "schemaVersion": 1,
            "profile": PREDICTION_PROFILE, "sha256": digest(specification)}, specification
