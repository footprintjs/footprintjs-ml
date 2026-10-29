# Use FootPrint ML from Python

Your Python application keeps control of training, evaluation and retries. FootPrint records explicit reference reads and writes through a local Node helper, then Lens/foottrace can inspect the saved record. The Python wheel and npm archive are two distributions of the same SDK and version; this does not introduce another ML framework.

## Install into your environment

Prerequisites: Python 3.11+ and Node.js 22+ with npm. The current CI targets Python 3.11/3.12 and Node 22/24 on Ubuntu. Create an environment, install the wheel, then explicitly install and check its helper:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install https://github.com/footprintjs/footprintjs-ml/releases/download/v0.6.0-beta.5/footprintjs_ml-0.6.0b5-py3-none-any.whl
.venv/bin/python -m footprint_ml_workflow setup
.venv/bin/python -m footprint_ml_workflow doctor
```

Windows uses `.venv\Scripts\python.exe` instead of `.venv/bin/python`. The wheel is a GitHub release asset, not a PyPI publication. The Python version `0.6.0b5` corresponds to npm version `0.6.0-beta.5`.

The wheel has no required Python packages. It does not install MLflow, NumPy, scikit-learn or JAX. Importing the module and constructing a capture object do not install dependencies or launch a process. The optional numerical trainer adapter still needs NumPy when explicitly used.

`setup` is an explicit network operation. It installs exactly the matching SDK archive plus `foottrace@1.8.0`, `agentfootprint@11.0.0` and `footprintjs@10.0.0` in the environment's `share/footprintjs-ml/0.6.0-beta.5` directory. npm lifecycle scripts, audit and funding requests are disabled. The packages support recording and the existing saved investigation tools; they do not become dependencies of the SDK core. Node and npm must already be installed.

The helper is checked in a temporary sibling directory before it is made available. A failed setup preserves the prior runtime. A completed matching installation can be checked again. `doctor` is read-only: it checks versions and imports without starting a trainer or connecting to MLflow. It is an environment check, not an authenticity or security certificate. Release `SHA256SUMS` identifies the distributed files.

To use a project-local helper instead, pass `--runtime-dir ./my-helper` to setup and doctor and `runtime_dir="./my-helper"` to `WorkflowCapture`. The default installation requires a virtual environment; an explicit project directory also works outside one. Importing or entering a capture never silently installs a missing helper.

## Add recording around existing work

```python
from footprint_ml_workflow import WorkflowCapture

with WorkflowCapture("./recording.json") as capture:
    with capture.stage("choose-model") as scope:
        scope["modelArtifact"] = measured_model_reference
    with capture.stage("evaluate-model") as scope:
        model_reference = scope["modelArtifact"]
        score = your_existing_evaluator(model_reference)
        scope["accuracy"] = float(score)
```

The references should identify the bytes actually consumed, including fitted preprocessing where relevant. Tensors and model objects stay in the numerical code or artifacts. Capture is explicit; unrecorded Python variables and arbitrary control dependencies are not automatically observed. See [the MLflow guide](MLFLOW.md) for checked artifact reads and the existing evaluation/release contracts.

## Try the MLflow example

Install the example's numerical dependencies yourself, then run the packaged example:

```sh
.venv/bin/python -m pip install mlflow==3.17.2 scikit-learn==1.7.2 numpy==2.2.6
.venv/bin/python -m footprint_ml_workflow example-mlflow --out ./my-mlflow-run
.venv/bin/python -m footprint_ml_workflow investigate --run ./my-mlflow-run --variable faultyReceipt
```

The example performs real training and evaluation against a local MLflow store. The investigation command runs the existing saved-recording tools in a separate Node process without permission to start a trainer. It reads JSON; it does not repeat numerical work. Use a new output path for every run and preserve the saved evidence.

For an adoption check without training another model, [the Python integration pilot](examples/python-adoption/README.md) compares an unchanged evaluator with and without capture against an existing retained MLflow run. Its code counts and recording size describe that controlled local integration, not independent developer productivity.

## Use the bundled coding skill

The wheel includes the same [feature guides](features/README.md) and [FootPrint ML skill](skills/footprintjs-ml/SKILL.md) as the repository. They install under the environment's `share/footprintjs-ml/` directory. Find the skill without starting the Node helper:

```sh
python -c "from pathlib import Path; import sysconfig; print(Path(sysconfig.get_path('data')) / 'share/footprintjs-ml/skills/footprintjs-ml/SKILL.md')"
```

Ask your coding agent to read that file and your existing workflow, or copy its containing skill directory into the agent's configured skill location. Library installation leaves agent configuration unchanged. The skill links to the relevant feature and actual APIs; the Python facade's supported contracts remain those documented above and in [MLFLOW.md](MLFLOW.md).

## Build the wheel from this repository

The Python build uses the standard setuptools backend. Build tools are development dependencies, not wheel runtime dependencies:

```sh
python3 -m venv .build-venv
.build-venv/bin/python -m pip install 'setuptools>=77.0.3' wheel
PYTHON="$PWD/.build-venv/bin/python" npm run build:python
```

This creates the wheel in `python-dist/`. The release acceptance check installs it into a fresh environment outside the checkout and provisions the helper from the locally packed SDK archive before recording and reopening a small run. Standard Python packaging is described in the [Python Packaging User Guide](https://packaging.python.org/en/latest/tutorials/packaging-projects/).
