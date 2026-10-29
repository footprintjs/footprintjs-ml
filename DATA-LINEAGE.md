# Data lineage checks

A release can name the correct model and pass its metric threshold while using an invalid evaluation. For example, a scaler fitted on validation data has learned from the partition meant to remain held out. The model identity check can pass because it is the same evaluated model. A separate data lineage check asks whether the declared training and preprocessing inputs were permitted.

The root entry exports `createDataLineageReceipt`, `readDataLineageReceipt`, and `checkDataLineage`. These are pure JSON functions with no filesystem, hashing, Python, or FootPrint dependency. They do not change `EvaluationReceipt` or `checkRelease` semantics.

## Backend observations and caller policy

The backend reports the inputs it actually used, rather than copying the requested preprocessing plan. It keeps large row memberships in an artifact and returns small references and counts:

```ts
const lineage = createDataLineageReceipt({
  lineageId: 'lineage-evaluation-A',
  createdAt: evaluationFinishedAt,
  modelRef: actualEvaluatedModel,
  datasetRef: actualEvaluationPartition,
  splitManifest: actualSplitManifest,
  trainingDatasetRef: actualTrainingPartition,
  overlap: {
    evidenceArtifact: membershipReportArtifact,
    trainEvaluationRows: 0,
    preprocessingEvaluationRows: 0,
  },
  preprocessing: {
    artifact: actualFittedPreprocessingArtifact,
    fitDatasetRefs: [actualPreprocessingFitPartition],
  },
});

const lineageDecision = checkDataLineage({
  receipt: lineage,
  modelRef: verifiedModel,
  datasetRef: intendedEvaluationPartition,
  splitManifest: intendedSplitManifest,
  policy: { trainingDatasetRef: authorizedTrainingPartition },
});

// Run the existing metric/identity check independently.
const releaseDecision = checkRelease(releaseRequest);
if (!releaseDecision.allowed || !lineageDecision.allowed) {
  // Record both decisions; the application withholds release.
}
```

`trainingDatasetRef` in policy is supplied independently by the application. A receipt cannot authorize its own choice of training partition. This first contract authorizes one exact training partition; each actual preprocessing fit input must match that partition. It does not yet model permitted unions of training shards or cross-validation fold policies.

## Receipt contract

The saved receipt has `kind: 'data-lineage-receipt'` and `schemaVersion: 1`, followed by:

| Field | Meaning |
| --- | --- |
| `lineageId`, `createdAt` | Caller-supplied identifier and finite, nonnegative observation timestamp. No age or expiry policy is applied. |
| `modelRef` | Snapshot of the model actually evaluated, including its originating checkpoint and any declared inference identity. |
| `datasetRef` | Snapshot of the partition actually evaluated. Its role must be `validation` or `test` for allowance. |
| `splitManifest` | Artifact reference for the backend's split definition. |
| `trainingDatasetRef` | Snapshot of the actual training partition, with role `train`. |
| `overlap.evidenceArtifact` | Artifact reference to backend membership/overlap evidence. Row lists stay in that artifact. |
| `overlap.trainEvaluationRows` | Count of distinct evaluation row identities also used for model training. |
| `overlap.preprocessingEvaluationRows` | Count of distinct evaluation row identities also used to fit preprocessing. |
| `preprocessing.artifact` | Artifact reference to the fitted preprocessing state used for evaluation. |
| `preprocessing.fitDatasetRefs` | Dataset references for the actual inputs used to fit that state. Applying an already fitted transform to validation/test data is not fitting it. |

Both counts must be finite, nonnegative safe integers. Training overlap cannot exceed the smaller training/evaluation row count; preprocessing overlap cannot exceed the evaluation row count. Omit `overlap` or `preprocessing` when the respective evidence is unavailable. Missing evidence never means zero; a partially formed evidence object is malformed. An empty fit-input list is incomplete evidence and cannot allow release. A workflow with no fitted preprocessing needs a different explicit contract rather than inventing a fit input.

Creation and reading validate present data, return detached deeply frozen snapshots, and retain extra JSON fields within model/dataset references as the existing validators do. Top-level receipt fields use the contract above. `readDataLineageReceipt` rejects unsupported schemas. Persisting and reopening the JSON preserves recorded evidence; it does not establish its authenticity.

## Decision meanings

`checkDataLineage` returns a frozen JSON object with `kind: 'data-lineage-decision'`, `schemaVersion: 1`, `allowed`, `status`, `receiptId`, reason codes/messages, and both proposed and recorded bindings.

| Status | Meaning |
| --- | --- |
| `allow` | All bindings match; training/evaluation roles are permitted; both reported overlap counts are zero; actual preprocessing fit inputs match the independently authorized training partition. |
| `deny` | A known binding differs, a declared role is invalid, overlap is positive, or a preprocessing fit input is unauthorized. Known failures take precedence over separately missing optional evidence. |
| `unknown` | Required evidence is missing or malformed, or optional overlap/preprocessing observations are unavailable or incomplete. `allowed` is false. |

Zero overlap counts do not override an unauthorized fit reference. A validation/test fit input is refused even if the backend also reports zero overlap. A high accuracy or low loss does not change this decision: metric acceptance belongs to `checkRelease` and cannot repair contaminated evaluation data.

Model binding compares the full checkpoint artifact and declared inference identity using the existing model-content equality helper. This lineage snapshot is stricter than a v2 evaluation receipt's inference-only coverage: a changed training checkpoint requires new lineage evidence even if predictions remain identical. Dataset binding compares artifact identity, role, rows, and shape. Artifact identity compares SHA-256, byte count, and format; relocation paths and reopened runtime handles may differ.

## FootPrint and the trust boundary

Keep the receipt and decisions in scope, alongside backend references. Existing FootPrint stage commits and events provide their recorded writer, branch, and retry history; Lens and foottrace can reopen those saved values. The backend does not invent a workflow stage identifier. The application can trace a bad `preprocessing.fitDatasetRefs` value to its recorded workflow writer using that history.

The core does not read artifacts, recompute hashes, inspect row lists, or discover leakage automatically. It checks the consistency of backend-reported facts against explicit caller policy. An adapter must measure overlap from the split memberships and actual fit inputs, bind the fitted preprocessing artifact into its inference contract, and report those facts honestly. A backend that lies about its inputs or counts can defeat this check. Signatures, artifact verification, time/group-aware leakage rules, feature/label leakage, statistically valid evaluation design, and deployment transactions remain outside this contract.

The check also does not make trainer side effects transactional. Run it with the existing live model verification immediately before the application's release stage, record the decisions, and release only when every required check explicitly allows it.
