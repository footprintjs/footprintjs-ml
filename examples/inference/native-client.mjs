/** App-local, bounded transport to the same persistent Python numerical worker. */
import {spawn} from 'node:child_process';
import {openSync, writeSync, closeSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_LINE = 262144;
const MAX_STDERR = 1048576;
export const NUMERICAL_THREAD_ENV = Object.freeze({
  OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1',
});

export class NumericalBackendError extends Error {
  constructor(error) {
    super(`Numerical backend ${error?.type || 'Error'}: ${error?.message || 'unknown failure'}`);
    this.name = 'NumericalBackendError';
    this.backendType = error?.type;
  }
}

export class PersistentNumericalBackend {
  constructor({root, fixtures, python = process.env.PYTHON || 'python3', timeoutMs = 60000}) {
    for (const [name, value] of Object.entries({root, fixtures, python})) {
      if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Invalid backend ${name}`);
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid backend timeout');
    this.timeoutMs = timeoutMs;
    this.ordinal = 0;
    this.pending = null;
    this.stdout = Buffer.alloc(0);
    this.stderrBytes = 0;
    this.stderrTruncated = false;
    this.closed = false;
    this.failure = null;
    this.stderrPath = resolve(dirname(root), 'backend.stderr.log');
    this.stderrFd = openSync(this.stderrPath, 'wx');
    try {
      this.process = spawn(python, [fileURLToPath(new URL('./worker.py', import.meta.url)),
        '--root', resolve(root), '--fixtures', resolve(fixtures)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {...process.env, MLFLOW_DISABLE_TELEMETRY: 'true', DO_NOT_TRACK: 'true', ...NUMERICAL_THREAD_ENV},
      });
    } catch (error) {
      closeSync(this.stderrFd);
      throw error;
    }
    this.exit = new Promise(resolveExit => {
      this.process.once('close', (code, signal) => {
        this.exitStatus = {code, signal};
        if (this.pending) this.fail(new Error(`Numerical worker exited before responding (${code ?? signal})`));
        resolveExit(this.exitStatus);
      });
    });
    this.process.once('error', error => this.fail(error));
    this.process.stdin.on('error', error => this.fail(error));
    this.process.stdout.on('data', chunk => this.acceptStdout(chunk));
    this.process.stdout.on('error', error => this.fail(error));
    this.process.stderr.on('data', chunk => {
      const remaining = Math.max(0, MAX_STDERR - this.stderrBytes);
      const retained = chunk.subarray(0, remaining);
      if (retained.length) writeSync(this.stderrFd, retained);
      this.stderrBytes += retained.length;
      if (chunk.length > remaining) this.stderrTruncated = true;
      // Keep the numerical runtime's actual warnings visible and retained.
      process.stderr.write(chunk);
    });
    this.process.stderr.on('error', error => this.fail(error));
  }

  fail(error) {
    this.failure ||= error;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (!this.exitStatus && !this.process.killed) this.process.kill('SIGKILL');
  }

  acceptStdout(chunk) {
    if (this.failure) return;
    this.stdout = Buffer.concat([this.stdout, chunk]);
    while (this.stdout.length) {
      const newline = this.stdout.indexOf(10);
      if ((newline < 0 && this.stdout.length > MAX_LINE) || newline + 1 > MAX_LINE) {
        this.fail(new Error('Numerical response exceeded its line limit')); return;
      }
      if (newline < 0) return;
      const line = this.stdout.subarray(0, newline);
      this.stdout = this.stdout.subarray(newline + 1);
      let response;
      try { response = JSON.parse(line.toString('utf8')); }
      catch { this.fail(new Error('Numerical response is not valid JSON')); return; }
      const pending = this.pending;
      if (!pending || !response || typeof response !== 'object' || response.id !== pending.id) {
        this.fail(new Error('Numerical response does not match the pending request')); return;
      }
      if (response.ok !== true && response.ok !== false) {
        this.fail(new Error('Numerical response has no boolean status')); return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      if (response.ok === true && Object.hasOwn(response, 'result')) pending.resolve(response.result);
      else if (response.ok === false) pending.reject(new NumericalBackendError(response.error));
      else { this.fail(new Error('Numerical response has no result')); pending.reject(this.failure); }
    }
  }

  call(command, input = {}) {
    if (this.closed) return Promise.reject(new Error('Numerical backend is closed'));
    if (this.failure) return Promise.reject(this.failure);
    if (this.exitStatus) return Promise.reject(new Error('Numerical worker has exited'));
    if (this.pending) return Promise.reject(new Error('Concurrent numerical requests are not supported'));
    const id = ++this.ordinal;
    const blob = Buffer.from(JSON.stringify({id, command, input}) + '\n');
    if (blob.length > MAX_LINE) return Promise.reject(new Error('Numerical request exceeded its line limit'));
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Numerical operation timed out')), this.timeoutMs);
      this.pending = {id, resolve: resolveCall, reject, timer};
      this.process.stdin.write(blob, error => { if (error) this.fail(error); });
    });
  }

  async close() {
    if (this.closed) return this.exitStatus;
    let closeError;
    try {
      if (!this.failure && !this.exitStatus) {
        await this.call('close');
        this.process.stdin.end();
      }
    } catch (error) { closeError = error; }
    finally {
      let timeout;
      await Promise.race([this.exit, new Promise(resolveWait => {
        timeout = setTimeout(() => {
          if (!this.exitStatus) this.process.kill('SIGKILL');
          resolveWait();
        }, 5000);
      })]);
      clearTimeout(timeout);
      // SIGKILL is bounded separately, including an unresponsive child.
      if (!this.exitStatus) {
        let finalTimeout;
        await Promise.race([this.exit, new Promise(resolveWait => { finalTimeout = setTimeout(resolveWait, 2000); })]);
        clearTimeout(finalTimeout);
      }
      this.closed = true;
      this.process.stdin.destroy();
      this.process.stdout.destroy();
      this.process.stderr.destroy();
      closeSync(this.stderrFd);
    }
    if (closeError) throw closeError;
    return this.exitStatus;
  }
}
