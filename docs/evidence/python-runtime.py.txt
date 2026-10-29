"""Registry, persistence and identity checks shared by numerical trainer plugins."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import re
import sys
from typing import Any
from uuid import uuid4
import zipfile
import numpy as np

from .identity import (MAX_TOTAL_BYTES, canonical_json, inference_identity, json_copy,
                       json_object, normalize_snapshot, normalized_arrays, snapshot_manifest,
                       snapshot_sha256)

CHECKPOINT_FORMAT = "footprint-ml-adapter-kit/trainstate-npz-v1"
DATASET_FORMAT = "footprint-ml-adapter-kit/dataset-npz-v1"
MAX_ARCHIVE_BYTES = MAX_TOTAL_BYTES + 4 * 1024 * 1024


class ContractError(ValueError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


def _text(value: Any, label: str) -> str:
    if type(value) is not str or not value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value


def _integer(value: Any, label: str, minimum: int = 1) -> int:
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise ValueError(f"{label} must be a safe integer >= {minimum}")
    return value


def _artifact_identity(value: Any) -> tuple[str, int, str]:
    if type(value) is not dict or value.get("kind") != "artifact":
        raise ValueError("Expected an ArtifactRef")
    digest = value.get("sha256")
    if type(digest) is not str or re.fullmatch(r"[a-fA-F0-9]{64}", digest) is None:
        raise ValueError("artifact.sha256 must be a SHA-256 hex digest")
    return digest.lower(), _integer(value.get("bytes"), "artifact.bytes", 0), _text(value.get("format"), "artifact.format")


def _same_inference(left: Any, right: Any) -> bool:
    if type(left) is not dict or type(right) is not dict:
        return False
    return (left.get("kind") == right.get("kind") == "inference-identity"
            and left.get("schemaVersion") == right.get("schemaVersion") == 1
            and type(left.get("sha256")) is str and type(right.get("sha256")) is str
            and left["sha256"].lower() == right["sha256"].lower()
            and left.get("profile") == right.get("profile"))


def serialize_snapshot(snapshot: Any, envelope: dict[str, Any]) -> bytes:
    """Safe NPZ: generated array keys plus one uint8 JSON metadata envelope."""
    value = normalize_snapshot(snapshot)
    document = json_object(envelope, "envelope")
    if "snapshot" in document:
        raise ValueError("The serializer owns the snapshot envelope field")
    descriptors = []
    arrays = {}
    for index, (name, array) in enumerate(value["arrays"].items()):
        key = f"array_{index:05d}"
        descriptors.append({"name": name, "key": key, "dtype": array.dtype.str, "shape": list(array.shape)})
        arrays[key] = array
    document["snapshot"] = {"metadata": value["metadata"], "arrays": descriptors}
    encoded = canonical_json(document)
    if len(encoded) > 2 * 1024 * 1024:
        raise ValueError("Snapshot JSON envelope exceeds the supported size")
    output = io.BytesIO()
    np.savez(output, metadata=np.frombuffer(encoded, dtype=np.uint8), **arrays)
    data = output.getvalue()
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("Serialized snapshot exceeds the supported size")
    return data


def deserialize_snapshot(data: bytes) -> tuple[dict[str, Any], dict[str, Any]]:
    """Decode the caller's already-read buffer; never enable pickle loading."""
    if type(data) is not bytes or len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("Snapshot byte buffer is invalid or exceeds the supported size")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (len(names) != len(set(names)) or "metadata.npy" not in names or len(names) > 10001
                or any(re.fullmatch(r"(?:metadata|array_\d{5})\.npy", name) is None for name in names)
                or sum(entry.file_size for entry in entries) > MAX_ARCHIVE_BYTES):
            raise ValueError("NPZ archive contains unsupported entries or size")
        # Validate header declarations before NumPy can allocate from them.
        for entry in entries:
            with archive.open(entry) as stream:
                version = np.lib.format.read_magic(stream)
                if version == (1, 0):
                    shape, _, dtype = np.lib.format.read_array_header_1_0(stream)
                elif version == (2, 0):
                    shape, _, dtype = np.lib.format.read_array_header_2_0(stream)
                else:
                    raise ValueError("Unsupported NPY header version")
                count = math.prod(shape)
                size = count * dtype.itemsize
                if (dtype.hasobject or dtype.fields is not None or dtype.kind not in "biufc"
                        or len(shape) > 16 or size > MAX_TOTAL_BYTES
                        or stream.tell() + size != entry.file_size):
                    raise ValueError("NPY header declares an unsupported dtype, shape or size")
                if entry.filename == "metadata.npy" and (dtype != np.uint8 or len(shape) != 1 or size > 2 * 1024 * 1024):
                    raise ValueError("Snapshot metadata header is invalid")
    with np.load(io.BytesIO(data), allow_pickle=False) as archive:
        encoded = archive["metadata"]
        if encoded.dtype != np.uint8 or encoded.ndim != 1 or encoded.nbytes > 2 * 1024 * 1024:
            raise ValueError("Snapshot envelope must be a bounded uint8 JSON vector")
        document = json_object(json.loads(encoded.tobytes().decode("utf-8")), "envelope")
        description = document.pop("snapshot", None)
        if type(description) is not dict or set(description) != {"arrays", "metadata"} or type(description["arrays"]) is not list:
            raise ValueError("Snapshot descriptors are missing or malformed")
        arrays = {}
        expected = {"metadata"}
        for index, descriptor in enumerate(description["arrays"]):
            if type(descriptor) is not dict or set(descriptor) != {"name", "key", "dtype", "shape"}:
                raise ValueError("Malformed snapshot array descriptor")
            name, key = descriptor["name"], descriptor["key"]
            if type(name) is not str or not name or name in arrays or key != f"array_{index:05d}":
                raise ValueError("Snapshot array names or generated keys are invalid")
            if key not in archive.files:
                raise ValueError("Snapshot array is missing from NPZ")
            array = np.array(archive[key], copy=True)
            if array.dtype.str != descriptor["dtype"] or list(array.shape) != descriptor["shape"]:
                raise ValueError("Snapshot array dtype or shape disagrees with its descriptor")
            arrays[name] = array
            expected.add(key)
        if set(archive.files) != expected:
            raise ValueError("NPZ has arrays absent from its snapshot manifest")
    return normalize_snapshot({"arrays": arrays, "metadata": description["metadata"]}), document


class AdapterRuntime:
    """One session and registry; never sends arrays across the JSON boundary."""
    def __init__(self) -> None:
        self.root: Path | None = None
        self.plugin: Any = None
        self.plugin_path: Path | None = None
        self.plugin_sha = ""
        self.profile = ""
        self.config: dict[str, Any] = {}
        self.metadata: dict[str, Any] = {}
        self.session_id = str(uuid4())
        self._next_handle = 1
        self._models: dict[int, dict[str, Any]] = {}
        self._datasets: dict[str, dict[str, Any]] = {}
        self._initialized = False
        self._closed = False

    def _ready(self) -> None:
        if not self._initialized or self._closed or self.root is None or self.plugin is None:
            raise ContractError("not-initialized", "Initialize the adapter runtime first")

    def _handle(self) -> int:
        handle = self._next_handle
        self._next_handle += 1
        return handle

    def _file(self, relative: Any) -> Path:
        if self.root is None or self.plugin is None:
            raise ContractError("not-initialized", "Initialize the adapter runtime first")
        path = Path(_text(relative, "artifact.path"))
        if path.is_absolute():
            raise ValueError("Artifact paths must be relative to the run root")
        file = (self.root / path).resolve()
        try:
            file.relative_to(self.root)
        except ValueError as error:
            raise ValueError("Artifact path escapes the run root") from error
        return file

    def _artifact(self, file: Path, data: bytes, format_name: str) -> dict[str, Any]:
        return {"kind": "artifact", "path": file.relative_to(self.root).as_posix(),
                "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "format": format_name}

    def _write(self, relative: str, data: bytes, format_name: str) -> dict[str, Any]:
        file = self._file(relative)
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary = file.with_name(file.name + "." + uuid4().hex + ".tmp")
        try:
            temporary.write_bytes(data)
            temporary.replace(file)
        finally:
            temporary.unlink(missing_ok=True)
        return self._artifact(file, data, format_name)

    def _load_plugin(self, path: Path, config: dict[str, Any], source: bytes) -> Any:
        if str(path.parent) not in sys.path:
            sys.path.insert(0, str(path.parent))
        specification = importlib.util.spec_from_file_location("footprint_ml_plugin_" + uuid4().hex, path)
        if specification is None or specification.loader is None:
            raise ValueError("Unable to import plugin file")
        module = importlib.util.module_from_spec(specification)
        sys.modules[specification.name] = module
        # Compile exactly the bytes whose SHA is reported, rather than rereading
        # a possibly replaced file through the import loader.
        exec(compile(source, str(path), "exec"), module.__dict__)
        factory = getattr(module, "create_plugin", None)
        if not callable(factory):
            raise ValueError("Plugin must export create_plugin(config)")
        plugin = factory(json_copy(config))
        for name in ("initialize", "train", "evaluate", "snapshot", "restore", "inference"):
            if not callable(getattr(plugin, name, None)):
                raise ValueError(f"Plugin must implement {name}")
        _text(getattr(plugin, "profile", None), "plugin.profile")
        return plugin

    def initialize(self, request: dict[str, Any]) -> dict[str, Any]:
        if self._initialized or self._closed:
            raise ContractError("already-initialized", "A runtime process can initialize only once")
        args = json_object(request, "initialize arguments")
        path = Path(_text(args.get("pluginPath"), "pluginPath")).expanduser().resolve()
        if not path.is_file():
            raise ValueError("pluginPath must name a Python file")
        config = json_object(args.get("config", {}), "config")
        source = path.read_bytes()
        plugin = self._load_plugin(path, config, source)
        initialized = plugin.initialize()
        if type(initialized) is not dict or set(initialized) != {"datasets", "metadata"}:
            raise ValueError("Plugin initialize must return datasets and metadata")
        metadata = json_object(initialized["metadata"], "plugin metadata")
        _text(metadata.get("preprocessingVersion"), "preprocessingVersion")
        _text(metadata.get("evaluationMethodVersion"), "evaluationMethodVersion")
        if type(initialized["datasets"]) is not dict or not initialized["datasets"]:
            raise ValueError("Plugin initialize must return named datasets")
        root = Path(_text(args.get("root"), "root")).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        self.root, self.plugin, self.plugin_path = root, plugin, path
        self.plugin_sha = hashlib.sha256(source).hexdigest()
        self.profile, self.config, self.metadata = plugin.profile, config, metadata
        self.session_id, self._next_handle = str(uuid4()), 1
        self._models.clear()
        self._datasets.clear()
        for index, role in enumerate(sorted(initialized["datasets"])):
            _text(role, "dataset role")
            definition = initialized["datasets"][role]
            if type(definition) is not dict:
                raise ValueError("Dataset definition must be a dictionary")
            arrays = normalized_arrays(definition.get("arrays"))
            rows = _integer(definition.get("rows"), "dataset.rows")
            shape = definition.get("shape")
            if type(shape) is not list or not shape or shape[0] != rows:
                raise ValueError("Dataset shape must start with its row count")
            for dimension in shape:
                _integer(dimension, "dataset.shape dimension")
            if not arrays or any(array.ndim == 0 or array.shape[0] != rows for array in arrays.values()):
                raise ValueError("Every dataset array must have the declared row count")
            if not any(list(array.shape) == shape for array in arrays.values()):
                raise ValueError("Declared dataset shape must match one dataset array")
            dataset_metadata = json_object(definition.get("metadata", {}), "dataset.metadata")
            snapshot = {"arrays": arrays, "metadata": dataset_metadata}
            envelope = {"kind": "footprint-ml-adapter-kit-dataset", "schemaVersion": 1,
                        "format": DATASET_FORMAT, "role": role, "rows": rows, "shape": shape,
                        "pluginSourceSha256": self.plugin_sha}
            artifact = self._write(f"datasets/{index:03d}-{hashlib.sha256(role.encode()).hexdigest()[:12]}-{uuid4().hex}.npz",
                                   serialize_snapshot(snapshot, envelope), DATASET_FORMAT)
            reference = {"kind": "dataset", "sessionId": self.session_id, "handle": self._handle(),
                         "artifact": artifact, "rows": rows, "shape": shape, "role": role}
            self._datasets[role] = {"ref": reference, "arrays": arrays,
                "fingerprint": snapshot_sha256(snapshot, domain="dataset", profile=self.profile), "metadata": dataset_metadata}
        backend = {**metadata, "sessionId": self.session_id, "profile": self.profile,
                   "pluginSourceSha256": self.plugin_sha, "runtime": "footprint-ml-adapter-kit/python-v1",
                   "identityProtocol": "footprint-ml-adapter-kit/identity/v1"}
        self._initialized = True
        return json_copy({"backend": backend, "datasets": {role: item["ref"] for role, item in self._datasets.items()}})

    def _capture(self, state: Any) -> dict[str, Any]:
        snapshot = normalize_snapshot(self.plugin.snapshot(state))
        full = snapshot_sha256(snapshot, domain="training-state", profile=self.profile)
        inference = normalize_snapshot(self.plugin.inference(state))
        identity = inference_identity(inference, self.profile)
        # Measurement methods must not themselves change registered state.
        second = snapshot_sha256(self.plugin.snapshot(state), domain="training-state", profile=self.profile)
        if full != second:
            raise ContractError("measurement-mutated-state", "Plugin snapshot/inference changed numerical state while measuring it")
        return {"snapshot": snapshot, "full": full, "inference": inference, "identity": identity}

    def _restore(self, snapshot: Any) -> tuple[Any, dict[str, Any]]:
        detached = normalize_snapshot(snapshot)
        expected = snapshot_sha256(detached, domain="training-state", profile=self.profile)
        state = self.plugin.restore(normalize_snapshot(detached))
        actual = self._capture(state)
        if actual["full"] != expected:
            raise ContractError("restore-not-equivalent", "Plugin restore did not preserve the complete snapshot")
        return state, actual

    def _intact(self, record: dict[str, Any]) -> dict[str, Any]:
        actual = self._capture(record["state"])
        full_changed = actual["full"] != record["full"]
        inference_changed = not _same_inference(actual["identity"], record["ref"]["inferenceIdentity"])
        if full_changed or inference_changed:
            raise ContractError("immutable-state-changed", "A published handle's numerical state changed", {
                "modelRef": record["ref"], "trainingStateChanged": full_changed,
                "inferenceChanged": inference_changed, "observedInferenceIdentity": actual["identity"]})
        return actual

    def _model(self, reference: Any) -> dict[str, Any]:
        if type(reference) is not dict or reference.get("kind") != "model" or reference.get("sessionId") != self.session_id:
            raise ContractError("foreign-session", "Model reference belongs to a foreign or stale session")
        handle = _integer(reference.get("handle"), "model.handle")
        record = self._models.get(handle)
        if record is None:
            raise ContractError("invalid-handle", "Model handle is invalid or disposed")
        if (_artifact_identity(reference.get("originArtifact")) != _artifact_identity(record["ref"]["originArtifact"])
                or not _same_inference(reference.get("inferenceIdentity"), record["ref"]["inferenceIdentity"])):
            raise ContractError("forged-reference", "Supplied model identity disagrees with the registered handle")
        self._intact(record)
        return record

    def _dataset(self, reference: Any) -> dict[str, Any]:
        if type(reference) is not dict or reference.get("kind") != "dataset" or reference.get("sessionId") != self.session_id:
            raise ContractError("foreign-dataset", "Dataset reference belongs to a foreign or stale session")
        record = self._datasets.get(reference.get("role"))
        if record is None:
            raise ValueError("Unknown dataset role")
        canonical = record["ref"]
        _integer(reference.get("handle"), "dataset.handle")
        if (reference.get("handle") != canonical["handle"] or reference.get("rows") != canonical["rows"]
                or reference.get("shape") != canonical["shape"]
                or _artifact_identity(reference.get("artifact")) != _artifact_identity(canonical["artifact"])):
            raise ContractError("forged-dataset", "Supplied dataset identity differs from the registered dataset")
        actual = snapshot_sha256({"arrays": record["arrays"], "metadata": record["metadata"]}, domain="dataset", profile=self.profile)
        if actual != record["fingerprint"]:
            raise ContractError("dataset-mutated", "Registered dataset buffers changed")
        return record

    def _envelope(self, observed: dict[str, Any]) -> dict[str, Any]:
        return {"kind": "footprint-ml-adapter-kit-checkpoint", "schemaVersion": 1, "format": CHECKPOINT_FORMAT,
                "pluginSourceSha256": self.plugin_sha, "profile": self.profile, "pluginConfig": self.config,
                "preprocessingVersion": self.metadata["preprocessingVersion"],
                "evaluationMethodVersion": self.metadata["evaluationMethodVersion"],
                "trainingStateSha256": observed["full"], "inferenceIdentity": observed["identity"],
                "inferenceManifest": snapshot_manifest(observed["inference"])}

    def _register(self, state: Any, observed: dict[str, Any], artifact: dict[str, Any]) -> dict[str, Any]:
        extra = json_object(self.plugin.model_metadata(state), "model_metadata") if callable(getattr(self.plugin, "model_metadata", None)) else {}
        after_metadata = self._capture(state)
        if after_metadata["full"] != observed["full"] or not _same_inference(after_metadata["identity"], observed["identity"]):
            raise ContractError("metadata-mutated-state", "model_metadata changed the state before publication")
        reserved = {"kind", "sessionId", "handle", "originArtifact", "inferenceIdentity"}
        if reserved & set(extra):
            raise ValueError("model_metadata cannot replace runtime-owned reference fields")
        reference = {**extra, "kind": "model", "sessionId": self.session_id, "handle": self._handle(),
                     "originArtifact": artifact, "inferenceIdentity": observed["identity"]}
        self._models[reference["handle"]] = {"state": state, "ref": reference, "full": observed["full"]}
        return reference

    def _read_checkpoint(self, relative: Any) -> tuple[Any, dict[str, Any], dict[str, Any]]:
        file = self._file(relative)
        data = file.read_bytes()
        actual = self._artifact(file, data, CHECKPOINT_FORMAT)
        snapshot, envelope = deserialize_snapshot(data)
        expected = {"kind": "footprint-ml-adapter-kit-checkpoint", "schemaVersion": 1, "format": CHECKPOINT_FORMAT,
                    "profile": self.profile, "pluginSourceSha256": self.plugin_sha,
                    "preprocessingVersion": self.metadata["preprocessingVersion"],
                    "evaluationMethodVersion": self.metadata["evaluationMethodVersion"]}
        for key, value in expected.items():
            if envelope.get(key) != value:
                raise ContractError("checkpoint-incompatible", f"Checkpoint {key} differs from the initialized plugin")
        state, observed = self._restore(snapshot)
        if observed["full"] != envelope.get("trainingStateSha256") or not _same_inference(observed["identity"], envelope.get("inferenceIdentity")):
            raise ContractError("checkpoint-inconsistent", "Decoded state differs from checkpoint identity metadata")
        if envelope.get("inferenceManifest") != snapshot_manifest(observed["inference"]):
            raise ContractError("checkpoint-inconsistent", "Inference audit manifest differs from measured state")
        return state, observed, actual

    def train(self, request: dict[str, Any]) -> dict[str, Any]:
        self._ready()
        args = json_object(request, "training request")
        model_ref, from_checkpoint = args.pop("modelRef", None), args.pop("fromCheckpoint", None)
        if model_ref is not None and from_checkpoint is not None:
            raise ValueError("Choose modelRef or fromCheckpoint, not both")
        source = None
        source_record = None
        if model_ref is not None:
            source_record = self._model(model_ref)
            source, _ = self._restore(self._intact(source_record)["snapshot"])
        elif from_checkpoint is not None:
            identity = _artifact_identity(from_checkpoint)
            source, _, actual = self._read_checkpoint(from_checkpoint.get("path"))
            if identity != _artifact_identity(actual):
                raise ContractError("checkpoint-mismatch", "Continuation file bytes differ from the intended artifact")
        try:
            result = self.plugin.train(json_copy(args), source)
        finally:
            if source_record is not None:
                self._intact(source_record)
        observed = self._capture(result)
        # Clone returned state too, so publication owns a detached materialization.
        state, checked = self._restore(observed["snapshot"])
        if not _same_inference(checked["identity"], observed["identity"]):
            raise ContractError("restore-not-equivalent", "Restoring the trained snapshot changed inference")
        artifact = self._write(f"checkpoints/{uuid4().hex}.npz", serialize_snapshot(checked["snapshot"], self._envelope(checked)), CHECKPOINT_FORMAT)
        return json_copy({"modelRef": self._register(state, checked, artifact), "checkpoint": artifact})

    def evaluate(self, request: dict[str, Any]) -> dict[str, Any]:
        self._ready()
        args = json_object(request, "evaluation request")
        record, dataset = self._model(args.get("modelRef")), self._dataset(args.get("datasetRef"))
        parameters = json_object(args.get("parameters", {}), "evaluation parameters")
        # Dataset copies prevent ordinary in-place evaluation code mutating the
        # canonical dataset whose bytes the returned DatasetRef identifies.
        buffers = normalized_arrays(dataset["arrays"])
        try:
            metrics = json_object(self.plugin.evaluate(record["state"], buffers, json_copy(parameters)), "evaluation metrics")
        finally:
            self._intact(record)
            self._dataset(dataset["ref"])
        if not metrics or any(type(value) not in (int, float) or not math.isfinite(value) for value in metrics.values()):
            raise ValueError("Evaluation must return a nonempty finite numerical metric map")
        return json_copy({"evaluationId": str(uuid4()), "modelRef": record["ref"], "datasetRef": dataset["ref"],
            "preprocessingVersion": self.metadata["preprocessingVersion"],
            "evaluationMethodVersion": self.metadata["evaluationMethodVersion"],
            "parameters": parameters, "metrics": metrics})

    def load(self, request: dict[str, Any]) -> dict[str, Any]:
        self._ready()
        args = json_object(request, "load request")
        checkpoint = args.get("checkpoint")
        if type(checkpoint) is not dict or checkpoint.get("kind") != "checkpoint":
            raise ValueError("load requires a CheckpointRef")
        proposed = checkpoint.get("artifact")
        _artifact_identity(proposed)
        state, observed, actual = self._read_checkpoint(proposed.get("path"))
        return json_copy({"modelRef": self._register(state, observed, actual), "actualArtifact": actual})

    def inspect(self, request: dict[str, Any]) -> dict[str, Any]:
        self._ready()
        record = self._model(json_object(request, "inspect request").get("modelRef"))
        return json_copy({"modelRef": record["ref"]})

    def dispose(self, request: dict[str, Any]) -> dict[str, Any]:
        self._ready()
        record = self._model(json_object(request, "dispose request").get("modelRef"))
        reference = record["ref"]
        del self._models[reference["handle"]]
        return json_copy({"modelRef": reference, "released": True})

    def dispatch(self, command: str, args: dict[str, Any]) -> dict[str, Any]:
        if command == "shutdown":
            self._models.clear()
            self._datasets.clear()
            self._closed = True
            return {"shutdown": True}
        if command not in {"initialize", "train", "evaluate", "load", "inspect", "dispose"}:
            raise ValueError(f"Unknown command {command!r}")
        return getattr(self, command)(args)


def serve() -> None:
    runtime = AdapterRuntime()
    for line in sys.stdin:
        identifier: Any = None
        command = None
        try:
            document = json_object(json.loads(line), "protocol request")
            identifier = document.get("id")
            if type(identifier) not in (str, int):
                raise ValueError("Protocol id must be a string or integer")
            command = _text(document.get("command"), "command")
            result = runtime.dispatch(command, json_object(document.get("args", {}), "args"))
            response = {"id": identifier, "ok": True, "result": result}
        except Exception as error:
            response = {"id": identifier, "ok": False, "error": {"type": type(error).__name__,
                "code": getattr(error, "code", "backend-error"), "message": str(error),
                "details": getattr(error, "details", {})}}
        sys.stdout.write(canonical_json(response).decode("utf-8") + "\n")
        sys.stdout.flush()
        if command == "shutdown" and response["ok"]:
            break
