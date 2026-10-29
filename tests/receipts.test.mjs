import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluationReceipt, checkRelease, checkpointRef } from '../dist/index.js';
import { NOW, clone, checkpointArtifact, evaluated, releaseRequest } from './fixtures.mjs';

const receipt = () => createEvaluationReceipt(evaluated());
const deny = decision => {
  assert.equal(decision.allowed, false);
  assert.ok(['deny', 'unknown'].includes(decision.status));
  assert.ok(decision.reasons.length > 0);
};

test('A validation receipt allows an explicit matching release policy and survives JSON persistence', () => {
  const evidence = receipt();
  assert.equal(evidence.kind, 'evaluation-receipt');
  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(evidence.checkpoint, checkpointRef(checkpointArtifact()));
  const accepted = checkRelease(releaseRequest(evidence));
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.status, 'allow');
  assert.equal(checkRelease(releaseRequest(JSON.parse(JSON.stringify(evidence)))).allowed, true);
});

test('Checkpoint identity follows bytes and serialization format, allowing reloads and storage relocation', () => {
  const evidence = receipt();
  const reloaded = releaseRequest(evidence);
  reloaded.modelRef.sessionId = 'worker-after-restart';
  reloaded.modelRef.handle = 1001;
  reloaded.modelRef.originArtifact.path = 'archive/moved-checkpoint.pkl';
  reloaded.datasetRef.sessionId = 'worker-after-restart';
  reloaded.datasetRef.handle = 2002;
  assert.equal(checkRelease(reloaded).allowed, true);
  for (const mutate of [
    request => { request.modelRef.originArtifact.sha256 = 'c'.repeat(64); },
    request => { request.modelRef.originArtifact.bytes++; },
    request => { request.modelRef.originArtifact.format = 'another-model-format/v1'; },
  ]) {
    const changed = releaseRequest(evidence); mutate(changed); deny(checkRelease(changed));
  }
});

test('Validation cannot be borrowed from different data, split semantics or preprocessing', () => {
  const evidence = receipt();
  for (const mutate of [
    request => { request.datasetRef.artifact.sha256 = 'd'.repeat(64); },
    request => { request.datasetRef.role = 'train'; },
    request => { request.datasetRef.rows++; },
    request => { request.datasetRef.shape = [50, 32]; },
    request => { request.preprocessingVersion = 'fit-on-all-data/v2'; },
  ]) {
    const changed = releaseRequest(evidence); mutate(changed); deny(checkRelease(changed));
  }
});

test('Evaluation protocol and nested parameter changes invalidate coverage; key ordering does not', () => {
  const evidence = receipt();
  const changedMethod = releaseRequest(evidence);
  changedMethod.evaluationMethodVersion = 'training-resubstitution/v1';
  deny(checkRelease(changedMethod));
  const changedParameters = releaseRequest(evidence);
  changedParameters.parameters.options.seed = 8;
  deny(checkRelease(changedParameters));
  const reordered = releaseRequest(evidence);
  reordered.parameters = { options: { seed: 7 }, predictionMode: 'labels' };
  assert.equal(checkRelease(reordered).allowed, true);
});

test('Policies apply their declared metric and direction, with inclusive threshold boundaries', () => {
  const evidence = receipt();
  const accuracyBoundary = releaseRequest(evidence);
  accuracyBoundary.policy.threshold = 0.97;
  assert.equal(checkRelease(accuracyBoundary).allowed, true);
  accuracyBoundary.policy.threshold = 0.970001;
  deny(checkRelease(accuracyBoundary));
  const loss = releaseRequest(evidence);
  loss.policy = { metric: 'logLoss', operator: 'lte', threshold: 0.11 };
  assert.equal(checkRelease(loss).allowed, true);
  loss.policy.threshold = 0.10;
  deny(checkRelease(loss));
  const missingMetric = releaseRequest(evidence);
  missingMetric.policy.metric = 'unrecorded-metric';
  deny(checkRelease(missingMetric));
});

test('Absent own metrics remain unavailable even when their names exist on Object.prototype', () => {
  const evidence = receipt();
  for (const metric of ['unrecorded-metric', 'toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const input = releaseRequest(evidence); input.policy.metric = metric;
    const decision = checkRelease(input);
    assert.equal(decision.allowed, false, metric);
    assert.equal(decision.status, 'unknown', metric);
    assert.ok(decision.reasons.some(reason => reason.code === 'metric-unavailable'), metric);
    assert.equal(decision.reasons.some(reason => reason.code === 'metric-threshold-failed'), false, metric);
  }
  // These labels are not forbidden: an explicitly recorded numerical metric is valid.
  for (const metric of ['constructor', '__proto__']) {
    const raw = evaluated(); raw.metrics = JSON.parse(`{"${metric}":0.97}`);
    const input = releaseRequest(createEvaluationReceipt(raw)); input.policy.metric = metric;
    assert.equal(checkRelease(input).allowed, true, metric);
  }
});

test('Freshness is explicit, with expired or future-dated evidence refused', () => {
  const evidence = receipt();
  const fresh = releaseRequest(evidence);
  fresh.policy.maxAgeMs = 100;
  assert.equal(checkRelease(fresh).allowed, true);
  const expired = releaseRequest(evidence);
  expired.policy.maxAgeMs = 99;
  deny(checkRelease(expired));
  const fromFuture = releaseRequest(evidence);
  fromFuture.now = NOW - 1;
  deny(checkRelease(fromFuture));
});

test('Receipts snapshot caller-owned objects and deeply prevent later evidence mutation', () => {
  const raw = evaluated();
  const evidence = createEvaluationReceipt(raw);
  const before = JSON.stringify(evidence);
  raw.metrics.accuracy = 0;
  raw.modelRef.originArtifact.sha256 = 'e'.repeat(64);
  raw.datasetRef.shape[1] = 1;
  raw.parameters.options.seed = 999;
  assert.equal(JSON.stringify(evidence), before);
  assert.equal(Object.isFrozen(evidence), true);
  for (const target of [evidence.metrics, evidence.modelRef.originArtifact, evidence.datasetRef.shape, evidence.parameters.options])
    assert.equal(Object.isFrozen(target), true);
  assert.throws(() => { evidence.metrics.accuracy = 1; }, TypeError);
  assert.throws(() => { evidence.parameters.options.seed = 42; }, TypeError);
  assert.equal(JSON.stringify(evidence), before);
});

test('Malformed, incomplete and nonfinite evidence never becomes an evaluation receipt', () => {
  const mutations = [
    input => { delete input.evaluationId; },
    input => { delete input.modelRef; },
    input => { delete input.datasetRef; },
    input => { delete input.preprocessingVersion; },
    input => { delete input.evaluationMethodVersion; },
    input => { input.modelRef.originArtifact.sha256 = 'not-a-sha256'; },
    input => { input.datasetRef.rows = 0; },
    input => { input.datasetRef.shape = [50, -1]; },
    input => { input.metrics = {}; },
    input => { input.metrics.accuracy = '0.97'; },
    input => { input.createdAt = NaN; },
    ...[NaN, Infinity, -Infinity].map(value => input => { input.metrics.accuracy = value; }),
  ];
  for (const mutate of mutations) {
    const input = evaluated(); mutate(input);
    assert.throws(() => createEvaluationReceipt(input));
  }
});

test('Malformed persisted receipts and invalid policy configuration fail closed at the release boundary', () => {
  const evidence = receipt();
  for (const mutate of [
    request => { delete request.receipt.modelRef; },
    request => { delete request.receipt.checkpoint; },
    request => { delete request.receipt.parameters; },
    request => { request.receipt.checkpoint.artifact.sha256 = 'f'.repeat(64); },
    request => { request.receipt.schemaVersion = 999; },
    request => { request.receipt.metrics.accuracy = NaN; },
    request => { request.policy.threshold = Infinity; },
    request => { request.policy.operator = 'unsupported'; },
    request => { request.policy.maxAgeMs = -1; },
    request => { request.now = NaN; },
  ]) {
    const malformed = clone(releaseRequest(evidence)); mutate(malformed);
    deny(checkRelease(malformed));
  }
});
