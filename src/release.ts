import {artifactRef, canonicalJson, cloneJson, detached, fail, finiteNumber, inferenceIdentity,
  jsonObject, nonempty, readDatasetRef, readModelRef, sameArtifact, sameModelContent, sameRuntime} from './contracts.js';
import type {ArtifactRef, InferenceIdentity, JsonObject, JsonValue, ModelRef, ReleaseDecision,
  ReleasePolicy, ReleaseReason} from './contracts.js';
import {checkRelease} from './guard.js';
import {checkSelection, createSelectionReceipt, readSelectionManifest} from './selection.js';
import type {SelectionCandidateResult, SelectionDecision} from './selection.js';
import {checkDataLineage} from './lineage.js';
import type {DataLineageDecision, DataLineagePolicy} from './lineage.js';

export interface ReleaseArtifactStore {
  read(reference: ArtifactRef): Promise<Uint8Array>;
  put(bytes: Uint8Array, options: {readonly format: string}): Promise<ArtifactRef>;
}
export interface ModelReleasePlan {
  readonly kind: 'model-release-plan'; readonly schemaVersion: 1;
  readonly releaseId: string; readonly idempotencyKey: string;
  readonly target: {readonly name: string; readonly expectedRevision: string | null};
  readonly modelArtifact: ArtifactRef;
  readonly manifestRef: ArtifactRef; readonly resultsRef: ArtifactRef;
  readonly selectionReceiptRef: ArtifactRef; readonly qualityPolicy: ReleasePolicy;
  readonly lineage?: {readonly required: boolean; readonly receiptRef?: ArtifactRef;
    readonly splitManifest: ArtifactRef; readonly policy: DataLineagePolicy};
}
export interface ReleaseArtifactIdentity { readonly sha256: string; readonly bytes: number; readonly format: string }
export interface ModelPublicationPayload {
  readonly kind: 'model-publication-payload'; readonly schemaVersion: 1;
  readonly releaseId: string; readonly idempotencyKey: string;
  readonly target: {readonly name: string; readonly expectedRevision: string | null};
  readonly artifact: ReleaseArtifactIdentity; readonly candidateId: string;
  readonly validUntil: number | null;
  readonly inferenceIdentity: InferenceIdentity | null;
  readonly evidence: {readonly plan: ReleaseArtifactIdentity; readonly manifest: ReleaseArtifactIdentity;
    readonly results: ReleaseArtifactIdentity; readonly selectionReceipt: ReleaseArtifactIdentity;
    readonly lineageReceipt?: ReleaseArtifactIdentity; readonly splitManifest?: ReleaseArtifactIdentity};
  readonly qualityPolicy: ReleasePolicy;
}
export interface ModelPublicationRequest {
  readonly payload: ModelPublicationPayload; readonly payloadSha256: string;
  readonly modelBytes: Uint8Array; readonly preparedRef: ArtifactRef;
}
export interface ModelPublicationLookupRequest {
  readonly payload: ModelPublicationPayload; readonly payloadSha256: string; readonly preparedRef: ArtifactRef;
}
export interface ModelPublicationReceipt {
  readonly kind: 'model-publication-receipt'; readonly schemaVersion: 1;
  readonly releaseId: string; readonly idempotencyKey: string; readonly targetName: string;
  readonly revision: string; readonly payloadSha256: string;
  readonly artifact: ArtifactRef; readonly preparedRef: ArtifactRef; readonly committedAt: number;
}
export interface ModelPublisherResult {
  readonly allowed: boolean; readonly status: 'published' | 'already-published' | 'deny' | 'unknown';
  readonly reasons: readonly ReleaseReason[]; readonly receipt: ModelPublicationReceipt | null;
}
export interface ModelPublisher {
  publish(request: ModelPublicationRequest): Promise<ModelPublisherResult>;
  /** Read-only recovery of an existing exact effect. Null means no committed key; it must never install anything. */
  lookup?(request: ModelPublicationLookupRequest): Promise<ModelPublisherResult | null>;
}
export interface ModelReleaseDecision {
  readonly kind: 'model-release-decision'; readonly schemaVersion: 1;
  readonly allowed: boolean; readonly status: 'allow' | 'deny' | 'unknown';
  readonly reasons: readonly ReleaseReason[]; readonly checkedAt: number | null;
  /** Present only when confirming an existing effect without fresh release authorization. */
  readonly basis?: 'historical-acknowledgement';
  readonly checks: {readonly quality: ReleaseDecision | null; readonly selection: SelectionDecision | null;
    readonly lineage: DataLineageDecision | null};
  readonly bindings: {readonly planRef: ArtifactRef | null; readonly modelRef: ModelRef | null;
    readonly payloadSha256: string | null};
}
export interface PreparedModelRelease {
  readonly kind: 'prepared-model-release'; readonly schemaVersion: 1; readonly preparedAt: number;
  readonly planRef: ArtifactRef; readonly modelRef: ModelRef;
  readonly payload: ModelPublicationPayload; readonly payloadSha256: string;
  readonly qualityDecision: ReleaseDecision; readonly selectionDecision: SelectionDecision;
  readonly lineageDecision: DataLineageDecision | null; readonly decision: ModelReleaseDecision;
}
export interface PrepareModelReleaseRequest {
  /** Independently authorized/pinned reference, never authority copied from the offered preparation. */
  readonly planRef: ArtifactRef; readonly modelRef: ModelRef;
  readonly store: ReleaseArtifactStore;
  readonly verifyModel: (request: {readonly modelRef: ModelRef}) => Promise<ModelRef>;
  readonly now?: number;
}
export interface ModelReleasePreparation {
  readonly kind: 'model-release-preparation'; readonly schemaVersion: 1;
  readonly allowed: boolean; readonly status: 'allow' | 'deny' | 'unknown';
  readonly reasons: readonly ReleaseReason[]; readonly decision: ModelReleaseDecision;
  readonly preparedRef: ArtifactRef | null; readonly record: PreparedModelRelease | null;
}
export interface PublishModelReleaseRequest {
  readonly planRef: ArtifactRef; readonly preparedRef: ArtifactRef; readonly store: ReleaseArtifactStore;
  readonly publisher: ModelPublisher; readonly now?: number;
  /** Needed for a new publication; optional for read-only acknowledgement of an existing effect. */
  readonly modelRef?: ModelRef;
  readonly verifyModel?: PrepareModelReleaseRequest['verifyModel'];
}
export interface ReleaseModelRequest extends Omit<PublishModelReleaseRequest, 'preparedRef'> {readonly preparedRef?: ArtifactRef}
export interface ModelReleasePublication {
  readonly kind: 'model-release-publication'; readonly schemaVersion: 1;
  readonly allowed: boolean; readonly status: 'published' | 'already-published' | 'deny' | 'unknown';
  readonly reasons: readonly ReleaseReason[]; readonly decision: ModelReleaseDecision;
  readonly preparedRef: ArtifactRef | null; readonly record: PreparedModelRelease | null;
  readonly publisherReceipt: ModelPublicationReceipt | null;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('invalid-release-field', `${label}.${key} is unsupported`);
}
function readPolicy(value: unknown): ReleasePolicy {
  const raw = jsonObject(value, 'qualityPolicy');
  exactKeys(raw, ['metric', 'operator', 'threshold', 'maxAgeMs'], 'qualityPolicy');
  if (raw.operator !== 'lte' && raw.operator !== 'gte') fail('invalid-release-policy', 'Quality operator must be lte or gte');
  return detached({metric: nonempty(raw.metric, 'qualityPolicy.metric'), operator: raw.operator,
    threshold: finiteNumber(raw.threshold, 'qualityPolicy.threshold'),
    ...(raw.maxAgeMs === undefined ? {} : {maxAgeMs: finiteNumber(raw.maxAgeMs, 'qualityPolicy.maxAgeMs', 0)})});
}
function readTarget(value: unknown): ModelReleasePlan['target'] {
  const raw = jsonObject(value, 'target'); exactKeys(raw, ['name', 'expectedRevision'], 'target');
  if (raw.expectedRevision !== null) nonempty(raw.expectedRevision, 'target.expectedRevision');
  return detached({name: nonempty(raw.name, 'target.name'), expectedRevision: raw.expectedRevision as string | null});
}
function identity(value: unknown): ReleaseArtifactIdentity {
  const raw = jsonObject(value, 'artifact identity'); exactKeys(raw, ['sha256', 'bytes', 'format'], 'artifact identity');
  const checked = artifactRef({kind: 'artifact', path: 'content-identity', ...raw});
  return detached({sha256: checked.sha256.toLowerCase(), bytes: checked.bytes, format: checked.format});
}
function contentIdentity(value: ArtifactRef): ReleaseArtifactIdentity {
  return identity({sha256: value.sha256, bytes: value.bytes, format: value.format});
}
export function readModelPublicationPayload(value: unknown): ModelPublicationPayload {
  const raw = jsonObject(value, 'publication payload');
  exactKeys(raw, ['kind', 'schemaVersion', 'releaseId', 'idempotencyKey', 'target', 'artifact', 'candidateId', 'validUntil',
    'inferenceIdentity', 'evidence', 'qualityPolicy'], 'publication payload');
  if (raw.kind !== 'model-publication-payload' || raw.schemaVersion !== 1)
    fail('invalid-publication-payload', 'Unsupported publication payload schema');
  const evidence = jsonObject(raw.evidence, 'payload.evidence');
  exactKeys(evidence, ['plan', 'manifest', 'results', 'selectionReceipt', 'lineageReceipt', 'splitManifest'], 'payload.evidence');
  const measured = raw.inferenceIdentity === null ? null : inferenceIdentity(raw.inferenceIdentity);
  return detached({kind: 'model-publication-payload' as const, schemaVersion: 1 as const,
    releaseId: nonempty(raw.releaseId, 'releaseId'), idempotencyKey: nonempty(raw.idempotencyKey, 'idempotencyKey'),
    target: readTarget(raw.target), artifact: identity(raw.artifact), candidateId: nonempty(raw.candidateId, 'candidateId'),
    validUntil: raw.validUntil === null ? null : finiteNumber(raw.validUntil, 'validUntil', 0),
    inferenceIdentity: measured === null ? null : {kind: 'inference-identity' as const, schemaVersion: 1 as const,
      profile: measured.profile, sha256: measured.sha256.toLowerCase()},
    evidence: {plan: identity(evidence.plan), manifest: identity(evidence.manifest), results: identity(evidence.results),
      selectionReceipt: identity(evidence.selectionReceipt),
      ...(evidence.lineageReceipt === undefined ? {} : {lineageReceipt: identity(evidence.lineageReceipt)}),
      ...(evidence.splitManifest === undefined ? {} : {splitManifest: identity(evidence.splitManifest)})},
    qualityPolicy: readPolicy(raw.qualityPolicy)});
}
/** Hash actual detached bytes; root import remains free of Node-specific modules. */
export async function releaseBytesSha256(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array)) fail('invalid-release-bytes', 'Artifact contents must be Uint8Array bytes');
  const snapshot = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', snapshot);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function modelPublicationPayloadSha256(value: ModelPublicationPayload): Promise<string> {
  return releaseBytesSha256(new TextEncoder().encode(canonicalJson(jsonObject(readModelPublicationPayload(value)))));
}

/** A pinned plan is caller-authorized authority. Reading it does not discover who may authorize a release. */
export function readModelReleasePlan(value: unknown): ModelReleasePlan {
  const raw = jsonObject(value, 'model release plan');
  exactKeys(raw, ['kind', 'schemaVersion', 'releaseId', 'idempotencyKey', 'target', 'modelArtifact',
    'manifestRef', 'resultsRef', 'selectionReceiptRef', 'qualityPolicy', 'lineage'], 'release plan');
  if (raw.kind !== 'model-release-plan' || raw.schemaVersion !== 1)
    fail('invalid-model-release-plan', 'Unsupported model release plan schema');
  let lineage: ModelReleasePlan['lineage'];
  if (raw.lineage !== undefined) {
    const source = jsonObject(raw.lineage, 'lineage');
    exactKeys(source, ['required', 'receiptRef', 'splitManifest', 'policy'], 'lineage');
    if (typeof source.required !== 'boolean') fail('invalid-release-lineage', 'lineage.required must be explicit');
    const policy = jsonObject(source.policy, 'lineage.policy');
    exactKeys(policy, ['trainingDatasetRef'], 'lineage.policy');
    lineage = {required: source.required, splitManifest: artifactRef(source.splitManifest),
      policy: {trainingDatasetRef: readDatasetRef(policy.trainingDatasetRef)},
      ...(source.receiptRef === undefined ? {} : {receiptRef: artifactRef(source.receiptRef)})};
  }
  return detached({kind: 'model-release-plan' as const, schemaVersion: 1 as const,
    releaseId: nonempty(raw.releaseId, 'releaseId'), idempotencyKey: nonempty(raw.idempotencyKey, 'idempotencyKey'),
    target: readTarget(raw.target), modelArtifact: artifactRef(raw.modelArtifact),
    manifestRef: artifactRef(raw.manifestRef), resultsRef: artifactRef(raw.resultsRef),
    selectionReceiptRef: artifactRef(raw.selectionReceiptRef), qualityPolicy: readPolicy(raw.qualityPolicy),
    ...(lineage === undefined ? {} : {lineage})});
}

async function measuredRead(store: ReleaseArtifactStore, value: ArtifactRef): Promise<Uint8Array> {
  const ref = artifactRef(value);
  if (!store || typeof store.read !== 'function') fail('invalid-release-store', 'A byte-reading artifact store is required');
  const returned = await store.read(ref);
  if (!(returned instanceof Uint8Array)) fail('invalid-release-bytes', 'The artifact store did not return byte contents');
  const bytes = new Uint8Array(returned);
  if (bytes.byteLength !== ref.bytes || await releaseBytesSha256(bytes) !== ref.sha256.toLowerCase())
    fail('release-artifact-mismatch', 'Actual artifact bytes differ from the externally pinned digest or byte count');
  return bytes;
}
async function measuredJson(store: ReleaseArtifactStore, ref: ArtifactRef): Promise<JsonValue> {
  const bytes = await measuredRead(store, ref);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { fail('invalid-release-json', 'A pinned JSON evidence artifact is not valid UTF-8 JSON'); }
  return cloneJson(parsed, 'pinned release evidence');
}
async function persistJson(store: ReleaseArtifactStore, record: unknown): Promise<ArtifactRef> {
  if (typeof store.put !== 'function') fail('invalid-release-store', 'A content-addressed byte writer is required');
  const bytes = new TextEncoder().encode(canonicalJson(cloneJson(record)));
  const ref = artifactRef(await store.put(new Uint8Array(bytes), {format: 'footprintjs-ml/prepared-model-release-json/v1'}));
  if (ref.format !== 'footprintjs-ml/prepared-model-release-json/v1') fail('release-artifact-mismatch', 'Stored preparation format changed');
  const actual = await measuredRead(store, ref);
  if (actual.length !== bytes.length || actual.some((byte, index) => byte !== bytes[index]))
    fail('release-artifact-mismatch', 'The preparation store persisted different contents');
  return ref;
}
const equalJson = (a: unknown, b: unknown) => canonicalJson(cloneJson(a)) === canonicalJson(cloneJson(b));
function newDecision(planRef: ArtifactRef | null = null, modelRef: ModelRef | null = null): ModelReleaseDecision {
  return {kind: 'model-release-decision', schemaVersion: 1, allowed: false, status: 'unknown',
    reasons: [], checkedAt: null, checks: {quality: null, selection: null, lineage: null},
    bindings: {planRef, modelRef, payloadSha256: null}};
}
function amend(decision: ModelReleaseDecision, code: string, message: string, status: 'deny' | 'unknown'): ModelReleaseDecision {
  return detached({...decision, allowed: false, status,
    reasons: [...decision.reasons, {code, message}]});
}
function failedDecision(error: unknown, decision: ModelReleaseDecision): ModelReleaseDecision {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'model-release-operation-failed';
  return amend(decision, code, error instanceof Error ? error.message : 'Model release operation failed',
    /mismatch|conflict|not-approved|expired|required|modified/.test(code) ? 'deny' : 'unknown');
}
function preparation(decision: ModelReleaseDecision, preparedRef: ArtifactRef | null = null,
  record: PreparedModelRelease | null = null): ModelReleasePreparation {
  return detached({kind: 'model-release-preparation' as const, schemaVersion: 1 as const,
    allowed: decision.allowed, status: decision.status, reasons: decision.reasons, decision, preparedRef, record});
}

async function evaluatePlan(input: PrepareModelReleaseRequest): Promise<{
  decision: ModelReleaseDecision; record: PreparedModelRelease | null; modelBytes: Uint8Array | null;
}> {
  let decision = newDecision();
  try {
    const planRef = artifactRef(input.planRef), proposed = readModelRef(input.modelRef);
    decision = newDecision(planRef, proposed);
    const plan = readModelReleasePlan(await measuredJson(input.store, planRef));
    const [manifestJson, resultsJson, selectionJson] = await Promise.all([
      measuredJson(input.store, plan.manifestRef), measuredJson(input.store, plan.resultsRef),
      measuredJson(input.store, plan.selectionReceiptRef),
    ]);
    const manifest = readSelectionManifest(manifestJson);
    const modelBytes = await measuredRead(input.store, plan.modelArtifact);
    let lineageJson: JsonValue | undefined;
    if (plan.lineage?.required) {
      if (!plan.lineage.receiptRef) fail('release-lineage-required', 'Required data-lineage evidence is missing');
      [lineageJson] = await Promise.all([measuredJson(input.store, plan.lineage.receiptRef),
        measuredRead(input.store, plan.lineage.splitManifest)]);
    }
    if (typeof input.verifyModel !== 'function') fail('release-live-verification-required', 'A live model verifier is required');
    const modelRef = readModelRef(await input.verifyModel({modelRef: proposed}));
    if (!sameRuntime(proposed, modelRef) || !sameModelContent(proposed, modelRef))
      fail('release-live-model-mismatch', 'Live verification returned a different model or runtime handle');
    const now = finiteNumber(input.now === undefined ? Date.now() : input.now, 'now', 0);
    const expected = createSelectionReceipt({selectionId: 'independent-release-comparison', createdAt: now,
      manifest, results: resultsJson as unknown as SelectionCandidateResult[]});
    const winner = expected.results.find(result => result.candidateId === expected.selectedCandidateId)!;
    const quality = checkRelease({modelRef, ...manifest.comparison, receipt: winner.evaluation, policy: plan.qualityPolicy, now});
    const selection = checkSelection({receipt: selectionJson, manifest, results: expected.results, modelRef, now});
    const lineage = plan.lineage?.required ? checkDataLineage({receipt: lineageJson, modelRef,
      datasetRef: manifest.comparison.datasetRef, splitManifest: plan.lineage.splitManifest, policy: plan.lineage.policy}) : null;
    const checks = {quality, selection, lineage};
    const reasons: ReleaseReason[] = [];
    let denied = false, unknown = false;
    for (const [name, check] of Object.entries(checks)) if (check && !check.allowed) {
      if (check.status === 'deny') denied = true; else unknown = true;
      reasons.push({code: `release-${name}-failed`, message: `${name} check refused: ${check.reasons.map(r => r.code).join(', ')}`});
    }
    if (!sameArtifact(plan.modelArtifact, winner.modelRef.originArtifact) || !sameArtifact(plan.modelArtifact, modelRef.originArtifact)) {
      denied = true;
      reasons.push({code: 'release-checkpoint-mismatch',
        message: 'The plan, winning result and verified live model must name the same exact checkpoint bytes/format'});
    }
    const validUntil = plan.qualityPolicy.maxAgeMs === undefined ? null :
      Math.min(Number.MAX_VALUE, winner.evaluation.createdAt + plan.qualityPolicy.maxAgeMs);
    const payload = readModelPublicationPayload({kind: 'model-publication-payload', schemaVersion: 1,
      releaseId: plan.releaseId, idempotencyKey: plan.idempotencyKey, target: plan.target,
      artifact: contentIdentity(plan.modelArtifact), candidateId: expected.selectedCandidateId,
      validUntil, inferenceIdentity: modelRef.inferenceIdentity ?? null,
      evidence: {plan: contentIdentity(planRef), manifest: contentIdentity(plan.manifestRef),
        results: contentIdentity(plan.resultsRef), selectionReceipt: contentIdentity(plan.selectionReceiptRef),
        ...(plan.lineage?.required && plan.lineage.receiptRef ? {lineageReceipt: contentIdentity(plan.lineage.receiptRef),
          splitManifest: contentIdentity(plan.lineage.splitManifest)} : {})}, qualityPolicy: plan.qualityPolicy});
    const payloadSha256 = await modelPublicationPayloadSha256(payload);
    const allowed = !denied && !unknown;
    if (allowed) reasons.push({code: 'model-release-checks-pass',
      message: 'Pinned authority, complete selection, quality, required data use, live model and exact checkpoint agree'});
    decision = detached({...decision, checkedAt: now, allowed, status: allowed ? 'allow' as const : denied ? 'deny' as const : 'unknown' as const,
      reasons, checks, bindings: {planRef, modelRef, payloadSha256}});
    if (!allowed) return {decision, record: null, modelBytes: null};
    const record: PreparedModelRelease = detached({kind: 'prepared-model-release' as const, schemaVersion: 1 as const,
      preparedAt: now, planRef, modelRef, payload, payloadSha256, qualityDecision: quality,
      selectionDecision: selection, lineageDecision: lineage, decision});
    return {decision, record, modelBytes};
  } catch (error) {
    return {decision: failedDecision(error, decision), record: null, modelBytes: null};
  }
}

/** Prepare measured immutable evidence; the returned JSON is not a reusable unchecked authorization token. */
export async function prepareModelRelease(input: PrepareModelReleaseRequest): Promise<ModelReleasePreparation> {
  const checked = await evaluatePlan(input);
  if (!checked.record) return preparation(checked.decision);
  try {
    const preparedRef = await persistJson(input.store, checked.record);
    return preparation(checked.decision, preparedRef, checked.record);
  } catch (error) { return preparation(failedDecision(error, checked.decision)); }
}

function readPrepared(value: unknown): PreparedModelRelease {
  const raw = jsonObject(value, 'prepared model release');
  exactKeys(raw, ['kind', 'schemaVersion', 'preparedAt', 'planRef', 'modelRef', 'payload', 'payloadSha256',
    'qualityDecision', 'selectionDecision', 'lineageDecision', 'decision'], 'prepared release');
  if (raw.kind !== 'prepared-model-release' || raw.schemaVersion !== 1)
    fail('invalid-release-preparation', 'Unsupported preparation schema');
  const decision = jsonObject(raw.decision, 'preparation decision');
  const quality = jsonObject(raw.qualityDecision, 'preparation quality');
  const selection = jsonObject(raw.selectionDecision, 'preparation selection');
  const lineage = raw.lineageDecision === null ? null : jsonObject(raw.lineageDecision, 'preparation lineage');
  if (decision.kind !== 'model-release-decision' || decision.allowed !== true || decision.status !== 'allow' ||
      quality.kind !== 'release-decision' || quality.allowed !== true ||
      selection.kind !== 'selection-decision' || selection.allowed !== true ||
      (lineage !== null && (lineage.kind !== 'data-lineage-decision' || lineage.allowed !== true)))
    fail('release-preparation-not-approved', 'The stored preparation does not retain successful required checks');
  return detached({kind: 'prepared-model-release' as const, schemaVersion: 1 as const,
    preparedAt: finiteNumber(raw.preparedAt, 'preparedAt', 0), planRef: artifactRef(raw.planRef), modelRef: readModelRef(raw.modelRef),
    payload: readModelPublicationPayload(raw.payload), payloadSha256: nonempty(raw.payloadSha256, 'payloadSha256'),
    qualityDecision: quality as unknown as ReleaseDecision, selectionDecision: selection as unknown as SelectionDecision,
    lineageDecision: lineage as unknown as DataLineageDecision | null, decision: decision as unknown as ModelReleaseDecision});
}
function publication(decision: ModelReleaseDecision, status: ModelReleasePublication['status'],
  preparedRef: ArtifactRef | null = null, record: PreparedModelRelease | null = null,
  publisherReceipt: ModelPublicationReceipt | null = null): ModelReleasePublication {
  return detached({kind: 'model-release-publication' as const, schemaVersion: 1 as const,
    allowed: decision.allowed && (status === 'published' || status === 'already-published'),
    status, reasons: decision.reasons, decision, preparedRef, record, publisherReceipt});
}

async function reconstructPrepared(input: Pick<PublishModelReleaseRequest, 'planRef' | 'store'>,
  preparedRef: ArtifactRef): Promise<PreparedModelRelease> {
  const offered = readPrepared(await measuredJson(input.store, preparedRef));
  const planRef = artifactRef(input.planRef);
  if (!sameArtifact(offered.planRef, planRef)) fail('release-plan-mismatch', 'The preparation belongs to a different independently pinned plan');
  if (await modelPublicationPayloadSha256(offered.payload) !== offered.payloadSha256.toLowerCase())
    fail('release-preparation-mismatch', 'The preparation payload does not match its measured semantic digest');
  // Historical consistency is reconstructed without pretending an archived handle is live.
  const historical = await evaluatePlan({planRef: offered.planRef, store: input.store, modelRef: offered.modelRef,
    now: offered.preparedAt, verifyModel: async ({modelRef}) => modelRef});
  if (!historical.record || !equalJson(historical.record, offered))
    fail('release-preparation-mismatch', 'Stored preparation claims do not reconstruct from their pinned authority and observations');
  return offered;
}

async function confirmedReceipt(value: unknown, offered: PreparedModelRelease, preparedRef: ArtifactRef,
  input: Pick<PublishModelReleaseRequest, 'planRef' | 'store'>, confirmedAt: number) {
  const receipt = jsonObject(value, 'publisher receipt') as unknown as ModelPublicationReceipt;
  if (receipt.kind !== 'model-publication-receipt' || receipt.schemaVersion !== 1 ||
      typeof receipt.payloadSha256 !== 'string' || receipt.payloadSha256.toLowerCase() !== offered.payloadSha256.toLowerCase() ||
      receipt.revision !== offered.payloadSha256.toLowerCase() || receipt.releaseId !== offered.payload.releaseId ||
      receipt.idempotencyKey !== offered.payload.idempotencyKey || receipt.targetName !== offered.payload.target.name ||
      !sameArtifact(artifactRef(receipt.artifact), {kind: 'artifact', path: 'approved-content', ...offered.payload.artifact}))
    fail('model-publisher-receipt-mismatch', 'The publisher confirmed a different artifact, target, idempotency payload or revision');
  finiteNumber(receipt.committedAt, 'publisher receipt.committedAt', 0);
  if (receipt.committedAt > confirmedAt)
    fail('model-publisher-receipt-mismatch', 'The publisher receipt is dated after the confirmation check');
  const originalPreparedRef = artifactRef(receipt.preparedRef);
  const originalRecord = sameArtifact(originalPreparedRef, preparedRef) ? offered : await reconstructPrepared(input, originalPreparedRef);
  if (originalRecord.payloadSha256.toLowerCase() !== offered.payloadSha256.toLowerCase() ||
      !equalJson(originalRecord.payload, offered.payload))
    fail('model-publisher-receipt-mismatch', 'The reused publication links different original preparation evidence');
  return {receipt, originalPreparedRef, originalRecord};
}

function proposedMatchesPayload(value: ModelRef, payload: ModelPublicationPayload) {
  const model = readModelRef(value);
  if (!sameArtifact(model.originArtifact, {kind: 'artifact', path: 'approved-content', ...payload.artifact})) return false;
  const identity = model.inferenceIdentity;
  return payload.inferenceIdentity === null ? identity === undefined : identity !== undefined &&
    identity.profile === payload.inferenceIdentity.profile && identity.sha256.toLowerCase() === payload.inferenceIdentity.sha256.toLowerCase();
}

/** Reload authority and recheck at publication. The receiver must verify and consume the same detached bytes. */
export async function publishModelRelease(input: PublishModelReleaseRequest): Promise<ModelReleasePublication> {
  let decision = newDecision(), preparedRef: ArtifactRef | null = null, offered: PreparedModelRelease | null = null;
  try {
    preparedRef = artifactRef(input.preparedRef);
    offered = await reconstructPrepared(input, preparedRef);
    if (!input.publisher || typeof input.publisher.publish !== 'function') fail('invalid-model-publisher', 'A byte-consuming publisher is required');
    if (input.publisher.lookup !== undefined) {
      if (typeof input.publisher.lookup !== 'function') fail('invalid-model-publisher', 'Publisher lookup must be a read-only function');
      const existing = await input.publisher.lookup({payload: offered.payload, payloadSha256: offered.payloadSha256, preparedRef});
      if (existing !== null) {
        if (!existing.allowed || existing.status !== 'already-published' || !existing.receipt) {
          decision = amend(decision, 'model-publisher-lookup-refused', existing.reasons?.map(r => r.code).join(', ') || 'Existing effect was not confirmed',
            existing.status === 'deny' ? 'deny' : 'unknown');
          return publication(decision, existing.status === 'deny' ? 'deny' : 'unknown', preparedRef, offered);
        }
        if (input.modelRef !== undefined && !proposedMatchesPayload(input.modelRef, offered.payload))
          fail('release-proposal-mismatch', 'The supplied model differs from the existing publication being acknowledged');
        const now = finiteNumber(input.now === undefined ? Date.now() : input.now, 'now', 0);
        const {receipt, originalPreparedRef, originalRecord} = await confirmedReceipt(existing.receipt, offered, preparedRef, input, now);
        decision = detached({...originalRecord.decision, checkedAt: now, basis: 'historical-acknowledgement' as const,
          reasons: [{code: 'historical-publication-confirmed',
            message: 'The receiver confirmed the original exact committed effect; no new publication or fresh model approval was performed'}]});
        return publication(decision, 'already-published', originalPreparedRef, originalRecord, receipt);
      }
    }
    const beforeNewPublication = finiteNumber(input.now === undefined ? Date.now() : input.now, 'now', 0);
    if (offered.payload.validUntil !== null && beforeNewPublication > offered.payload.validUntil)
      fail('release-approval-expired', 'No existing effect was confirmed and the prepared approval has expired');
    if (input.modelRef === undefined || typeof input.verifyModel !== 'function')
      fail('release-live-verification-required', 'No existing effect was confirmed; a live model and verifier are required for any new publication');
    const checked = await evaluatePlan({...input, modelRef: input.modelRef, verifyModel: input.verifyModel}); decision = checked.decision;
    if (!checked.record || !checked.modelBytes) return publication(decision, decision.status === 'deny' ? 'deny' : 'unknown', preparedRef, offered);
    if (offered.preparedAt > checked.record.preparedAt) fail('release-preparation-mismatch', 'Preparation is dated after the fresh publication check');
    if (offered.payloadSha256.toLowerCase() !== checked.record.payloadSha256 || !equalJson(offered.payload, checked.record.payload))
      fail('release-preparation-mismatch', 'Prepared effectful claims differ from fresh pinned authority and live checks');
    const result = await input.publisher.publish({payload: checked.record.payload, payloadSha256: checked.record.payloadSha256,
      modelBytes: new Uint8Array(checked.modelBytes), preparedRef});
    if (!result.allowed || (result.status !== 'published' && result.status !== 'already-published') || !result.receipt) {
      decision = amend(decision, 'model-publisher-refused', result.reasons?.map(r => r.code).join(', ') || 'Publisher returned no confirmed outcome',
        result.status === 'deny' ? 'deny' : 'unknown');
      return publication(decision, result.status === 'deny' ? 'deny' : 'unknown', preparedRef, offered);
    }
    const confirmedAt = finiteNumber(input.now === undefined ? Date.now() : input.now, 'now', 0);
    const {receipt, originalPreparedRef, originalRecord} = await confirmedReceipt(result.receipt, offered, preparedRef, input, confirmedAt);
    return publication(decision, result.status, originalPreparedRef, originalRecord, receipt);
  } catch (error) {
    decision = failedDecision(error, decision);
    return publication(decision, decision.status === 'deny' ? 'deny' : 'unknown', preparedRef, offered);
  }
}

/** Convenience path; retries still rely on stable semantic payloads and receiver-side idempotency. */
export async function releaseModel(input: ReleaseModelRequest): Promise<ModelReleasePublication> {
  if (input.preparedRef !== undefined) return publishModelRelease({...input, preparedRef: input.preparedRef});
  if (input.modelRef === undefined || typeof input.verifyModel !== 'function')
    return publication(amend(newDecision(), 'release-live-verification-required',
      'A fresh one-shot release requires a live model/verifier; recover a retained preparedRef for read-only acknowledgement', 'unknown'), 'unknown');
  const prepared = await prepareModelRelease({...input, modelRef: input.modelRef, verifyModel: input.verifyModel});
  if (!prepared.allowed || !prepared.preparedRef)
    return publication(prepared.decision, prepared.status === 'deny' ? 'deny' : 'unknown', prepared.preparedRef, prepared.record);
  return publishModelRelease({...input, preparedRef: prepared.preparedRef});
}
