# Publish the exact artifact that passed the composed checks

Use TypeScript/JavaScript `prepareModelRelease`, `publishModelRelease` or `releaseModel` when approval must become an actual artifact handoff. Python capture currently exposes no publication API. `readModelReleasePlan` validates a plan that independently pins model bytes, candidate manifest/results, selection receipt, quality policy and any required lineage evidence.

Preparation and new publication load actual stored bytes, verify their identities, compose the guards and require current live-model verification. An offered preparation's `allowed` flag is not sufficient authority. The publisher receives detached approved bytes and a stable semantic payload; it must verify and consume that same snapshot.

The optional `footprintjs-ml/release` entry supplies `createFileArtifactStore` and `createLocalModelPublisher`. The local receiver uses a process lock plus atomic registry replacement, target revision checks and idempotency bindings. These are single-host filesystem guarantees. A matching retry can acknowledge the original publication; it does not assert that the historical model remains the current target.

Verify swapped bytes, lost acknowledgements and competing updates with the [release tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/release.test.mjs) and [local publisher tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/release-node.test.mjs). Unconfirmed outcomes stay unknown. The implementation makes no distributed exactly-once or power-loss durability claim.

Read the [release guide](../../RELEASE.md), [core release source](../../src/release.ts) and [local receiver](../../src/release/local-publisher.ts). Keep numerical buffers out of workflow scope.
