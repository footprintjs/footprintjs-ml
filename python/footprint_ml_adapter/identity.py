"""Versioned numerical identity framing; no trainer-specific assumptions."""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any
import numpy as np

PROTOCOL = "footprint-ml-adapter-kit/identity/v1"
MAX_ARRAY_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024


def json_copy(value: Any, *, depth: int = 0) -> Any:
    """Accept plain finite JSON, preserving integer versus floating JSON values."""
    if depth > 64:
        raise ValueError("JSON nesting exceeds 64 levels")
    if value is None or type(value) in (str, bool, int):
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("JSON numbers must be finite")
        return value
    if type(value) is list:
        return [json_copy(item, depth=depth + 1) for item in value]
    if type(value) is dict and all(type(key) is str for key in value):
        return {key: json_copy(item, depth=depth + 1) for key, item in value.items()}
    raise ValueError("Metadata must contain plain JSON values only")


def canonical_json(value: Any) -> bytes:
    return json.dumps(json_copy(value), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def json_object(value: Any, name: str = "metadata") -> dict[str, Any]:
    result = json_copy(value)
    if type(result) is not dict:
        raise ValueError(f"{name} must be a JSON object")
    if len(canonical_json(result)) > 1_048_576:
        raise ValueError(f"{name} exceeds the supported JSON size")
    return result


def normalized_arrays(value: Any) -> dict[str, np.ndarray]:
    if type(value) is not dict:
        raise ValueError("arrays must be a dictionary")
    if any(type(name) is not str for name in value):
        raise ValueError("Array names must be strings")
    result: dict[str, np.ndarray] = {}
    total = 0
    for name in sorted(value):
        if type(name) is not str or not name or len(name.encode("utf-8")) > 1024:
            raise ValueError("Array names must be nonempty UTF-8 strings of at most 1024 bytes")
        array = value[name]
        if not isinstance(array, np.ndarray) or array.dtype.kind not in "biufc" or array.dtype.fields is not None:
            raise ValueError(f"Array {name!r} must have an ordinary numeric or bool dtype")
        if array.ndim > 16 or array.nbytes > MAX_ARRAY_BYTES:
            raise ValueError(f"Array {name!r} exceeds the supported dimensions or size")
        if not np.isfinite(array).all():
            raise ValueError(f"Array {name!r} contains nonfinite values")
        total += array.nbytes
        if total > MAX_TOTAL_BYTES:
            raise ValueError("Snapshot exceeds the supported total array size")
        # Copies prevent plugin or caller mutation from changing an observation.
        dtype = array.dtype.newbyteorder("<")
        result[name] = np.array(array, dtype=dtype, order="C", copy=True)
    return result


def normalize_snapshot(value: Any) -> dict[str, Any]:
    if type(value) is not dict or set(value) != {"arrays", "metadata"}:
        raise ValueError("Snapshot must contain exactly arrays and metadata")
    return {"arrays": normalized_arrays(value["arrays"]), "metadata": json_object(value["metadata"])}


def _frame(hasher: Any, tag: str, payload: bytes) -> None:
    encoded = tag.encode("utf-8")
    hasher.update(len(encoded).to_bytes(4, "big"))
    hasher.update(encoded)
    hasher.update(len(payload).to_bytes(8, "big"))
    hasher.update(payload)


def snapshot_sha256(snapshot: Any, *, domain: str, profile: str) -> str:
    """Frame domain/profile, canonical metadata, then sorted named array fields.

    A field is uint32be(tag-byte-count), tag UTF8, uint64be(payload-byte-count),
    payload. Array shape is canonical JSON; dtype is NumPy's little-endian str.
    """
    if not isinstance(domain, str) or not domain or not isinstance(profile, str) or not profile:
        raise ValueError("Identity domain and profile must be nonempty strings")
    value = normalize_snapshot(snapshot)
    hasher = hashlib.sha256((PROTOCOL + "\0").encode("ascii"))
    _frame(hasher, "domain", domain.encode("utf-8"))
    _frame(hasher, "profile", profile.encode("utf-8"))
    _frame(hasher, "metadata", canonical_json(value["metadata"]))
    for name, array in value["arrays"].items():
        _frame(hasher, "array-name", name.encode("utf-8"))
        _frame(hasher, "array-dtype", array.dtype.str.encode("ascii"))
        _frame(hasher, "array-shape", canonical_json(list(array.shape)))
        _frame(hasher, "array-bytes", array.tobytes(order="C"))
    return hasher.hexdigest()


def inference_identity(snapshot: Any, profile: str) -> dict[str, Any]:
    return {"kind": "inference-identity", "schemaVersion": 1,
            "sha256": snapshot_sha256(snapshot, domain="inference", profile=profile), "profile": profile}


def snapshot_manifest(snapshot: Any) -> dict[str, Any]:
    value = normalize_snapshot(snapshot)
    return {"metadata": value["metadata"], "arrays": [
        {"name": name, "dtype": array.dtype.str, "shape": list(array.shape), "bytes": array.nbytes,
         "sha256": hashlib.sha256(array.tobytes(order="C")).hexdigest()}
        for name, array in value["arrays"].items()]}
