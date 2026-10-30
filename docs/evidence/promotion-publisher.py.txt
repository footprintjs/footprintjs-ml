"""Optional checked MLflow promotion receiver; stdlib and an injected client only.

The supported profile promotes one pre-existing registered version backed by one
complete application-defined predictor artifact under a canonical runs:/ source.
All writers must share this single-host journal/lock. It is not a distributed
compare-and-swap service, a flavor-directory packager or approval authority.
"""
from __future__ import annotations

from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from typing import Any
import uuid

from footprint_ml_workflow import (_artifact_path, _checked_chunks, _json_bytes,
                                   _object_pairs, _open_regular, _run_id, _text)

PROFILE = "single-host-cooperating-writers/v1"
MAX_JOURNAL_BYTES = 16 * 1024 * 1024
MAX_MODEL_BYTES = 132 * 1024 * 1024
_MARKER = b"footprint-mlflow-promotion/v1\n"


class PromotionError(ValueError):
    def __init__(self, code: str, message: str, status: str = "deny"):
        super().__init__(message)
        self.code, self.status = code, status


def _fail(code: str, message: str, status: str = "deny") -> Any:
    raise PromotionError(code, message, status)


def _exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if type(value) is not dict or set(value) != keys:
        _fail("invalid-promotion-record", f"{label} has missing or unsupported fields")
    return value


def _digest(value: Any) -> str:
    if type(value) is not str or not re.fullmatch(r"[0-9a-f]{64}", value):
        _fail("invalid-promotion-record", "Expected a lowercase SHA-256 digest")
    return value


def _reference(value: Any) -> dict[str, Any]:
    _exact(value, {"kind", "path", "sha256", "bytes", "format"}, "Managed artifact")
    if value["kind"] != "artifact" or type(value["bytes"]) is not int or not 0 <= value["bytes"] <= 2**53-1:
        _fail("invalid-promotion-record", "Invalid artifact kind or byte count")
    digest = _digest(value["sha256"])
    format = _text(value["format"], "artifact format")
    wanted = "sha256-" + digest + "-" + hashlib.sha256(format.encode()).hexdigest() + ".bin"
    if value["path"] != wanted:
        _fail("invalid-promotion-record", "Artifact path must match its managed content and format identity")
    return copy.deepcopy(value)


def _binding(value: Any) -> dict[str, str]:
    _exact(value, {"version", "runId", "source", "artifactPath"}, "Registry binding")
    version = value["version"]
    if type(version) is not str or not re.fullmatch(r"[1-9][0-9]{0,15}", version):
        _fail("invalid-registry-binding", "Model version must be a positive canonical decimal string")
    run_id = _run_id(value["runId"])
    path = _artifact_path(value["artifactPath"])
    source = _text(value["source"], "registered source")
    prefix = f"runs:/{run_id}/"
    if not source.startswith(prefix):
        _fail("unsupported-registry-source", "This profile requires a canonical runs:/ source in the bound run")
    directory = _artifact_path(source[len(prefix):])
    if not path.startswith(directory + "/"):
        _fail("invalid-registry-binding", "The predictor artifact must be inside the registered source directory")
    return {"version": version, "runId": run_id, "source": source, "artifactPath": path}


def _result(status: str, code: str, message: str, receipt: Any = None) -> dict[str, Any]:
    return copy.deepcopy({"allowed": status in ("published", "already-published"), "status": status,
                          "reasons": [{"code": code, "message": message}], "receipt": receipt})


class MlflowModelPublisher:
    """Promote a pinned registered version through the existing release API.

    Construction/import starts no process, imports no MLflow and contacts no
    service. Call through WorkflowCapture.publish_model_release/release_model;
    using this low-level receiver directly does not establish ML approval.
    The application owns client credentials/timeouts, registry identity, complete
    artifact profile, trusted local directories and coordination of every writer.
    Pending intents require operator investigation; aliases/tags alone never
    establish that this request committed. No automatic lock breaking or retry of
    uncertain effects, process-crash recovery, fsync durability or hostile-FS
    guarantee is supplied. Historical acknowledgements do not assert current use.
    """

    def __init__(self, client: Any, *, store_root: str | os.PathLike[str],
                 journal_dir: str | os.PathLike[str], registry_id: str,
                 model_name: str, alias: str, binding: dict[str, Any],
                 coordination: str = PROFILE):
        if coordination != PROFILE:
            _fail("unsupported-promotion-coordination", "Select the explicit single-host cooperating-writer profile")
        self.client = client
        self.store_root = Path(store_root).expanduser().absolute()
        self.journal_dir = Path(journal_dir).expanduser().absolute()
        self.registry_id = _text(registry_id, "registry_id", limit=128)
        self.model_name = _text(model_name, "model_name", limit=256)
        self.alias = _text(alias, "alias", limit=128)
        for label in (self.registry_id, self.model_name, self.alias):
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", label):
                _fail("unsupported-promotion-target", "This profile uses simple registry, model and alias names")
        self._binding = _binding(copy.deepcopy(binding))
        self.target_name = f"mlflow:{self.registry_id}/{self.model_name}@{self.alias}"
        self._target = {"registryId": self.registry_id, "modelName": self.model_name, "alias": self.alias}

    @property
    def binding(self) -> dict[str, str]:
        return copy.deepcopy(self._binding)

    def _request(self, request: Any, *, publish: bool) -> dict[str, Any]:
        keys = {"payload", "payloadSha256", "payloadCanonicalJson", "preparedRef"}
        if publish: keys.add("modelArtifact")
        _exact(request, keys, "Publisher request")
        snapshot = json.loads(_json_bytes(request))
        payload, canonical = snapshot["payload"], snapshot["payloadCanonicalJson"]
        if type(canonical) is not str or hashlib.sha256(canonical.encode()).hexdigest() != _digest(snapshot["payloadSha256"]):
            _fail("publication-payload-mismatch", "Canonical publication bytes differ from their supplied identity")
        parsed = json.loads(canonical, object_pairs_hook=_object_pairs)
        # Comparing both JSON projections preserves types, including bool vs int,
        # without reimplementing JavaScript's canonical number serialization.
        comparable = lambda item: json.dumps(item, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if comparable(parsed) != comparable(payload):
            _fail("publication-payload-mismatch", "Canonical publication bytes describe a different payload")
        if (type(payload) is not dict or payload.get("kind") != "model-publication-payload"
                or type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != 1):
            _fail("invalid-publication-request", "Unsupported publication payload")
        _text(payload.get("releaseId"), "releaseId"); _text(payload.get("idempotencyKey"), "idempotencyKey")
        target = _exact(payload.get("target"), {"name", "expectedRevision"}, "Publication target")
        if target["name"] != self.target_name:
            _fail("promotion-target-mismatch", "The approved target differs from this configured receiver")
        if target["expectedRevision"] is not None: _digest(target["expectedRevision"])
        artifact = _exact(payload.get("artifact"), {"sha256", "bytes", "format"}, "Publication artifact")
        _digest(artifact["sha256"]); _text(artifact["format"], "format")
        if type(artifact["bytes"]) is not int or not 0 <= artifact["bytes"] <= MAX_MODEL_BYTES:
            _fail("promotion-model-too-large", "The single-artifact promotion profile is limited to 132 MiB")
        until = payload.get("validUntil")
        if until is not None and (type(until) not in (int, float) or until < 0):
            _fail("invalid-publication-request", "Invalid publication expiry")
        _reference(snapshot["preparedRef"])
        if publish:
            ref = _reference(snapshot["modelArtifact"])
            if any(ref[k] != artifact[k] for k in ("sha256", "bytes", "format")):
                _fail("publication-artifact-mismatch", "Received model artifact differs from approved identity")
        return snapshot

    def _managed_bytes(self, ref: Any) -> bytes:
        ref = _reference(ref)
        if ref["bytes"] > MAX_MODEL_BYTES:
            _fail("promotion-model-too-large", "The promotion artifact exceeds 132 MiB")
        if self.store_root.is_symlink():
            _fail("unsafe-promotion-storage", "The artifact root must be a real directory")
        try:
            with _open_regular(self.store_root / ref["path"], self.store_root) as source:
                content = b"".join(_checked_chunks(source, ref["bytes"]))
        except ValueError:
            _fail("publication-artifact-mismatch", "Managed model changed or is outside the regular-file profile")
        if hashlib.sha256(content).hexdigest() != ref["sha256"]:
            _fail("publication-artifact-mismatch", "Managed model content differs from approved identity")
        return content

    def _empty(self) -> dict[str, Any]:
        return {"kind": "mlflow-promotion-journal", "schemaVersion": 1, "target": self._target, "entries": []}

    def _read_journal(self) -> dict[str, Any] | None:
        root = self.journal_dir
        if not root.exists(): return None
        if root.is_symlink() or not root.is_dir():
            _fail("invalid-promotion-journal", "Journal root must be a real directory")
        path, marker = root / "journal.json", root / "initialized"
        if path.is_symlink():
            _fail("invalid-promotion-journal", "Promotion journal cannot be a symlink")
        if not path.exists():
            if marker.exists() or marker.is_symlink():
                _fail("invalid-promotion-journal", "An initialized promotion journal is missing")
            return None
        with _open_regular(marker, root) as source:
            if b"".join(_checked_chunks(source, len(_MARKER))) != _MARKER:
                _fail("invalid-promotion-journal", "Invalid journal initialization marker")
        with _open_regular(path, root) as source:
            if os.fstat(source.fileno()).st_size > MAX_JOURNAL_BYTES:
                _fail("invalid-promotion-journal", "Promotion journal exceeds 16 MiB")
            content = b"".join(_checked_chunks(source))
        state = json.loads(content, object_pairs_hook=_object_pairs)
        _exact(state, {"kind", "schemaVersion", "target", "entries"}, "Promotion journal")
        if (state["kind"] != "mlflow-promotion-journal" or type(state["schemaVersion"]) is not int
                or state["schemaVersion"] != 1 or state["target"] != self._target
                or type(state["entries"]) is not list or len(state["entries"]) > 2048):
            _fail("invalid-promotion-journal", "Unsupported journal, target or entry count")
        keys, revision, pending = set(), None, False
        for row in state["entries"]:
            _exact(row, {"request", "binding", "intendedAt", "status", "receipt"}, "Promotion entry")
            req = self._request(row["request"], publish=True)
            _binding(row["binding"])
            key = req["payload"]["idempotencyKey"]
            if key in keys or pending or req["payload"]["target"]["expectedRevision"] != revision:
                _fail("invalid-promotion-journal", "Conflicting journal history")
            keys.add(key)
            if type(row["intendedAt"]) is not int or row["intendedAt"] < 0:
                _fail("invalid-promotion-journal", "Invalid intent timestamp")
            self._managed_bytes(req["modelArtifact"])
            if row["status"] == "pending" and row["receipt"] is None:
                pending = True
            elif row["status"] == "committed":
                receipt = row["receipt"]
                self._validate_receipt(receipt, row)
                revision = receipt["revision"]
            else: _fail("invalid-promotion-journal", "Invalid promotion state")
        return state

    def _validate_receipt(self, receipt: Any, row: dict[str, Any]) -> None:
        _exact(receipt, {"kind", "schemaVersion", "releaseId", "idempotencyKey", "targetName", "revision",
                         "payloadSha256", "artifact", "preparedRef", "committedAt", "registry"}, "Promotion receipt")
        req, p = row["request"], row["request"]["payload"]
        wanted = {"kind": "model-publication-receipt", "schemaVersion": 1, "releaseId": p["releaseId"],
                  "idempotencyKey": p["idempotencyKey"], "targetName": p["target"]["name"],
                  "revision": req["payloadSha256"], "payloadSha256": req["payloadSha256"],
                  "artifact": req["modelArtifact"], "preparedRef": req["preparedRef"],
                  "registry": {**self._target, **row["binding"], "coordination": PROFILE}}
        if type(receipt["schemaVersion"]) is not int or any(receipt[k] != v for k, v in wanted.items()):
            _fail("invalid-promotion-journal", "Receipt does not bind its original exact request and registry version")
        stamp = receipt["committedAt"]
        if type(stamp) is not int or stamp < row["intendedAt"] or stamp > int(time.time()*1000):
            _fail("invalid-promotion-journal", "Invalid commit timestamp")

    def _journal_bytes(self, state: dict[str, Any]) -> bytes:
        try: content = _json_bytes(state, limit=MAX_JOURNAL_BYTES) + b"\n"
        except ValueError:
            _fail("promotion-journal-too-large", "Promotion journal exceeds its metadata capacity")
        if len(content) > MAX_JOURNAL_BYTES:
            _fail("promotion-journal-too-large", "Promotion journal exceeds its metadata capacity")
        return content

    def _write_journal(self, state: dict[str, Any]) -> None:
        content = self._journal_bytes(state)
        path = self.journal_dir / (".journal-" + uuid.uuid4().hex + ".tmp")
        try:
            with path.open("xb") as file: file.write(content)
            os.replace(path, self.journal_dir / "journal.json")
        finally:
            path.unlink(missing_ok=True)

    def _initialize(self) -> dict[str, Any]:
        state = self._read_journal()
        if state is not None: return state
        state = self._empty(); self._write_journal(state)
        with (self.journal_dir / "initialized").open("xb") as file: file.write(_MARKER)
        return state

    @contextmanager
    def _lock(self):
        self.journal_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.journal_dir.is_symlink() or not self.journal_dir.is_dir():
            _fail("unsafe-promotion-storage", "The journal root must be a real directory")
        lock = self.journal_dir / ".promotion-lock"
        try: lock.mkdir(mode=0o700)
        except FileExistsError:
            _fail("promotion-lock-unavailable", "Promotion lock is busy or needs operator investigation", "unknown")
        owner = lock / "owner.json"; owned = False; primary_failed = False
        try:
            file = owner.open("x"); owned = True
            try:
                file.write(json.dumps({"pid": os.getpid(), "token": uuid.uuid4().hex}))
            except BaseException:
                try: file.close()
                except BaseException: pass
                raise
            else: file.close()
            yield
        except BaseException:
            primary_failed = True
            raise
        finally:
            cleanup_error = None
            try:
                if owned: owner.unlink()
            except OSError as error: cleanup_error = error
            try: lock.rmdir()
            except OSError as error: cleanup_error = cleanup_error or error
            if not primary_failed and cleanup_error is not None: raise cleanup_error

    def _acknowledge(self, state: Any, req: dict[str, Any]) -> dict[str, Any] | None:
        if state is None: return None
        row = next((r for r in state["entries"] if r["request"]["payload"]["idempotencyKey"] == req["payload"]["idempotencyKey"]), None)
        if row is None: return None
        if row["request"]["payloadSha256"] != req["payloadSha256"] or row["request"]["payloadCanonicalJson"] != req["payloadCanonicalJson"]:
            return _result("deny", "idempotency-key-conflict", "This key already identifies another exact publication request")
        if row["binding"] != self._binding:
            return _result("deny", "promotion-binding-conflict", "This request was recorded for another pinned registry version")
        if row["status"] == "pending":
            return _result("unknown", "promotion-effect-unconfirmed", "An earlier attempt may have changed the alias; matching aliases or tags cannot confirm this request")
        return _result("already-published", "historical-promotion-confirmed", "The original exact committed effect is acknowledged without changing the current alias", row["receipt"])

    def lookup(self, request: dict[str, Any]) -> dict[str, Any] | None:
        """Read-only historical acknowledgement. No client calls or initialization."""
        try:
            req = self._request(request, publish=False)
            return self._acknowledge(self._read_journal(), req)
        except PromotionError as error:
            return _result(error.status, error.code, str(error))
        except Exception:
            return _result("unknown", "promotion-history-unconfirmed", "The retained promotion history could not be confirmed")

    def _alias_version(self) -> str | None:
        # Absence is confirmed from registered-model metadata. Some MLflow
        # versions report missing aliases as INVALID_PARAMETER_VALUE, which
        # must not be confused with permission, transport or invalid requests.
        model = self.client.get_registered_model(self.model_name)
        aliases = getattr(model, "aliases", None)
        if getattr(model, "name", None) != self.model_name or type(aliases) is not dict:
            _fail("promotion-alias-unconfirmed", "Registry did not supply an authoritative alias map", "unknown")
        if self.alias not in aliases: return None
        version = str(aliases[self.alias])
        if not re.fullmatch(r"[1-9][0-9]{0,15}", version):
            _fail("promotion-alias-unconfirmed", "Registry alias has invalid version metadata", "unknown")
        result = self.client.get_model_version_by_alias(self.model_name, self.alias)
        if getattr(result, "name", None) != self.model_name or str(getattr(result, "version", "")) != version:
            _fail("promotion-alias-unconfirmed", "Registry alias changed during its metadata lookup", "unknown")
        return version

    def _receipt(self, req: dict[str, Any], committed_at: int) -> dict[str, Any]:
        return {"kind": "model-publication-receipt", "schemaVersion": 1,
            "releaseId": req["payload"]["releaseId"], "idempotencyKey": req["payload"]["idempotencyKey"],
            "targetName": self.target_name, "revision": req["payloadSha256"], "payloadSha256": req["payloadSha256"],
            "artifact": req["modelArtifact"], "preparedRef": req["preparedRef"], "committedAt": committed_at,
            "registry": {**self._target, **self._binding, "coordination": PROFILE}}

    def _check_registry_artifact(self, approved: bytes) -> None:
        actual = self.client.get_model_version(self.model_name, self._binding["version"])
        if (getattr(actual, "name", None) != self.model_name or str(getattr(actual, "version", "")) != self._binding["version"]
                or getattr(actual, "run_id", None) != self._binding["runId"] or getattr(actual, "source", None) != self._binding["source"]
                or getattr(actual, "status", None) != "READY"):
            _fail("promotion-binding-mismatch", "Actual registered version differs from the pinned source/run/version or is not READY")
        with tempfile.TemporaryDirectory(prefix="footprint-ml-promotion-") as temporary:
            root = Path(temporary).absolute()
            path = Path(self.client.download_artifacts(self._binding["runId"], self._binding["artifactPath"], dst_path=str(root))).absolute()
            try:
                with _open_regular(path, root) as source:
                    content = b"".join(_checked_chunks(source, len(approved)))
            except ValueError:
                _fail("promotion-artifact-mismatch", "Registered predictor changed or differs from the approved regular-file size/profile")
            if content != approved:
                _fail("promotion-artifact-mismatch", "Registered predictor bytes differ from the exact approved model artifact")

    def read_state(self) -> dict[str, Any] | None:
        """Detached local journal inspection; this is not live registry state."""
        return copy.deepcopy(self._read_journal())

    def publish(self, request: dict[str, Any]) -> dict[str, Any]:
        try:
            req = self._request(request, publish=True)
            approved = self._managed_bytes(req["modelArtifact"])
            with self._lock():
                state = self._initialize()
                old = self._acknowledge(state, req)
                if old is not None: return old
                if any(row["status"] == "pending" for row in state["entries"]):
                    return _result("unknown", "promotion-effect-unconfirmed", "A pending intent needs operator investigation before another effect")
                last = state["entries"][-1] if state["entries"] else None
                revision = last["request"]["payloadSha256"] if last else None
                if req["payload"]["target"]["expectedRevision"] != revision:
                    return _result("deny", "target-revision-conflict", "The independently expected revision differs from confirmed local history")
                expected_version = last["binding"]["version"] if last else None
                self._check_registry_artifact(approved)
                if self._alias_version() != expected_version:
                    return _result("unknown", "promotion-alias-conflict", "The actual alias is outside the confirmed coordinated history")
                until = req["payload"]["validUntil"]
                if until is not None and int(time.time()*1000) > until:
                    return _result("deny", "publication-expired", "Approval expired before a new alias change")
                row = {"request": req, "binding": self._binding, "intendedAt": int(time.time()*1000), "status": "pending", "receipt": None}
                state["entries"].append(copy.deepcopy(row))
                if len(state["entries"]) > 2048:
                    return _result("deny", "promotion-journal-too-large", "This profile retains at most 2048 promotion attempts")
                # Reserve the complete acknowledgement before any external
                # mutation. A maximum safe timestamp bounds later digit growth.
                prospective = copy.deepcopy(state)
                prospective["entries"][-1].update(status="committed", receipt=self._receipt(req, 2**53-1))
                self._journal_bytes(prospective)
                self._write_journal(state)  # Intent precedes every external effect.
                # Slow persistence/metadata requests must not consume an expired
                # approval. Removing an unissued intent does not undo an effect.
                if self._alias_version() != expected_version:
                    return _result("unknown", "promotion-alias-conflict", "The alias changed after intent persistence; no setter was invoked")
                if until is not None and int(time.time()*1000) > until:
                    state["entries"].pop(); self._write_journal(state)
                    return _result("deny", "publication-expired", "Approval expired after intent persistence; no alias change was invoked")
                try:
                    self.client.set_registered_model_alias(self.model_name, self.alias, self._binding["version"])
                    if self._alias_version() != self._binding["version"]:
                        _fail("promotion-alias-conflict", "Alias readback did not confirm the requested version", "unknown")
                    self._check_registry_artifact(approved)
                    receipt = self._receipt(req, int(time.time()*1000))
                    state["entries"][-1].update(status="committed", receipt=receipt)
                    self._write_journal(state)
                except Exception:
                    return _result("unknown", "promotion-effect-unconfirmed", "Alias change or its confirmation was uncertain; the pending intent is retained and will not be repeated automatically")
                return _result("published", "promotion-committed", "Exact version and predictor bytes were observed after the alias change and retained in the local journal", receipt)
        except PromotionError as error:
            return _result(error.status, error.code, str(error))
        except Exception:
            return _result("unknown", "promotion-unconfirmed", "The registry publication could not be confirmed; no success is inferred")
