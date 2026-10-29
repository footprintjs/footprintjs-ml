---
name: footprintjs-ml
description: Integrate footprintjs-ml into existing ML workflows, check model evaluation and release evidence, or backtrack a saved ML result using the existing Lens and foottrace tools. Use when implementing or debugging FootPrint ML integrations.
---

# Build and investigate ML workflows with FootPrint ML

Keep the application's numerical framework and workflow ownership. Add the smallest relevant FootPrint ML boundary: measured references, evaluation evidence, a guard, or saved investigation. ML workflow investigation is the purpose; agent conversation tracking is not required.

## Find the relevant contract

Read the application's installed SDK version and existing integration before editing. The public exports, TypeScript declarations and Python module are the API authority. Read only the feature guides needed for the task.

These relative links work in the repository, npm package and Python wheel's documentation tree. If this skill was copied into a separate agent skill directory, locate the SDK's bundled guides or use the [versioned feature index](https://github.com/footprintjs/footprintjs-ml/blob/v0.6.0-beta.6/features/README.md). For another installed SDK version, use its matching release tag and API declarations.

| Task | Read first | Then, if needed |
| --- | --- | --- |
| Keep a Python-owned workflow and add reference history | [Python installation](../../PYTHON.md), [MLflow capture](../../MLFLOW.md) | [Unchanged-evaluator example](../../examples/python-adoption/README.md) |
| Define model, checkpoint and dataset references | [References](../../features/references/README.md) | [Trainer adapter](../../ADAPTER.md) |
| Record a numerical evaluation | [Evaluation](../../features/evaluation/README.md) | [Approval](../../features/approval/README.md) |
| Orchestrate a trainer from TypeScript or add a trainer plugin | [Trainer adapter](../../features/trainer-adapter/README.md) | [Python hooks](../../python/README.md), conformance runner in [ADAPTER.md](../../ADAPTER.md) |
| Check that a proposed model has matching acceptable evidence | [Approval](../../features/approval/README.md) | [Adapter guide](../../ADAPTER.md) |
| Explain a normal or surprising saved result | [Investigation](../../features/investigation/README.md) | [Backtracking](../../BACKTRACKING.md) |
| Check what data training or fitted preprocessing used | [Data lineage](../../features/data-lineage/README.md) | [Data-use contracts](../../DATA-LINEAGE.md) |
| Compare a declared candidate set | [Selection](../../features/selection/README.md) | [Comparison contracts](../../SELECTION.md) |
| Publish the exact approved checkpoint; handle a publication retry | [Publication](../../features/publication/README.md) | [Release API](../../RELEASE.md) |
| Diagnose setup or dependency problems | [Python installation](../../PYTHON.md), [compatibility](../../COMPATIBILITY.md) | `doctor` for an explicitly installed helper |

## Choose the existing integration path

**Python owns the workflow:** use `WorkflowCapture` and, for an application-supplied MLflow client, `MlflowArtifacts`. Python retains training, evaluation, branches and retry logic. Entering capture explicitly starts the native Node recording helper. `scope[key]` reads and assignments record selected JSON state. Keep tensors, fitted objects and dataframes in the trainer or artifacts.

The started Python facade exposes evaluation receipt creation/reading, `check_release`, lineage receipt creation/reading and `check_data_lineage`, plus `read_selection_manifest`, selection receipt creation/reading and `check_selection`. These call the existing TypeScript contracts; keep JSON field names such as `modelRef` and `datasetRef` in camelCase. Read actual request inputs through scope and assign returned receipts/decisions to scope when their history is required; helper calls do not capture those edges automatically. See the [Python guard example](../../examples/python-guards/README.md).

Python owns its candidate loop, branching and retry policy. `runExperiment` and checked publication remain TypeScript APIs; do not invent `capture.run_experiment` or Python publication methods, or reimplement guards in Python.

**TypeScript owns orchestration:** use the existing FootPrint stages and optional `footprintjs-ml/adapter` for the numerical worker. Import optional paths when the application uses them. Connect adapter callbacks to the currently executing stage; do not keep an initialization stage's scope alive as the event target. Close the owned worker in `finally`.

**Saved investigation only:** use the existing CLI or `openWorkflowRecording` from `footprintjs-ml/lens`, with the public host toolpack injected as documented. Generic backtracking needs no ML release bindings or custom graph engine. Do not start a trainer to answer a question already covered by the saved record.

## Preserve evidence meaning while implementing

- Read the actual inputs used by a computation or decision through tracked scope. A closure read, equivalent copied value or ceremonial unused scope read cannot establish that dependency. In Python, nested reads return detached JSON; assign a modified value back to record the change.
- Capture during execution through the existing recorder. Do not fabricate a commit log, repair old history by adding imagined reads, or convert supplemental callbacks into native control edges.
- Bind artifact bytes at consumption. For MLflow, prefer `read_bytes(ref)` and decode that checked buffer. A tag, model label or registry version alone does not identify a complete predictor. Include fitted preprocessing and input/output semantics in the chosen inference profile.
- Keep exact resumable checkpoints distinct from inference identity. Complete checkpoints include optimizer/progress/random state as required by the trainer. V1 evaluation receipts cover checkpoints; V2 receipts cover a measured inference profile and keep an audit checkpoint. Training-only changes can preserve inference identity. Publication and lineage may impose additional exact-checkpoint requirements.
- Create evaluation evidence from actual backend observations. Retain the observed model/data/preprocessing/method/parameters with the metric; do not relabel an old metric for a new model. Expected manifests and release policies come from the caller's declared requirements, independently of the offered receipt.
- Proceed only when the relevant decision's `allowed` field is explicitly true. An `unknown` decision does not permit release. Approval is separate from publication; use the existing release API to pin evidence and hand off the exact approved artifact.
- A discarded stage rolls back captured state writes, not numerical work, file writes, registry operations or other external effects. Python attempt/retry labels describe caller-controlled execution. This capture profile is serial root stages; it is not a durable or distributed scheduler.
- Keep dependencies and worker startup explicit. The SDK core and wheel require no runtime packages, but recording/investigation needs the documented Node helper and chosen numerical integrations have their own dependencies.

## Investigate without inventing a cause

Start with a recorded scope key or the exact recorded decision stage. Reuse native `backtrack`, `who_wrote`, `get_value` and `trace_node` through the documented toolpack. Use `normaliseStateKey` from `foottrace/paths` for nested keys; a dotted string can be a literal root key.

An optional `before` bound is an exclusive commit-array index. Use it to exclude later corrections from an earlier result. When multiple release decisions share a status, select the actual recorded runtime stage rather than the first matching label. Preserve native missing-read/control/truncation messages.

Report what the recorded reference history supports and what remains outside capture. Reopening JSON reconstructs recorded state; it does not restore tensors, resume training, authenticate observations, prove statistical causation or execute a new guard. Numerical accuracy belongs to the trainer and evaluation, not FootPrint.

## Verify the integration you changed

Use the existing small example or contract test relevant to the requested feature. For a new trainer, run the documented conformance plan against that profile. For a provenance integration, verify a real writer-to-consumed-input chain and that an unrelated later correction is absent. For release checks, exercise the relevant stale/mismatched evidence and matching evidence; for publication, include the exact-byte handoff and applicable retry case.

When wrapping existing numerical work, compare returned observations before and after capture. Reopen the saved recording in a separate process after the worker exits and show that no numerical work repeats. Do not claim external developer adoption, investigation speed or runtime overhead from source line counts or a successful local example.

Deliver the integration changes, the verification performed, a concrete saved-result investigation when relevant, and any remaining capture or API boundary. Keep application-specific numerical logic out of this skill.
