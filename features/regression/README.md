# Refuse a group regression hidden by an overall improvement

Use a paired baseline/challenger guard when a model's overall score can hide worse results for a predefined group. Declare the group definition, membership, evaluation subset, metric direction, absolute deterioration allowance and minimum sample count independently of offered results.

The root APIs are `readRegressionManifest`, `createRegressionReceipt`, `readRegressionReceipt` and `checkRegression`. A started Python `WorkflowCapture` exposes the corresponding snake_case methods through the same core. The guard consumes ordinary evaluator receipts and performs no numerical training or evaluation. Exact model content and shared evaluation protocol must agree; missing evidence or insufficient declared coverage stays unknown. Known conflicting bindings or an excessive measured deterioration deny approval.

An optional `regression` block in the independently pinned release plan makes this guard mandatory alongside existing quality/selection/lineage checks. Both preparation and new publication reload actual pinned artifacts. Proceed only when the composed result explicitly allows.

Read [the contracts and usage](../../REGRESSION.md), [the executed numerical proof](../../examples/regression/README.md), [evaluation](../evaluation/README.md) and [publication](../publication/README.md). The proof contrasts group-balanced and pooled regression on a fixed imbalanced population; it does not establish significance, fairness or a human debugging-speed advantage. Ordinary complete logs can preserve the same facts. Lens provides reusable backtracking through the consumed state without custom queries or rerunning numerical work.
