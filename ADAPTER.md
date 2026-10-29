# Optional trainer adapter

Available in the `footprintjs-ml` beta under `footprintjs-ml/adapter`. Existing receipt and guard schemas remain compatible. This optional entry point supplies the Python worker, reference lifecycle, safe checkpoint container, identity encoding, TypeScript client, plugin conformance checks and a generic saved-run Lens session. Your trainer keeps its numerical functions, model, optimizer and dataset.

The supplied transfer proof adapts the official JAX Gaussian-process regression example. It uses different model state, data and metric from the earlier digit classifier. The upstream numerical source is retained unchanged with its Apache license. This is a controlled integration of independently authored numerical code; no external developer adoption study has been conducted.

## Connect a trainer

Install the beta package (or the downloaded release tarball). Python, NumPy and your numerical framework must already be installed; the kit does not install them automatically.

```sh
npm install https://github.com/footprintjs/footprintjs-ml/releases/download/v0.6.0-beta.9/footprintjs-ml-0.6.0-beta.9.tgz
```

```ts
import { createPythonTrainerAdapter } from 'footprintjs-ml/adapter';
import { checkRelease } from 'footprintjs-ml';

const trainer = await createPythonTrainerAdapter({
  root: './artifacts/my-run',
  pluginPath: './my_trainer_plugin.py',
  expectedProfile: 'my-model/deterministic-predictor-v1',
  config: { datasetDirectory: './data' },
}, {
  python: '.venv/bin/python',
  emit: (name, payload) => currentStageScope.$emit(name, payload),
});
try {
  const result = await trainer.adapter.train({ steps: 100 });
  const evaluation = {
    modelRef: result.modelRef,
    datasetRef: trainer.datasets.validation,
    preprocessingVersion: trainer.backend.preprocessingVersion,
    evaluationMethodVersion: trainer.backend.evaluationMethodVersion,
    parameters: {},
  };
  const { receipt } = await trainer.adapter.evaluate(evaluation);
  const verified = await trainer.adapter.verifyModel({ modelRef: result.modelRef });
  const decision = checkRelease({ ...evaluation, modelRef: verified, receipt,
    policy: { metric: 'mse', operator: 'lte', threshold: 0.1 },
  });
  // The application's publication stage proceeds only when decision.allowed is true.
  await trainer.adapter.dispose({ modelRef: verified });
} finally {
  await trainer.close();
}
```

`train` options belong to the plugin. Dataset role names, dimensions, model fields, optimizer, architecture and inference profile are not fixed by this client. The expected profile must be explicit; an unexpected or missing measured identity invalidates the owned worker session. A bundler that relocates `dist/adapter/client.js` must pass `workerPath` pointing to the installed `python/worker.py`.

The emitter should delegate to the currently executing FootPrint stage, rather than retaining the initialization stage's scope. Numerical arrays remain in Python or artifact files; the JSON-lines connection carries references, small metadata, metrics and receipts. Worker calls have bounded responses, correlated IDs, deadlines and explicit shutdown. There is no automatic worker restart or rollback of artifact writes.

## Implement the Python hooks

The plugin is an ordinary local Python module with `create_plugin(config)`. Its returned object supplies:

| Member | Responsibility |
| --- | --- |
| `profile` | A versioned name for the predictor semantics and component selection. |
| `initialize()` | Return backend method/preprocessing versions and named datasets as numerical array mappings, row counts and shapes. |
| `train(request, source)` | Call the existing trainer and return its resulting state. The runtime supplies a detached source for continuation. |
| `evaluate(state, dataset_arrays, parameters)` | Call existing prediction/evaluation code and return finite named metrics. |
| `snapshot(state)` | Export **all** resumable state as numeric arrays plus JSON metadata. |
| `restore(snapshot)` | Reconstruct the trainer's state from that export. |
| `inference(state)` | Export the actual predictor components and inference specification as arrays plus JSON metadata. |
| `model_metadata(state)` | Optional small model labels/counters for reference display. |

An export has the form `{ "arrays": { "parameter/name": numpy_array, ... }, "metadata": { ... } }`. The runtime measures both the complete snapshot and inference export. It owns sessions, handles, checkpoint files and artifact hashes. It hashes the bytes it actually reads, decodes that same buffer with `allow_pickle=False`, and checks the restored state before returning a live reference. It verifies the registered full-state and inference fingerprints whenever a handle is used. Continuation gets copied state so an existing trainer's in-place optimizer update cannot change an already published handle.

The plugin must include everything prediction depends on: weights, fitted preprocessing, architecture, input/output semantics, inference code and relevant configuration/dependency identity. A Gaussian process also needs the conditioning inputs and targets. A deterministic predictor can exclude optimizer state; a stochastic predictor needs an explicitly different profile that covers its random behaviour. The kit cannot decide these semantics for an arbitrary model.

The default identity encoding and safe NPZ profile are documented in [the Python guide](python/README.md). Numeric arrays are measured with explicit dtype, shape and byte order. Object arrays, nonfinite values and executable checkpoint payloads are refused. Plugin files are trusted local application code, not isolated or authenticated third-party programs.

## Conformance and the second trainer

The reusable conformance runner accepts a plugin, config and plan. A plan declares training, continuation, an optional training-only change, and metric policy. It exercises the actual plugin/runtime boundary: restore agreement, changed predictor identity, training-only identity agreement, forged/stale/foreign references, actual registered-state mutation and disposal. Results identify passed checks and the evidence they used. The runner is a separate test session; its events are not inserted into the workflow's saved run.

Start with the [bring-your-own-trainer quickstart](QUICKSTART.md). The [technical story](https://footprintjs.github.io/footprintjs-ml/technical-story.html#25) separately retains the earlier external-trainer proof and its evidence. The Node protocol tests use an explicitly fake numerical fixture; they do not establish numerical correctness. The real plugin conformance and independent NumPy audit provide separate checks.

Passing conformance establishes the tested behaviour and selected mutations. It cannot prove that an arbitrary plugin included every semantically relevant component, that a dishonest plugin measured anything, or that a model is suitable for unseen data. Independent component and numerical auditing remain necessary for a supported adapter profile.

## Backtrack any saved workflow value

The `openWorkflowRecording` reader accepts a saved FootPrint snapshot without ML-specific bindings. It delegates value tracing to the existing public Lens/foottrace toolpack. Use it to start at a selected candidate, recorded score or other scope key. See [BACKTRACKING.md](BACKTRACKING.md) for the API and a missing-read example. The ML decision reader remains available below.

Read the inputs used by a decision through tracked scope. A score held only in a JavaScript closure or an unobserved backend cannot acquire a dependency edge simply because the same value also appears elsewhere in the record.

## Add ML context to saved decisions

Attach a small binding manifest to the saved trace:

```js
{
  workflow: { kind: 'ml-adapter-workflow/v1' },
  mlInvestigation: {
    schemaVersion: 1,
    bindings: {
      model: 'activePredictor', receipt: 'approval', decision: 'policyDecision',
      allowed: 'publishAllowed', releasedModel: 'releasedPredictor'
    }
  },
  footprint: executor.getSnapshot(),
  rows: recordedCallbacks
}
```

These are the workflow's own scope-key names. The ML Lens session discovers actual decision stages and writers from the saved commit log. It does not need hardcoded stage IDs, model names or custom queries. Import `openAdapterWorkflowRun` from `footprintjs-ml/lens` and inject the existing public Lens/foottrace bridge. The supplied viewer adds a decision selector for these runs.

Native tool responses remain native evidence. Callback rows remain supplemental. Missing typed integrity events or control-dependency lookup remain visible limitations. State replay reconstructs recorded references and receipts; it does not restore live arrays, rerun Python or resume training.

## Scope and limits

This beta targets Node.js 22+ with a local Python worker and trusted storage. APIs may change. Live inspection is an operation-boundary observation. The application still owns atomic publication, concurrency, worker recovery and checkpoint retention. GPU synchronization/copy costs and large-model recording overhead have not been measured. The earlier digit-classifier and sklearn benchmark evidence is preserved separately.

Build with `npm run build`; run Node tests with `npm test`. `FOOTPRINT_ML_TSC` or `node build.mjs --tsc /path/to/typescript/bin/tsc` selects an existing compiler. Python tests and conformance require the package's Python directory on `PYTHONPATH`, plus NumPy and any dependencies of the chosen trainer.
