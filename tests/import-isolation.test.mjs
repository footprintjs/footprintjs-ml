import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import * as moduleApi from 'node:module';

test('Root import never loads optional entry points; a deferred adapter import loads only when reached', async t => {
  if (typeof moduleApi.registerHooks !== 'function') { t.skip('Module graph observation requires Node registerHooks; current verification uses Node 24.'); return; }
  const loaded = [];
  const hook = moduleApi.registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });
  try {
    const core = await import('footprintjs-ml');
    assert.equal(typeof core.checkRelease, 'function');
    assert.ok(loaded.some(url => url.endsWith('/dist/index.js')));
    const optional = url => /\/dist\/(?:adapter|conformance|release)\/|\/lens\/session\.mjs$/.test(url);
    assert.ok(!loaded.some(optional), 'Root traversed an optional module');
    assert.ok(!loaded.some(url => url.startsWith('node:')), 'Root traversed a Node-only dependency');
    const maybeLoad = enabled => enabled ? import('footprintjs-ml/adapter') : undefined;
    assert.equal(maybeLoad(false), undefined);
    assert.ok(!loaded.some(optional), 'A disabled feature loaded adapter code');
    const adapter = await maybeLoad(true);
    assert.equal(typeof adapter.createPythonTrainerAdapter, 'function');
    assert.equal(typeof adapter.servePythonCapture, 'function');
    assert.ok(!loaded.some(url => /\/node_modules\/foottrace\//.test(url)), 'An optional adapter import loaded the recording runtime before explicit use');
    assert.ok(loaded.some(url => url.endsWith('/dist/adapter/client.js')));
    assert.ok(!loaded.some(url => /\/dist\/conformance\/|\/lens\/session\.mjs$/.test(url)));
  } finally { hook.deregister(); }
});

test('Importing every public entry point starts no worker; explicit trainer construction is the first spawn', async () => {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const originals = Object.fromEntries(names.map(name => [name, childProcess[name]]));
  const attempts = [];
  try {
    for (const name of names) childProcess[name] = (...args) => {
      attempts.push({ operation: name, executable: args[0] }); throw new Error('Blocked test worker creation');
    };
    moduleApi.syncBuiltinESMExports();
    const core = await import('footprintjs-ml');
    const adapter = await import('footprintjs-ml/adapter');
    const lens = await import('footprintjs-ml/lens');
    const conformance = await import('footprintjs-ml/conformance');
    const release = await import('footprintjs-ml/release');
    assert.equal(typeof core.checkRelease, 'function');
    assert.equal(typeof lens.openAdapterWorkflowRun, 'function');
    assert.equal(typeof adapter.servePythonCapture, 'function');
    assert.equal(typeof conformance.runAdapterConformance, 'function');
    assert.equal(typeof release.createFileArtifactStore, 'function');
    assert.equal(typeof release.createLocalModelPublisher, 'function');
    assert.equal(attempts.length, 0);
    assert.throws(() => new adapter.PythonTrainer({ python: '/explicit-trainer-creation' }), /Blocked test worker creation/);
    assert.deepEqual(attempts, [{ operation: 'spawn', executable: '/explicit-trainer-creation' }]);
  } finally {
    for (const name of names) childProcess[name] = originals[name];
    moduleApi.syncBuiltinESMExports();
  }
});
