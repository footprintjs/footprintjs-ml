import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactRef, createTrainerAdapter, inferenceIdentity } from '../index.js';
import type { BackendEvaluation, DatasetRef, DisposeResult, InferenceIdentity,
  LoadResult, TrainerAdapter, TrainerPort, TrainResult } from '../index.js';
import { AdapterKitError } from './contracts.js';
import type { PythonBackendMetadata, PythonInitialization, PythonInitializeRequest, PythonModelRef, PythonTrainerOptions } from './contracts.js';
type Pending = { command: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function limit(value: number | undefined, fallback: number, label: string) {
  const result = value ?? fallback;
  if (!positive(result)) throw new TypeError(`${label} must be a positive safe integer`);
  return result;
}
function freeze<T>(value: T): T {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Worker metadata contains a nonfinite number');
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** A private JSON-lines transport. No tensor buffers or model arrays cross this boundary. */
class WorkerTransport {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private stderr = '';
  private failure?: AdapterKitError;
  private ended = false;
  private closing = false;
  private closingPromise?: Promise<void>;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private timeoutMs: number;
  private shutdownMs: number;
  private maxBytes: number;

  constructor(options: PythonTrainerOptions) {
    this.timeoutMs = limit(options.requestTimeoutMs, 120_000, 'requestTimeoutMs');
    this.shutdownMs = limit(options.shutdownTimeoutMs, 1_000, 'shutdownTimeoutMs');
    this.maxBytes = limit(options.maxResponseBytes, 1_048_576, 'maxResponseBytes');
    const python = options.python ?? process.env.PYTHON ?? 'python3';
    if (!text(python)) throw new TypeError('python must name an executable');
    const worker = options.workerPath instanceof URL ? fileURLToPath(options.workerPath) :
      options.workerPath ?? fileURLToPath(new URL('../../python/worker.py', import.meta.url));
    if (!text(worker)) throw new TypeError('workerPath must name a local file');
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.child = spawn(python, ['-u', resolve(worker)], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env } });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    this.child.stdout.on('end', () => {
      this.receive(this.decoder.end());
      if (this.buffer.trim() && !this.failure) this.line(this.buffer);
      this.buffer = '';
    });
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4096); });
    this.child.stdin.on('error', error => this.abort(new AdapterKitError('transport', `Worker input failed: ${error.message}`)));
    this.child.on('error', error => this.abort(new AdapterKitError('spawn', `Could not start Python worker: ${error.message}`)));
    this.child.once('close', (code, signal) => {
      this.ended = true;
      const message = `Python worker closed (code ${code}, signal ${signal ?? 'none'})` +
        (this.stderr.trim() ? `: ${this.stderr.trim()}` : '');
      if (!this.closing || this.pending.size) this.abort(new AdapterKitError('exit', message));
      this.resolveExit();
    });
  }
  private abort(error: AdapterKitError) {
    this.failure ??= error;
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(this.failure); }
    this.pending.clear();
    if (!this.ended) this.child.kill('SIGKILL');
  }
  invalidate(error: AdapterKitError) { this.abort(error); }
  private receive(fragment: string) {
    if (this.failure) return;
    this.buffer += fragment;
    let boundary: number;
    while ((boundary = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, boundary); this.buffer = this.buffer.slice(boundary + 1);
      if (Buffer.byteLength(line) > this.maxBytes) { this.abort(new AdapterKitError('protocol', 'Worker response exceeded maxResponseBytes')); return; }
      if (line.trim()) this.line(line);
      if (this.failure) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) this.abort(new AdapterKitError('protocol', 'Worker response exceeded maxResponseBytes'));
  }
  private line(line: string) {
    let response: unknown;
    try { response = JSON.parse(line); }
    catch { this.abort(new AdapterKitError('protocol', 'Worker wrote a non-JSON protocol response')); return; }
    if (!record(response) || !positive(response.id) || typeof response.ok !== 'boolean') {
      this.abort(new AdapterKitError('protocol', 'Worker response lacks a valid id/ok envelope')); return;
    }
    const waiting = this.pending.get(response.id as number);
    if (!waiting) { this.abort(new AdapterKitError('protocol', 'Worker responded with an unknown request id')); return; }
    this.pending.delete(response.id as number); clearTimeout(waiting.timer);
    if (response.ok) {
      if (!Object.hasOwn(response, 'result')) {
        const error = new AdapterKitError('protocol', 'Successful worker response has no result', { command: waiting.command });
        waiting.reject(error); this.abort(error);
      } else waiting.resolve(response.result);
    } else {
      const details = record(response.error) ? response.error : {};
      const type = text(details.type) ? String(details.type) : 'WorkerError';
      const message = text(details.message) ? String(details.message) : 'Worker rejected the operation';
      waiting.reject(new AdapterKitError('worker', `${type}: ${message.slice(0, 2000)}`,
        { command: waiting.command, workerType: type }));
    }
  }
  request<T>(command: string, args: object, timeoutMs = this.timeoutMs, allowClosing = false): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended || (this.closing && !allowClosing)) return Promise.reject(new AdapterKitError('closed', 'Python worker is closed'));
    const id = ++this.nextId;
    let encoded: string;
    try { encoded = JSON.stringify({ id, command, args }) + '\n'; }
    catch { return Promise.reject(new TypeError('Worker requests must contain JSON-serializable values')); }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.abort(new AdapterKitError('timeout',
        `Python worker ${command} exceeded its ${timeoutMs}ms deadline; worker terminated`, { command })), timeoutMs);
      this.pending.set(id, { command, resolve: value => resolve(value as T), reject, timer });
      this.child.stdin.write(encoded, error => { if (error) this.abort(new AdapterKitError('transport', `Could not write worker request: ${error.message}`, { command })); });
    });
  }
  close(): Promise<void> {
    this.closingPromise ??= (async () => {
      this.closing = true;
      if (this.ended) return;
      const forced = setTimeout(() => this.abort(new AdapterKitError('closed', 'Worker shutdown deadline reached; worker terminated')), this.shutdownMs);
      try {
        if (!this.failure) await this.request('shutdown', {}, this.shutdownMs, true).catch(() => {});
        this.child.stdin.end();
        await this.exitPromise;
      } finally { clearTimeout(forced); }
    })();
    return this.closingPromise;
  }
}

function initialization(value: unknown, profile: string): PythonInitialization {
  if (!record(value) || !record(value.backend) || !record(value.datasets))
    throw new TypeError('Worker initialization must return backend metadata and datasets');
  const backend = value.backend;
  for (const key of ['sessionId', 'preprocessingVersion', 'evaluationMethodVersion', 'pluginSourceSha256'])
    if (!text(backend[key])) throw new TypeError(`Worker backend.${key} must be a nonempty string`);
  if (!/^[a-f\d]{64}$/i.test(String(backend.pluginSourceSha256))) throw new TypeError('Invalid plugin source digest');
  if (backend.profile !== profile) throw new TypeError('Worker profile differs from the explicitly requested plugin profile');
  if (!Object.keys(value.datasets).length) throw new TypeError('Plugin must provide at least one dataset');
  for (const [role, ref] of Object.entries(value.datasets)) {
    if (!text(role) || !record(ref) || ref.kind !== 'dataset' || ref.role !== role || ref.sessionId !== backend.sessionId ||
      !positive(ref.handle) || !positive(ref.rows) || !Array.isArray(ref.shape) || !ref.shape.length ||
      ref.shape[0] !== ref.rows || !ref.shape.every(positive)) throw new TypeError(`Invalid plugin dataset reference for ${role}`);
    artifactRef(ref.artifact);
  }
  return freeze(structuredClone(value)) as unknown as PythonInitialization;
}

/** One owned Python process; numerical model/data types belong to its plugin. */
export class PythonTrainer {
  private readonly transport: WorkerTransport;
  private initialized?: PythonInitialization;
  private initializing = false;
  private core?: TrainerAdapter<PythonModelRef, DatasetRef>;
  constructor(private readonly options: PythonTrainerOptions = {}) { this.transport = new WorkerTransport(options); }
  get backend(): PythonBackendMetadata {
    if (!this.initialized) throw new Error('Initialize the Python trainer before reading metadata');
    return this.initialized.backend;
  }
  get datasets(): PythonInitialization['datasets'] {
    if (!this.initialized) throw new Error('Initialize the Python trainer before reading datasets');
    return this.initialized.datasets;
  }
  get adapter(): TrainerAdapter<PythonModelRef, DatasetRef> {
    if (!this.core) throw new Error('Initialize the Python trainer before using its adapter');
    return this.core;
  }
  private model(value: unknown, operation: string): PythonModelRef {
    try {
      if (!record(value) || value.kind !== 'model' || value.sessionId !== this.backend.sessionId || !positive(value.handle))
        throw new TypeError('Model must identify the current live session and a positive handle');
      artifactRef(value.originArtifact);
      const measured = inferenceIdentity(value.inferenceIdentity);
      if (measured.profile !== this.backend.profile) throw new TypeError('Model inference profile differs from the plugin profile');
      return freeze({ ...value, inferenceIdentity: measured }) as unknown as PythonModelRef;
    } catch {
      const error = new AdapterKitError('protocol', `Worker ${operation} returned an invalid measured model reference; session terminated`, { command: operation });
      this.transport.invalidate(error); throw error;
    }
  }
  private async modelResult<T>(operation: string, input: object): Promise<T> {
    const raw = await this.transport.request<unknown>(operation, input);
    const ref = this.model(record(raw) ? raw.modelRef : undefined, operation);
    return freeze({ ...(raw as object), modelRef: ref }) as T;
  }
  async initialize(request: PythonInitializeRequest): Promise<PythonInitialization> {
    if (this.initialized || this.initializing) throw new Error('A Python trainer may be initialized only once');
    if (!text(request?.root) || !text(request?.pluginPath) || !text(request?.expectedProfile))
      throw new TypeError('initialize requires root, pluginPath, and expectedProfile');
    this.initializing = true;
    try {
      const result = initialization(await this.transport.request('initialize', {
        root: resolve(request.root), pluginPath: resolve(request.pluginPath), config: request.config ?? {},
      }), request.expectedProfile);
      this.initialized = result;
      const port: TrainerPort<PythonModelRef, DatasetRef> = {
        sessionId: result.backend.sessionId,
        train: input => this.modelResult<TrainResult<PythonModelRef>>('train', input),
        evaluate: input => this.modelResult<BackendEvaluation<PythonModelRef, DatasetRef>>('evaluate', input),
        load: input => this.modelResult<LoadResult<PythonModelRef>>('load', input),
        inspect: input => this.modelResult<{ modelRef: PythonModelRef }>('inspect', input),
        dispose: input => this.modelResult<DisposeResult<PythonModelRef>>('dispose', input),
      };
      this.core = createTrainerAdapter(port, { emit: this.options.emit, clock: this.options.clock });
      return result;
    } catch (error) {
      this.transport.invalidate(new AdapterKitError('protocol', `Python trainer initialization failed: ${error instanceof Error ? error.message : String(error)}`));
      throw error;
    } finally { this.initializing = false; }
  }
  close(): Promise<void> { return this.transport.close(); }
}

export async function createPythonTrainerAdapter(request: PythonInitializeRequest, options: PythonTrainerOptions = {}): Promise<PythonTrainer> {
  const trainer = new PythonTrainer(options);
  try { await trainer.initialize(request); return trainer; }
  catch (error) { await trainer.close(); throw error; }
}
