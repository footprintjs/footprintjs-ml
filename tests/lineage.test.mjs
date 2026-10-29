import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataLineageReceipt, readDataLineageReceipt, checkDataLineage,
  createEvaluationReceipt, checkRelease } from '../dist/index.js';
import { NOW, clone, model, dataset, evaluated, releaseRequest } from './fixtures.mjs';

const artifact = (name, digest) => ({ kind: 'artifact', path: `lineage/${name}.json`,
  sha256: digest.repeat(64), bytes: 128, format: 'lineage/json-v1' });
const training = () => ({ ...dataset(), handle: 1, role: 'train', rows: 150, shape: [150, 64],
  artifact: artifact('train', 'c') });
function observed() {
  return { lineageId: 'lineage-A', createdAt: NOW, modelRef: { ...model(),
    inferenceIdentity: { kind: 'inference-identity', schemaVersion: 1, sha256: 'd'.repeat(64),
      profile: 'fixture-predictor/v1' } },
    datasetRef: dataset(), splitManifest: artifact('splits', 'e'), trainingDatasetRef: training(),
    overlap: { evidenceArtifact: artifact('membership-report', 'f'),
      trainEvaluationRows: 0, preprocessingEvaluationRows: 0 },
    preprocessing: { artifact: artifact('fitted-scaler', '1'), fitDatasetRefs: [training()] } };
}
const evidence = () => createDataLineageReceipt(observed());
const request = receipt => ({ receipt, modelRef: clone(receipt.modelRef), datasetRef: clone(receipt.datasetRef),
  splitManifest: clone(receipt.splitManifest), policy: { trainingDatasetRef: training() } });
function status(decision, expected, code) {
  assert.equal(decision.status, expected);
  assert.equal(decision.allowed, expected === 'allow');
  if (code) assert.ok(decision.reasons.some(reason => reason.code === code),
    `Missing ${code}: ${JSON.stringify(decision.reasons)}`);
}

test('Clean declared train-only preprocessing and disjoint held-out data allow after JSON persistence', () => {
  const receipt = evidence();
  const saved = JSON.parse(JSON.stringify(receipt));
  assert.deepEqual(readDataLineageReceipt(saved), receipt);
  const decision = checkDataLineage(request(saved));
  status(decision, 'allow', 'declared-lineage-matches-policy');
  assert.equal(decision.receiptId, 'lineage-A');
  assert.deepEqual(decision.bindings.receipt.preprocessing.fitDatasetRefs, [training()]);
  assert.deepEqual(decision.bindings.proposed.trainingDatasetRef, training());
});

test('The correct model and a high passing metric cannot excuse preprocessing fit on evaluation data', () => {
  const raw = observed();
  raw.preprocessing.fitDatasetRefs.push(clone(raw.datasetRef));
  raw.overlap.preprocessingEvaluationRows = raw.datasetRef.rows;
  const lineageReceipt = createDataLineageReceipt(raw);
  const metricReceipt = createEvaluationReceipt({ ...evaluated(), modelRef: raw.modelRef,
    datasetRef: raw.datasetRef, metrics: { accuracy: 0.999999 } });
  status(checkRelease({ ...releaseRequest(metricReceipt), modelRef: raw.modelRef, datasetRef: raw.datasetRef }), 'allow');
  const decision = checkDataLineage(request(lineageReceipt));
  status(decision, 'deny', 'preprocessing-evaluation-overlap');
  assert.ok(decision.reasons.some(reason => reason.code === 'preprocessing-fit-dataset-unauthorized'));
  assert.deepEqual(decision.bindings.proposed.modelRef, decision.bindings.receipt.modelRef);
});

test('Known training overlap denies even when preprocessing evidence is missing', () => {
  const raw = observed();
  raw.overlap.trainEvaluationRows = 3;
  delete raw.preprocessing;
  const decision = checkDataLineage(request(createDataLineageReceipt(raw)));
  status(decision, 'deny', 'training-evaluation-overlap');
  assert.ok(decision.reasons.some(reason => reason.code === 'preprocessing-fit-evidence-unavailable'));
});

test('Zero reported overlap never overrides an unauthorized preprocessing fit partition', () => {
  for (const fitInput of [dataset(), { ...training(), artifact: artifact('other-train', '2') },
    { ...dataset(), role: 'test' }]) {
    const raw = observed(); raw.preprocessing.fitDatasetRefs.push(fitInput);
    const decision = checkDataLineage(request(createDataLineageReceipt(raw)));
    status(decision, 'deny', 'preprocessing-fit-dataset-unauthorized');
  }
});

test('Fit-input role is checked even when artifact, rows, and shape match the allowed training data', () => {
  const raw = observed(); raw.preprocessing.fitDatasetRefs[0].role = 'validation';
  status(checkDataLineage(request(createDataLineageReceipt(raw))), 'deny', 'preprocessing-fit-role-invalid');
});

test('Missing overlap, missing preprocessing, and empty actual fit inputs remain unknown', () => {
  for (const mutate of [
    raw => { delete raw.overlap; },
    raw => { delete raw.preprocessing; },
    raw => { raw.preprocessing.fitDatasetRefs = []; },
    raw => { delete raw.overlap; delete raw.preprocessing; },
  ]) {
    const raw = observed(); mutate(raw);
    status(checkDataLineage(request(createDataLineageReceipt(raw))), 'unknown');
  }
  const missing = request(evidence()); delete missing.receipt;
  status(checkDataLineage(missing), 'unknown', 'invalid-or-missing-evidence');
});

test('A different checkpoint or inference claim cannot borrow a lineage receipt', () => {
  for (const mutate of [
    input => { input.modelRef.originArtifact.sha256 = '3'.repeat(64); },
    input => { input.modelRef.originArtifact.bytes++; },
    input => { input.modelRef.originArtifact.format = 'another-format/v1'; },
    input => { input.modelRef.inferenceIdentity.sha256 = '4'.repeat(64); },
    input => { input.modelRef.inferenceIdentity.profile = 'different-profile/v1'; },
    input => { delete input.modelRef.inferenceIdentity; },
  ]) {
    const input = request(evidence()); mutate(input);
    status(checkDataLineage(input), 'deny', 'model-mismatch');
  }
  const legacy = observed(); delete legacy.modelRef.inferenceIdentity;
  const input = request(createDataLineageReceipt(legacy));
  input.modelRef.inferenceIdentity = observed().modelRef.inferenceIdentity;
  status(checkDataLineage(input), 'deny', 'model-mismatch');
});

test('Evaluation dataset, split manifest, and authorized training partition are independent bindings', () => {
  for (const [code, mutate] of [
    ['dataset-mismatch', input => { input.datasetRef.artifact.sha256 = '3'.repeat(64); }],
    ['dataset-mismatch', input => { input.datasetRef.shape[1] = 32; }],
    ['dataset-mismatch', input => { input.datasetRef.rows++; input.datasetRef.shape[0]++; }],
    ['split-manifest-mismatch', input => { input.splitManifest.sha256 = '4'.repeat(64); }],
    ['split-manifest-mismatch', input => { input.splitManifest.bytes++; }],
    ['split-manifest-mismatch', input => { input.splitManifest.format = 'different-format/v1'; }],
    ['training-dataset-mismatch', input => { input.policy.trainingDatasetRef.artifact.sha256 = '5'.repeat(64); }],
  ]) {
    const input = request(evidence()); mutate(input);
    status(checkDataLineage(input), 'deny', code);
  }
});

test('Evaluation accepts validation or test roles and refuses training or undeclared roles', () => {
  const testRun = observed(); testRun.datasetRef.role = 'test';
  status(checkDataLineage(request(createDataLineageReceipt(testRun))), 'allow');
  for (const role of ['train', 'development', 'holdout']) {
    const raw = observed(); raw.datasetRef.role = role;
    status(checkDataLineage(request(createDataLineageReceipt(raw))), 'deny', 'evaluation-role-invalid');
  }
});

test('Neither caller policy nor receipt may relabel validation data as an allowed training partition', () => {
  const raw = observed(); raw.trainingDatasetRef.role = 'validation';
  const input = request(createDataLineageReceipt(raw));
  input.policy.trainingDatasetRef = clone(raw.trainingDatasetRef);
  status(checkDataLineage(input), 'deny', 'training-role-invalid');
});

test('Reopened runtime handles and relocated paths do not change content bindings', () => {
  const input = request(evidence());
  for (const ref of [input.modelRef, input.datasetRef, input.policy.trainingDatasetRef]) {
    ref.sessionId = 'reopened-worker'; ref.handle += 1000;
  }
  input.modelRef.originArtifact.path = 'moved/model.bin';
  input.datasetRef.artifact.path = 'moved/validation.json';
  input.policy.trainingDatasetRef.artifact.path = 'moved/train.json';
  input.splitManifest.path = 'moved/splits.json';
  status(checkDataLineage(input), 'allow');
});

test('Counts must be finite nonnegative safe integers bounded by distinct evaluation row counts', () => {
  for (const field of ['trainEvaluationRows', 'preprocessingEvaluationRows']) {
    for (const value of [NaN, Infinity, -Infinity, -1, 0.5, '0', null, 51, Number.MAX_SAFE_INTEGER + 1]) {
      const raw = observed(); raw.overlap[field] = value;
      assert.throws(() => createDataLineageReceipt(raw), `${field}=${value}`);
      const saved = { ...raw, kind: 'data-lineage-receipt', schemaVersion: 1 };
      assert.throws(() => readDataLineageReceipt(saved), `${field}=${value}`);
      const input = request(evidence()); input.receipt = saved;
      status(checkDataLineage(input), 'unknown', 'invalid-or-missing-evidence');
    }
  }
  const raw = observed(); delete raw.overlap.preprocessingEvaluationRows;
  assert.throws(() => createDataLineageReceipt(raw));
});

test('Malformed schemas, required references, artifacts, fit-input arrays, and timestamps fail closed', () => {
  for (const mutate of [
    raw => { delete raw.modelRef; },
    raw => { delete raw.datasetRef; },
    raw => { delete raw.trainingDatasetRef; },
    raw => { delete raw.splitManifest; },
    raw => { raw.splitManifest.sha256 = 'invalid'; },
    raw => { delete raw.overlap.evidenceArtifact; },
    raw => { delete raw.preprocessing.artifact; },
    raw => { raw.preprocessing.fitDatasetRefs = null; },
    raw => { raw.preprocessing.fitDatasetRefs = [null]; },
    raw => { raw.lineageId = ''; },
    ...[NaN, Infinity, -1].map(value => raw => { raw.createdAt = value; }),
  ]) {
    const raw = observed(); mutate(raw);
    assert.throws(() => createDataLineageReceipt(raw));
  }
  for (const mutate of [
    raw => { raw.kind = 'other'; },
    raw => { raw.schemaVersion = 2; },
    raw => { delete raw.schemaVersion; },
  ]) {
    const saved = clone(evidence()); mutate(saved);
    assert.throws(() => readDataLineageReceipt(saved));
    const input = request(evidence()); input.receipt = saved;
    status(checkDataLineage(input), 'unknown', 'invalid-or-missing-evidence');
  }
});

test('Receipt creation, saved receipt reading, and decisions detach and deeply freeze nested snapshots', () => {
  const raw = observed(), receipt = createDataLineageReceipt(raw);
  const before = JSON.stringify(receipt);
  raw.preprocessing.fitDatasetRefs[0].artifact.sha256 = '3'.repeat(64);
  raw.overlap.trainEvaluationRows = 25;
  raw.modelRef.inferenceIdentity.sha256 = '4'.repeat(64);
  assert.equal(JSON.stringify(receipt), before);
  const saved = clone(receipt), read = readDataLineageReceipt(saved);
  saved.preprocessing.fitDatasetRefs[0].shape[1] = 1;
  assert.equal(JSON.stringify(read), before);
  const input = request(receipt), decision = checkDataLineage(input);
  const decisionBefore = JSON.stringify(decision);
  input.modelRef.originArtifact.bytes++;
  input.policy.trainingDatasetRef.artifact.sha256 = '5'.repeat(64);
  assert.equal(JSON.stringify(decision), decisionBefore);
  for (const value of [receipt, receipt.modelRef.inferenceIdentity, receipt.overlap,
    receipt.preprocessing.fitDatasetRefs, receipt.preprocessing.fitDatasetRefs[0].shape,
    read.preprocessing.artifact, decision.reasons, decision.bindings.receipt.preprocessing])
    assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { receipt.overlap.trainEvaluationRows = 1; }, TypeError);
  assert.throws(() => { decision.bindings.receipt.preprocessing.fitDatasetRefs.push(training()); }, TypeError);
});

test('Executable, accessor, cyclic, and non-JSON lineage data are not accepted as evidence', () => {
  const withAccessor = observed();
  Object.defineProperty(withAccessor.preprocessing, 'fitDatasetRefs', { enumerable: true, get() {
    throw new Error('must not execute');
  } });
  assert.throws(() => createDataLineageReceipt(withAccessor), /accessor/);
  const withFunction = observed(); withFunction.preprocessing.fitDatasetRefs[0].reader = () => [];
  assert.throws(() => createDataLineageReceipt(withFunction));
  const cyclic = observed(); cyclic.self = cyclic;
  assert.throws(() => createDataLineageReceipt(cyclic), /cycle/);
});
