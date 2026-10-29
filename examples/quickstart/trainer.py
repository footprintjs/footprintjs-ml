"""A small numerical trainer behind the FootPrint ML plugin boundary.

Fit y = weight * x + bias with deterministic full-batch gradient descent.
Models, datasets and gradient arrays stay in Python. The SDK worker returns refs.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path
import sys

import numpy as np


def _integer(value, name, minimum=0, maximum=10_000):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer in [{minimum}, {maximum}]")
    return value


def _keys(value, allowed, name):
    if type(value) is not dict or set(value) - set(allowed):
        raise ValueError(f"{name} accepts only {', '.join(sorted(allowed))}")


class LinearTrainer:
    profile = "footprintjs-ml/quickstart-linear-inference/v1"

    def __init__(self, config):
        _keys(config, {"seed", "learningRate", "trainRows", "validationRows"}, "config")
        rate = config.get("learningRate", 0.2)
        if type(rate) not in (int, float) or not math.isfinite(rate) or not 0 < rate <= 0.5:
            raise ValueError("learningRate must be finite, greater than zero and at most 0.5")
        self.config = {
            "seed": _integer(config.get("seed", 2026), "seed", 0, 2**32 - 2),
            "learningRate": float(rate),
            "trainRows": _integer(config.get("trainRows", 32), "trainRows", 2, 1024),
            "validationRows": _integer(config.get("validationRows", 16), "validationRows", 2, 1024),
        }
        self.datasets = {}
        # Separate seeded generators produce distinct train/validation examples.
        for offset, role in enumerate(("train", "validation")):
            rows = self.config[role + "Rows"]
            x = np.random.default_rng(self.config["seed"] + offset).uniform(-1.0, 1.0, (rows, 1))
            self.datasets[role] = {"x": x, "y": 2.0 * x + 1.0}
        self.contract = {
            "architecture": "one-feature-affine/v1",
            "inputSchema": {"dtype": "float64", "shape": ["rows", 1]},
            "outputSchema": {"dtype": "float64", "shape": ["rows", 1]},
            "preprocessing": "identity/no-fitted-state/v1",
            "inferenceCode": "numpy-multiply-add/v1",
            "pluginSourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "dependencies": {"numpy": np.__version__, "python": f"{sys.version_info.major}.{sys.version_info.minor}"},
        }
        data = self.datasets["train"]
        fingerprint = hashlib.sha256()
        for name in ("x", "y"):
            array = np.asarray(data[name], dtype="<f8", order="C")
            fingerprint.update(json.dumps({"name": name, "dtype": "<f8", "shape": list(array.shape)}, sort_keys=True).encode())
            fingerprint.update(array.tobytes(order="C"))
        self.training_data_sha256 = fingerprint.hexdigest()

    def initialize(self):
        return {
            "datasets": {
                role: {"arrays": {name: value.copy() for name, value in arrays.items()},
                       "rows": len(arrays["x"]), "shape": list(arrays["x"].shape),
                       "metadata": {"fixture": "independent-seeded-affine/v1", "role": role}}
                for role, arrays in self.datasets.items()
            },
            "metadata": {"preprocessingVersion": "identity/v1", "evaluationMethodVersion": "mse/v1"},
        }

    def _check_state(self, state):
        if type(state) is not dict or set(state) != {"weight", "bias", "steps"}:
            raise ValueError("state must contain weight, bias and steps")
        _integer(state["steps"], "state.steps", 0, 2**53 - 1)
        for name in ("weight", "bias"):
            array = state[name]
            if not isinstance(array, np.ndarray) or array.shape != (1,) or array.dtype != np.dtype("float64") or not np.isfinite(array).all():
                raise ValueError(f"state.{name} must be one finite float64 value")

    def train(self, request, source):
        _keys(request, {"steps"}, "train request")
        steps = _integer(request.get("steps", 20), "steps", 1, 10_000)
        state = {"weight": np.zeros(1, dtype="float64"), "bias": np.zeros(1, dtype="float64"), "steps": 0} if source is None else self.restore(self.snapshot(source))
        if state["steps"] + steps > 2**53 - 1:
            raise ValueError("total training steps exceed the supported integer range")
        x, y = self.datasets["train"]["x"], self.datasets["train"]["y"]
        for _ in range(steps):
            residual = x * state["weight"][0] + state["bias"][0] - y
            # For mean((prediction - target)^2), these are its two derivatives.
            gradient_weight = 2.0 * float(np.mean(residual * x))
            gradient_bias = 2.0 * float(np.mean(residual))
            state["weight"][0] -= self.config["learningRate"] * gradient_weight
            state["bias"][0] -= self.config["learningRate"] * gradient_bias
            state["steps"] += 1
        self._check_state(state)
        return state

    def evaluate(self, state, dataset_arrays, parameters):
        self._check_state(state)
        _keys(parameters, set(), "evaluation parameters")
        _keys(dataset_arrays, {"x", "y"}, "dataset arrays")
        if set(dataset_arrays) != {"x", "y"}:
            raise ValueError("dataset must contain x and y")
        x, y = dataset_arrays["x"], dataset_arrays["y"]
        if (not isinstance(x, np.ndarray) or not isinstance(y, np.ndarray)
                or x.ndim != 2 or x.shape[1:] != (1,) or x.shape != y.shape or len(x) == 0
                or x.dtype != np.dtype("float64") or y.dtype != np.dtype("float64")
                or not np.isfinite(x).all() or not np.isfinite(y).all()):
            raise ValueError("evaluation needs matching nonempty finite float64 [rows, 1] arrays")
        residual = x * state["weight"][0] + state["bias"][0] - y
        return {"mse": float(np.mean(residual * residual))}

    def snapshot(self, state):
        self._check_state(state)
        return {
            "arrays": {name: state[name].copy() for name in ("weight", "bias")},
            "metadata": {"steps": state["steps"], "config": copy.deepcopy(self.config),
                         "trainingDataSha256": self.training_data_sha256,
                         "contract": copy.deepcopy(self.contract)},
        }

    def restore(self, snapshot):
        _keys(snapshot, {"arrays", "metadata"}, "snapshot")
        if set(snapshot) != {"arrays", "metadata"} or type(snapshot["metadata"]) is not dict:
            raise ValueError("snapshot needs arrays and metadata")
        arrays, metadata = snapshot["arrays"], snapshot["metadata"]
        if type(arrays) is not dict or set(arrays) != {"weight", "bias"} or set(metadata) != {"steps", "config", "trainingDataSha256", "contract"}:
            raise ValueError("snapshot fields do not match this trainer")
        if metadata["config"] != self.config or metadata["trainingDataSha256"] != self.training_data_sha256 or metadata["contract"] != self.contract:
            raise ValueError("snapshot configuration, data or inference contract is incompatible")
        state = {name: arrays[name].copy() for name in ("weight", "bias")}
        state["steps"] = metadata["steps"]
        self._check_state(state)
        return state

    def inference(self, state):
        self._check_state(state)
        return {"arrays": {name: state[name].copy() for name in ("weight", "bias")},
                "metadata": copy.deepcopy(self.contract)}

    def model_metadata(self, state):
        self._check_state(state)
        return {"steps": state["steps"]}


def create_plugin(config):
    return LinearTrainer(config)
