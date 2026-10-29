# Catch a stale inference cache using actual backend observations

This folder offers two workflows over one persistent numerical worker: Python-owned capture and an actual native FootPrint chart. Both keep models and arrays in the worker or safe numeric artifact files, while scope holds references, receipts and decisions. Neither is a hosted inference platform.

## Python-owned capture

Install the optional example dependencies in your numerical environment and choose a fresh output directory:

```sh
python -m pip install -r examples/inference/requirements.txt
python examples/inference/run.py --out ./inference-run
```

Use the matching installed Python SDK/helper or a built source checkout. `--runtime-dir DIR` selects an explicit installed helper. The controller prefers an installed SDK before using its source fallback. In this path Python owns the stages, branches and retries. `WorkflowCapture` records its explicit scope operations through the foottrace writer; no FootPrint executor is running.

## Native FootPrint stages, deciders and retry

Use the explicit Node workflow packages from [the quickstart](https://github.com/footprintjs/footprintjs-ml/blob/main/QUICKSTART.md), plus the numerical requirements above. From the SDK source/package root:

```sh
node examples/inference/native-run.mjs --out ./native-inference-run --python .venv/bin/python
node examples/inference/native-investigate.mjs --run ./native-inference-run
```

From another project, use the corresponding paths under `node_modules/footprintjs-ml/`. `--out` must be a new directory; `--python` selects the numerical environment. This command is a Node-owned workflow, not the Python `example-inference` launcher.

The [native workflow](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/native-run.mjs), using its [numerical client](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/native-client.mjs), gives an actual `FlowChartExecutor` control of the chart's function and decider stages. A declared native stage retry handles a controlled transient backend failure; the corrected prediction's invocation ID stays fixed across that retry. Deciders route inference outcomes into blocked or handoff branches. The implementation retains the real executor snapshot and attached public control/decision observations rather than manufacturing a commit log from callbacks.

The recording uses the native inference envelope, and the shared outcome keeps `execution.orchestration: 'footprintjs-flowchart'`. Saved keys include `wrongInferenceDecision`, `correctedInferenceDecision` and `releasedPredictionRef`. These names differ from the Python path's `staleDecision` and `correctedDecision`. The native investigator reads the saved record with backend spawning forbidden. The workflow explicitly retains public control-recorder lookup results and the [example control adapter](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/native-control.mjs) reopens them through the existing toolpack bridge after checking run, commit and governing-decider references. The investigator compares this control-enabled result with a snapshot-only baseline that still reports missing control lookup. This adapter supplies no producer authentication or end-to-end capture attestation.

The worker remains the same numerical boundary. Native retry state rollback does not undo worker, file or external effects. This example does not establish crash durability, authenticated backend observations or production serving guarantees.

## Shared numerical proof

The fixtures retain the real digit classifier A, fitted scaler S1 and fixed train/validation data from the earlier MLflow proof. Their original source hashes are checked before use. Before observing B's results, the worker trains B once with the predetermined regularization setting `C=0.0001`, using the same training rows and S1. The inference batch is always the first 64 validation rows; neither setting is tuned to manufacture a difference.

See [dataset attribution and derived split details](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/DATASET.md) for the bundled digit observations.

The application freshly evaluates A and checks its own receipt against a predeclared accuracy policy. It independently retains approved A and an ordered input/output contract. A later cache-load stage mistakenly loads B. The backend prediction call uses that cache and does not receive the independently approved A reference. Its receipt reports B's actual model state, so the native inference guard blocks the output handoff. The same worker then loads A and produces a new accepted output.

Two further controls preserve the distinction between model identity and contract evidence: actual A predicts after a deliberate feature-column reversal, and a derived receipt omits its model observation. Reordered fields are denied; missing model evidence remains unknown.

Every real prediction measures the consumed classifier coefficients, intercepts, classes and fitted scaler from memory before and after computation. The original model file hash is separate audit evidence. Actual model/contract observations are not copied from the request. Input/output artifact identities, invocation IDs and row counts bind each result to its call.

Before retaining a receipt, the caller reads the recorded `cacheObservation` and requires its actual model identity, worker/session and cache generation to agree with the prediction's backend observation. That checked dependency connects prediction evidence to the preceding cache-load stage. FootPrint does not automatically observe worker internals or external cache side effects; this application supplies and checks their observations.

`recording.json` is captured live and its `outcome` scope value equals `outcome.json`. Blocked raw predictions remain private debugging artifacts. Only an allowed result becomes `releasedPredictionRef`; this is an application handoff, not a remote deployment. Backend warnings are forwarded and retained in `backend.stderr.log`.

To reproduce the small numerical fixtures from the retained original run, use `prepare_fixtures.py --source-run ORIGINAL_RUN --out NEW_FIXTURE_DIRECTORY`. No unsafe pickle or executable checkpoint loader is used. Saved-record investigation can later explain the identities and cache writers without repeating numerical work.

For a separate numerical check, run `python -I -S examples/inference/audit.py --run ./inference-run`. This standard-library-only audit verifies the retained artifact/memory fingerprints and recomputes all three label arrays with explicit scaling, scalar dense scores and class argmax. It also checks A's full validation accuracy. It writes a new `audit.json` without modifying the original recording or outcome. It does not verify training or diagnose numerical-backend warnings.
