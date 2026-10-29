import { canonicalJson, detached, fail, finiteNumber, jsonObject, nonempty, readDatasetRef,
  readModelRef, sameArtifact, sameDataset, sameInference } from './contracts.js';
import type { EvaluationReceipt, JsonValue, ReleaseDecision, ReleasePolicy, ReleaseReason, ReleaseRequest } from './contracts.js';
import { readEvaluationReceipt } from './receipts.js';

/** Fail closed: this is a consistency/policy decision, not a deployment action. */
export function checkRelease(input: ReleaseRequest): ReleaseDecision {
  let receipt: EvaluationReceipt | undefined;
  let policy: ReleasePolicy | null = null, checkedAt: number | null = null;
  let proposed: JsonValue = null, recorded: JsonValue = null;
  let coverage: 'checkpoint' | 'inference' | null = null;
  const reasons: ReleaseReason[] = [];
  let denied = false, unknown = false;
  const deny = (code: string, message: string) => { denied = true; reasons.push({ code, message }); };
  try {
    const copy = jsonObject(input, 'release request');
    const modelRef = readModelRef(copy.modelRef), datasetRef = readDatasetRef(copy.datasetRef);
    const preprocessingVersion = nonempty(copy.preprocessingVersion, 'preprocessingVersion');
    const evaluationMethodVersion = nonempty(copy.evaluationMethodVersion, 'evaluationMethodVersion');
    const parameters = copy.parameters === undefined ? {} : jsonObject(copy.parameters, 'parameters');
    receipt = readEvaluationReceipt(copy.receipt);
    coverage = receipt.schemaVersion === 1 ? 'checkpoint' : 'inference';
    checkedAt = finiteNumber(copy.now === undefined ? Date.now() : copy.now, 'now', 0);
    const raw = jsonObject(copy.policy, 'policy');
    for (const key of Object.keys(raw)) if (!['metric', 'operator', 'threshold', 'maxAgeMs'].includes(key))
      fail('invalid-policy', `Unsupported policy field: ${key}`);
    const metric = nonempty(raw.metric, 'policy.metric');
    if (raw.operator !== 'gte' && raw.operator !== 'lte') fail('invalid-policy', 'Policy operator must be gte or lte');
    const threshold = finiteNumber(raw.threshold, 'policy.threshold');
    policy = { metric, operator: raw.operator, threshold,
      ...(raw.maxAgeMs === undefined ? {} : { maxAgeMs: finiteNumber(raw.maxAgeMs, 'policy.maxAgeMs', 0) }) };
    const evaluatedCheckpoint = receipt.schemaVersion === 1 ? receipt.checkpoint : receipt.checkpointForAudit;
    proposed = jsonObject({ modelRef, checkpoint: modelRef.originArtifact,
      inferenceIdentity: modelRef.inferenceIdentity ?? null, datasetRef,
      preprocessingVersion, evaluationMethodVersion, parameters });
    recorded = jsonObject({ evaluationId: receipt.evaluationId, createdAt: receipt.createdAt,
      checkpoint: evaluatedCheckpoint.artifact, modelRef: receipt.modelRef,
      inferenceIdentity: receipt.schemaVersion === 2 ? receipt.inferenceIdentity : receipt.modelRef.inferenceIdentity ?? null,
      datasetRef: receipt.datasetRef,
      preprocessingVersion: receipt.preprocessingVersion, evaluationMethodVersion: receipt.evaluationMethodVersion,
      parameters: receipt.parameters, metrics: receipt.metrics });
    if (receipt.schemaVersion === 1) {
      if (!sameArtifact(modelRef.originArtifact, receipt.checkpoint.artifact))
        deny('checkpoint-mismatch', 'The proposed checkpoint differs from the evaluated checkpoint digest, size, or format.');
      const oldIdentity = receipt.modelRef.inferenceIdentity, newIdentity = modelRef.inferenceIdentity;
      if ((oldIdentity === undefined) !== (newIdentity === undefined) ||
          (oldIdentity !== undefined && newIdentity !== undefined && !sameInference(oldIdentity, newIdentity)))
        deny('inference-evidence-mismatch', 'Identity presence or value differs; checkpoint-only evidence cannot be upgraded to inference coverage.');
    } else if (modelRef.inferenceIdentity === undefined) {
      unknown = true;
      reasons.push({ code: 'inference-identity-unavailable', message: 'The proposed model has no measured inference identity required by this receipt.' });
    } else if (!sameInference(modelRef.inferenceIdentity, receipt.inferenceIdentity)) {
      deny('inference-mismatch', 'The proposed inference profile or digest differs from the evaluated inference identity.');
    } else {
      reasons.push({ code: 'inference-identity-matches', message: 'The proposed inference profile and digest match the evaluated model.' });
      if (!sameArtifact(modelRef.originArtifact, receipt.checkpointForAudit.artifact))
        reasons.push({ code: 'checkpoint-differs-inference-matches', message: 'The full training checkpoint differs; this v2 receipt covers the matching inference identity and retains its evaluated checkpoint for audit.' });
    }
    if (!sameDataset(datasetRef, receipt.datasetRef))
      deny('dataset-mismatch', 'The evaluation dataset identity, role, shape, or row count differs.');
    if (preprocessingVersion !== receipt.preprocessingVersion)
      deny('preprocessing-mismatch', 'The proposed preprocessing version differs from the evaluated preprocessing.');
    if (evaluationMethodVersion !== receipt.evaluationMethodVersion)
      deny('evaluation-method-mismatch', 'The evaluation method version differs.');
    if (canonicalJson(parameters) !== canonicalJson(receipt.parameters))
      deny('parameters-mismatch', 'The evaluation parameters differ from the recorded parameters.');
    if (receipt.createdAt > checkedAt) deny('receipt-from-future', 'The receipt is dated after the release check.');
    if (policy.maxAgeMs !== undefined && checkedAt - receipt.createdAt > policy.maxAgeMs)
      deny('receipt-expired', 'The receipt exceeds the policy maximum age.');
    const measured = Object.hasOwn(receipt.metrics, metric) ? receipt.metrics[metric] : undefined;
    if (measured === undefined) { unknown = true; reasons.push({ code: 'metric-unavailable', message: `Metric ${metric} was not recorded.` }); }
    else if (!(policy.operator === 'gte' ? measured >= threshold : measured <= threshold))
      deny('metric-threshold-failed', `Recorded ${metric}=${measured} does not satisfy ${policy.operator} ${threshold}.`);
  } catch (error) {
    unknown = true;
    reasons.push({ code: 'invalid-or-missing-evidence', message: error instanceof Error ? error.message : 'Invalid release evidence' });
  }
  const allowed = !denied && !unknown;
  if (allowed) reasons.push({ code: 'receipt-matches-policy', message: `${coverage === 'inference' ? 'Inference identity' : 'Checkpoint'}, dataset, preprocessing, evaluation method, parameters, and metric policy match.` });
  return detached({ kind: 'release-decision' as const, schemaVersion: 1 as const,
    allowed, status: allowed ? 'allow' as const : denied ? 'deny' as const : 'unknown' as const,
    reasons, checkedAt, receiptId: receipt?.evaluationId ?? null, policy,
    bindings: { coverage, proposed, receipt: recorded } });
}
