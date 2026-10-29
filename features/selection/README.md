# Verify the winner of a declared model comparison

Use the TypeScript/JavaScript selection APIs when several models have valid evaluations but the workflow may choose the wrong one. Python capture currently exposes no selection guard or experiment driver. Declare a `SelectionManifest` before execution: the complete candidate/configuration set, shared evaluation context, metric, `min`/`max` direction and exact candidate-ID tie rule.

`readSelectionManifest` validates that declaration. `createSelectionReceipt` computes the ranking and winner from complete comparable candidate results; `readSelectionReceipt` recomputes saved claims. `checkSelection` compares an offered receipt and proposed model with the independently pinned manifest and separately retained observations. Do not supply the receipt's own manifest/results as that independent authority.

`runExperiment` is an optional sequential callback driver in canonical candidate-ID order. The application owns retries, parallel scheduling and cleanup. Selection checks neither numerical correctness nor statistical significance, and they do not impose an absolute quality threshold. Compose [approval](../approval/README.md) and [data lineage](../data-lineage/README.md) as required.

Verify that reversed direction, omitted competitors or incompatible datasets cannot rewrite the intended comparison in the [selection tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/selection.test.mjs). The [backtracking example](../../examples/selection-backtracking/README.md) re-ranks retained JAX observations without repeating numerical training or evaluation.

Read the [selection guide](../../SELECTION.md) and [public selection source](../../src/selection.ts). Its result is the winner of this declared finite comparison, not the best possible model.
