import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ConformanceError, runAdapterConformance } from '../dist/conformance/index.js';

const python = process.env.FOOTPRINT_ML_TEST_PYTHON ?? 'python3';
const available = spawnSync(python, ['--version'], { encoding: 'utf8' }).status === 0;
const fixture = fileURLToPath(new URL('./fixtures/conformance_runner.py', import.meta.url));
const options = (mode = 'success', extra = {}) => ({
  pluginPath: 'fixture plugin.py', out: 'fixture out', python, runnerPath: fixture,
  config: { mode }, plan: { train: { steps: 1 } }, timeoutMs: 5000, ...extra,
});
const pythonTest = (name, operation) => test(name, { skip: !available && `Python executable ${python} is unavailable` }, operation);

test('Conformance and CLI imports create no process even when spawning is blocked', () => {
  const entry = new URL('../dist/conformance/index.js', import.meta.url).href;
  const cli = new URL('../dist/conformance/cli.js', import.meta.url).href;
  const code = `import {createRequire,syncBuiltinESMExports} from 'node:module';
    const require=createRequire(import.meta.url);
    require('node:child_process').spawn=()=>{throw new Error('unexpected child at import')};
    syncBuiltinESMExports();
    await import(${JSON.stringify(entry)}); await import(${JSON.stringify(cli)});
    console.log('imports-inert');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'imports-inert');
});

pythonTest('A valid report is detached and frozen; arguments are literal and snapshotted before awaiting', async () => {
  const config = { mode: 'success', literal: '$(touch should-never-run); "quotes"' };
  const plan = { train: { steps: 1 } };
  const promise = runAdapterConformance(options('success', { config, plan, pluginPath: 'literal; plugin.py' }));
  config.mode = 'failure'; plan.train.steps = 900;
  const report = await promise;
  assert.equal(report.passed, true);
  assert.equal(report.backend.receivedConfig.mode, 'success');
  assert.equal(report.backend.receivedConfig.literal, '$(touch should-never-run); "quotes"');
  assert.equal(report.backend.receivedPlugin, resolve('literal; plugin.py'));
  assert.equal(report.plan.train.steps, 1);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.cases[0].details));
  assert.throws(() => { report.backend.receivedConfig.mode = 'changed'; }, TypeError);
});

pythonTest('Exit one preserves a valid failed conformance report', async () => {
  const report = await runAdapterConformance(options('failure'));
  assert.equal(report.passed, false);
  assert.equal(report.requiredPassed, false);
  assert.equal(report.counts.failed, 1);
});

pythonTest('Explicit skipped coverage remains partial instead of becoming a passing report', async () => {
  const report = await runAdapterConformance(options('partial'));
  assert.equal(report.status, 'partial');
  assert.equal(report.passed, false);
  assert.equal(report.requiredPassed, true);
  assert.equal(report.cases[1].passed, null);
});

pythonTest('Malformed JSON, contradictory counts and contradictory status are protocol failures', async () => {
  for (const mode of ['malformed', 'wrong-count', 'contradictory-status']) {
    await assert.rejects(runAdapterConformance(options(mode)), error =>
      error instanceof ConformanceError && error.code === 'invalid-report');
  }
});

pythonTest('Unexpected exits cannot turn an earlier passing report into successful conformance', async () => {
  for (const mode of ['unexpected-exit', 'passing-error']) {
    await assert.rejects(runAdapterConformance(options(mode)), error =>
      error instanceof ConformanceError && error.code === 'unexpected-exit');
  }
});

pythonTest('Deadline and stdout bounds terminate the owned child rather than wait for it', async () => {
  const started = Date.now();
  await assert.rejects(runAdapterConformance(options('sleep', { timeoutMs: 40 })), error => error.code === 'timeout');
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(runAdapterConformance(options('overflow', { maxOutputBytes: 128 })), error => error.code === 'output-limit');
});

pythonTest('Error diagnostics retain a bounded stderr tail', async () => {
  await assert.rejects(runAdapterConformance(options('malformed-stderr', { maxOutputBytes: 128 })), error => {
    assert.equal(error.code, 'invalid-report');
    assert.ok(Buffer.byteLength(error.stderr) <= 128);
    assert.ok(error.stderr.endsWith('final-marker'));
    return true;
  });
});

test('Invalid JSON options and an unavailable interpreter fail explicitly', async () => {
  await assert.rejects(runAdapterConformance(options('success', { config: { nonfinite: NaN } })), error => error.code === 'invalid-options');
  await assert.rejects(runAdapterConformance(options('success', { python: join(tmpdir(), 'footprint-missing-python-executable') })),
    error => error.code === 'spawn-failed');
});

pythonTest('CLI reads JSON files and exits distinctly for success, conformance failure and input failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'footprint-conformance-cli-'));
  try {
    const shim = join(directory, 'python shim.py');
    await writeFile(shim, '#!/usr/bin/env python3\nimport runpy,sys\nsys.argv.pop(1)\nrunpy.run_path(' +
      JSON.stringify(fixture) + ',run_name="__main__")\n', { mode: 0o755 });
    const configFile = join(directory, 'config.json'), planFile = join(directory, 'plan.json');
    await writeFile(planFile, JSON.stringify({ train: { steps: 1 } }));
    const cli = fileURLToPath(new URL('../dist/conformance/cli.js', import.meta.url));
    const argv = ['--plugin', 'literal plugin.py', '--config-file', configFile, '--plan-file', planFile,
      '--out', join(directory, 'literal out; name'), '--python', shim];
    for (const [mode, status] of [['success', 0], ['failure', 1], ['partial', 0]]) {
      await writeFile(configFile, JSON.stringify({ mode }));
      const response = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8' });
      assert.equal(response.status, status, response.stderr);
      assert.equal(JSON.parse(response.stdout).backend.receivedConfig.mode, mode);
    }
    const invalid = spawnSync(process.execPath, [cli, '--unknown', 'value'], { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'invalid-options');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
