# Python workflows with MLflow evidence

Keep training, evaluation, control flow and retries in your Python application. The optional FootPrint ML capture bridge records explicit JSON reads and writes with the existing native foottrace writer. MLflow continues to own its experiments, runs, artifacts and registered model versions.

This integration is a beta addition with a local Node capture process. Python controls its own workflow. The bridge uses the native foottrace writer directly, without a FootPrint executor or automatic Python branch instrumentation.

## Dependencies and loading

| Part | Dependencies and behaviour |
| --- | --- |
| npm root SDK | No runtime dependencies. Importing the core does not load the Python capture process. |
| `python/footprint_ml_workflow.py` | Python 3.11+ standard library only. Importing it, constructing `WorkflowCapture`, or constructing `MlflowArtifacts` starts no process and imports no MLflow or numerical framework. |
| Capture worker | Node.js 22+ and the host's explicit foottrace installation. Entering `WorkflowCapture` or calling `start()` launches the shipped worker. |
| `MlflowArtifacts` binding | An application-supplied client. The binder does not import MLflow, install it, create runs, change aliases or select credentials. |
| `footprint_ml_promotion.MlflowModelPublisher` | Standard-library receiver with an injected client. An explicit checked publication may change one pinned version's alias under the documented local coordination profile. Construction performs no effect. |
| Example | Explicit MLflow, NumPy and scikit-learn dependencies in [requirements.txt](examples/mlflow/requirements.txt). |

Install the Python wheel of the same SDK and explicitly set up its Node helper using [PYTHON.md](PYTHON.md). This removes the need to add an npm package's Python directory to `PYTHONPATH`. The Python module also remains in the npm archive under `python/` for existing integrations. The earlier numerical adapter remains optional and still requires NumPy when used.

From a source checkout, install the Node development dependencies with `npm ci` and build with `npm run build`. The example instructions in [examples/mlflow/README.md](examples/mlflow/README.md) install the numerical dependencies into a separate Python environment. A source/archive module uses its adjacent built worker; an installed wheel finds the matching helper in the active environment. A custom helper directory can be supplied using `runtime_dir=...`, or a custom worker with an explicit argument list using `command=[...]`.

## Bind the bytes your workflow consumes

Your application creates the MLflow client and chooses a run and artifact:

```python
from mlflow import MlflowClient  # Explicit application dependency.
from footprint_ml_workflow import MlflowArtifacts, WorkflowCapture

client = MlflowClient(tracking_uri=existing_tracking_uri)
artifacts = MlflowArtifacts(client, cache_dir="./downloaded-artifacts")
weights = artifacts.bind_artifact(
    existing_run_id, "model/weights.json", format="my-numeric-model/v1"
)

with WorkflowCapture("./recording.json") as capture:
    with capture.stage("select-model", name="Select the recorded model") as scope:
        scope["modelArtifact"] = weights
    with capture.stage("consume-model") as scope:
        checked_bytes = artifacts.read_bytes(scope["modelArtifact"])
        # Your existing model decoder and evaluation consume checked_bytes.
```

`bind_artifact` asks the injected client for the run metadata and downloads the selected artifact into a new cache directory. It measures the actual regular-file bytes and returns:

```json
{
  "kind": "mlflow-artifact",
  "schemaVersion": 1,
  "runId": "your-run-id",
  "experimentId": "your-experiment-id",
  "artifactPath": "model/weights.json",
  "artifact": {
    "kind": "artifact",
    "path": "runs:/your-run-id/model/weights.json",
    "sha256": "measured-sha256",
    "bytes": 1234,
    "format": "my-numeric-model/v1"
  }
}
```

The values above illustrate the shape. `read_bytes(ref)` checks the opened regular-file descriptor's size against the bound length before reading its contents. Its read is bounded to that size with a one-byte growth probe, and observed size/timestamp changes are refused. It rechecks the digest and returns that same checked buffer. It refuses altered cache contents and references that were not bound by that `MlflowArtifacts` instance. `local_path(ref)` verifies before returning a path, but a subsequent file open can observe a later change. Prefer `read_bytes` at the actual consumption boundary.

Initial binding measures the downloaded file in bounded chunks; it does not impose an SDK-wide artifact-size cap. `read_bytes` assembles the complete checked artifact in memory. Downloads and their size/resource limits remain the application's responsibility, and this trusted-local-cache profile does not establish hostile-filesystem protection or streaming numerical decoding.

Hashes identify the bytes compared. They do not authenticate the original trainer, prove that the model is correct or establish that a predictor profile includes every relevant dependency. An MLflow run ID or tag is not an approval authority. Network configuration, credentials and download timeouts remain responsibilities of the injected client.

Uploading evidence is explicit: `artifacts.log_recording(run_id, path)` calls the client's `log_artifact`. Binding or closing capture does not upload anything automatically.

## Capture and retry semantics

`with capture.stage(stage_id, name=None, attempt=None, retry_of=None) as scope` opens a stage. Normal exit commits its writes. An application exception discards pending writes and records the failed attempt with a bounded error description. The exception still propagates. Your Python `try/except` decides whether to retry and passes the failed `scope.runtime_stage_id` as `retry_of` when appropriate.

`scope[key]` reads through the worker and raises `KeyError` for a missing key. `scope.get(key, default)` distinguishes absence from a stored `None`. Assignment and `scope.set(key, value)` write through the same connection. Values must be finite, plain JSON, at most 64 KiB per value. Arrays, models and dataframes stay in the Python application or artifact files.

The direct writer does not apply a FootPrint executor's redaction policy. The application chooses the references and small metadata it records, and omits or filters sensitive values before capture. Failed stages also record a bounded exception message, so application exceptions need the same care.

These are whole-key JSON operations. Reads return detached values. Assign modified nested objects back through scope to record a change. A closure, ordinary Python object mutation or numerical operation outside these explicit calls is not automatically traced. Merely storing an equivalent value elsewhere in scope cannot establish that a stage consumed it.

A started capture calls the existing TypeScript JSON contracts through the worker: evaluation creation/reading and `check_release`; lineage creation/reading and `check_data_lineage`; and selection manifest/receipt reading, receipt creation and `check_selection`. Python method names and their complete list are in [PYTHON.md](PYTHON.md); request fields retain the TypeScript camelCase names. These helpers need an open connection but do not require an active stage. Read their actual operands through scope and write the returned receipt or decision through scope when they belong in the history. A helper call does not invent those dependencies or write its result automatically.

Python keeps the candidate loop, numerical work and retries. The guard helpers neither query MLflow for missing evidence nor infer memberships from a run ID. Supply independently declared comparison inputs and backend-observed lineage. `runExperiment` remains a TypeScript callback driver. The [Python guard example](examples/python-guards/README.md) uses retained observations without new training; its JAX candidate and digit-lineage sections describe separate original runs.

The connection is synchronous and supports one active stage on its owning Python thread. Its timeout bounds request writing and response waiting. Protocol failure or timeout terminates the child process. There is no automatic worker restart or replay. `snapshot()` returns the current recording within the response-size limit; read larger recordings from the saved file. Normal `close()` persists and closes it. Capture files are replaced at recording boundaries. They are not a durable workflow scheduler or a write-ahead log for recovery from arbitrary crashes.

## The controlled preprocessing failure

The [example](examples/mlflow/run.py) trained a real scikit-learn digit classifier once, stored numeric artifacts in a local MLflow experiment and created a local registered model version. A deliberately incompatible scaler S2 was prepared before validation. An ordinary Python retry selected it instead of the original fitted scaler S1.

The retained local proof observed:

| Predictor used | Held-out accuracy | Release check |
| --- | --- | --- |
| Weights with S1 | 98% | Matching evidence allowed |
| Same weights with S2 | 34% | S1's stale receipt refused; fresh S2 evidence failed the 90% threshold |
| Same weights with restored S1 | 98% | Matching corrected evidence allowed |

The raw held-out data and weight artifact hashes stayed unchanged. The measured scaler hash changed on retry and returned to its original value after correction. The complete predictor identity includes both weight and fitted-preprocessing identity. The registered model version identifies the numeric classifier source in this example; it alone does not identify every preprocessing choice.

These scores belong to this controlled local run. FootPrint did not create its prediction accuracy. scikit-learn and the supplied evaluation computed it. The proof records local approval without changing a registry alias or deploying a model. It does not establish general model quality or a debugging advantage over complete structured logs.

## Checked registered-model promotion

The Python facade's `prepare_model_release`, `publish_model_release` and `release_model` call the same existing TypeScript release APIs. They load pinned evidence through the Node managed artifact store, compose quality/selection/required-lineage checks and require live model verification for a new handoff. `put_release_artifact(file_path, store_root=..., format=...)` imports real bytes; scope and callback messages carry references, never numerical buffers.

The optional receiver is explicit:

```python
from footprint_ml_promotion import MlflowModelPublisher

publisher = MlflowModelPublisher(
    client,
    store_root="./release-store",
    journal_dir="./promotion-journal",
    registry_id="local-registry",
    model_name="my-predictor",
    alias="champion",
    binding={"version": "7", "runId": run_id,
             "source": f"runs:/{run_id}/predictor",
             "artifactPath": "predictor/bundle.json"},
    coordination="single-host-cooperating-writers/v1",
)
```

These are illustrative coordinates, not existing approved evidence. Registered versions are created by the application beforehand. This profile requires a canonical `runs:/{runId}/{directory}` source and one artifact inside that directory. The application-defined artifact must contain the complete predictor state it intends to approve. The supplied [NumPy example](examples/mlflow-promotion/README.md) uses a single safe JSON bundle with weights, fitted scaler and ordered input/output semantics; the receiver does not package arbitrary MLflow flavor directories or provide serving.

`target_name` is `mlflow:{registry_id}/{model_name}@{alias}`. Pin that exact target and expected revision in the independent release plan. Consume the actual version/run/source/artifact configuration through scope when constructing the publisher. A closure-configured receiver plus an unused equivalent scope label does not record which version it consumed.

Before alias mutation the receiver checks the registered version's name, version, run, source and READY status, downloads the specified artifact, and measures its bytes against the exact approved artifact. It writes a pending intent before the alias setter, then verifies the observed alias/version/artifact before committing a local receipt. All cooperating writers for that target must share the same one-host journal and lock. This is not an MLflow compare-and-swap primitive or a distributed exactly-once service.

A lost outer reply after the receiver committed can recover through read-only `lookup`; that historical receipt does not claim the alias is still current. A timeout inside the setter can occur after its external effect. The pending journal then stays unknown; a matching alias or tag is not commit evidence, and retry performs no second mutation. Pending intent, abandoned locks and ambiguous outcomes need operator investigation. Client credentials, registry identity, timeouts, trusted storage and coordination of writers remain application responsibilities. Helper callback timeouts do not cancel external operations.

The journal is limited to 16 MiB and 2,048 entries; this receiver's single artifact is limited to 132 MiB. General `put_release_artifact` import happens earlier and reads a complete file bounded to its descriptor size; it does not apply that predictor-profile cap. The application controls import sizes and memory use. These are complete-buffer local profiles, without streaming/constant-memory transfer, process-crash recovery, fsync/power-loss durability, hostile-filesystem protection, producer authentication or numerical-correctness proof. See [the release guide](RELEASE.md#python-release-callbacks-and-mlflow-promotion) for the callback protocol and [the real local proof](examples/mlflow-promotion/README.md) for refusal, acknowledgement and uncertain-effect controls.

## Reopen the saved run

Once the application exits, the existing saved-recording tools can backtrack a captured result or receipt using `recording.json`. The model and preprocessing references connect the captured workflow to MLflow's artifacts. See [BACKTRACKING.md](BACKTRACKING.md) for generic value tracing and the [example guide](examples/mlflow/README.md) for its reproduction and evidence files.

Investigation reads recorded state. It does not connect to MLflow, launch Python training, recompute accuracy, rerun a release guard or publish a model unless an application explicitly performs those separate operations. Retain the artifact bytes when independent numerical checking is required.

## Test the dependency boundary

From the SDK checkout:

```sh
python3 -I -S python/tests/test_workflow.py -v
```

This suite uses an import blocker and a Python process without site packages to exercise standalone import and local artifact binding. It also checks mutation refusal, protocol failures, bounded writes/timeouts and, when the built worker and Node are available, the native capture connection. Fake-client tests check the binding contract. The real MLflow example checks integration separately. Neither test category proves arbitrary model semantics.
