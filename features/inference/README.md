# Check what a prediction actually used

Use inference evidence when an approved model may differ from the model actually loaded in a prediction cache, or when unchanged tensor dimensions hide different feature, unit or class-label meaning.

`createPredictionContract` and `readPredictionContract` define and validate ordered input/output fields, dtype/unit declarations, preprocessing version, optional class labels and parameters. `createInferenceReceipt` and `readInferenceReceipt` retain the actual observed model/contract and input/output artifact references for one invocation. `checkInference` compares them with independently supplied expected context. A receipt copied from the request cannot reveal a stale backend cache.

A started Python `WorkflowCapture` exposes the corresponding five snake_case methods through the same core implementation. Read actual operands through tracked scope and store the returned evidence/decision to retain their history. Keep numerical buffers in the backend or artifacts. Missing observations remain unknown; known mismatches deny. Only explicit `allowed: true` permits a guarded next step.

The [real numerical example](../../examples/inference/README.md) offers Python-owned capture and an actual FootPrint `FlowChartExecutor` path with function/decider stages and native retry. Both check a wrong cached model, repaired cache and same-shape feature-order control. Its numerical dependencies are optional application dependencies. This checks supplied evidence, not model accuracy, backend honesty or hosted serving reliability.

Read the [inference guide](../../INFERENCE.md), [core source](../../src/inference.ts), [Python usage](../../PYTHON.md) and existing [saved investigation](../investigation/README.md).
