# Check the model and meaning used for a prediction

A model can have valid evaluation and release evidence while an inference process still uses an old model from its cache. A tensor can also keep the same dimensions while its columns, units or class-label mapping mean something different. Inference evidence records what the prediction backend observed for one invocation, then compares those observations with the caller's independently supplied expectation.

This feature adds `createPredictionContract`, `readPredictionContract`, `createInferenceReceipt`, `readInferenceReceipt` and `checkInference` to the root API. They are pure JSON functions. They do not start a trainer, inspect a cache, read artifact files, calculate a prediction or publish an output.

## Declare the prediction contract

`createPredictionContract(input)` accepts:

```ts
const expectedContract = createPredictionContract({
  profile: 'my-predictor/input-output-v1',
  input: { fields: [
    { name: 'age', dtype: 'float64', unit: 'years' },
    { name: 'income', dtype: 'float64', unit: 'USD/year' },
  ] },
  output: { fields: [
    { name: 'negative_probability', dtype: 'float64' },
    { name: 'positive_probability', dtype: 'float64' },
  ] },
  preprocessingVersion: 'training-scaler/v1',
  classLabels: ['negative', 'positive'],
  parameters: {},
});
```

The result has `kind: 'prediction-contract'` and `schemaVersion: 1`; omitted parameters normalize to `{}`. Input and output fields are ordered. Each field has a name, dtype and optional unit. Class labels, when present, are also ordered. `readPredictionContract` validates a saved contract. This is a declared semantic contract, not tensor inspection or a conversion layer. The application defines a versioned profile and supplies the field names, dtype/unit conventions, preprocessing identity, labels and parameters that actually matter to its predictor.

An unchanged shape does not establish a match. Swapped fields, different declared dtypes, units, output interpretation or class order must not silently acquire the expected meaning. Missing information does not establish equivalence. The guard does not infer units, reorder features, relabel classes or convert values.

## Record actual backend observations

`createInferenceReceipt(input)` requires an invocation ID, timestamp, input/output artifact references and positive input/output row counts:

```ts
const receipt = createInferenceReceipt({
  inferenceId: invocationId,
  createdAt: inferenceFinishedAt,
  inputRef: measuredInputArtifact,
  outputRef: measuredOutputArtifact,
  inputRows: actualInputRows,
  outputRows: actualOutputRows,
  modelRef: backendObservedModel,
  contract: backendObservedContract,
});
```

The result has `kind: 'inference-receipt'` and `schemaVersion: 1`. `modelRef` and `contract` are optional only so missing observations can remain explicit. Omitting them does not supply a fallback match. `readInferenceReceipt` validates persisted evidence without rerunning prediction.

The backend must observe the actual loaded model, fitted preprocessing and prediction configuration used by the invocation. Echoing a requested model or expected contract into the receipt does not measure a stale cache. Keep the model's measured inference identity distinct from the requested model label and full checkpoint identity. Keep numerical arrays in the backend or artifacts; scope carries the measured references and small metadata. A source-artifact digest alone does not measure live state after a mutation. The backend should measure the actual components covered by its inference profile at the operation boundary and bind the input and output of that same invocation.

Artifact references bind declared digests, byte counts and formats. This pure receipt constructor does not hash files or prove their bytes were consumed. The application's backend must measure the actual buffers and bind the output it retains or returns. The example does this at its own numerical boundary.

## Compare against independent expected context

```ts
const decision = checkInference({
  receipt,
  modelRef: independentlyApprovedModel,
  contract: expectedContract,
  inputRef: independentlyBoundInput,
  rows: expectedRows,
  inferenceId: invocationId,
  now: decisionTime,
  maxAgeMs: allowedReceiptAge,
});
```

`now` and `maxAgeMs` are optional. The expected invocation, model, contract and input must come from the caller's own request or authority, rather than being copied out of the offered receipt.

The guard compares the actual and expected measured inference identities, input artifact identity, invocation ID, row counts, contract and applicable timestamps. Both model references need a measured inference identity; checkpoint-only evidence cannot establish inference coverage. A training-only checkpoint difference may preserve a matching inference identity and remains audit context rather than an automatic model mismatch.

The decision has `allowed`, `status`, reasons, checked time, invocation ID and expected/receipt bindings. Known conflicts produce `deny`; unavailable required observations or malformed evidence produce `unknown`. A known conflict still denies when another observation is missing. Proceed only when `allowed` is explicitly true. An allow result establishes consistency of the supplied evidence, not that a model is statistically suitable or that the observations are authentic.

The guard performs no output-delivery or registry effect. If the workflow gates output delivery, retain the backend output until approval and then deliver the exact observed output reference. A denied or unknown result should not be made harmless merely by changing its label. This local pattern is not a hosted serving system, distributed cache protocol or transactional deployment guarantee.

## Choose workflow ownership

The inference contracts are independent of the workflow host. Two examples share the numerical backend while retaining different execution evidence:

| Path | Who controls stages, decisions and retries? | What creates the recording? |
| --- | --- | --- |
| Python-owned `run.py` | The Python application and its explicit stage contexts | `WorkflowCapture` forwards chosen scope operations to the native foottrace writer; no FootPrint executor runs. |
| Native `native-run.mjs` | An actual FootPrint `FlowChartExecutor` runs function and decider stages, with a declared native retry policy | The executor snapshot and attached public recorders retain the execution evidence. |

To use FootPrint's existing orchestration, run the native example after installing the documented Node peers and numerical example requirements:

```sh
node examples/inference/native-run.mjs --out ./native-inference-run --python .venv/bin/python
node examples/inference/native-investigate.mjs --run ./native-inference-run
```

Function stages call the numerical worker and the same pure ML guards. Decider stages route the observed inference decision into the application's handoff or blocked path. A native stage retry handles a controlled transient backend error; it is not a manually labelled Python attempt. Models and arrays remain in the worker/artifacts, and scope holds references and small evidence. The example's output handoff is still an application operation, not a hosted serving or registry system.

Retain the actual executor snapshot and recorder output. Do not reconstruct native commit logs from backend callbacks or treat application observations as automatically instrumented backend internals. Native retry state rollback does not roll back numerical work, file writes or external effects. Snapshot replay does not restart a worker, resume training or establish crash durability. A snapshot-only reader has no retained control lookup. This native example explicitly saves the public control recorder's lookup results and reopens them with its bundled [control adapter](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/native-control.mjs), which validates the run and committed decision/stage references before supplying the existing toolpack bridge. Its investigator compares that result with the snapshot-only baseline. This is example integration, not a new graph engine or core export. Capture-completeness, authentication and any remaining native warnings still apply. See the [example guide](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/README.md) for both paths and their commands.

## Use it from Python and retain its history

A started `WorkflowCapture` exposes `create_prediction_contract`, `read_prediction_contract`, `create_inference_receipt`, `read_inference_receipt` and `check_inference`. Each takes the corresponding single JSON input and delegates to the same TypeScript functions. JSON fields keep their camelCase names. No numerical framework is added to the SDK or wheel dependencies.

Read actual observations and independent request inputs through tracked scope, then write the returned receipt and decision when they belong in the saved history. Helpers can run outside an active stage, but they do not create scope dependencies or commit their results automatically. See [Python installation and usage](https://github.com/footprintjs/footprintjs-ml/blob/main/PYTHON.md).

The [inference example](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/README.md) uses a real local numerical backend and an intentionally stale model cache. Its outputs remain in the backend/artifacts while scope contains references. The backend observes the actual cached model and contract; the workflow checks the wrong model, a corrected cache and a same-shape feature-order control. Numerical dependencies are explicit application requirements in [requirements.txt](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/requirements.txt). Its [dataset note](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/DATASET.md) attributes the retained digit fixtures; a separate [standard-library auditor](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/inference/audit.py) checks saved numerical evidence without rerunning a trainer. The guard itself performs no such arithmetic audit.

Reopen the saved recording with the existing [Lens/foottrace investigation tools](https://github.com/footprintjs/footprintjs-ml/blob/main/BACKTRACKING.md). Replay explains the recorded model, contract, input, output and decision history; it does not recompute predictions, inspect the current live cache or authenticate the original backend. See [testing boundaries](https://github.com/footprintjs/footprintjs-ml/blob/main/TESTING.md) and [the core implementation](https://github.com/footprintjs/footprintjs-ml/blob/main/src/inference.ts).
