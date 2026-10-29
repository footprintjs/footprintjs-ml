import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrainerAdapter, checkpointRef, checkRelease, ML_EVENTS } from '../dist/index.js';
import { NOW, clone, checkpointArtifact, model, request, evaluated, releaseRequest, fakePort } from './fixtures.mjs';

test('A backend evaluation produces an immutable receipt from actual returned evidence', async () => {
  const { port, calls } = fakePort();
  const emitted = [];
  const adapter = createTrainerAdapter(port, { clock: () => NOW, emit: (...args) => emitted.push(clone(args)) });
  const input = request();
  const result = await adapter.evaluate(input);
  assert.equal(calls.evaluate.length, 1);
  assert.deepEqual(calls.evaluate[0], input);
  assert.equal(result.receipt.createdAt, NOW);
  assert.equal(result.receipt.metrics.accuracy, 0.97);
  assert.equal(result.receipt.evaluationId, 'evaluation-A');
  assert.deepEqual(result.receipt.modelRef, result.backendResult.modelRef);
  assert.equal(checkRelease(releaseRequest(result.receipt)).allowed, true);
  assert.ok(emitted.length > 0, 'Successful adapter work should emit its explicit backend evidence');
  try { result.backendResult.metrics.accuracy = 0; } catch (error) { assert.ok(error instanceof TypeError); }
  assert.equal(result.receipt.metrics.accuracy, 0.97);
});

test('Live evaluation refuses stale worker references before using the backend', async () => {
  const { port, calls } = fakePort();
  const adapter = createTrainerAdapter(port, { clock: () => NOW });
  const stale = request(); stale.modelRef.sessionId = 'a-previous-worker';
  await assert.rejects(adapter.evaluate(stale));
  assert.equal(calls.evaluate.length, 0);
  const staleDataset = request(); staleDataset.datasetRef.sessionId = 'a-previous-worker';
  await assert.rejects(adapter.evaluate(staleDataset));
  assert.equal(calls.evaluate.length, 0);
});

test('Async backend work cannot rewrite the evaluation intent through shared mutable input', async () => {
  let observed, finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { port } = fakePort({ evaluate(input) {
    observed = input; entered();
    return new Promise(resolve => { finish = () => resolve({ ...clone(input),
      evaluationId: 'async-evaluation', metrics: { accuracy: 0.97 } }); });
  } });
  const input = request();
  const pending = createTrainerAdapter(port, { clock: () => NOW }).evaluate(input);
  await started;
  input.modelRef.originArtifact.sha256 = 'e'.repeat(64);
  input.preprocessingVersion = 'caller-changed-during-await';
  input.parameters.options.seed = 99;
  assert.equal(observed.modelRef.originArtifact.sha256, checkpointArtifact().sha256);
  assert.equal(observed.preprocessingVersion, request().preprocessingVersion);
  assert.throws(() => { observed.parameters.options.seed = 55; }, TypeError);
  finish();
  const result = await pending;
  assert.equal(result.receipt.parameters.options.seed, 7);
  assert.equal(checkRelease(releaseRequest(result.receipt)).allowed, true);
});

test('An evaluation for another runtime model or dataset cannot masquerade as the requested work', async () => {
  for (const mutate of [
    output => { output.modelRef.handle++; },
    output => { output.modelRef.originArtifact.sha256 = 'c'.repeat(64); },
    output => { output.datasetRef.handle++; },
    output => { output.datasetRef.artifact.sha256 = 'd'.repeat(64); },
    output => { output.datasetRef.role = 'train'; },
  ]) {
    const { port } = fakePort({ async evaluate(input) {
      const output = { ...clone(input), evaluationId: 'wrong-work', metrics: { accuracy: 0.97 } };
      mutate(output); return output;
    } });
    await assert.rejects(createTrainerAdapter(port, { clock: () => NOW }).evaluate(request()));
  }
});

test('The adapter compares actual preprocessing, method and configuration rather than echoing intent', async () => {
  for (const mutate of [
    output => { output.preprocessingVersion = 'other-scaler/v2'; },
    output => { output.evaluationMethodVersion = 'resubstitution/v1'; },
    output => { output.parameters.options.seed = 99; },
    output => { delete output.parameters; },
    output => { delete output.preprocessingVersion; },
    output => { delete output.evaluationMethodVersion; },
    output => { output.metrics.accuracy = NaN; },
  ]) {
    const { port } = fakePort({ async evaluate(input) {
      const output = { ...clone(input), evaluationId: 'observed-work', metrics: { accuracy: 0.97 } };
      mutate(output); return output;
    } });
    await assert.rejects(createTrainerAdapter(port, { clock: () => NOW }).evaluate(request()));
  }
});

test('Training output must identify its real session and the checkpoint it reports', async () => {
  const good = fakePort();
  const adapter = createTrainerAdapter(good.port);
  const result = await adapter.train({ datasetRef: request().datasetRef, parameters: { seed: 7 } });
  assert.equal(result.modelRef.sessionId, good.port.sessionId);
  for (const mutate of [
    output => { output.modelRef.sessionId = 'another-worker'; },
    output => { output.modelRef.originArtifact.sha256 = 'e'.repeat(64); },
    output => { output.checkpoint.bytes++; },
  ]) {
    const output = { modelRef: model(), checkpoint: checkpointArtifact() }; mutate(output);
    const { port } = fakePort({ async train() { return output; } });
    await assert.rejects(createTrainerAdapter(port).train({ datasetRef: request().datasetRef }));
  }
});

test('Checkpoint loading admits a new runtime identity for matching bytes and rejects observed mismatches', async () => {
  const loaded = model(); loaded.handle = 100;
  const { port } = fakePort({ async load(input) { return { modelRef: clone(loaded), actualArtifact: clone(input.checkpoint.artifact) }; } });
  const adapter = createTrainerAdapter(port);
  const returned = await adapter.loadCheckpoint({ checkpoint: checkpointRef(checkpointArtifact()) });
  assert.equal(returned.handle, 100);
  assert.equal(returned.originArtifact.sha256, checkpointArtifact().sha256);
  for (const mutate of [
    output => { output.actualArtifact.sha256 = 'f'.repeat(64); },
    output => { output.modelRef.originArtifact.sha256 = 'c'.repeat(64); },
    output => { output.modelRef.sessionId = 'another-worker'; },
  ]) {
    const output = { modelRef: model(), actualArtifact: checkpointArtifact() }; mutate(output);
    const { port: wrong } = fakePort({ async load() { return output; } });
    await assert.rejects(createTrainerAdapter(wrong).loadCheckpoint({ checkpoint: checkpointRef(checkpointArtifact()) }));
  }
});

test('A rejected newly loaded handle receives explicit compensating cleanup, without successful load evidence', async () => {
  const actual = checkpointArtifact(); actual.sha256 = 'f'.repeat(64);
  const unwanted = model(); unwanted.handle = 44; unwanted.originArtifact = actual;
  const emissions = [];
  const { port, calls } = fakePort({ async load() { return { modelRef: unwanted, actualArtifact: actual }; } });
  const adapter = createTrainerAdapter(port, { emit: (name, payload) => emissions.push({ name, payload }) });
  await assert.rejects(adapter.loadCheckpoint({ checkpoint: checkpointRef(checkpointArtifact()) }),
    error => error.code === 'loaded-checkpoint-mismatch');
  assert.equal(calls.dispose.length, 1);
  assert.equal(calls.dispose[0].modelRef.handle, 44);
  const cleaned = emissions.find(event => event.name === ML_EVENTS.disposeCompleted);
  assert.equal(cleaned.payload.purpose, 'unpublished-result-cleanup');
  assert.equal(cleaned.payload.released, true);
  assert.equal(cleaned.payload.modelRef.handle, 44);
  assert.equal(emissions.some(event => event.name === ML_EVENTS.loadCompleted), false);
});

test('Cleanup failure cannot replace a rejected-load error or assert successful disposal', async () => {
  const actual = checkpointArtifact(); actual.sha256 = 'f'.repeat(64);
  const unwanted = model(); unwanted.handle = 44; unwanted.originArtifact = actual;
  for (const dispose of [
    async () => { throw new Error('Secondary cleanup failure'); },
    async ({ modelRef }) => ({ modelRef, released: false }),
  ]) {
    const emissions = [];
    const { port } = fakePort({ async load() { return { modelRef: unwanted, actualArtifact: actual }; }, dispose });
    const adapter = createTrainerAdapter(port, { emit: (name, payload) => emissions.push({ name, payload }) });
    await assert.rejects(adapter.loadCheckpoint({ checkpoint: checkpointRef(checkpointArtifact()) }),
      error => error.code === 'loaded-checkpoint-mismatch');
    assert.equal(emissions.some(event => event.name === ML_EVENTS.disposeCompleted), false);
    const failedCleanup = emissions.find(event => event.name === ML_EVENTS.failed &&
      event.payload.operation === 'dispose' && event.payload.purpose === 'unpublished-result-cleanup');
    assert.ok(failedCleanup, 'Unconfirmed cleanup must name the potentially retained native handle');
    assert.equal(failedCleanup.payload.modelRef.handle, 44);
    assert.equal(typeof failedCleanup.payload.error, 'string');
  }
});

test('Reusing a published runtime handle for different checkpoint bytes is refused without deleting its owner', async () => {
  const changedArtifact = checkpointArtifact(); changedArtifact.sha256 = 'f'.repeat(64);
  const changedModel = model(); changedModel.originArtifact = changedArtifact;
  const { port, calls } = fakePort({ async load() { return { modelRef: changedModel, actualArtifact: changedArtifact }; } });
  const adapter = createTrainerAdapter(port, { clock: () => NOW });
  await adapter.train({ parameters: { seed: 7 } });
  await assert.rejects(adapter.loadCheckpoint({ checkpoint: checkpointRef(changedArtifact) }),
    error => error.code === 'runtime-handle-reused');
  assert.equal(calls.dispose.length, 0);
  assert.equal((await adapter.evaluate(request())).receipt.modelRef.originArtifact.sha256, checkpointArtifact().sha256);
});

test('An observer failure cannot prevent cleanup of an unpublished loaded handle', async () => {
  const { port, calls } = fakePort();
  const adapter = createTrainerAdapter(port, { emit(name) {
    if (name === ML_EVENTS.loadCompleted) throw new Error('Primary completion observer failure');
    if (name === ML_EVENTS.disposeStarted) throw new Error('Secondary cleanup observer failure');
  } });
  await assert.rejects(adapter.loadCheckpoint({ checkpoint: checkpointRef(checkpointArtifact()) }),
    /Primary completion observer failure/);
  assert.equal(calls.dispose.length, 1);
  assert.equal(calls.dispose[0].modelRef.handle, 7);
});

test('Malformed accessor-backed output is rejected without executing the getter', async () => {
  let getterCalls = 0;
  const malformed = { actualArtifact: checkpointArtifact() };
  Object.defineProperty(malformed, 'modelRef', { enumerable: true, get() { getterCalls++; return model(); } });
  const { port, calls } = fakePort({ async load() { return malformed; } });
  await assert.rejects(createTrainerAdapter(port).loadCheckpoint({ checkpoint: checkpointRef(checkpointArtifact()) }));
  assert.equal(getterCalls, 0);
  assert.equal(calls.dispose.length, 0);
});

test('Failed evaluation does not pretend to roll back backend lifetime; explicit disposal owns cleanup', async () => {
  const liveHandles = new Set([7]);
  let disposals = 0;
  const { port } = fakePort({
    async evaluate() { throw new Error('Injected worker evaluation error'); },
    async dispose({ modelRef }) { disposals++; liveHandles.delete(modelRef.handle); return { modelRef, released: true }; },
  });
  const adapter = createTrainerAdapter(port);
  await assert.rejects(adapter.evaluate(request()), /Injected worker evaluation error/);
  assert.equal(liveHandles.has(7), true);
  assert.equal(disposals, 0);
  const result = await adapter.dispose({ modelRef: model() });
  assert.equal(result.released, true);
  assert.equal(liveHandles.has(7), false);
  assert.equal(disposals, 1);
});

test('Disposal cannot report successful cleanup for another handle or a failed release', async () => {
  const wrongRef = model(); wrongRef.handle = 99;
  const { port: wrong } = fakePort({ async dispose() { return { modelRef: wrongRef, released: true }; } });
  await assert.rejects(createTrainerAdapter(wrong).dispose({ modelRef: model() }));
  const { port: refusal } = fakePort({ async dispose({ modelRef }) { return { modelRef, released: false }; } });
  let rejected = false;
  let result;
  try { result = await createTrainerAdapter(refusal).dispose({ modelRef: model() }); } catch { rejected = true; }
  assert.ok(rejected || result?.released === false);
  const { port: failing } = fakePort({ async dispose() { throw new Error('Cleanup transport failed'); } });
  await assert.rejects(createTrainerAdapter(failing).dispose({ modelRef: model() }), /Cleanup transport failed/);
});

test('A confirmed disposed reference cannot be evaluated or disposed twice through the adapter', async () => {
  const { port, calls } = fakePort();
  const adapter = createTrainerAdapter(port);
  await adapter.dispose({ modelRef: model() });
  await assert.rejects(adapter.evaluate(request()), error => error.code === 'released-model');
  await assert.rejects(adapter.dispose({ modelRef: model() }), error => error.code === 'released-model');
  assert.equal(calls.evaluate.length, 0);
  assert.equal(calls.dispose.length, 1);
});
