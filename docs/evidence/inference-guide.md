# Catch a stale inference cache using actual backend observations

This is a local Python application with one persistent numerical worker. FootPrint records references, receipts and decisions; models and arrays stay in the worker or safe numeric artifact files. It is not a hosted inference platform.

Install the optional example dependencies in your numerical environment and choose a fresh output directory:

```sh
python -m pip install -r examples/inference/requirements.txt
python examples/inference/run.py --out ./inference-run
```

Use the matching installed Python SDK/helper or a built source checkout. `--runtime-dir DIR` selects an explicit installed helper. The controller prefers an installed SDK before using its source fallback.

The fixtures retain the real digit classifier A, fitted scaler S1 and fixed train/validation data from the earlier MLflow proof. Their original source hashes are checked before use. Before observing B's results, the worker trains B once with the predetermined regularization setting `C=0.0001`, using the same training rows and S1. The inference batch is always the first 64 validation rows; neither setting is tuned to manufacture a difference.

See [dataset attribution and derived split details](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/DATASET.md) for the bundled digit observations.

The application freshly evaluates A and checks its own receipt against a predeclared accuracy policy. It independently retains approved A and an ordered input/output contract. A later cache-load stage mistakenly loads B. The backend prediction call uses that cache and does not receive the independently approved A reference. Its receipt reports B's actual model state, so the native inference guard blocks the output handoff. The same worker then loads A and produces a new accepted output.

Two further controls preserve the distinction between model identity and contract evidence: actual A predicts after a deliberate feature-column reversal, and a derived receipt omits its model observation. Reordered fields are denied; missing model evidence remains unknown.

Every real prediction measures the consumed classifier coefficients, intercepts, classes and fitted scaler from memory before and after computation. The original model file hash is separate audit evidence. Actual model/contract observations are not copied from the request. Input/output artifact identities, invocation IDs and row counts bind each result to its call.

Before retaining a receipt, the caller reads the recorded `cacheObservation` and requires its actual model identity, worker/session and cache generation to agree with the prediction's backend observation. That checked dependency connects prediction evidence to the preceding cache-load stage. FootPrint does not automatically observe worker internals or external cache side effects; this application supplies and checks their observations.

`recording.json` is captured live and its `outcome` scope value equals `outcome.json`. Blocked raw predictions remain private debugging artifacts. Only an allowed result becomes `releasedPredictionRef`; this is an application handoff, not a remote deployment. Backend warnings are forwarded and retained in `backend.stderr.log`.

To reproduce the small numerical fixtures from the retained original run, use `prepare_fixtures.py --source-run ORIGINAL_RUN --out NEW_FIXTURE_DIRECTORY`. No unsafe pickle or executable checkpoint loader is used. Saved-record investigation can later explain the identities and cache writers without repeating numerical work.

For a separate numerical check, run `python -I -S examples/inference/audit.py --run ./inference-run`. This standard-library-only audit verifies the retained artifact/memory fingerprints and recomputes all three label arrays with explicit scaling, scalar dense scores and class argmax. It also checks A's full validation accuracy. It writes a new `audit.json` without modifying the original recording or outcome. It does not verify training or diagnose numerical-backend warnings.
