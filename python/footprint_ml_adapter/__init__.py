"""Optional trainer adapter scaffolding; numerical definitions belong to plugins."""
from .identity import inference_identity, normalize_snapshot, snapshot_sha256
from .runtime import AdapterRuntime, ContractError, deserialize_snapshot, serialize_snapshot

__version__ = "0.1.0"
__all__ = ["inference_identity", "normalize_snapshot", "snapshot_sha256", "AdapterRuntime",
           "ContractError", "deserialize_snapshot", "serialize_snapshot"]
