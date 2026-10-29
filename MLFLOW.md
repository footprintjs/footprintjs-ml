# Python workflows with MLflow evidence

Keep training, evaluation, control flow and retries in your Python application. The optional FootPrint ML capture bridge records explicit JSON reads and writes with the existing native foottrace writer. MLflow continues to own its experiments, runs, artifacts and registered model versions.

This integration is a beta addition with a local Node capture process. Python controls its own workflow. The bridge uses the native foottrace writer directly, without a FootPrint executor or automatic Python branch instrumentation.

## Dependencies and loading

| Part | Dependencies and behaviour |
| --- | --- |
| npm root SDK | No runtime dependencies. Importing the core does not load the Python capture process. |
| `python/footprint_ml_workflow.py` | Python 3.11+ standard library only. Importing it, constructing `WorkflowCapture`, or constructing `MlflowArtifacts` starts no process and imports no MLflow or numerical framework. |
| Capture worker | Node.js 22+ and the host's explicit foottrace installation. Entering `WorkflowCapture` or calling `start()` launches the shipped worker. |
| MLflow binding | An application-supplied client. The module does not import MLflow, install it, create runs, change aliases or select credentials. |
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

The values above illustrate the shape. `read_bytes(ref)` rechecks the bound digest and length, then returns that same checked buffer. It refuses altered cache contents and references that were not bound by that `MlflowArtifacts` instance. `local_path(ref)` verifies before returning a path, but a subsequent file open can observe a later change. Prefer `read_bytes` at the actual consumption boundary.

Hashes identify the bytes compared. They do not authenticate the original trainer, prove that the model is correct or establish that a predictor profile includes every relevant dependency. An MLflow run ID or tag is not an approval authority. Network configuration, credentials and download timeouts remain responsibilities of the injected client.

Uploading evidence is explicit: `artifacts.log_recording(run_id, path)` calls the client's `log_artifact`. Binding or closing capture does not upload anything automatically.

## Capture and retry semantics

`with capture.stage(stage_id, name=None, attempt=None, retry_of=None) as scope` opens a stage. Normal exit commits its writes. An application exception discards pending writes and records the failed attempt with a bounded error description. The exception still propagates. Your Python `try/except` decides whether to retry and passes the failed `scope.runtime_stage_id` as `retry_of` when appropriate.

`scope[key]` reads through the worker and raises `KeyError` for a missing key. `scope.get(key, default)` distinguishes absence from a stored `None`. Assignment and `scope.set(key, value)` write through the same connection. Values must be finite, plain JSON, at most 64 KiB per value. Arrays, models and dataframes stay in the Python application or artifact files.

The direct writer does not apply a FootPrint executor's redaction policy. The application chooses the references and small metadata it records, and omits or filters sensitive values before capture. Failed stages also record a bounded exception message, so application exceptions need the same care.

These are whole-key JSON operations. Reads return detached values. Assign modified nested objects back through scope to record a change. A closure, ordinary Python object mutation or numerical operation outside these explicit calls is not automatically traced. Merely storing an equivalent value elsewhere in scope cannot establish that a stage consumed it.

`capture.create_evaluation_receipt(input)` and `capture.check_release(input)` call the existing TypeScript ML contracts through the worker. Read their operands through scope and write the returned receipt or decision through scope when they belong in the workflow history. A helper call does not invent those dependencies or write its result automatically.

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

## Reopen the saved run

Once the application exits, the existing saved-recording tools can backtrack a captured result or receipt using `recording.json`. The model and preprocessing references connect the captured workflow to MLflow's artifacts. See [BACKTRACKING.md](BACKTRACKING.md) for generic value tracing and the [example guide](examples/mlflow/README.md) for its reproduction and evidence files.

Investigation reads recorded state. It does not connect to MLflow, launch Python training, recompute accuracy, rerun a release guard or publish a model unless an application explicitly performs those separate operations. Retain the artifact bytes when independent numerical checking is required.

## Test the dependency boundary

From the SDK checkout:

```sh
python3 -I -S python/tests/test_workflow.py -v
```

This suite uses an import blocker and a Python process without site packages to exercise standalone import and local artifact binding. It also checks mutation refusal, protocol failures, bounded writes/timeouts and, when the built worker and Node are available, the native capture connection. Fake-client tests check the binding contract. The real MLflow example checks integration separately. Neither test category proves arbitrary model semantics.
