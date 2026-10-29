# Check whether evaluation evidence permits a handoff

Use TypeScript/JavaScript `checkRelease` when the current proposed model needs matching evaluation evidence and an explicit quality policy. Python's `capture.check_release` delegates to the same native guard. It is a pure JSON consistency/policy check; it does not deploy a model or contact its backend.

Supply the current `modelRef`, intended `datasetRef`, preprocessing/method versions, evaluation parameters, offered receipt and a policy containing metric, `gte`/`lte` threshold and optional `maxAgeMs`. V1 compares exact checkpoint coverage; v2 compares the measured prediction identity while retaining its evaluated checkpoint for audit. Dataset/context differences, future or expired receipts and a failing threshold block approval.

The returned `ReleaseDecision` has `allowed`, `status`, reasons and proposed/recorded bindings. Continue only when `allowed === true`; `unknown` also means blocked. Live verification belongs to the adapter. Data-use and candidate-selection rules require their [separate checks](../data-lineage/README.md), [selection evidence](../selection/README.md) or the composed publication API.

Verify that S1's evaluation cannot approve an S2 predictor in the [Python MLflow example](../../examples/mlflow/README.md). Its accuracy comes from scikit-learn; the guard checks the reported evidence against declared policy.

Read the [guard source](../../src/guard.ts), [receipt policy tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/receipts.test.mjs) and [quickstart](../../QUICKSTART.md). For an actual artifact handoff, continue with [publication](../publication/README.md).
