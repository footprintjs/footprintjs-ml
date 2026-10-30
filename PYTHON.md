# Use FootPrint ML from Python

Your Python application keeps control of training, evaluation and retries. FootPrint records explicit reference reads and writes through a local Node helper, then Lens/foottrace can inspect the saved record. The Python wheel and npm archive are two distributions of the same SDK and version; this does not introduce another ML framework.

## Install into your environment

Prerequisites: Python 3.11+ and Node.js 22+ with npm. The current CI targets Python 3.11/3.12 and Node 22/24 on Ubuntu. Create an environment, install the wheel, then explicitly install and check its helper:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install https://github.com/footprintjs/footprintjs-ml/releases/download/v0.6.0-beta.12/footprintjs_ml-0.6.0b12-py3-none-any.whl
.venv/bin/python -m footprint_ml_workflow setup
.venv/bin/python -m footprint_ml_workflow doctor
```

Windows uses `.venv\Scripts\python.exe` instead of `.venv/bin/python`. The wheel is a GitHub release asset, not a PyPI publication. The Python version `0.6.0b12` corresponds to npm version `0.6.0-beta.12`.

The wheel has no required Python packages. It does not install MLflow, NumPy, scikit-learn or JAX. Importing the module and constructing a capture object do not install dependencies or launch a process. The optional numerical trainer adapter still needs NumPy when explicitly used.

`setup` is an explicit network operation. It installs exactly the matching SDK archive plus `foottrace@1.8.0`, `agentfootprint@11.0.0` and `footprintjs@10.0.0` in the environment's `share/footprintjs-ml/0.6.0-beta.12` directory. npm lifecycle scripts, audit and funding requests are disabled. The packages support recording and the existing saved investigation tools; they do not become dependencies of the SDK core. Node and npm must already be installed.

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

## Use the existing evidence guards from Python

A started `WorkflowCapture` exposes the same JSON contracts used by the TypeScript API. Python method names use snake_case; request and response fields retain camelCase names such as `modelRef`, `datasetRef` and `splitManifest`.

| Task | Python methods |
| --- | --- |
| Evaluation evidence | `create_evaluation_receipt`, `read_evaluation_receipt`, `check_release` |
| Data-use evidence | `create_data_lineage_receipt`, `read_data_lineage_receipt`, `check_data_lineage` |
| Candidate comparison | `read_selection_manifest`, `create_selection_receipt`, `read_selection_receipt`, `check_selection` |
| Actual prediction context | `create_prediction_contract`, `read_prediction_contract`, `create_inference_receipt`, `read_inference_receipt`, `check_inference` |

Each method takes one plain JSON object and calls the existing TypeScript implementation in the explicit Node helper. The receipt readers validate saved claims; they do not rerun numerical evaluation. No additional Python framework or copy of the guard algorithms is installed.

These helpers do not automatically record their operands or returned values. Inside a stage, read actual observations and independent expected authority through scope, then write the returned receipt or decision when it belongs in the history. For example, given caller-populated scope keys:

```python
with capture.stage("check-selected-model") as scope:
    decision = capture.check_selection({
        "receipt": scope["offeredSelectionReceipt"],
        "manifest": scope["expectedSelectionManifest"],
        "results": scope["expectedCandidateResults"],
        "modelRef": scope["modelRef"],
        "now": scope["decisionTime"],
    })
    scope["selectionDecision"] = decision
```

The expected manifest/results must be retained independently of the offered receipt. For lineage, observed memberships, overlap counts and fitted-preprocessing inputs come from the backend; missing evidence remains unknown. A guard authorizes only when `allowed` is explicitly true. Compose the quality, selection and data-use checks required by the application.

Python keeps its training code, candidate loop, branches and retries. `runExperiment` remains a TypeScript callback driver. Calling a helper requires an open capture connection, but no active stage; calls outside stages have no automatic scope provenance. See the [data-lineage guide](DATA-LINEAGE.md), [selection guide](SELECTION.md) and [retained-observation Python proof](examples/python-guards/README.md).

Try the retained-observation guard proof after setup, using only the Python standard library and the explicit Node helper:

```sh
.venv/bin/python -m footprint_ml_workflow example-guards --out ./python-guard-run
.venv/bin/python -m footprint_ml_workflow investigate --run ./python-guard-run --variable wrongSelectionDecision
```

This checks recorded JAX candidate results and separate digit-lineage evidence. It does not train or numerically re-evaluate a model, and it does not publish one. The second command reopens saved scope history after the example's capture worker exits. Use a new output directory for each run.

## Publish an exact checked artifact

The started facade also delegates the existing release APIs. It uses the Node file artifact store; numerical arrays and model buffers do not travel through JSON packets or scope.

| Python method | Purpose |
| --- | --- |
| `put_release_artifact(file_path, *, store_root, format)` | Import actual local bytes into the managed release store and return their reference. |
| `read_model_release_plan(input)` | Validate an independently authorized plan with the core reader. |
| `prepare_model_release(input, *, store_root, verify_model)` | Load pinned evidence, compose the guards and verify the actual live model. |
| `publish_model_release(input, *, store_root, publisher, verify_model=None)` | Reconstruct approval and hand off exact bytes, or acknowledge an existing matching publication. |
| `release_model(input, *, store_root, publisher, verify_model=None)` | Use the same core convenience operation; new publication requires live verification. |

Request fields retain camelCase: preparation takes `planRef`, `modelRef` and optional `now`; publication also takes `preparedRef`. `verify_model(request)` returns a measured actual `ModelRef`. The publisher implements `publish(request)` and optional read-only `lookup(request)`. Callback requests contain the semantic payload, canonical payload string, digest and preparation reference. Publication additionally supplies a managed `modelArtifact` reference to the exact approved bytes in `store_root`.

Artifact import is a general whole-file operation bounded to the opened descriptor's size. It has no automatic 132 MiB predictor-profile cap; the MLflow receiver applies that separate cap after import. The application must control import sizes and memory use. This is not streaming or constant-memory transfer.

Read actual release inputs through scope and assign returned metadata to scope. Callbacks cannot issue nested capture or scope requests. They run on bounded helper threads; a timeout does not cancel an external client operation. An uncertain effect remains unknown. Keep client timeouts and recovery policy explicit rather than blindly repeating a registry update.

`from footprint_ml_promotion import MlflowModelPublisher` supplies an optional receiver for one pre-existing registered MLflow version backed by one complete artifact under a canonical `runs:/` source. It imports no MLflow itself. The application injects its client and coordinates all writers using the same local journal/lock. See [checked MLflow promotion](MLFLOW.md#checked-registered-model-promotion), the [release boundary](RELEASE.md#python-release-callbacks-and-mlflow-promotion) and the [real local proof](examples/mlflow-promotion/README.md).

After setup, explicitly install the example dependencies and launch the packaged proof:

```sh
python -m pip install numpy==2.2.6 mlflow==3.17.2
python -m footprint_ml_workflow example-promotion --out ./promotion-run
python -m footprint_ml_workflow investigate --run ./promotion-run --variable approvedMlflowPromotion
```

## Check a prediction backend's actual model and contract

`create_prediction_contract`, `read_prediction_contract`, `create_inference_receipt`, `read_inference_receipt` and `check_inference` use the same core JSON functions as TypeScript. The backend must observe the model actually loaded in its cache and the input/output contract it executed. Copying the requested model or expected feature order into a receipt does not detect a stale cache. Supply expected context independently; missing actual model/contract evidence remains unknown.

Read the [inference guide](INFERENCE.md) for the complete input shape, ordered fields, dtype/unit/class-label comparisons and invocation bindings. Store only actual model/contract and input/output references plus small observations in scope. Numerical arrays stay in the backend or artifact files. Helpers do not automatically record their operands or results.

The [inference example](examples/inference/README.md) uses a real local numerical worker with explicit NumPy and scikit-learn application dependencies. It checks a wrong cached model, repaired cache and same-shape feature-order control while retaining rejected output privately. Its [requirements](examples/inference/requirements.txt) do not become SDK dependencies. An inference check does not publish a model, start a hosted serving system or prove numerical correctness.

After helper setup, install those example-only requirements and use a fresh output directory:

```sh
.venv/bin/python -m pip install numpy==2.2.6 scikit-learn==1.7.2
.venv/bin/python -m footprint_ml_workflow example-inference --out ./inference-run
.venv/bin/python -m footprint_ml_workflow investigate --run ./inference-run --variable staleDecision
```

The first run performs the example's numerical work. The investigation command only reopens its saved state after the workers exit. A matching model alone does not excuse a mismatched input/output contract; both are checked against the caller's independent request. The `example-inference` launcher remains the Python-owned `WorkflowCapture` path. For actual FootPrint-owned function/decider stages and native stage retry, use the Node commands in the [workflow-ownership guide](INFERENCE.md#choose-workflow-ownership) with the same numerical Python interpreter. That native path does not require another Python capture process.

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

## Paired baseline/group regression

The started capture exposes `read_regression_manifest(input)`, `create_regression_receipt(input)`, `read_regression_receipt(input)` and `check_regression(input)`. These call the same TypeScript core; they add no numerical dependency. Keep JSON fields camelCase and read the actual operands through scope before calling a guard. The [regression guide](REGRESSION.md) defines missing/insufficient evidence, absolute tolerances, binding and freshness behavior. The [numerical example](examples/regression/README.md) trains two ordinary regressions on fixed imbalanced data, refuses a worse predefined group despite an overall improvement, then reopens saved evidence without training.

For release composition, the independently pinned plan's optional `regression` block names managed `manifestRef`, `observationsRef` and `receiptRef` artifacts. Its presence requires the check in existing `prepare_model_release`/`publish_model_release`/`release_model` calls.

## Monitoring a deployed model on a closed batch

The started capture exposes `read_monitoring_manifest(input)`, `create_monitoring_receipt(input)`, `read_monitoring_receipt(input)` and `check_monitoring(input)` through the same TypeScript core. The [monitoring guide](MONITORING.md) defines the deployment, event-time window, actual prediction, delayed-label join, coverage and evaluation evidence. Keep actual data/model arrays in the backend and read the consumed references through scope. A recommendation records a decision; it does not pause or replace a service. The [numerical proof](examples/monitoring/README.md) reopens its saved result without predicting or training again.
