# Bring your own trainer: first run

This example checks a model swap and explains the saved decision after the trainer has stopped. It uses real NumPy training on a small, deterministic regression problem. It is a CPU reference integration, not a benchmark or a general trainer.

## Install a released beta

Use Node.js 22+ and Python 3.11 or 3.12 for the pinned NumPy reference trainer. The beta CI targets Node 22/24 and Python 3.11/3.12 with NumPy 2.2.6; see [COMPATIBILITY.md](COMPATIBILITY.md).

Create a new directory and install the exact beta archive plus the example’s workflow/investigation packages:

```sh
mkdir footprint-ml-try
cd footprint-ml-try
npm init -y
npm install https://github.com/footprintjs/footprintjs-ml/releases/download/v0.6.0-beta.1/footprintjs-ml-0.6.0-beta.1.tgz footprintjs@10.0.0 agentfootprint@11.0.0 foottrace@1.8.0
python3 -m venv .venv
.venv/bin/python -m pip install numpy==2.2.6
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`. Python, NumPy and numerical frameworks are not installed or started by importing the SDK.

## Run the model swap

```sh
npx --no-install footprint-ml demo --out ./quickstart-run --python .venv/bin/python
```

The workflow trains model A, records A’s evaluation, then continues to a changed model B. It proposes B with A’s old receipt. The release guard must reject that mismatch. A new evaluation of B produces matching evidence and an allowed decision. The example records those outcomes and closes its Python worker.

An allowed decision in this quickstart is a release check. It does not upload or deploy the model to a remote registry.

The output directory contains `recording.json`, `outcome.json` and the numerical artifacts needed to inspect what ran. Keep this directory to investigate the run later. References identify recorded artifacts; they are not live handles after the trainer closes.

## Reopen the saved decisions

Run these as separate commands after the training command exits:

```sh
npx --no-install footprint-ml investigate --run ./quickstart-run --decision stale
npx --no-install footprint-ml investigate --run ./quickstart-run --decision fresh
```

The investigator opens the saved FootPrint record through Lens/foottrace. It should identify the stage that changed the model reference, the earlier evaluation writer, and the selected release decision. The stale investigation writes `investigation.json`; the fresh investigation writes `investigation-fresh.json`. It does not start Python, rerun training or recompute a score.

## Connect your trainer

Start with [examples/quickstart/trainer.py](examples/quickstart/trainer.py). Replace its numerical work with calls to your existing training code, using the hooks in the [adapter guide](ADAPTER.md) and [Python protocol](python/README.md). The workflow can then run that plugin with its explicit plan:

```sh
npx --no-install footprint-ml demo --plugin /path/to/trainer.py --plan /path/to/plan.json --out ./my-run --python .venv/bin/python
```

The hooks cover initialization, training, evaluation, complete checkpoint state, restore and inference identity. The identity profile must include what your predictions depend on. Weights alone are insufficient if fitted preprocessing, model architecture or input/label interpretation can change. The adapter measures what your hooks expose; it cannot determine whether your declarations are complete.

The numerical trainer stays in Python. FootPrint’s workflow driver runs in JavaScript and carries references and small observations across the boundary. From a source checkout, `python examples/quickstart/run.py --out ./quickstart-run` is a convenience launcher that uses the current Python interpreter and delegates orchestration to Node. This beta does not provide a native Python implementation of the FootPrint engine.

## Build and verify from source

```sh
git clone https://github.com/footprintjs/footprintjs-ml.git
cd footprintjs-ml
npm ci
npm run build
npm test
python3 -m venv .venv
.venv/bin/python -m pip install -r examples/quickstart/requirements.txt
PYTHON="$PWD/.venv/bin/python" npm run beta:smoke
```

The smoke check is the clean-install acceptance test: it packs the SDK, installs it into a temporary consumer, runs the quickstart against the installed package, and reopens its recording in a new process. It must fail if the wrong-model proposal is accepted or the saved investigation cannot explain the decisions. Python and NumPy must be available to the smoke check’s selected Python interpreter.

You can also create a tarball for another local project with `npm pack`, then install the resulting `footprintjs-ml-0.6.0-beta.1.tgz` using `npm install /path/to/footprintjs-ml-0.6.0-beta.1.tgz`. This uses the package you built and does not require an npm registry publication.
