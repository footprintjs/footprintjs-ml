import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createPythonTrainerAdapter, PythonTrainer } from '../dist/adapter/index.js';
import { checkpointRef, checkRelease } from 'footprintjs-ml';

const workerPath = fileURLToPath(new URL('./fixtures/protocol_worker.py', import.meta.url));
const request = { root: tmpdir(), pluginPath: workerPath, expectedProfile: 'fixture/arbitrary-v1' };
const options = mode => ({ python: process.env.TEST_PYTHON ?? 'python3', workerPath, requestTimeoutMs: 1000,
  env: { KIT_FIXTURE_MODE: mode } });

test('The generic client accepts arbitrary profile, dataset role and shape without a digit-model contract', async () => {
  const trainer = await createPythonTrainerAdapter(request, options('healthy'));
  try {
    assert.equal(trainer.backend.profile, request.expectedProfile);
    assert.deepEqual(Object.keys(trainer.datasets), ['calibration']);
    assert.deepEqual(trainer.datasets.calibration.shape, [3, 2]);
    assert.ok(Object.isFrozen(trainer.backend));
    assert.ok(Object.isFrozen(trainer.datasets.calibration));
    await assert.rejects(trainer.initialize(request), /only once/);
  } finally { await trainer.close(); await trainer.close(); }
});

test('The public adapter routes generic worker results through v0.2 receipts, inspection and disposal', async () => {
  const trainer = await createPythonTrainerAdapter(request, options('healthy'));
  try {
    const trained = await trainer.adapter.train({ iterations: 2 });
    const ref = await trainer.adapter.loadCheckpoint({ checkpoint: checkpointRef(trained.checkpoint) });
    const verified = await trainer.adapter.verifyModel({ modelRef: ref });
    const evaluation = { modelRef: verified, datasetRef: trainer.datasets.calibration,
      preprocessingVersion: trainer.backend.preprocessingVersion, evaluationMethodVersion: trainer.backend.evaluationMethodVersion, parameters: { folds: 2 } };
    const { receipt } = await trainer.adapter.evaluate(evaluation);
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.metrics.mse, 0.125);
    assert.equal(checkRelease({ ...evaluation, receipt, policy: { metric: 'mse', operator: 'lte', threshold: 0.2 } }).allowed, true);
    await trainer.adapter.dispose({ modelRef: verified });
    await assert.rejects(trainer.adapter.verifyModel({ modelRef: verified }), /already been released/);
  } finally { await trainer.close(); }
});

test('An unrequested worker profile fails initialization rather than selecting another identity protocol', async () => {
  await assert.rejects(createPythonTrainerAdapter(request, options('wrong-profile')), /explicitly requested/);
});

for (const mode of ['missing-identity', 'foreign-session', 'malformed', 'unknown-id']) {
  test(`A ${mode} worker response invalidates the owned session`, async () => {
    const trainer = await createPythonTrainerAdapter(request, options(mode));
    try {
      await assert.rejects(trainer.adapter.train({}), /invalid|non-JSON|unknown request/);
      await assert.rejects(trainer.adapter.train({}), /invalid|non-JSON|unknown request/);
    } finally { await trainer.close(); }
  });
}

test('A timed out operation terminates the worker and cannot be retried in that session', async () => {
  const trainer = await createPythonTrainerAdapter(request, { ...options('timeout'), requestTimeoutMs: 250 });
  try {
    await assert.rejects(trainer.adapter.train({}), error => error.code === 'timeout');
    await assert.rejects(trainer.adapter.train({}), error => error.code === 'timeout');
  } finally { await trainer.close(); }
});

test('Unavailable Python reports a spawn error and repeated close remains safe', async () => {
  const trainer = new PythonTrainer({ ...options('healthy'), python: '/unavailable-python-for-test' });
  await assert.rejects(trainer.initialize(request), error => error.code === 'spawn');
  await trainer.close(); await trainer.close();
});
