"""Safe numeric model loading and actual in-memory predictor measurement."""
import hashlib
import json

import numpy as np
import sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

MODEL_FORMAT = "footprint-ml/sklearn-logistic-numeric-json/v1"
SCALER_FORMAT = "footprint-ml/sklearn-standard-scaler-json/v1"
DATA_FORMAT = "footprint-ml/digits-split-json/v1"
PROFILE = "digits-logistic-standardscaler/actual-memory/v1"
CONTRACT_PROFILE = "digits-64-named-pixels-to-class-label/v1"


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else encode(value)).hexdigest()


def data_arrays(blob):
    doc = json.loads(blob)
    if doc["schema"] != DATA_FORMAT:
        raise ValueError("Unsupported retained digit dataset")
    x, y = np.asarray(doc["x"]["values"], dtype=np.float64), np.asarray(doc["y"]["values"], dtype=np.int64)
    if (x.ndim != 2 or x.shape[1] != 64 or y.shape != (len(x),) or not len(x)
            or not np.isfinite(x).all() or list(x.shape) != doc["x"]["shape"]):
        raise ValueError("Invalid retained digit arrays")
    return x, y


def load_model(blob):
    doc = json.loads(blob)
    if doc["schema"] != MODEL_FORMAT:
        raise ValueError("Unsupported safe classifier format")
    model = LogisticRegression(solver="lbfgs", C=float(doc["C"]), max_iter=1000)
    model.coef_, model.intercept_ = np.asarray(doc["coef"], dtype=np.float64), np.asarray(doc["intercept"], dtype=np.float64)
    model.classes_, model.n_features_in_ = np.asarray(doc["classes"], dtype=np.int64), int(doc["features"])
    if (model.coef_.shape != (10, 64) or model.intercept_.shape != (10,) or model.n_features_in_ != 64
            or not np.array_equal(model.classes_, np.arange(10)) or not np.isfinite(model.coef_).all()
            or not np.isfinite(model.intercept_).all()):
        raise ValueError("Invalid retained classifier state")
    return model


def load_scaler(blob):
    doc = json.loads(blob)
    if doc["schema"] != SCALER_FORMAT or doc["withMean"] is not True or doc["withStd"] is not True:
        raise ValueError("Unsupported safe scaler format")
    scaler = StandardScaler()
    scaler.mean_, scaler.scale_, scaler.var_ = (np.asarray(doc[key], dtype=np.float64) for key in ("mean", "scale", "variance"))
    scaler.n_features_in_, scaler.n_samples_seen_ = int(doc["features"]), int(doc["samplesSeen"])
    scaler_state(scaler)
    return scaler


def scaler_state(scaler):
    for array in (scaler.mean_, scaler.scale_, scaler.var_):
        if array.shape != (64,) or not np.isfinite(array).all():
            raise ValueError("Actual fitted scaler has invalid state")
    if np.any(scaler.scale_ <= 0) or np.any(scaler.var_ < 0):
        raise ValueError("Actual fitted scaler has invalid scales")
    return {"withMean": bool(scaler.with_mean), "withStd": bool(scaler.with_std),
            "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(), "variance": scaler.var_.tolist(),
            "features": int(scaler.n_features_in_)}


def actual_state(model, scaler):
    # These values are read from the objects that actually run transform/predict.
    # Neither a request's modelRef nor the original file digest supplies them.
    if not np.isfinite(model.coef_).all() or not np.isfinite(model.intercept_).all():
        raise ValueError("Actual classifier parameters became nonfinite")
    return {"profile": PROFILE, "classifier": {"coef": model.coef_.tolist(), "intercept": model.intercept_.tolist(),
                "classes": model.classes_.tolist(), "features": int(model.n_features_in_)},
            "preprocessing": scaler_state(scaler), "inputSemantics": "digits-8x8-row-major-64-features/v1",
            "implementation": {"sklearn": sklearn.__version__, "numpy": np.__version__}}


def contract(scaler, order):
    return {"profile": CONTRACT_PROFILE,
            "input": {"fields": [{"name": "pixel_" + str(index), "dtype": "float64", "unit": "intensity-0-to-16"} for index in order]},
            "output": {"fields": [{"name": "digit", "dtype": "int64"}]},
            "preprocessingVersion": "standardscaler-state/sha256:" + digest(scaler_state(scaler)),
            "classLabels": list(range(10)), "parameters": {"method": "ordered-class-argmax"}}


def model_document(model, train_hash, scaler_hash, c):
    return {"schema": MODEL_FORMAT, "sklearnVersion": sklearn.__version__, "C": c, "solver": "lbfgs",
            "trainingDataSha256": train_hash, "trainedWithScalerSha256": scaler_hash,
            "architecture": "64-input-10-class-linear-logits/v1", "coef": model.coef_.tolist(),
            "intercept": model.intercept_.tolist(), "classes": model.classes_.tolist(), "features": int(model.n_features_in_)}
