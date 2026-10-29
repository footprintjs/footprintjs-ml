# Measure a Python capture integration with existing MLflow artifacts

This pilot compares an ordinary Python evaluator with an opt-in capture wrapper. Both call the **same evaluator function** and consume the existing MLflow proof's weights, fitted scalers and raw validation data. It trains no new model and requests no MLflow writes. Each path recomputes three evaluation results so their outputs and consumed-byte identities can be compared.

This is a local integration inventory. The evaluator was extracted from the preceding controlled example. It is not an independent developer adoption trial, a timing study or proof that another team's workflow needs the same number of changes.

## Install and run

Use the installed Python wheel and prepared optional runtime described in [PYTHON.md](../../PYTHON.md). Install the MLflow example's dependencies into that environment:

```sh
python -m pip install -r examples/mlflow/requirements.txt
```

The source run must be the existing output of [the MLflow proof](../mlflow/README.md), including `tracking.db`, retained artifacts, `recording.json` and `outcome.json`. The pilot first verifies that its outcome sidecar equals the outcome inside the original recording. It does not create a replacement training run.

From the SDK checkout, using the Python environment containing the installed wheel:

```sh
python examples/python-adoption/run.py \
  --source-run /path/to/existing-mlflow-proof \
  --out /path/to/new-adoption-pilot \
  --forbid-sdk-root /path/to/footprintjs-ml-checkout
```

An explicit `--runtime-dir /path/to/prepared-runtime` is available. Otherwise the installed capture client's default runtime discovery applies. `--forbid-sdk-root` makes the pilot fail if either the imported capture module or the Node worker resolves inside that checkout. There are no SDK `sys.path` modifications in this pilot. The example's own numerical helper remains local application code.

To run wholly outside the checkout, copy the `python-adoption` folder to another directory and execute its `run.py` with the same arguments. The installed wheel supplies capture, and the configured runtime supplies the Node helper. The source-run path still points to the retained artifacts.

The output path must be new. Files include `baseline-outcome.json`, `captured-outcome.json`, `recording.json`, `adoption-report.json` and a literal `integration.patch` between the baseline and wrapper drivers. Download caches contain numerical artifacts and are not needed merely to read the report.

## What is measured

- Exact equality of the two returned result objects, including actual consumed artifact digests and predictor identity.
- The unchanged evaluator function and numerical-helper source hashes.
- Physical and nonblank source lines, imported SDK symbols, stage call sites and scope read/write sites, counted from the actual files and Python syntax tree.
- Literal added/removed lines between the two driver files. This is textual inventory, not semantic edit distance or developer effort.
- Actual capture module/worker paths, worker exit status, recorded stage attempts/commits, recording bytes and recording digest.
- Calls through each injected MLflow client facade. These are caller-level API calls, not internal storage or HTTP request counts.

The report keeps the shared numerical code separate from the integration drivers. `numerical.py` is an unchanged copy of the preceding example's helper. `existing_evaluator.py` extracts its scope-free prediction/evaluation function. `baseline.py` chooses preprocessing with ordinary Python control flow. `wrapped.py` adds explicit capture calls around that same work.

The frozen scenario evaluates S1, injects a failed selection attempt, retries with the incompatible S2, then restores S1. Python owns that retry in both drivers. The captured path records the discarded attempt and links the committed retry. It does not infer arbitrary Python branches or locals.

## What remains outside this pilot

No human speed, superior diagnosis, broad adoption, runtime-overhead percentage, deployment guarantee or new model quality is measured. The original numerical backend emitted matrix warnings whose cause remains undiagnosed; the preceding independent saved-artifact audit corroborates its finite aggregate accuracies. This pilot preserves the same numerical function rather than introducing another inference algorithm.

The minimal wrapper records metrics and references without adding evaluation receipts or release guards. The preceding MLflow proof separately tests those contracts. Root-cause investigation is also separate: the existing CLI can later backtrack `faultyScore` in the saved recording. This pilot implements no new queries and runs none automatically.
