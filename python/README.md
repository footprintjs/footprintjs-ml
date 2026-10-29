# Python trainer adapter in footprintjs-ml

The optional `footprintjs-ml/adapter` entry in the beta provides a reusable process boundary, handle registry, numerical identity protocol, NPZ persistence, and conformance runner. A plugin supplies the actual model and numerical implementation. The kit does not import FootPrint, implement a mathematical engine, or manufacture a FootPrint execution trace.

The runtime needs Python 3.11+ and NumPy. The contract tests run with NumPy 1.24.3; the external JAX GP conformance run uses NumPy 2.2.6. A plugin installs and declares its own numerical dependencies.

## Plugin interface

A Python file exports `create_plugin(config: dict)`. It returns an object with:

```python
profile: str
initialize() -> {
    "datasets": {
        role: {"arrays": {name: numpy_array}, "rows": int,
               "shape": list[int], "metadata": optional_json_dict}
    },
    "metadata": {"preprocessingVersion": str,
                 "evaluationMethodVersion": str, ...small_json}
}
train(request: dict, source: state_or_none) -> state
evaluate(state, dataset_arrays: dict, parameters: dict) -> {metric: finite_number}
snapshot(state) -> {"arrays": {name: numpy_array}, "metadata": json_dict}
restore(snapshot: dict) -> state
inference(state) -> {"arrays": {name: numpy_array}, "metadata": json_dict}
model_metadata(state) -> small_json_dict  # optional
```

`snapshot` must represent **all** state needed to continue training, including optimizer/RNG state and configuration. `restore` must validate and reconstruct that complete state. `inference` declares the profile's inference contract: parameters, fitted preprocessing, architecture, input/label schemas, inference code and relevant dependencies. Optimizer-only state and training counters normally remain outside inference identity. The kit cannot determine whether this declaration is complete.

The runtime calls numerical methods directly. A plugin must implement or reject the parameters it accepts, validate its own model-specific shapes/configuration, and report stable protocol versions. The runtime records the parameters actually passed to `evaluate`; it cannot generically prove that numerical code consumed every setting. Snapshot/inference/model-metadata methods must not mutate the state they describe. Plugin logging must use stderr so stdout remains the JSON protocol.

Plugins receive detached JSON configuration and request dictionaries. Training-source wrapper fields `modelRef` and `fromCheckpoint` are removed before calling `train`. A source model is reconstructed from a detached snapshot, so an ordinary trainer that updates its input in place does not mutate a published source handle. The newly returned state is also snapshot/restored before publication. Round trips must preserve complete state and inference identity.

## Worker protocol

Run `python /path/to/node_modules/footprintjs-ml/python/worker.py`. The runner adds its own package directory to `sys.path`; no installation or `PYTHONPATH` setting is necessary.

Requests use a correlated ID and nested arguments:

```json
{"id":1,"command":"initialize","args":{"root":"/absolute/run","pluginPath":"/absolute/plugin.py","config":{}}}
```

Responses are `{id,ok:true,result}` or `{id,ok:false,error:{type,code,message,details}}`. Commands are sequential:

| Command | Arguments | Result |
| --- | --- | --- |
| `initialize` | `root`, `pluginPath`, `config` | `backend`, canonical `datasets` refs |
| `train` | plugin domain options; optional `modelRef` **or** `fromCheckpoint:ArtifactRef` | new `modelRef`, exact `checkpoint:ArtifactRef` |
| `evaluate` | `modelRef`, `datasetRef`, versions and optional `parameters:{}` | observed refs/versions/parameters, metrics, `evaluationId` |
| `load` | `checkpoint:{kind:'checkpoint',artifact:ArtifactRef}` | new `modelRef`, `actualArtifact` |
| `inspect` | `modelRef` | checked canonical `modelRef` |
| `dispose` | `modelRef` | canonical `modelRef`, `released:true` |
| `shutdown` | none | `shutdown:true`, then worker exit |

One worker initializes once. Handles are monotonically allocated and session-bound. A new process creates a new session; a saved checkpoint can be loaded into it. The backend reports actual plugin profile/file SHA, required protocol versions and identity-protocol version. The imported plugin is compiled from the same source byte buffer whose SHA is reported. Other modules/dependencies imported by that plugin remain the plugin profile's responsibility.

Every live model boundary measures the complete training snapshot and inference identity. Registered-state drift is refused before inspect, evaluation, continuation or disposal; evaluation is checked again afterward. `model_metadata` is checked for mutation before registration. A failed integrity check does not claim cleanup or roll back numerical side effects. Close the worker to release a corrupted registry and use a fresh process if recovery is required.

Dataset arrays are copied into runtime-owned buffers and persisted under unique file names. Their first dimension must equal the declared row count, and one array must match the declared dataset shape. Evaluation receives copies, preserving canonical dataset buffers. Dataset refs carry exact artifact identity, role, shape, rows and live session/handle values.

Use the TypeScript adapter from `footprintjs-ml/adapter` so intended and observed artifacts are compared. Public `load` intentionally returns the identity of the bytes actually decoded; it does not substitute the requested digest. The core adapter rejects mismatches and attempts cleanup of an unpublished handle. Continuation from `fromCheckpoint` checks its intended identity before training.

## Canonical numerical identity v1

`footprint_ml_adapter.identity` exports `normalize_snapshot`, `snapshot_sha256`, `inference_identity` and `snapshot_manifest`. Metadata contains plain finite JSON. NumPy arrays use ordinary bool, signed/unsigned integer, floating or complex dtypes; object, string, structured and nonfinite arrays are refused. Scalars are allowed. Normalization makes detached C-contiguous copies with little-endian dtype/bytes. Array rank is bounded to 16, one array to 64 MiB and total array payload to 128 MiB.

The SHA-256 input begins with ASCII:

```text
footprint-ml-adapter-kit/identity/v1\0
```

It then includes these framed fields in order:

1. `domain`: UTF-8 `inference`, `training-state`, or `dataset`.
2. `profile`: the UTF-8 plugin profile.
3. `metadata`: canonical JSON bytes.
4. For each array sorted by Unicode name: `array-name`, `array-dtype`, `array-shape`, `array-bytes`.

Each frame is `uint32-big-endian(tag byte count)`, UTF-8 tag, `uint64-big-endian(payload byte count)`, payload. Array dtype is normalized NumPy `dtype.str`; shape is canonical JSON; data is little-endian C-order bytes. Names, dtype and shape are bound separately, so equal raw byte strings with different interpretations do not match.

Canonical JSON here is explicitly the Python JSON representation: sorted string keys, separators `(',', ':')`, `ensure_ascii=False`, `allow_nan=False`, UTF-8. Integer and floating representations remain distinct; this is not an assertion of RFC 8785/JCS compatibility. Profiles should use stable metadata types. The returned inference identity is `{kind:'inference-identity',schemaVersion:1,sha256,profile}`.

## Safe numerical persistence

`serialize_snapshot`/`deserialize_snapshot` encode one NPZ with numeric arrays under generated `array_00000` keys and a `metadata` uint8 JSON vector. Original names are mapped in the JSON manifest, so parameter names never become ZIP paths. Loading uses `allow_pickle=False`, rejects unexpected/duplicate entries, checks NPY headers before allocation, bounds archive size, and validates actual array dtype/shape/finiteness against its manifest. Only numerical data and JSON are decoded. These checks do not make an executable Python plugin safe to load from an untrusted party.

Checkpoint format is `footprint-ml-adapter-kit/trainstate-npz-v1`; dataset format is `footprint-ml-adapter-kit/dataset-npz-v1`. The checkpoint JSON envelope contains:

```text
kind, schemaVersion, format,
pluginSourceSha256, profile, pluginConfig,
preprocessingVersion, evaluationMethodVersion,
trainingStateSha256, inferenceIdentity,
inferenceManifest: {metadata, arrays:[{name,dtype,shape,bytes,sha256}]},
snapshot: {metadata, arrays:[{name,key,dtype,shape}]}
```

The loader reads one buffer, hashes that buffer and decodes that same buffer. It validates plugin/source/profile and method/preprocessing compatibility, restores the full state, and independently recomputes its fingerprints and inference manifest. The manifest supports plugin-specific independent audit when the inference arrays can be obtained or derived from the retained training snapshot. A digest is an identity claim, not a signature or proof of authenticity; retain checkpoints and recordings in trusted storage.

## Conformance CLI and tests

The portable wrapper accepts JSON text arguments:

```sh
python /path/to/node_modules/footprintjs-ml/python/conformance.py \
  --plugin /path/to/plugin.py \
  --config '{"seed":2026}' \
  --plan '{"train":{"steps":30},"continue":{"steps":70},"trainingOnly":{"steps":0,"resetOptimizer":true},"metric":"mse","operator":"lte","threshold":0.5}' \
  --out ./conformance-run
```

Training options are plugin-defined. `evaluationDatasetRole` defaults to `validation`; `trainingOnly` is optional. The runner writes `conformance-report.json` and retains its own datasets/checkpoints separately from any FootPrint run. It exercises real initialization/training/evaluation, reload, a fresh session, immutable continuation, changed inference, training-only numerical changes, forged/stale/foreign/disposed refs, and local fault injection into actual registered numerical state. Mutation injection is a harness operation, not a public worker command.

Reports distinguish `structuralPassed` and `numericalPassed`, list every case and numerical observation, and state limits explicitly. Missing optional coverage has `status:'skipped'`, `passed:null` and a reason; it is never counted as a pass. Overall status is `partial` and `passed:false` if coverage is skipped, while `requiredPassed` can remain true. The CLI exits successfully for a partial report only when required checks pass and no executed case fails. Plugin component completeness remains `not-proven` even when all exercised cases pass.

Run the lightweight Python tests without JAX or an external trainer:

```sh
python -m unittest discover -s /path/to/node_modules/footprintjs-ml/python/tests -v
```

The suite checks canonical interpretation, nonfinite/object rejection, allocation-header guards, NPZ mapping, in-place source isolation, optimizer-only drift, evaluation mutation, actual versus intended checkpoint identity, lifecycle guards, metadata purity and honest skipped-coverage reporting. These are adapter-boundary tests; they do not claim mathematical correctness of a numerical trainer.

The existing `footprint-ml-adapter-kit/*-v1` protocol/profile identifiers are retained for artifact compatibility. Consolidating the npm package changes entry points and worker locations, not numerical hashing or receipt semantics. Python/JAX installation remains an explicit environment step.
