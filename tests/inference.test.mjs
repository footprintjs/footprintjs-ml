import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEvaluationReceipt, readEvaluationReceipt, receiptCheckpoint, checkRelease,
  createTrainerAdapter, checkpointRef, ML_EVENTS } from '../dist/index.js';
import { readEvaluationReceipt as readV01 } from './fixtures/legacy-v0.1-reader/receipts.js';
import { NOW, clone, model, evaluated, request, releaseRequest, checkpointArtifact, fakePort } from './fixtures.mjs';

// This fixture profile deliberately includes only inference-relevant components.
// Optimizer/PRNG/step/container bytes are separate checkpoint state, not its inputs.
const inference = (changes = {}) => ({ kind: 'inference-identity', schemaVersion: 1,
  profile: 'fixture/weights-preprocessing-architecture-code/v1',
  sha256: createHash('sha256').update(JSON.stringify({ weights: 'weights-A', preprocessing: 'scale-A',
    architecture: '64-32-10-relu', code: 'inference-source-A', ...changes })).digest('hex') });
const awareModel = (changes = {}) => ({ ...model(), inferenceIdentity: inference(changes) });
const awareInput = () => ({ ...evaluated(), modelRef: awareModel() });
const awareReceipt = () => createEvaluationReceipt(awareInput());
const awareRelease = receipt => ({ ...releaseRequest(receipt), modelRef: awareModel() });
const blocked = decision => { assert.equal(decision.allowed, false); assert.ok(decision.reasons.length > 0); };

function inspectedPort() {
  let actual = awareModel();
  const calls = { inspect: [], evaluate: [], train: [], load: [], dispose: [] };
  const sequence = [];
  let evaluateEffect;
  const port = {
    sessionId: actual.sessionId,
    async inspect(input) { sequence.push('inspect'); calls.inspect.push(clone(input)); return { modelRef: clone(actual) }; },
    async train(input) { sequence.push('train'); calls.train.push(clone(input)); return { modelRef: awareModel(), checkpoint: checkpointArtifact() }; },
    async load(input) { sequence.push('load'); calls.load.push(clone(input)); return { modelRef: awareModel(), actualArtifact: checkpointArtifact() }; },
    async evaluate(input) {
      sequence.push('evaluate'); calls.evaluate.push(clone(input));
      const result = { ...clone(input), evaluationId: 'aware-evaluation', metrics: { accuracy: .97 } };
      evaluateEffect?.();
      return result;
    },
    async dispose(input) { sequence.push('dispose'); calls.dispose.push(clone(input)); return { modelRef: clone(actual), released: true }; },
  };
  return { port, calls, sequence, setActual(ref) { actual = clone(ref); },
    onEvaluate(effect) { evaluateEffect = effect; } };
}

test('New identity-aware evaluations produce an explicit v2 inference receipt with separate checkpoint audit data', () => {
  const receipt = awareReceipt();
  assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(receipt.inferenceIdentity, inference());
  assert.deepEqual(receipt.checkpointForAudit, checkpointRef(checkpointArtifact()));
  assert.equal(Object.hasOwn(receipt, 'checkpoint'), false);
  assert.deepEqual(receiptCheckpoint(receipt), receipt.checkpointForAudit);
  assert.deepEqual(readEvaluationReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
  assert.equal(Object.isFrozen(receipt.inferenceIdentity), true);
  assert.equal(checkRelease(awareRelease(receipt)).allowed, true);
  assert.equal(checkRelease(awareRelease(receipt)).bindings.coverage, 'inference');
});

test('V2 coverage permits optimizer-only and container changes while retaining the original checkpoint for audit', () => {
  const receipt = awareReceipt();
  for (const changes of [
    { sha256: 'c'.repeat(64), bytes: 2048 },
    { sha256: 'd'.repeat(64), bytes: 1500, format: 'new-checkpoint-container/v2' },
  ]) {
    const proposed = awareRelease(receipt);
    Object.assign(proposed.modelRef.originArtifact, changes);
    proposed.modelRef.sessionId = 'restarted-worker';
    proposed.modelRef.handle = 100;
    const decision = checkRelease(proposed);
    assert.equal(decision.allowed, true);
    assert.equal(receipt.checkpointForAudit.artifact.sha256, checkpointArtifact().sha256);
  }
});

test('Changed weights, fitted preprocessing, architecture or inference code cannot borrow prior v2 coverage', () => {
  const receipt = awareReceipt();
  for (const change of [{ weights: 'weights-B' }, { preprocessing: 'scale-B' },
    { architecture: '64-16-10-tanh' }, { code: 'inference-source-B' }]) {
    const proposed = awareRelease(receipt);
    proposed.modelRef.inferenceIdentity = inference(change);
    blocked(checkRelease(proposed));
  }
  const otherProfile = awareRelease(receipt);
  otherProfile.modelRef.inferenceIdentity.profile = 'another-backend/same-digest-domain/v1';
  blocked(checkRelease(otherProfile));
});

test('V1 receipts are preserved rather than silently upgraded, and retain exact-checkpoint coverage', () => {
  const legacy = createEvaluationReceipt(evaluated());
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(checkRelease(releaseRequest(legacy)).bindings.coverage, 'checkpoint');
  assert.deepEqual(receiptCheckpoint(legacy), legacy.checkpoint);
  assert.equal(readV01(clone(legacy)).schemaVersion, 1);
  const taggedLegacy = clone(legacy);
  taggedLegacy.modelRef.inferenceIdentity = inference();
  const restored = readEvaluationReceipt(taggedLegacy);
  assert.equal(restored.schemaVersion, 1);
  assert.equal(Object.hasOwn(restored, 'inferenceIdentity'), false);
  assert.equal(Object.hasOwn(restored, 'checkpointForAudit'), false);
  const exact = awareRelease(restored);
  assert.equal(checkRelease(exact).allowed, true);
  exact.modelRef.originArtifact.sha256 = 'e'.repeat(64);
  blocked(checkRelease(exact));
  assert.throws(() => readV01(clone(awareReceipt())), /schema|receipt|Unsupported/i);
});

test('Missing, mixed and contradictory identity evidence fails closed without dropping back to checkpoint matching', () => {
  const receipt = awareReceipt();
  for (const mutate of [
    input => { delete input.modelRef.inferenceIdentity; },
    input => { delete input.receipt.inferenceIdentity; },
    input => { delete input.receipt.modelRef.inferenceIdentity; },
    input => { input.receipt.inferenceIdentity = inference({ weights: 'contradiction' }); },
    input => { input.receipt.checkpointForAudit.artifact.sha256 = 'e'.repeat(64); },
    input => { input.receipt.inferenceIdentity.profile = 'contradictory-profile/v1'; },
    input => { input.receipt.checkpoint = clone(input.receipt.checkpointForAudit); },
  ]) {
    const input = clone(awareRelease(receipt)); mutate(input); blocked(checkRelease(input));
  }
  const legacyWithAwareProposal = awareRelease(createEvaluationReceipt(evaluated()));
  blocked(checkRelease(legacyWithAwareProposal));
  const mixedV1 = clone(createEvaluationReceipt(evaluated()));
  mixedV1.inferenceIdentity = inference();
  assert.throws(() => readEvaluationReceipt(mixedV1));
});

test('Malformed identity claims are rejected when recording or reopening evidence', () => {
  for (const mutate of [
    identity => { identity.kind = 'other-kind'; },
    identity => { identity.schemaVersion = 999; },
    identity => { identity.sha256 = 'not-a-digest'; },
    identity => { identity.profile = ''; },
  ]) {
    const input = awareInput(); mutate(input.modelRef.inferenceIdentity);
    assert.throws(() => createEvaluationReceipt(input));
  }
});

test('Identity-aware new handles require inspection before train/load publication or evaluation', async () => {
  for (const operation of ['train', 'loadCheckpoint', 'evaluate', 'dispose']) {
    const fixture = inspectedPort(); delete fixture.port.inspect;
    const adapter = createTrainerAdapter(fixture.port, { clock: () => NOW });
    if (operation === 'train') await assert.rejects(adapter.train({ candidateId: 'aware' }));
    if (operation === 'loadCheckpoint') await assert.rejects(adapter.loadCheckpoint({ checkpoint: checkpointRef(checkpointArtifact()) }));
    if (operation === 'evaluate') {
      await assert.rejects(adapter.evaluate({ ...request(), modelRef: awareModel() }));
      assert.equal(fixture.calls.evaluate.length, 0);
    }
    if (operation === 'dispose') {
      await assert.rejects(adapter.dispose({ modelRef: awareModel() }));
      assert.equal(fixture.calls.dispose.length, 0);
    }
  }
});

test('Explicit verifyModel always asks an inspector, including for legacy refs', async () => {
  const legacy = fakePort();
  await assert.rejects(createTrainerAdapter(legacy.port).verifyModel({ modelRef: model() }));
  let inspections = 0;
  legacy.port.inspect = async ({ modelRef }) => { inspections++; return { modelRef: clone(modelRef) }; };
  assert.deepEqual(await createTrainerAdapter(legacy.port).verifyModel({ modelRef: model() }), model());
  assert.equal(inspections, 1);
});

test('Live mutation hidden behind stale metadata is caught before evaluation or explicit verification', async () => {
  const fixture = inspectedPort();
  const adapter = createTrainerAdapter(fixture.port, { clock: () => NOW });
  const trained = await adapter.train({ candidateId: 'aware' });
  fixture.setActual(awareModel({ weights: 'mutated-live-weights' }));
  await assert.rejects(adapter.verifyModel({ modelRef: trained.modelRef }));
  await assert.rejects(adapter.evaluate({ ...request(), modelRef: trained.modelRef }));
  assert.equal(fixture.calls.evaluate.length, 0);
});

test('An evaluator cannot mutate the inspected model during work and still publish an old receipt', async () => {
  const fixture = inspectedPort();
  fixture.onEvaluate(() => fixture.setActual(awareModel({ weights: 'mutated-during-evaluation' })));
  const emissions = [];
  const adapter = createTrainerAdapter(fixture.port, { clock: () => NOW,
    emit: (name, payload) => emissions.push({ name, payload }) });
  await assert.rejects(adapter.evaluate({ ...request(), modelRef: awareModel() }));
  assert.equal(fixture.calls.evaluate.length, 1);
  assert.ok(fixture.calls.inspect.length >= 2);
  assert.equal(emissions.some(event => event.name === ML_EVENTS.evaluateCompleted), false);
});

test('A newly returned model is inspected before publication, and its original fingerprint cannot be rewritten', async () => {
  for (const operation of ['train', 'loadCheckpoint']) {
    const fixture = inspectedPort();
    fixture.setActual(awareModel({ code: 'different-actual-program' }));
    const emissions = [];
    const adapter = createTrainerAdapter(fixture.port, { emit: (name, payload) => emissions.push({ name, payload }) });
    await assert.rejects(operation === 'train' ? adapter.train({}) :
      adapter.loadCheckpoint({ checkpoint: checkpointRef(checkpointArtifact()) }));
    assert.ok(fixture.calls.inspect.length > 0);
    assert.equal(emissions.some(event => event.name === (operation === 'train' ? ML_EVENTS.trainCompleted : ML_EVENTS.loadCompleted)), false);
  }
  const fixture = inspectedPort();
  const adapter = createTrainerAdapter(fixture.port);
  const original = await adapter.train({});
  const forged = clone(original.modelRef); forged.inferenceIdentity = inference({ weights: 'new-weights' });
  fixture.setActual(forged);
  await assert.rejects(adapter.verifyModel({ modelRef: forged }));
});

test('Successful identity-aware evaluation is inspected before and after work, and disposal is inspected first', async () => {
  const fixture = inspectedPort();
  const adapter = createTrainerAdapter(fixture.port, { clock: () => NOW });
  const trained = await adapter.train({});
  fixture.sequence.length = 0;
  const { receipt } = await adapter.evaluate({ ...request(), modelRef: trained.modelRef });
  assert.deepEqual(fixture.sequence, ['inspect', 'evaluate', 'inspect']);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(checkRelease(awareRelease(receipt)).allowed, true);
  fixture.sequence.length = 0;
  await adapter.dispose({ modelRef: trained.modelRef });
  assert.deepEqual(fixture.sequence, ['inspect', 'dispose']);
});

test('Training continuation receives an immutable copy of the verified source and configuration', async () => {
  const fixture = inspectedPort();
  fixture.port.train = async input => {
    assert.equal(Object.isFrozen(input), true);
    assert.equal(Object.isFrozen(input.modelRef.inferenceIdentity), true);
    assert.equal(Object.isFrozen(input.parameters), true);
    assert.throws(() => { input.modelRef.inferenceIdentity.sha256 = 'f'.repeat(64); }, TypeError);
    assert.throws(() => { input.parameters.learningRate = 99; }, TypeError);
    return { modelRef: awareModel(), checkpoint: checkpointArtifact() };
  };
  const adapter = createTrainerAdapter(fixture.port);
  const result = await adapter.train({ modelRef: awareModel(), parameters: { learningRate: .01 } });
  assert.equal(result.modelRef.inferenceIdentity.sha256, inference().sha256);
  assert.ok(fixture.calls.inspect.length >= 2);
});

test('Inference equivalence never permits a published live handle to change its full checkpoint metadata', async () => {
  const fixture = inspectedPort();
  const adapter = createTrainerAdapter(fixture.port);
  await adapter.train({});
  const changed = awareModel(); changed.originArtifact.sha256 = 'e'.repeat(64);
  fixture.setActual(changed);
  fixture.port.train = async () => ({ modelRef: changed, checkpoint: changed.originArtifact });
  await assert.rejects(adapter.train({}), error => error.code === 'runtime-handle-reused');
  assert.equal(fixture.calls.dispose.length, 0);
});
