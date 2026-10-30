# Bind later performance to a deployed model and closed batch

Use monitoring evidence when an already released model receives new data and actual outcomes arrive later. The library connects an independently declared deployment snapshot, one batch prediction, a closed event-time window, label provenance and join coverage to a performance decision. Python keeps prediction and joins; the core performs deterministic JSON consistency and policy checks.

`checkMonitoring` reuses `checkInference` and `checkRelease`. The additional contract identifies which deployed revision and observation period the metric covers, and whether enough predictions were matched to actual outcomes. It does not create a monitoring server or modify the existing release plan.

## Independent declaration

`readMonitoringManifest(value)` validates a `monitoring-manifest` with schema version 1:

| Field | Meaning |
| --- | --- |
| `monitorId` | Independently named monitoring operation. |
| `deployment` | Expected `targetName`, `revision`, exact `modelRef` and `publicationRef` artifact. |
| `window` | `windowId`, half-open event bounds `startAt`/`endAt`, `inputRef`, `membershipRef`, `expectedRows` and `inferenceId`. |
| `contract` | Existing ordered `PredictionContract` for the actual batch invocation. |
| `labelSource` | Independently accepted outcome producer `name` and `version`. Actual label artifact identity arrives later. |
| `joinMode` | Explicit `row-id-window-time/v1` keyed join profile. |
| `evaluation` | Expected preprocessing/method versions and parameters for the measured joined data. |
| `policy` | Metric, `gte`/`lte`, absolute threshold, `minSamples`, `minCoverage` and optional `maxAgeMs`. |

Declare the window, source, method and policy independently before inspecting performance. A reference copied from an offered receipt is not independent authority. This first profile covers one nonempty closed batch and one prediction invocation. `minCoverage` is the required fraction of window predictions matched to outcomes. The count and coverage floors are policy requirements, not statistical-power guarantees. If an application permits coverage below 1, the measured metric covers the matched outcomes only; it establishes neither performance for missing outcomes nor freedom from label-selection bias.

A publication reference and revision identify the independently chosen release evidence. The application must actually read its target and load the predictor bytes it observes. The pure guard does not discover a deployment, hash files or establish uninterrupted serving history. Runtime handle relocation is permitted for the same durable model content; the exact checkpoint and measured inference identity must agree with the deployed snapshot.

## Actual observations and delayed labels

`createMonitoringReceipt({monitoringId, createdAt, manifest, observation})` retains a detached immutable bundle. `readMonitoringReceipt(value)` validates a saved bundle without repeating prediction or metrics. The singular `observation` contains:

- An actual `deployment` snapshot with observation time.
- The observed `window` identity, bounds, input/membership references, row count and closure time.
- An optional ordinary `InferenceReceipt` for the batch's actual model, contract and input/output artifacts.
- Optional `labels` with batch ID, window ID, source, actual label artifact and availability time.
- An optional measured `join` report reference and its mode, input/output/label/membership identities, joined dataset, matched/missing/duplicate/unmatched/cross-window counts and creation time.
- An optional ordinary `EvaluationReceipt` for the actual joined dataset.

Keep arrays and row membership lists in the backend or artifacts. The backend must compute the join from the actual prediction and label rows. Intact label rows arriving in a different order remain valid under a keyed join. Labels with duplicate identities, foreign windows or unmatched keys are distinct reported conflicts. Matching IDs does not prove that label values are correct.

Zero matched rows or incomplete observations can be retained without inventing a nonempty evaluation dataset. Once enough outcomes are available, use a fresh receipt that retains the new evidence and its actual timestamps. It must not relabel an earlier batch's result as the new batch's measurement.

`checkMonitoring({receipt, manifest, observation, now?})` compares the offered receipt with the independent declaration and separately retained observations. Keep those inputs independent of the offered receipt. Read the actual operands through tracked scope and store returned decisions or references when their history matters.

## Decision meaning

The result includes `allowed`, `status`, reasons, health, a recommendation, coverage and the existing inference/quality subchecks.

- Valid comparable evidence meeting coverage and the metric rule can establish `healthy` with an allowing decision.
- Valid sufficiently covered evidence failing the metric rule can establish `degraded` and recommend review.
- Missing outcomes, incomplete measurements or insufficient declared coverage keep health unknown. A known conflicting binding or invalid reported join refuses evidence even when another observation is unavailable.

A review recommendation is a recorded policy result. It performs no alert delivery, service pause, rollback, retraining or deployment effect. An allowing decision only covers this declared batch and rule. It grants no blanket permission for future traffic and does not revoke or rewrite the original release approval.

Window bounds describe the input rows' event time. Prediction, target observation, label availability, join and evaluation timestamps describe processing observations. Closed batches may be processed after their event-time interval. The profile checks consistency and chronology of supplied observations; it does not attest an entire historical serving interval. The optional maximum age applies to the measured evaluation through the existing quality guard; it does not make event time a new measurement time.

## Python and saved investigation

A started `WorkflowCapture` provides `read_monitoring_manifest`, `create_monitoring_receipt`, `read_monitoring_receipt` and `check_monitoring`. Arguments preserve camelCase JSON fields and call the same TypeScript implementation. No numerical or third-party runtime dependency is added.

The [example](examples/monitoring/README.md) trains and publishes one small predictor, reads the actual local target and installed bytes into a held backend, then processes two closed batches. Outcomes are initially absent for the later batch. After they arrive, a fresh measurement reveals worse error and records a review recommendation. Corrupted evidence and valid reordered labels are separate controls; the example supplies no real production pause.

Large native responses are kept intact as managed artifacts, with small exact projections and references in scope. Existing [Lens and foottrace](BACKTRACKING.md) follow the captured decision to the deployed snapshot, predictions, joined outcomes and independently declared window. Reopening the saved record starts no trainer and repeats no prediction, guard or publication.

Numerical metrics, join contents, label truth and producer authentication remain outside the pure guard. A high error or a data-distribution change does not by itself establish a causal diagnosis. Statistical significance, drift detection, continuous scheduling and hosted monitoring are separate responsibilities. Read [testing boundaries](TESTING.md), [inference contracts](INFERENCE.md) and [evaluation receipts](features/evaluation/README.md).
