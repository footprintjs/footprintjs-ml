# Explain performance after a model is released

A correctly loaded model can perform poorly on a later batch. Monitoring evidence connects an independently declared deployment and closed event-time window to actual predictions, delayed outcomes, reported keyed joins, coverage and measured performance.

The root APIs are `readMonitoringManifest`, `createMonitoringReceipt`, `readMonitoringReceipt` and `checkMonitoring`. A started Python `WorkflowCapture` exposes the corresponding snake_case methods through the same TypeScript core. Existing inference and evaluation guards check their respective evidence; the new contract binds them to a deployed revision and a closed batch with enough correctly matched outcomes.

Missing or insufficient outcomes keep health unknown. Known model/window/revision or reported join conflicts refuse the evidence. A valid, sufficiently covered measurement can establish healthy or degraded performance under the declared threshold. The recommendation is recorded JSON; no service is paused and no model is replaced.

Read [the closed-batch contract](../../MONITORING.md), [the numerical proof](../../examples/monitoring/README.md), [inference evidence](../inference/README.md) and [saved investigation](../investigation/README.md). Metrics and actual row joins stay in the numerical backend or artifacts. The pure guard does not inspect arbitrary data, authenticate a producer, establish label truth, diagnose drift or measure statistical significance.
