import { checkpointRef, detached, fail, finiteNumber, inferenceIdentity, isRecord, jsonObject, nonempty,
  readCheckpointRef, readDatasetRef, readModelRef, sameArtifact, sameInference } from './contracts.js';
import type { CheckpointRef, DatasetRef, EvaluationReceipt, EvaluationReceiptBase, EvaluationReceiptInput, ModelRef } from './contracts.js';

function observedBase<M extends ModelRef, D extends DatasetRef>(input: unknown): EvaluationReceiptBase<M, D> {
  const copy = jsonObject(input, 'evaluation');
  const modelRef = readModelRef<M>(copy.modelRef), datasetRef = readDatasetRef<D>(copy.datasetRef);
  const metrics = jsonObject(copy.metrics, 'metrics');
  if (!Object.keys(metrics).length) fail('invalid-metrics', 'At least one numerical metric is required');
  for (const [name, value] of Object.entries(metrics)) { nonempty(name, 'metric name'); finiteNumber(value, `metrics.${name}`); }
  return detached({ kind: 'evaluation-receipt' as const,
    evaluationId: nonempty(copy.evaluationId, 'evaluationId'), createdAt: finiteNumber(copy.createdAt, 'createdAt', 0),
    modelRef, datasetRef,
    preprocessingVersion: nonempty(copy.preprocessingVersion, 'preprocessingVersion'),
    evaluationMethodVersion: nonempty(copy.evaluationMethodVersion, 'evaluationMethodVersion'),
    parameters: copy.parameters === undefined ? {} : jsonObject(copy.parameters, 'parameters'),
    metrics: metrics as Readonly<Record<string, number>> });
}

/** The caller supplies observations. An explicit measured identity selects v2. */
export function createEvaluationReceipt<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>(
  input: EvaluationReceiptInput<M, D>,
): EvaluationReceipt<M, D> {
  const base = observedBase<M, D>(input);
  const checkpoint = checkpointRef(base.modelRef.originArtifact);
  if (base.modelRef.inferenceIdentity !== undefined)
    return detached({ ...base, schemaVersion: 2 as const,
      inferenceIdentity: base.modelRef.inferenceIdentity, checkpointForAudit: checkpoint });
  return detached({ ...base, schemaVersion: 1 as const, checkpoint });
}

/** Read the stated schema without upgrading archived checkpoint-only evidence. */
export function readEvaluationReceipt(value: unknown): EvaluationReceipt {
  const copy = jsonObject(value, 'receipt');
  if (copy.kind !== 'evaluation-receipt' || (copy.schemaVersion !== 1 && copy.schemaVersion !== 2))
    fail('invalid-receipt', 'Unsupported or missing evaluation receipt schema');
  if (!isRecord(copy.parameters)) fail('invalid-receipt', 'Receipt must retain its evaluation parameters');
  const base = observedBase<ModelRef, DatasetRef>(copy);
  if (copy.schemaVersion === 1) {
    if (Object.hasOwn(copy, 'checkpointForAudit') || Object.hasOwn(copy, 'inferenceIdentity'))
      fail('invalid-receipt', 'A v1 receipt cannot assert v2 inference coverage fields');
    const checkpoint = readCheckpointRef(copy.checkpoint);
    if (!sameArtifact(checkpoint.artifact, base.modelRef.originArtifact))
      fail('invalid-receipt', 'Receipt checkpoint disagrees with its evaluated model');
    return detached({ ...base, schemaVersion: 1 as const, checkpoint });
  }
  if (Object.hasOwn(copy, 'checkpoint')) fail('invalid-receipt', 'A v2 receipt must use checkpointForAudit');
  const checkpointForAudit = readCheckpointRef(copy.checkpointForAudit);
  if (!sameArtifact(checkpointForAudit.artifact, base.modelRef.originArtifact))
    fail('invalid-receipt', 'Receipt audit checkpoint disagrees with its evaluated model');
  const identity = inferenceIdentity(copy.inferenceIdentity);
  if (base.modelRef.inferenceIdentity === undefined || !sameInference(identity, base.modelRef.inferenceIdentity))
    fail('invalid-receipt', 'Receipt inference identity disagrees with its evaluated model');
  return detached({ ...base, schemaVersion: 2 as const, inferenceIdentity: identity, checkpointForAudit });
}

/** The exact saved training checkpoint retained as audit evidence in either schema. */
export function receiptCheckpoint(receipt: EvaluationReceipt): CheckpointRef {
  const checked = readEvaluationReceipt(receipt);
  return checked.schemaVersion === 1 ? checked.checkpoint : checked.checkpointForAudit;
}
