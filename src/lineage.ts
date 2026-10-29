import { artifactRef, detached, fail, finiteNumber, jsonObject, nonempty, readDatasetRef,
  readModelRef, sameArtifact, sameDataset, sameModelContent } from './contracts.js';
import type { ArtifactRef, DatasetRef, JsonValue, ModelRef } from './contracts.js';

/** Counts are backend observations of distinct evaluation row identities. */
export interface DataLineageOverlap {
  readonly evidenceArtifact: ArtifactRef;
  readonly trainEvaluationRows: number;
  readonly preprocessingEvaluationRows: number;
}
export interface DataLineagePreprocessing {
  readonly artifact: ArtifactRef;
  readonly fitDatasetRefs: readonly DatasetRef[];
}
export interface DataLineageReceiptInput<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef> {
  readonly lineageId: string;
  readonly createdAt: number;
  readonly modelRef: M;
  readonly datasetRef: D;
  readonly splitManifest: ArtifactRef;
  readonly trainingDatasetRef: DatasetRef;
  /** Omit when membership evidence is unavailable; omission is never zero. */
  readonly overlap?: DataLineageOverlap;
  /** Omit when actual preprocessing fit inputs were not observed. */
  readonly preprocessing?: DataLineagePreprocessing;
}
export interface DataLineageReceipt<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>
  extends DataLineageReceiptInput<M, D> {
  readonly kind: 'data-lineage-receipt';
  readonly schemaVersion: 1;
}
export interface DataLineagePolicy {
  /** The caller authorizes the training partition independently of the receipt. */
  readonly trainingDatasetRef: DatasetRef;
}
export interface DataLineageRequest {
  readonly receipt: unknown;
  readonly modelRef: ModelRef;
  readonly datasetRef: DatasetRef;
  readonly splitManifest: ArtifactRef;
  readonly policy: DataLineagePolicy;
}
export interface DataLineageReason { readonly code: string; readonly message: string }
export interface DataLineageDecision {
  readonly kind: 'data-lineage-decision';
  readonly schemaVersion: 1;
  readonly allowed: boolean;
  readonly status: 'allow' | 'deny' | 'unknown';
  readonly reasons: readonly DataLineageReason[];
  readonly receiptId: string | null;
  readonly bindings: { readonly proposed: JsonValue; readonly receipt: JsonValue };
}

function count(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    fail('invalid-lineage-count', `${label} must be a nonnegative safe integer <= ${maximum}`);
  return value;
}

function observedLineage<M extends ModelRef, D extends DatasetRef>(input: unknown): DataLineageReceipt<M, D> {
  const copy = jsonObject(input, 'data lineage');
  const modelRef = readModelRef<M>(copy.modelRef), datasetRef = readDatasetRef<D>(copy.datasetRef);
  const trainingDatasetRef = readDatasetRef(copy.trainingDatasetRef);
  const splitManifest = artifactRef(copy.splitManifest);
  let overlap: DataLineageOverlap | undefined;
  if (Object.hasOwn(copy, 'overlap')) {
    const raw = jsonObject(copy.overlap, 'overlap');
    overlap = {
      evidenceArtifact: artifactRef(raw.evidenceArtifact),
      trainEvaluationRows: count(raw.trainEvaluationRows, 'overlap.trainEvaluationRows',
        Math.min(trainingDatasetRef.rows, datasetRef.rows)),
      preprocessingEvaluationRows: count(raw.preprocessingEvaluationRows,
        'overlap.preprocessingEvaluationRows', datasetRef.rows),
    };
  }
  let preprocessing: DataLineagePreprocessing | undefined;
  if (Object.hasOwn(copy, 'preprocessing')) {
    const raw = jsonObject(copy.preprocessing, 'preprocessing');
    if (!Array.isArray(raw.fitDatasetRefs))
      fail('invalid-lineage-preprocessing', 'preprocessing.fitDatasetRefs must be an array of actual fit-input dataset references');
    preprocessing = { artifact: artifactRef(raw.artifact), fitDatasetRefs: raw.fitDatasetRefs.map(ref => readDatasetRef(ref)) };
  }
  return detached({ kind: 'data-lineage-receipt' as const, schemaVersion: 1 as const,
    lineageId: nonempty(copy.lineageId, 'lineageId'), createdAt: finiteNumber(copy.createdAt, 'createdAt', 0),
    modelRef, datasetRef, splitManifest, trainingDatasetRef,
    ...(overlap === undefined ? {} : { overlap }),
    ...(preprocessing === undefined ? {} : { preprocessing }) });
}

/** Snapshot backend-reported lineage, including incomplete evidence without inventing facts. */
export function createDataLineageReceipt<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>(
  input: DataLineageReceiptInput<M, D>,
): DataLineageReceipt<M, D> {
  return observedLineage<M, D>(input);
}

/** Validate saved evidence without reading artifacts or measuring row membership. */
export function readDataLineageReceipt(value: unknown): DataLineageReceipt {
  const copy = jsonObject(value, 'data lineage receipt');
  if (copy.kind !== 'data-lineage-receipt' || copy.schemaVersion !== 1)
    fail('invalid-lineage-receipt', 'Unsupported or missing data lineage receipt schema');
  return observedLineage<ModelRef, DatasetRef>(copy);
}

/** A separate consistency check: metric success does not establish uncontaminated data. */
export function checkDataLineage(input: DataLineageRequest): DataLineageDecision {
  let receipt: DataLineageReceipt | undefined;
  let proposed: JsonValue = null, recorded: JsonValue = null;
  const reasons: DataLineageReason[] = [];
  let denied = false, unknown = false;
  const deny = (code: string, message: string) => { denied = true; reasons.push({ code, message }); };
  const missing = (code: string, message: string) => { unknown = true; reasons.push({ code, message }); };
  try {
    const copy = jsonObject(input, 'data lineage request');
    const modelRef = readModelRef(copy.modelRef), datasetRef = readDatasetRef(copy.datasetRef);
    const splitManifest = artifactRef(copy.splitManifest);
    const policy = jsonObject(copy.policy, 'data lineage policy');
    const allowedTraining = readDatasetRef(policy.trainingDatasetRef);
    receipt = readDataLineageReceipt(copy.receipt);
    proposed = jsonObject({ modelRef, datasetRef, splitManifest, trainingDatasetRef: allowedTraining });
    recorded = jsonObject(receipt);

    if (!sameModelContent(modelRef, receipt.modelRef))
      deny('model-mismatch', 'The proposed checkpoint or declared inference identity differs from the lineage model.');
    if (!sameDataset(datasetRef, receipt.datasetRef))
      deny('dataset-mismatch', 'The proposed evaluation dataset identity, role, shape, or row count differs from the lineage dataset.');
    if (!sameArtifact(splitManifest, receipt.splitManifest))
      deny('split-manifest-mismatch', 'The proposed split manifest digest, size, or format differs from the lineage manifest.');
    if (!sameDataset(allowedTraining, receipt.trainingDatasetRef))
      deny('training-dataset-mismatch', 'The lineage training partition differs from the partition authorized by policy.');
    if (datasetRef.role !== 'validation' && datasetRef.role !== 'test')
      deny('evaluation-role-invalid', 'The evaluated partition must have role validation or test.');
    if (allowedTraining.role !== 'train' || receipt.trainingDatasetRef.role !== 'train')
      deny('training-role-invalid', 'The authorized and recorded training partitions must have role train.');

    if (receipt.overlap === undefined) {
      missing('overlap-evidence-unavailable', 'Backend-reported training and preprocessing overlap counts are unavailable.');
    } else {
      if (receipt.overlap.trainEvaluationRows > 0)
        deny('training-evaluation-overlap', `${receipt.overlap.trainEvaluationRows} evaluation row identities were also used for training.`);
      if (receipt.overlap.preprocessingEvaluationRows > 0)
        deny('preprocessing-evaluation-overlap', `${receipt.overlap.preprocessingEvaluationRows} evaluation row identities were also used to fit preprocessing.`);
    }
    if (receipt.preprocessing === undefined || receipt.preprocessing.fitDatasetRefs.length === 0) {
      missing('preprocessing-fit-evidence-unavailable', 'The fitted preprocessing artifact and its actual fit-input datasets are required.');
    } else {
      for (const [index, fitInput] of receipt.preprocessing.fitDatasetRefs.entries()) {
        if (fitInput.role !== 'train')
          deny('preprocessing-fit-role-invalid', `Preprocessing fit input ${index} has role ${fitInput.role}; only train is permitted.`);
        if (!sameDataset(fitInput, allowedTraining))
          deny('preprocessing-fit-dataset-unauthorized', `Preprocessing fit input ${index} differs from the training partition authorized by policy.`);
      }
    }
  } catch (error) {
    missing('invalid-or-missing-evidence', error instanceof Error ? error.message : 'Invalid data lineage evidence');
  }
  const allowed = !denied && !unknown;
  if (allowed) reasons.push({ code: 'declared-lineage-matches-policy',
    message: 'Model, evaluation and training partitions, split manifest, zero reported overlap, and actual preprocessing fit inputs match the declared lineage policy.' });
  return detached({ kind: 'data-lineage-decision' as const, schemaVersion: 1 as const,
    allowed, status: allowed ? 'allow' as const : denied ? 'deny' as const : 'unknown' as const,
    reasons, receiptId: receipt?.lineageId ?? null, bindings: { proposed, receipt: recorded } });
}
