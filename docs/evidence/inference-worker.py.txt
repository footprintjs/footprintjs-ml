"""One long-lived, local numerical cache. It is not an inference service."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import sys
import time
import uuid

import numpy as np
import sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score

from numerical import (CONTRACT_PROFILE, DATA_FORMAT, MODEL_FORMAT, PROFILE, SCALER_FORMAT,
                       actual_state, contract, data_arrays, digest, encode, load_model,
                       load_scaler, model_document, scaler_state)

MAX_LINE = 262144


class Backend:
    def __init__(self, root, fixtures):
        self.root, self.fixtures = root, fixtures
        self.root.mkdir(parents=True, exist_ok=False)
        self.session = str(uuid.uuid4())
        self.models, self.origins, self.cache = {}, {}, None
        self.cache_generation = 0

    def store(self, relative, blob, format):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(blob)
        return {"kind": "artifact", "path": "backend/" + relative, "sha256": digest(blob), "bytes": len(blob), "format": format}

    def read(self, ref):
        path = PurePosixPath(ref["path"])
        if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "backend":
            raise ValueError("Invalid local backend artifact path")
        blob = (self.root.parent / Path(*path.parts)).read_bytes()
        if digest(blob) != ref["sha256"] or len(blob) != ref["bytes"]:
            raise ValueError("Actual backend artifact bytes differ from their reference")
        return blob

    def measure(self):
        if self.cache is None:
            raise ValueError("No model is cached")
        state = actual_state(self.models[self.cache], self.scaler)
        identity = {"kind": "inference-identity", "schemaVersion": 1, "profile": PROFILE, "sha256": digest(state)}
        model_ref = {"kind": "model", "sessionId": self.session, "handle": 1 if self.cache == "A" else 2,
                     "originArtifact": self.origins[self.cache], "inferenceIdentity": identity}
        return model_ref, state

    def initialize(self, plan):
        if self.models:
            raise ValueError("This numerical worker can initialize only once")
        if plan["modelBC"] != 0.0001 or plan["predictionRows"] != 64:
            raise ValueError("The proof fixes B's C and the first-64-row batch before evaluation")
        source_blob = (self.fixtures / "source.json").read_bytes()
        if digest(source_blob) != plan["fixtureManifestSha256"]:
            raise ValueError("Fixture source manifest changed")
        source = json.loads(source_blob)
        blobs = {}
        for name in ("model-A.json", "scaler-S1.json", "train.json", "validation.json"):
            blob = (self.fixtures / name).read_bytes()
            if digest(blob) != source["files"][name]["sha256"] or len(blob) != source["files"][name]["bytes"]:
                raise ValueError("Retained numerical fixture changed: " + name)
            blobs[name] = blob
        self.scaler = load_scaler(blobs["scaler-S1.json"])
        self.scaler_ref = self.store("scaler-S1.json", blobs["scaler-S1.json"], SCALER_FORMAT)
        self.origins["A"] = self.store("model-A.json", blobs["model-A.json"], MODEL_FORMAT)
        self.models["A"] = load_model(blobs["model-A.json"])
        train_x, train_y = data_arrays(blobs["train.json"])
        self.validation_x, self.validation_y = data_arrays(blobs["validation.json"])
        self.validation_ref = self.store("validation.json", blobs["validation.json"], DATA_FORMAT)
        # C was fixed before any B validation/prediction is observed. B uses the
        # same training rows and fitted S1, and is trained only once here.
        model_b = LogisticRegression(solver="lbfgs", C=0.0001, max_iter=1000).fit(self.scaler.transform(train_x), train_y)
        self.models["B"] = model_b
        self.origins["B"] = self.store("model-B.json", encode(model_document(model_b, digest(blobs["train.json"]),
                                      digest(blobs["scaler-S1.json"]), 0.0001)), MODEL_FORMAT)
        batch = {"schema": "footprint-ml/fixed-inference-input/v1", "featureOrder": list(range(64)),
                 "sourceValidation": self.validation_ref, "rowSelection": {"kind": "prefix", "start": 0, "rows": 64},
                 "x": {"dtype": "float64", "shape": [64, 64], "values": self.validation_x[:64].tolist()}}
        self.input_ref = self.store("input-first-64.json", encode(batch), "footprint-ml/fixed-inference-input/v1")
        self.cache = "A"
        a_ref, _ = self.measure()
        self.cache = "B"
        b_ref, _ = self.measure()
        if a_ref["inferenceIdentity"] == b_ref["inferenceIdentity"]:
            raise ValueError("The fixed model B did not produce distinct measured parameters")
        self.cache = None
        return {"modelARef": a_ref, "modelBRef": b_ref, "inputRef": self.input_ref, "rows": 64,
                "scalerRef": self.scaler_ref, "scalerStateSha256": digest(scaler_state(self.scaler)),
                "sourceManifestSha256": digest(source_blob), "workerPid": os.getpid(), "sessionId": self.session,
                "trainingCalls": 1, "fixedModelBC": 0.0001, "versions": {"numpy": np.__version__, "sklearn": sklearn.__version__}}

    def load_cache(self, model_ref):
        selected = next((label for label, ref in self.origins.items() if ref == model_ref["originArtifact"]), None)
        if selected is None:
            raise ValueError("Unknown source model artifact")
        self.read(self.origins[selected])  # Loading checks source bytes separately.
        self.cache = selected
        observed, _ = self.measure()
        if observed["inferenceIdentity"] != model_ref["inferenceIdentity"]:
            raise ValueError("The actual model no longer matches the cache-load intent")
        self.cache_generation += 1
        return {"modelRef": observed, "cacheGeneration": self.cache_generation, "workerPid": os.getpid(), "sessionId": self.session}

    def evaluate(self):
        before, _ = self.measure()
        prediction = self.models[self.cache].predict(self.scaler.transform(self.validation_x))
        after, _ = self.measure()
        if before != after:
            raise ValueError("Predictor state changed during evaluation")
        return {"modelRef": before, "datasetRef": {"kind": "dataset", "sessionId": self.session, "handle": 1,
                "artifact": self.validation_ref, "role": "validation", "rows": len(self.validation_x), "shape": list(self.validation_x.shape)},
                "preprocessingVersion": "standardscaler-state/sha256:" + digest(scaler_state(self.scaler)),
                "evaluationMethodVersion": "sklearn-accuracy/raw-heldout-digits/v1", "parameters": {},
                "metrics": {"accuracy": float(accuracy_score(self.validation_y, prediction))},
                "evaluationId": str(uuid.uuid4()), "createdAt": int(time.time() * 1000),
                "workerPid": os.getpid(), "sessionId": self.session}

    def predict(self, request):
        # Deliberate stale-cache failure: this API uses its current cached model.
        # It never receives or echoes the application's independently approved A.
        invocation = request["inferenceId"]
        if not isinstance(invocation, str) or not invocation or len(invocation) > 100 or not all(c.isalnum() or c == '-' for c in invocation):
            raise ValueError("Invalid inference invocation identifier")
        input_blob = self.read(request["inputRef"])
        batch = json.loads(input_blob)
        x = np.asarray(batch["x"]["values"], dtype=np.float64)
        if x.shape != (64, 64) or not np.isfinite(x).all():
            raise ValueError("The actual inference batch is not the fixed finite 64-row batch")
        order = list(reversed(range(64))) if request.get("reverseFields") is True else list(range(64))
        before, state = self.measure()
        labels = self.models[self.cache].predict(self.scaler.transform(x[:, order])).tolist()
        after, after_state = self.measure()
        if before != after or digest(state) != digest(after_state):
            raise ValueError("Actual predictor state changed while producing this output")
        state_ref = self.store("private/" + invocation + "-actual-state.json", encode({"before": state, "after": after_state}),
                               "footprint-ml/actual-inference-state-json/v1")
        output = {"schema": "footprint-ml/digit-prediction-output/v1", "inferenceId": invocation,
                  "inputSha256": digest(input_blob), "actualModelIdentity": before["inferenceIdentity"],
                  "actualFieldOrder": order, "labels": labels}
        output_ref = self.store("private/" + invocation + "-output.json", encode(output), "footprint-ml/digit-prediction-output/v1")
        return {"inferenceId": invocation, "createdAt": int(time.time() * 1000), "inputRef": request["inputRef"],
                "outputRef": output_ref, "inputRows": len(x), "outputRows": len(labels),
                "modelRef": before, "contract": contract(self.scaler, order),
                "observation": {"workerPid": os.getpid(), "sessionId": self.session, "cacheGeneration": self.cache_generation,
                                "beforeModelRef": before, "afterModelRef": after, "actualStateArtifact": state_ref,
                                "stateUnchangedDuringPrediction": True}}

    def compare_outputs(self, left, right):
        a, b = json.loads(self.read(left)), json.loads(self.read(right))
        if a["inputSha256"] != b["inputSha256"] or len(a["labels"]) != len(b["labels"]):
            raise ValueError("Cannot compare outputs from different inputs")
        return {"rows": len(a["labels"]), "differentLabels": sum(x != y for x, y in zip(a["labels"], b["labels"]))}


def serve(root, fixtures):
    backend = Backend(root, fixtures)
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            return
        if len(line) > MAX_LINE or not line.endswith(b"\n"):
            raise ValueError("Backend request exceeded its line limit")
        request = json.loads(line)
        try:
            command, payload = request["command"], request.get("input", {})
            if command == "initialize": result = backend.initialize(payload)
            elif command == "load_cache": result = backend.load_cache(payload["modelRef"])
            elif command == "evaluate": result = backend.evaluate()
            elif command == "predict": result = backend.predict(payload)
            elif command == "compare_outputs": result = backend.compare_outputs(payload["left"], payload["right"])
            elif command == "close": result = {"closed": True, "workerPid": os.getpid()}
            else: raise ValueError("Unknown numerical backend command")
            response = {"id": request["id"], "ok": True, "result": result}
        except Exception as error:
            response = {"id": request["id"], "ok": False, "error": {"type": type(error).__name__, "message": str(error)}}
        print(json.dumps(response, separators=(",", ":"), allow_nan=False), flush=True)
        if request["command"] == "close":
            return


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--fixtures", required=True)
    args = parser.parse_args()
    serve(Path(args.root), Path(args.fixtures))
