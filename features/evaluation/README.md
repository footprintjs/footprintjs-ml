# Bind a score to what was evaluated

Use an evaluation receipt to prevent a score from being borrowed for a different predictor, dataset or evaluation protocol. The trainer supplies observations; FootPrint records their identity and later use.

The TypeScript/JavaScript `createEvaluationReceipt` accepts the actual `modelRef`, `datasetRef`, preprocessing and evaluation-method versions, parameters, finite named metrics, evaluation ID and timestamp. It creates a detached, deeply frozen JSON record. A model with a measured inference identity produces a v2 receipt, with that identity and a separate `checkpointForAudit`. Otherwise v1 retains exact checkpoint coverage. `readEvaluationReceipt` validates the saved schema without upgrading old evidence; `receiptCheckpoint` retrieves its retained checkpoint reference. Python's `capture.create_evaluation_receipt` delegates creation to that native function.

The receipt constructor does not calculate accuracy, inspect numerical arrays or authenticate the producer. The backend must measure the components its prediction depends on. Keep the receipt and consumed references in tracked scope so investigation can follow their writers.

Verify persistence, protocol changes and malformed/nonfinite observations with the [receipt tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/receipts.test.mjs). The [quickstart](../../QUICKSTART.md) trains A, changes the model to B and demonstrates why A's receipt cannot cover B.

Read the [receipt implementation](../../src/receipts.ts) and [contracts](../../src/contracts.ts). Apply [approval](../approval/README.md) for a policy decision; recording a receipt alone grants no permission to publish.
