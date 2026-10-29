# Keep the ML workflow in Python; investigate its saved FootPrint evidence

This example trains a real scikit-learn digit classifier once, using the bundled digits dataset and a fixed stratified split. It stores safe numeric weights, fitted preprocessing and data in a real local MLflow experiment and creates a local registered model version. No model pickle or executable checkpoint loader is used.

The Python application owns training, its `try/except` retry and its decisions. `WorkflowCapture` records explicit scope reads and writes with the native foottrace writer through the optional FootPrint ML bridge. It uses no FootPrint executor and does not automatically instrument Python branches. `MlflowArtifacts` receives the application's MLflow client and measures downloaded artifact bytes; the capture library itself does not import MLflow, NumPy or scikit-learn.

From the package root, install the example dependencies into a separate environment:

For a released wheel, [the Python guide](../../PYTHON.md) provides `setup`, `doctor`, `example-mlflow` and `investigate` commands without source-checkout paths. The commands below are the source/archive reproduction path.

```sh
python3.12 -m venv .mlflow-venv
.mlflow-venv/bin/python -m pip install -r examples/mlflow/requirements.txt
.mlflow-venv/bin/python examples/mlflow/run.py --out ./mlflow-proof-run
```

The capture sidecar requires Node.js 22+ and the optional workflow/investigation packages documented in the main quickstart. The output path must be new. Tracking uses an explicit SQLite database and artifact directory inside that path, with no MLflow server or remote registry.

The classifier is trained with scaler S1. Before validation, the example also creates a deliberately incompatible scaler S2 by fitting shifted training inputs. This fault is fixed in advance; it does not tune against held-out accuracy. A selection attempt fails before committing state; an ordinary Python retry mistakenly selects S2. The trained weights and raw held-out data remain unchanged.

The example then:

1. Validates S1 and records a matching evaluation receipt.
2. Measures the predictor selected by retry and asks the existing release guard to check S1's stale receipt for S2.
3. Evaluates S2 using the same weights and raw held-out data, recording the actual consumed preprocessing identity.
4. Restores S1, evaluates again and records the exact locally approved predictor.

The native TypeScript receipt and guard functions run behind the capture connection; the example does not implement another guard. Each predictor identity combines the measured model-source artifact with the fitted-scaler artifact and the prediction contract. The local MLflow registered version identifies the safe classifier source; it does not alone identify the complete predictor when preprocessing changes.

`recording.json` is captured during execution. `outcome.json` contains observed accuracy, MLflow run/experiment/model-version identifiers, actual consumed artifact digests, retry metadata and guard decisions. Subsequent investigation can use saved JSON without repeating training or evaluation. The example records local approval; it does not change a registry alias or deploy a model.

An optional independent check uses only Python's standard library:

```sh
python -I -S examples/mlflow/audit.py --run ./mlflow-proof-run
```

It verifies retained artifact bytes against the recorded identities and recomputes predictions with explicit scaling and dense linear-score arithmetic. It creates a new `audit.json` and preserves the recording and outcome. This verifies inference from saved parameters, not the training algorithm. The original macOS numerical run emitted matrix-multiplication warnings despite finite saved parameters and scores matching this independent check; their cause remains undiagnosed.
