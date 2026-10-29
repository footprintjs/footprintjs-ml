# Keep model and data identity explicit

Use references when a workflow must distinguish a live backend handle from the durable content it represents. Store these small JSON values in scope; keep tensors, fitted objects and large memberships in the backend or artifacts.

The root declares TypeScript types `ArtifactRef`, `CheckpointRef`, `ModelRef`, `DatasetRef` and `InferenceIdentity`. Runtime validators `artifactRef`, `checkpointRef` and `inferenceIdentity` work in TypeScript or JavaScript. An artifact names a path, SHA-256, byte count and format. A model adds session/handle identity and its origin artifact; a dataset adds role, rows and shape. An inference identity names a versioned prediction profile and digest, covering fitted preprocessing when predictions depend on it.

The validators return frozen JSON snapshots. They do not read files or measure hashes. Durable comparisons can accept relocated paths and reopened handles; the live adapter separately rejects stale sessions and reused handles. A matching prediction identity does not establish identical optimizer or resumable training state.

Verify that changing fitted preprocessing invalidates inference coverage while an explicitly excluded optimizer-only change can preserve it in the [identity tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/inference.test.mjs).

Read the [contracts](../../src/contracts.ts), [adapter guide](../../ADAPTER.md) and [Python MLflow example](../../examples/mlflow/README.md) for measured references. Continue with [evaluation receipts](../evaluation/README.md).
