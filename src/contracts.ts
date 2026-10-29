/** JSON references only: numerical buffers and fitted models stay in a trainer. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }

export interface ArtifactRef {
  readonly kind: 'artifact'; readonly path: string; readonly sha256: string;
  readonly bytes: number; readonly format: string;
}
export interface CheckpointRef { readonly kind: 'checkpoint'; readonly artifact: ArtifactRef }
/** A backend-measured digest of the inference contract named by profile. */
export interface InferenceIdentity {
  readonly kind: 'inference-identity'; readonly schemaVersion: 1;
  readonly sha256: string; readonly profile: string;
}
export interface ModelRef {
  readonly kind: 'model'; readonly sessionId: string; readonly handle: number;
  readonly originArtifact: ArtifactRef;
  readonly inferenceIdentity?: InferenceIdentity;
}
export interface DatasetRef {
  readonly kind: 'dataset'; readonly sessionId: string; readonly handle: number;
  readonly artifact: ArtifactRef; readonly rows: number; readonly shape: readonly number[];
  readonly role: string;
}
export interface EvaluationRequest<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef> {
  readonly modelRef: M; readonly datasetRef: D; readonly preprocessingVersion: string;
  readonly evaluationMethodVersion: string; readonly parameters?: JsonObject;
}
export interface BackendEvaluation<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>
  extends EvaluationRequest<M, D> {
  readonly evaluationId: string; readonly metrics: Readonly<Record<string, number>>;
  readonly [extra: string]: unknown;
}
export interface TrainResult<M extends ModelRef = ModelRef> {
  readonly modelRef: M; readonly checkpoint: ArtifactRef; readonly [extra: string]: unknown;
}
export interface LoadResult<M extends ModelRef = ModelRef> {
  readonly modelRef: M; readonly actualArtifact: ArtifactRef; readonly [extra: string]: unknown;
}
export interface DisposeResult<M extends ModelRef = ModelRef> { readonly modelRef: M; readonly released: boolean }
export interface InspectResult<M extends ModelRef = ModelRef> { readonly modelRef: M }
export interface TrainerPort<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef> {
  readonly sessionId: string;
  train(request: JsonObject): Promise<TrainResult<M>>;
  evaluate(request: EvaluationRequest<M, D>): Promise<BackendEvaluation<M, D>>;
  load(request: { readonly checkpoint: CheckpointRef }): Promise<LoadResult<M>>;
  dispose(request: { readonly modelRef: M }): Promise<DisposeResult<M>>;
  /** Recompute/observe the actual live model; required for identity-aware refs. */
  inspect?(request: { readonly modelRef: M }): Promise<InspectResult<M>>;
}
export interface EvaluationReceiptBase<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef> {
  readonly kind: 'evaluation-receipt';
  readonly evaluationId: string; readonly createdAt: number;
  readonly modelRef: M; readonly datasetRef: D;
  readonly preprocessingVersion: string; readonly evaluationMethodVersion: string;
  readonly parameters: JsonObject; readonly metrics: Readonly<Record<string, number>>;
}
export interface EvaluationReceiptV1<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>
  extends EvaluationReceiptBase<M, D> {
  readonly schemaVersion: 1; readonly checkpoint: CheckpointRef;
}
export interface EvaluationReceiptV2<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>
  extends EvaluationReceiptBase<M, D> {
  readonly schemaVersion: 2; readonly inferenceIdentity: InferenceIdentity;
  readonly checkpointForAudit: CheckpointRef;
}
export type EvaluationReceipt<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef> =
  EvaluationReceiptV1<M, D> | EvaluationReceiptV2<M, D>;
export interface EvaluationReceiptInput<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>
  extends BackendEvaluation<M, D> { readonly createdAt: number }
export interface ReleasePolicy {
  readonly metric: string; readonly operator: 'gte' | 'lte'; readonly threshold: number;
  readonly maxAgeMs?: number;
}
export interface ReleaseRequest extends EvaluationRequest {
  readonly receipt: unknown; readonly policy: ReleasePolicy; readonly now?: number;
}
export interface ReleaseReason { readonly code: string; readonly message: string }
export interface ReleaseDecision {
  readonly kind: 'release-decision'; readonly schemaVersion: 1;
  readonly allowed: boolean; readonly status: 'allow' | 'deny' | 'unknown';
  readonly reasons: readonly ReleaseReason[]; readonly checkedAt: number | null;
  readonly receiptId: string | null; readonly policy: ReleasePolicy | null;
  readonly bindings: {
    readonly coverage: 'checkpoint' | 'inference' | null;
    readonly proposed: JsonValue; readonly receipt: JsonValue;
  };
}

export class MLContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'MLContractError'; this.code = code; }
}
export function fail(code: string, message: string): never { throw new MLContractError(code, message); }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('invalid-string', `${label} must be a nonempty string`);
  return value;
}
export function finiteNumber(value: unknown, label: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum))
    fail('invalid-number', `${label} must be a finite number${minimum === undefined ? '' : ` >= ${minimum}`}`);
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    fail('invalid-integer', `${label} must be a positive safe integer`);
  return value;
}

/** Reject executable/accessor/class values, cycles, undefined and nonfinite JSON. */
export function cloneJson(value: unknown, label = 'value', ancestors = new Set<object>(), depth = 0): JsonValue {
  if (depth > 64) fail('invalid-json', `${label} exceeds the JSON nesting limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finiteNumber(value, label);
  if (typeof value !== 'object') fail('invalid-json', `${label} must contain only JSON values`);
  if (ancestors.has(value)) fail('invalid-json', `${label} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    fail('invalid-json', `${label} must contain plain JSON objects`);
  if (Object.getOwnPropertySymbols(value).length) fail('invalid-json', `${label} has symbol properties`);
  const next = new Set(ancestors); next.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors))
    if (descriptor.enumerable && !('value' in descriptor)) fail('invalid-json', `${label}.${key} is an accessor`);
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(descriptors, index)) fail('invalid-json', `${label} contains an array hole`);
      result.push(cloneJson(descriptors[index].value, `${label}[${index}]`, next, depth + 1));
    }
    if (Object.keys(value).some(key => !/^\d+$/.test(key) || Number(key) >= value.length))
      fail('invalid-json', `${label} has non-index array properties`);
    return result;
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) if (descriptor.enumerable)
    Object.defineProperty(result, key, { value: cloneJson(descriptor.value, `${label}.${key}`, next, depth + 1),
      enumerable: true, configurable: true, writable: true });
  return result;
}
export function jsonObject(value: unknown, label = 'value'): JsonObject {
  const copy = cloneJson(value, label);
  if (!isRecord(copy)) fail('invalid-json', `${label} must be a JSON object`);
  return copy as JsonObject;
}
export function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}
export function detached<T>(value: T, label = 'value'): T { return freezeDeep(cloneJson(value, label)) as T; }
export function artifactRef(value: unknown): ArtifactRef {
  const copy = jsonObject(value, 'artifact');
  if (copy.kind !== 'artifact') fail('invalid-artifact', 'Expected kind artifact');
  nonempty(copy.path, 'artifact.path'); nonempty(copy.format, 'artifact.format');
  if (typeof copy.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(copy.sha256))
    fail('invalid-artifact', 'artifact.sha256 must be a SHA-256 hex digest');
  if (typeof copy.bytes !== 'number' || !Number.isSafeInteger(copy.bytes) || copy.bytes < 0)
    fail('invalid-artifact', 'artifact.bytes must be a nonnegative safe integer');
  return freezeDeep(copy) as unknown as ArtifactRef;
}
export function checkpointRef(value: ArtifactRef): CheckpointRef {
  return freezeDeep({ kind: 'checkpoint' as const, artifact: artifactRef(value) });
}
export function inferenceIdentity(value: unknown): InferenceIdentity {
  const copy = jsonObject(value, 'inferenceIdentity');
  if (copy.kind !== 'inference-identity' || copy.schemaVersion !== 1)
    fail('invalid-inference-identity', 'Unsupported or missing inference identity schema');
  nonempty(copy.profile, 'inferenceIdentity.profile');
  if (typeof copy.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(copy.sha256))
    fail('invalid-inference-identity', 'inferenceIdentity.sha256 must be a SHA-256 hex digest');
  return freezeDeep(copy) as unknown as InferenceIdentity;
}
export function readCheckpointRef(value: unknown): CheckpointRef {
  const copy = jsonObject(value, 'checkpoint');
  if (copy.kind !== 'checkpoint') fail('invalid-checkpoint', 'Expected kind checkpoint');
  return checkpointRef(artifactRef(copy.artifact));
}
export function readModelRef<M extends ModelRef = ModelRef>(value: unknown): M {
  const copy = jsonObject(value, 'modelRef');
  if (copy.kind !== 'model') fail('invalid-model', 'Expected kind model');
  nonempty(copy.sessionId, 'modelRef.sessionId'); positiveInteger(copy.handle, 'modelRef.handle');
  artifactRef(copy.originArtifact);
  if (Object.hasOwn(copy, 'inferenceIdentity')) inferenceIdentity(copy.inferenceIdentity);
  return freezeDeep(copy) as unknown as M;
}
export function readDatasetRef<D extends DatasetRef = DatasetRef>(value: unknown): D {
  const copy = jsonObject(value, 'datasetRef');
  if (copy.kind !== 'dataset') fail('invalid-dataset', 'Expected kind dataset');
  nonempty(copy.sessionId, 'datasetRef.sessionId'); positiveInteger(copy.handle, 'datasetRef.handle');
  nonempty(copy.role, 'datasetRef.role'); positiveInteger(copy.rows, 'datasetRef.rows'); artifactRef(copy.artifact);
  if (!Array.isArray(copy.shape) || !copy.shape.length) fail('invalid-dataset', 'datasetRef.shape must be nonempty');
  for (const size of copy.shape) positiveInteger(size, 'datasetRef.shape dimension');
  if (copy.shape[0] !== copy.rows) fail('invalid-dataset', 'datasetRef.shape[0] must equal rows');
  return freezeDeep(copy) as unknown as D;
}
export function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.sha256.toLowerCase() === b.sha256.toLowerCase() && a.bytes === b.bytes && a.format === b.format;
}
export function sameRuntime(a: { sessionId: string; handle: number }, b: { sessionId: string; handle: number }): boolean {
  return a.sessionId === b.sessionId && a.handle === b.handle;
}
export function sameInference(a: InferenceIdentity, b: InferenceIdentity): boolean {
  return a.profile === b.profile && a.sha256.toLowerCase() === b.sha256.toLowerCase();
}
/** Identity presence is significant; an absent claim never matches a measured one. */
export function sameModelContent(a: ModelRef, b: ModelRef): boolean {
  return sameArtifact(a.originArtifact, b.originArtifact) &&
    (a.inferenceIdentity === undefined ? b.inferenceIdentity === undefined :
      b.inferenceIdentity !== undefined && sameInference(a.inferenceIdentity, b.inferenceIdentity));
}
export function sameDataset(a: DatasetRef, b: DatasetRef): boolean {
  return sameArtifact(a.artifact, b.artifact) && a.role === b.role && a.rows === b.rows &&
    a.shape.length === b.shape.length && a.shape.every((size, index) => size === b.shape[index]);
}
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isRecord(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' +
    canonicalJson(value[key] as JsonValue)).join(',') + '}';
  return JSON.stringify(value);
}
