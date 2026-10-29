# Connect numerical work without moving tensors into scope

Use a trainer adapter when FootPrint stages call an existing numerical backend and need checked model ownership, observations and lifecycle events. Training and evaluation remain in that backend.

The TypeScript/JavaScript `createTrainerAdapter(port, options)` wraps a `TrainerPort`. Its public methods are `train`, `evaluate`, `loadCheckpoint`, `verifyModel` and `dispose`. The port supplies numerical operations and live inspection. The adapter checks returned model/checkpoint agreement, actual evaluation context, stale sessions, handle reuse and confirmed disposal. Identity-aware evaluation inspects the live model before and after work.

For the optional local Python worker, explicitly import `createPythonTrainerAdapter` from `footprintjs-ml/adapter` and implement the documented plugin hooks. The factory starts the worker when called; importing the package does not. Delegate emitted events to the currently executing stage, and consume business references through its scope rather than a cached closure.

An existing Python orchestrator can instead use [Python capture](../../PYTHON.md) and an injected MLflow client; it need not become a TypeScript workflow.

Verify stale references and live mutation with the [adapter tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/backend.test.mjs) and [identity tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/inference.test.mjs). The adapter does not automatically restart workers or make backend side effects transactional.

Read the [adapter guide](../../ADAPTER.md), [public implementation](../../src/adapter.ts) and [trainer example](../../examples/quickstart/TRAINER.md).
