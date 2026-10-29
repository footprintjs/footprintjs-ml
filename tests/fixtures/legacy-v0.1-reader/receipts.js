import { checkpointRef, detached, fail, finiteNumber, isRecord, jsonObject, nonempty, readCheckpointRef, readDatasetRef, readModelRef, sameArtifact } from './contracts.js';
/** The caller must supply observed backend identities, not requested labels. */
export function createEvaluationReceipt(input) {
    const copy = jsonObject(input, 'evaluation');
    const modelRef = readModelRef(copy.modelRef), datasetRef = readDatasetRef(copy.datasetRef);
    const metrics = jsonObject(copy.metrics, 'metrics');
    if (!Object.keys(metrics).length)
        fail('invalid-metrics', 'At least one numerical metric is required');
    for (const [name, value] of Object.entries(metrics)) {
        nonempty(name, 'metric name');
        finiteNumber(value, `metrics.${name}`);
    }
    return detached({ kind: 'evaluation-receipt', schemaVersion: 1,
        evaluationId: nonempty(copy.evaluationId, 'evaluationId'), createdAt: finiteNumber(copy.createdAt, 'createdAt', 0),
        modelRef, checkpoint: checkpointRef(modelRef.originArtifact), datasetRef,
        preprocessingVersion: nonempty(copy.preprocessingVersion, 'preprocessingVersion'),
        evaluationMethodVersion: nonempty(copy.evaluationMethodVersion, 'evaluationMethodVersion'),
        parameters: copy.parameters === undefined ? {} : jsonObject(copy.parameters, 'parameters'),
        metrics: metrics });
}
/** Revalidate JSON-restored evidence, including redundant checkpoint binding. */
export function readEvaluationReceipt(value) {
    const copy = jsonObject(value, 'receipt');
    if (copy.kind !== 'evaluation-receipt' || copy.schemaVersion !== 1)
        fail('invalid-receipt', 'Unsupported or missing evaluation receipt schema');
    const checkpoint = readCheckpointRef(copy.checkpoint);
    const receipt = createEvaluationReceipt(copy);
    if (!sameArtifact(checkpoint.artifact, receipt.modelRef.originArtifact))
        fail('invalid-receipt', 'Receipt checkpoint disagrees with its evaluated model');
    if (!isRecord(copy.parameters))
        fail('invalid-receipt', 'Receipt must retain its evaluation parameters');
    return receipt;
}
//# sourceMappingURL=receipts.js.map