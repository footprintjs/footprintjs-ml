# Checked model release

The beta includes `prepareModelRelease`, `publishModelRelease` and `releaseModel`. They bind the exact checkpoint bytes being handed to a publisher to a declared model-selection experiment, its validation evidence and any required data-lineage evidence.

The trainer still owns numerical models and computation. FootPrint stages coordinate the operations and record their reference/evidence changes. The release API checks the ML meaning of those observations. A publisher supplies the actual external effect; the optional Node implementation supplies one local file registry.

## Imports and loading

The core functions and contracts come from the Node-free root entry:

```ts
import {
  readModelReleasePlan,
  prepareModelRelease,
  publishModelRelease,
  releaseModel,
} from 'footprintjs-ml';

// Load the Node files/registry implementation when this workflow needs it.
const {
  createFileArtifactStore,
  createLocalModelPublisher,
} = await import('footprintjs-ml/release');
```

These are subpaths of one package. Importing the root or an optional entry starts no Python process, trainer or publication. Factories perform no storage operation until a method is called. The Node helpers use the local filesystem and cryptography; other environments can supply the core ports directly.

## The independently pinned plan

`ModelReleasePlan` has this shape:

```ts
interface ModelReleasePlan {
  kind: 'model-release-plan';
  schemaVersion: 1;
  releaseId: string;
  idempotencyKey: string;
  target: { name: string; expectedRevision: string | null };
  modelArtifact: ArtifactRef;
  manifestRef: ArtifactRef;
  resultsRef: ArtifactRef;
  selectionReceiptRef: ArtifactRef;
  qualityPolicy: ReleasePolicy;
  lineage?: {
    required: boolean;
    receiptRef?: ArtifactRef;
    splitManifest: ArtifactRef;
    policy: DataLineagePolicy;
  };
}
```

The application must obtain `planRef` from an independently authorized source, such as its release configuration or approving workflow. Copying `planRef` out of an offered preparation and then treating that same value as authority would allow the offered record to authorize itself. Hashes establish content identity after that trust choice; they do not make an arbitrary plan authorized.

The plan pins the checkpoint, complete candidate/configuration manifest, independently observed candidate results and offered selection receipt. The manifest fixes the comparison dataset, preprocessing, evaluation method, parameters, metric direction and tie rule. The quality policy fixes the metric threshold and optional maximum age. If lineage is required, its receipt and split manifest must also be supplied. Missing required lineage cannot produce an approved release.

For a new publication, the core reads actual bytes through the store, snapshots them and checks their digest and byte count against each reference. It parses the JSON evidence and recomputes the declared winner from the full observed candidate set. It then checks:

- The winning model's own evaluation against the declared quality policy.
- The supplied selection receipt, complete comparison and proposed winner against the pinned manifest and results.
- Required data-lineage evidence against the proposed model, comparison dataset, split and data-use policy.
- A fresh live observation of the proposed model through `verifyModel`.
- Agreement between the plan, winning result and verified model on the exact checkpoint digest, byte count and format.

This last requirement is stricter than prediction-only evaluation coverage. An optimizer-only checkpoint change may leave predictions unchanged and retain a valid v2 evaluation. It still changes the exact artifact this release plan names, so it cannot silently replace that artifact.

Artifact format names remain declared metadata. The managed Node store binds the format label to its content-addressed filename; it does not parse arbitrary numerical serialization formats or prove that a file is a valid model.

## Prepare and publish

`prepareModelRelease` accepts `{ planRef, modelRef, store, verifyModel, now? }`. It returns a JSON result with `allowed`, `status`, reasons, the composed decision, a persisted `preparedRef` and the preparation record when approved. Only `allowed === true` authorizes progress to the next checked step.

`publishModelRelease` accepts `{ planRef, preparedRef, store, publisher, modelRef?, verifyModel?, now? }`. `modelRef` and `verifyModel` are required whenever no existing publication is confirmed. Before any new effect, the API reloads the independently pinned authority and offered preparation, checks their byte identities, reconstructs the preparation's claims and repeats the current quality, selection, required lineage, live-model and exact-checkpoint checks. Stored `allowed: true` flags alone are insufficient.

For example, with already populated evidence storage and an independently pinned plan:

```ts
import type { ArtifactRef, ModelRef } from 'footprintjs-ml';
import { prepareModelRelease, publishModelRelease } from 'footprintjs-ml';

async function releaseChosenModel(input: {
  pinnedPlanRef: ArtifactRef;
  modelRef: ModelRef;
  verifyModel: (request: { modelRef: ModelRef }) => Promise<ModelRef>;
  artifactRoot: string;
  publisherRoot: string;
}) {
  const { createFileArtifactStore, createLocalModelPublisher } =
    await import('footprintjs-ml/release');
  const store = createFileArtifactStore({ root: input.artifactRoot });
  const publisher = createLocalModelPublisher({ root: input.publisherRoot });
  const prepared = await prepareModelRelease({
    planRef: input.pinnedPlanRef,
    modelRef: input.modelRef,
    verifyModel: input.verifyModel,
    store,
  });
  if (!prepared.allowed || !prepared.preparedRef) return prepared;

  return publishModelRelease({
    planRef: input.pinnedPlanRef,
    preparedRef: prepared.preparedRef,
    modelRef: input.modelRef,
    verifyModel: input.verifyModel,
    store,
    publisher,
  });
}
```

`releaseModel` is the convenience form. With no `preparedRef`, it prepares and publishes through the same checked paths. With a retained `preparedRef`, it follows `publishModelRelease`, including read-only acknowledgement recovery. A preparation is evidence to reconstruct, not an unchecked reusable authorization token. Altered preparations, mismatched plans, swapped model bytes or inconsistent publisher receipts are refused or returned as unknown.

The library allocates transient `Uint8Array` copies of serialized checkpoint files to hash and transfer the same bytes. Put references and JSON evidence in scope, rather than those byte buffers. This API is not streaming and does not claim constant memory for large checkpoints. It does not turn JavaScript into the tensor runtime.

## Stable publication identity

The publication payload contains the release/idempotency IDs, target and expected revision, checkpoint identity, winning candidate, inference identity, quality policy and identities of the pinned evidence. Its `validUntil` is derived from the winning evaluation's creation time and `maxAgeMs`, or is `null` when no maximum age is required.

The top-level payload uses content identities instead of current live handles and storage locations, and excludes preparation time. It still binds the complete pinned evidence by hash, including any historical metadata inside those artifacts. Re-preparing against the same pinned authority, evidence and effectful claims can therefore identify the same intended effect in a fresh client. Rewriting a plan or results file is not automatically equivalent. The publication receipt retains the original preparation reference and original commit time; a retry does not replace that receipt with a newly timestamped one.

The core hands the publisher detached checkpoint bytes, the payload, its semantic hash and the preparation reference. A receiver must independently snapshot and verify those supplied bytes and hash, then consume that same snapshot. Reopening a mutable source path after the check would reintroduce the byte-swap problem.

## Optional Node store and local publisher

`createFileArtifactStore({ root })` returns:

| Method | Behavior |
| --- | --- |
| `put(bytes, { format })` | Snapshot bytes and exclusively install an immutable content-and-format-addressed file. Reuse an existing file only if its actual bytes agree. |
| `putJson(value, format?)` | Persist a detached canonical JSON snapshot; default format is `application/json`. |
| `read(ref)` | Accept a managed reference, check its path/format binding and verify actual digest and byte count before returning an owned byte array. |

Import externally produced checkpoint/evidence bytes with `put` before using their managed references in a release plan. The helper does not read arbitrary backend-relative paths. Matching content identity permits the trainer's original path and managed storage path to differ.

`createLocalModelPublisher({ root })` returns `publish`, `lookup`, `readTarget(name)` and `readState()`. It snapshots incoming payload/model bytes, verifies both identities and installs the received model as an immutable managed artifact. It uses an interprocess directory lock around the complete registry read/check/update. One atomic registry document holds publication history, current targets and idempotency bindings. Atomic rename is used inside that lock; rename by itself is not concurrency control.

For a new publication, the receiver requires the target's current revision to equal `expectedRevision`. `null` means the target must not already exist. The committed revision is the payload hash. It checks expiry before the new effect and immediately before replacing the registry document. A different payload under an existing idempotency key is denied. A matching key/payload returns the unchanged original receipt before attempting a new target CAS.

`readTarget` reports the current local target; publication history is separate. A retry acknowledging old publication A after a newer B has advanced the target returns A's historical receipt and leaves B current. An acknowledgement is not a claim that A is still deployed.

Corrupt/future registry documents, inconsistent indexes, modified stored blobs and missing/corrupt initialization metadata fail closed. Returned state is detached and frozen. Unknown storage/lock outcomes are not success. A stale lock or incomplete initialization needs operator recovery; the helper does not automatically break a lock it cannot prove safe to remove.

The root and its parent directory entries must be trusted and modified only by cooperating local processes. Managed paths reject traversal and observed symlinks. The implementation does not defeat an adversarial filesystem rename race. It claims one-host local-filesystem behavior, with no fsync/power-loss durability, hostile-filesystem, network-filesystem or distributed exactly-once guarantee.

## Recovering a lost acknowledgement

`ModelPublisher.lookup?({ payload, payloadSha256, preparedRef })` is optional and strictly read-only. It may return the original confirmed `already-published` receipt, a refusal/unknown result, or `null` when no committed idempotency key is found. It must never create a publication or update a target. The Node implementation does not create even an absent registry during lookup and verifies the retained model blob before acknowledging it.

At publication/retry, the core first reconstructs the offered preparation from the independently pinned plan and historical evidence. If lookup confirms the exact original effect, the core also validates that receipt's artifact, target, key, payload hash, revision, commit time and original preparation. It returns `status: 'already-published'` with `decision.basis: 'historical-acknowledgement'`. That path can work after approval expiry or after the live backend has gone away, because it confirms an existing effect and performs no fresh model approval or new publication.

If no existing effect is confirmed, expired approval cannot authorize a new publication. A new effect still requires current live verification and all required checks. Keep the original `preparedRef` and independently pinned `planRef` for recovery; an unverified offered plan is not a substitute.

To simulate a lost acknowledgement, an example transport can throw **after** its receiver's `publish` has returned a committed result. That tests acknowledgement recovery. It must not pretend that an exception before the receiver commits proves an existing effect.

## Trust and extension boundaries

The direct publisher port is a trusted low-level receiver for core-approved requests. It does not authenticate ML approval, verify every ML guard itself, sign receipts or establish remote authorization. Supplying a payload and its matching self-computed hash directly to `publisher.publish` bypasses the core's authority/ML checks. Integrations should expose the checked release API and retain an appropriate trust boundary around the port.

Backend observations and the complete declared experiment remain trusted inputs. Required lineage checks explicit observations, not arbitrary undisclosed data leakage. The local publisher is one effect implementation, not a model registry service, deployment controller, remote scheduler or production authorization system. Other publisher/store ports must preserve same-byte consumption, independent receiver checks, read-only lookup and their own atomic/idempotent semantics.

Saved FootPrint/Lens inspection explains recorded plan, preparation, guard, handoff and acknowledgement facts without publishing or retraining. It does not establish faster human debugging than complete structured logs. The prior v0.4 selection reports remain historical evidence for that version; v0.5 release results and tests are recorded separately.
