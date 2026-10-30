# Publish the exact artifact that passed the composed checks

Use TypeScript/JavaScript `prepareModelRelease`, `publishModelRelease` or `releaseModel` when approval must become an actual artifact handoff. The Python facade exposes these same operations as `prepare_model_release`, `publish_model_release` and `release_model`, plus managed-artifact import and plan reading. `readModelReleasePlan` validates a plan that independently pins model bytes, candidate manifest/results, selection receipt, quality policy and any required lineage evidence.

Preparation and new publication load actual stored bytes, verify their identities, compose the guards and require current live-model verification. An offered preparation's `allowed` flag is not sufficient authority. The publisher receives detached approved bytes and a stable semantic payload; it must verify and consume that same snapshot.

The optional `footprintjs-ml/release` entry supplies `createFileArtifactStore` and `createLocalModelPublisher`. The local receiver uses a process lock plus atomic registry replacement, target revision checks and idempotency bindings. These are single-host filesystem guarantees. A matching retry can acknowledge the original publication; it does not assert that the historical model remains the current target.

Python's optional `footprint_ml_promotion.MlflowModelPublisher` checks a pre-existing registered version and the downloaded complete predictor artifact before alias mutation. It requires an injected client and a shared one-host journal/lock for all cooperating writers. A committed receipt can recover a lost outer reply; a pending setter timeout remains unknown and is not automatically repeated. This adds a Python/MLflow path to the existing publication feature, not a distributed CAS service, model-flavor packager or serving system. See [MLflow promotion](../../MLFLOW.md#checked-registered-model-promotion) and its [actual local example](../../examples/mlflow-promotion/README.md).

Verify swapped bytes, lost acknowledgements and competing updates with the [release tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/release.test.mjs) and [local publisher tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/release-node.test.mjs). Unconfirmed outcomes stay unknown. The implementation makes no distributed exactly-once or power-loss durability claim.

Read the [release guide](../../RELEASE.md), [core release source](../../src/release.ts) and [local receiver](../../src/release/local-publisher.ts). Keep numerical buffers out of workflow scope.
