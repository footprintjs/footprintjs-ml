import {canonicalJson, detached, fail, finiteNumber, isRecord, jsonObject, nonempty,
  readDatasetRef, readModelRef, sameModelContent} from './contracts.js';
import type {DatasetRef, EvaluationReceipt, JsonObject, JsonValue, ModelRef} from './contracts.js';
import {readEvaluationReceipt} from './receipts.js';
import {checkRelease} from './guard.js';

export interface SelectionCandidate {
  readonly candidateId: string;
  readonly configuration: JsonObject;
}
export interface SelectionComparison<D extends DatasetRef = DatasetRef> {
  readonly datasetRef: D;
  readonly preprocessingVersion: string;
  readonly evaluationMethodVersion: string;
  readonly parameters: JsonObject;
}
export interface SelectionPolicy {
  readonly metric: string;
  readonly direction: 'min' | 'max';
  /** Exact numeric ties use locale-independent UTF-16 candidate-id order. */
  readonly tieBreak: 'candidate-id-ascending';
}
export interface SelectionManifest<D extends DatasetRef = DatasetRef> {
  readonly kind: 'selection-manifest';
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly candidates: readonly SelectionCandidate[];
  readonly comparison: SelectionComparison<D>;
  readonly policy: SelectionPolicy;
}
export interface SelectionCandidateResult<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef> {
  readonly candidateId: string;
  readonly configuration: JsonObject;
  readonly modelRef: M;
  readonly evaluation: EvaluationReceipt<M, D>;
}
export interface SelectionRank {
  readonly candidateId: string;
  readonly value: number;
}
export interface SelectionReceiptInput<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef> {
  readonly selectionId: string;
  readonly createdAt: number;
  readonly manifest: SelectionManifest<D>;
  readonly results: readonly SelectionCandidateResult<M, D>[];
}
export interface SelectionReceipt<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>
  extends SelectionReceiptInput<M, D> {
  readonly kind: 'selection-receipt';
  readonly schemaVersion: 1;
  readonly ranking: readonly SelectionRank[];
  readonly selectedCandidateId: string;
  readonly selectedModelRef: M;
}
export interface SelectionRequest {
  readonly receipt: unknown;
  /** Independently pinned declaration, not a value copied from the offered receipt. */
  readonly manifest: SelectionManifest;
  /** Independently retained observations, not results copied from the offered receipt. */
  readonly results: readonly SelectionCandidateResult[];
  readonly modelRef: ModelRef;
  readonly now?: number;
}
export interface SelectionReason { readonly code: string; readonly message: string }
export interface SelectionDecision {
  readonly kind: 'selection-decision';
  readonly schemaVersion: 1;
  readonly allowed: boolean;
  readonly status: 'allow' | 'deny' | 'unknown';
  readonly reasons: readonly SelectionReason[];
  readonly checkedAt: number | null;
  readonly selectionId: string | null;
  readonly experimentId: string | null;
  readonly selectedCandidateId: string | null;
  readonly policy: SelectionPolicy | null;
  readonly bindings: { readonly proposed: JsonValue; readonly receipt: JsonValue; readonly expected: JsonValue };
}
export interface ExperimentRequest<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef> {
  readonly manifest: SelectionManifest<D>;
  readonly executeCandidate: (candidate: SelectionCandidate, comparison: SelectionComparison<D>) =>
    Promise<SelectionCandidateResult<M, D>> | SelectionCandidateResult<M, D>;
  /** A progress hook can retain completed references for provenance or caller-owned cleanup. */
  readonly onResult?: (result: SelectionCandidateResult<M, D>, index: number) => Promise<void> | void;
  readonly now?: number;
}

const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const equal = (a: unknown, b: unknown) => canonicalJson(jsonObject({value: a}).value) === canonicalJson(jsonObject({value: b}).value);
function exactKeys(value: JsonObject, keys: readonly string[], label: string) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('invalid-selection-field', `${label}.${key} is not a supported field`);
}
function candidate(value: unknown): SelectionCandidate {
  const copy = jsonObject(value, 'candidate');
  exactKeys(copy, ['candidateId', 'configuration'], 'candidate');
  return detached({candidateId: nonempty(copy.candidateId, 'candidateId'),
    configuration: jsonObject(copy.configuration, 'candidate.configuration')});
}

/** Read the complete declared search set and comparison policy; no training is performed. */
export function readSelectionManifest<D extends DatasetRef = DatasetRef>(value: unknown): SelectionManifest<D> {
  const copy = jsonObject(value, 'selection manifest');
  exactKeys(copy, ['kind', 'schemaVersion', 'experimentId', 'candidates', 'comparison', 'policy'], 'manifest');
  if (copy.kind !== 'selection-manifest' || copy.schemaVersion !== 1)
    fail('invalid-selection-manifest', 'Unsupported or missing selection manifest schema');
  if (!Array.isArray(copy.candidates) || copy.candidates.length === 0)
    fail('invalid-selection-candidates', 'Declare a nonempty complete candidate set');
  const candidates = copy.candidates.map(candidate).sort((a, b) => lexical(a.candidateId, b.candidateId));
  if (new Set(candidates.map(c => c.candidateId)).size !== candidates.length)
    fail('duplicate-selection-candidate', 'Candidate identifiers must be unique');
  const rawComparison = jsonObject(copy.comparison, 'comparison');
  exactKeys(rawComparison, ['datasetRef', 'preprocessingVersion', 'evaluationMethodVersion', 'parameters'], 'comparison');
  const comparison: SelectionComparison<D> = {
    datasetRef: readDatasetRef<D>(rawComparison.datasetRef),
    preprocessingVersion: nonempty(rawComparison.preprocessingVersion, 'comparison.preprocessingVersion'),
    evaluationMethodVersion: nonempty(rawComparison.evaluationMethodVersion, 'comparison.evaluationMethodVersion'),
    parameters: jsonObject(rawComparison.parameters, 'comparison.parameters'),
  };
  const rawPolicy = jsonObject(copy.policy, 'selection policy');
  exactKeys(rawPolicy, ['metric', 'direction', 'tieBreak'], 'policy');
  if (rawPolicy.direction !== 'min' && rawPolicy.direction !== 'max')
    fail('invalid-selection-policy', 'Selection direction must be min or max');
  if (rawPolicy.tieBreak !== 'candidate-id-ascending')
    fail('invalid-selection-policy', 'An explicit candidate-id-ascending tie policy is required');
  const policy: SelectionPolicy = {metric: nonempty(rawPolicy.metric, 'policy.metric'),
    direction: rawPolicy.direction, tieBreak: rawPolicy.tieBreak};
  return detached({kind: 'selection-manifest' as const, schemaVersion: 1 as const,
    experimentId: nonempty(copy.experimentId, 'experimentId'), candidates, comparison, policy});
}

function resultAt<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>(value: unknown,
  declaration: SelectionCandidate, manifest: SelectionManifest<D>, now: number): SelectionCandidateResult<M, D> {
  const copy = jsonObject(value, 'candidate result');
  exactKeys(copy, ['candidateId', 'configuration', 'modelRef', 'evaluation'], 'candidate result');
  const candidateId = nonempty(copy.candidateId, 'candidate result.candidateId');
  const configuration = jsonObject(copy.configuration, 'candidate result.configuration');
  if (candidateId !== declaration.candidateId || !equal(configuration, declaration.configuration))
    fail('selection-configuration-mismatch', 'The observed candidate identifier/configuration differs from its declaration');
  const modelRef = readModelRef<M>(copy.modelRef);
  const evaluation = readEvaluationReceipt(copy.evaluation) as EvaluationReceipt<M, D>;
  // This neutral finite threshold reuses v1/v2 identity, context and date semantics.
  // It is not a model-quality gate; the application's real release policy remains separate.
  const decision = checkRelease({modelRef, ...manifest.comparison, receipt: evaluation,
    policy: {metric: manifest.policy.metric, operator: 'gte', threshold: -Number.MAX_VALUE}, now});
  if (!decision.allowed) fail('invalid-selection-evaluation',
    `Candidate ${candidateId} has missing, incomparable, future-dated or model-mismatched evaluation evidence: ${decision.reasons.map(r => r.code).join(', ')}`);
  return detached({candidateId, configuration, modelRef, evaluation});
}

function resultsAt<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>(value: unknown,
  manifest: SelectionManifest<D>, now: number): readonly SelectionCandidateResult<M, D>[] {
  if (!Array.isArray(value) || value.length !== manifest.candidates.length)
    fail('incomplete-selection-results', 'Exactly one result is required for every declared candidate');
  const declarations = new Map(manifest.candidates.map(c => [c.candidateId, c]));
  const seen = new Set<string>();
  const results = value.map(raw => {
    const copy = jsonObject(raw, 'candidate result');
    const id = nonempty(copy.candidateId, 'candidate result.candidateId');
    if (seen.has(id)) fail('duplicate-selection-result', `Candidate ${id} has more than one result`);
    seen.add(id);
    const declared = declarations.get(id);
    if (!declared) fail('undeclared-selection-result', `Candidate ${id} was not declared`);
    return resultAt<M, D>(copy, declared, manifest, now);
  });
  return detached(results.sort((a, b) => lexical(a.candidateId, b.candidateId)));
}

function rank(results: readonly SelectionCandidateResult[], policy: SelectionPolicy): readonly SelectionRank[] {
  return detached(results.map(result => ({candidateId: result.candidateId, value: result.evaluation.metrics[policy.metric]}))
    .sort((a, b) => a.value === b.value ? lexical(a.candidateId, b.candidateId) :
      policy.direction === 'min' ? (a.value < b.value ? -1 : 1) : (a.value > b.value ? -1 : 1)));
}

/** Compute, rather than accept, the ranking and winner from complete comparable observations. */
export function createSelectionReceipt<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>(
  input: SelectionReceiptInput<M, D>,
): SelectionReceipt<M, D> {
  const copy = jsonObject(input, 'selection receipt input');
  exactKeys(copy, ['selectionId', 'createdAt', 'manifest', 'results'], 'selection receipt input');
  const createdAt = finiteNumber(copy.createdAt, 'createdAt', 0);
  const manifest = readSelectionManifest<D>(copy.manifest);
  const results = resultsAt<M, D>(copy.results, manifest, createdAt);
  const ranking = rank(results, manifest.policy), selectedCandidateId = ranking[0].candidateId;
  const selectedModelRef = results.find(result => result.candidateId === selectedCandidateId)!.modelRef;
  return detached({kind: 'selection-receipt' as const, schemaVersion: 1 as const,
    selectionId: nonempty(copy.selectionId, 'selectionId'), createdAt, manifest, results,
    ranking, selectedCandidateId, selectedModelRef});
}

/** Reading recomputes the ranking; saved winner/rank/score claims are not taken on trust. */
export function readSelectionReceipt(value: unknown): SelectionReceipt {
  const copy = jsonObject(value, 'selection receipt');
  exactKeys(copy, ['kind', 'schemaVersion', 'selectionId', 'createdAt', 'manifest', 'results',
    'ranking', 'selectedCandidateId', 'selectedModelRef'], 'selection receipt');
  if (copy.kind !== 'selection-receipt' || copy.schemaVersion !== 1)
    fail('invalid-selection-receipt', 'Unsupported or missing selection receipt schema');
  const computed = createSelectionReceipt({selectionId: nonempty(copy.selectionId, 'selectionId'),
    createdAt: finiteNumber(copy.createdAt, 'createdAt', 0),
    manifest: readSelectionManifest(copy.manifest), results: copy.results as unknown as SelectionCandidateResult[]});
  if (!equal(copy.ranking, computed.ranking) || copy.selectedCandidateId !== computed.selectedCandidateId)
    fail('selection-ranking-mismatch', 'The saved ranking or winner disagrees with the declared comparable results');
  const selectedModelRef = readModelRef(copy.selectedModelRef);
  if (!sameModelContent(selectedModelRef, computed.selectedModelRef))
    fail('selection-model-mismatch', 'The saved selected model disagrees with its winning candidate');
  return detached({...computed, selectedModelRef});
}

// Content comparisons follow the existing reference semantics: locations and live
// handles are not content identities, while profile and identity presence matter.
function artifactKey(value: {sha256: string; bytes: number; format: string}) {
  return {sha256: value.sha256.toLowerCase(), bytes: value.bytes, format: value.format};
}
function inferenceKey(value: {sha256: string; profile: string} | undefined) {
  return value === undefined ? null : {sha256: value.sha256.toLowerCase(), profile: value.profile};
}
function modelKey(value: ModelRef) {
  return {checkpoint: artifactKey(value.originArtifact), inferenceIdentity: inferenceKey(value.inferenceIdentity)};
}
function datasetKey(value: DatasetRef) {
  return {artifact: artifactKey(value.artifact), role: value.role, rows: value.rows, shape: value.shape};
}
function comparisonKey(value: SelectionComparison) {
  return {...value, datasetRef: datasetKey(value.datasetRef)};
}
function observedKey(results: readonly SelectionCandidateResult[]) {
  return results.map(result => ({candidateId: result.candidateId, configuration: result.configuration,
    modelRef: modelKey(result.modelRef), evaluation: {
      schemaVersion: result.evaluation.schemaVersion, evaluationId: result.evaluation.evaluationId,
      createdAt: result.evaluation.createdAt, modelRef: modelKey(result.evaluation.modelRef),
      checkpoint: artifactKey(result.evaluation.schemaVersion === 1 ? result.evaluation.checkpoint.artifact : result.evaluation.checkpointForAudit.artifact),
      inferenceIdentity: result.evaluation.schemaVersion === 2 ? inferenceKey(result.evaluation.inferenceIdentity) : null,
      datasetRef: datasetKey(result.evaluation.datasetRef), preprocessingVersion: result.evaluation.preprocessingVersion,
      evaluationMethodVersion: result.evaluation.evaluationMethodVersion,
      parameters: result.evaluation.parameters, metrics: result.evaluation.metrics,
    }}));
}

/** Check a receipt against independently retained declaration/results and a current measured model ref. */
export function checkSelection(input: SelectionRequest): SelectionDecision {
  let receipt: SelectionReceipt | undefined, manifest: SelectionManifest | undefined;
  let checkedAt: number | null = null, selectedCandidateId: string | null = null;
  let proposed: JsonValue = null, recorded: JsonValue = null, expected: JsonValue = null;
  const reasons: SelectionReason[] = [];
  let denied = false, unknown = false;
  const deny = (code: string, message: string) => {denied = true; reasons.push({code, message});};
  try {
    const copy = jsonObject(input, 'selection request');
    exactKeys(copy, ['receipt', 'manifest', 'results', 'modelRef', 'now'], 'selection request');
    checkedAt = finiteNumber(copy.now === undefined ? Date.now() : copy.now, 'now', 0);
    manifest = readSelectionManifest(copy.manifest);
    const results = resultsAt(copy.results, manifest, checkedAt);
    const modelRef = readModelRef(copy.modelRef);
    const expectedRanking = rank(results, manifest.policy);
    selectedCandidateId = expectedRanking[0].candidateId;
    const winner = results.find(result => result.candidateId === selectedCandidateId)!;
    receipt = readSelectionReceipt(copy.receipt);
    proposed = jsonObject({modelRef}); recorded = jsonObject(receipt);
    expected = jsonObject({manifest, results, ranking: expectedRanking, selectedCandidateId});
    if (receipt.createdAt > checkedAt) deny('selection-receipt-from-future', 'The selection receipt is dated after this check');
    if (receipt.manifest.experimentId !== manifest.experimentId)
      deny('selection-experiment-mismatch', 'The receipt belongs to a different declared experiment');
    if (!equal(receipt.manifest.policy, manifest.policy))
      deny('selection-policy-mismatch', 'The receipt changed the independently declared metric, direction or tie policy');
    if (!equal(receipt.manifest.candidates, manifest.candidates))
      deny('selection-candidate-set-mismatch', 'The receipt omitted, added or changed a declared candidate/configuration');
    if (!equal(comparisonKey(receipt.manifest.comparison), comparisonKey(manifest.comparison)))
      deny('selection-comparison-mismatch', 'The receipt changed the independently declared data, preprocessing, method or evaluation parameters');
    if (!equal(observedKey(receipt.results), observedKey(results)))
      deny('selection-results-mismatch', 'The receipt differs from the independently retained model/evaluation observations');
    if (receipt.selectedCandidateId !== selectedCandidateId)
      deny('selection-winner-mismatch', 'The receipt winner is not the winner of the complete expected comparison');
    const identity = checkRelease({modelRef, ...manifest.comparison, receipt: winner.evaluation,
      policy: {metric: manifest.policy.metric, operator: 'gte', threshold: -Number.MAX_VALUE}, now: checkedAt});
    if (!identity.allowed) {
      if (identity.status === 'unknown') unknown = true; else denied = true;
      reasons.push({code: 'selection-proposed-model-mismatch',
        message: 'The proposed model is not covered by the winning candidate evaluation: ' + identity.reasons.map(r => r.code).join(', ')});
    }
  } catch (error) {
    unknown = true;
    reasons.push({code: 'invalid-or-missing-selection-evidence', message: error instanceof Error ? error.message : 'Invalid selection evidence'});
  }
  const allowed = !denied && !unknown;
  if (allowed) reasons.push({code: 'selection-matches-declaration',
    message: 'The full declared candidate/configuration set, comparable observations, deterministic ranking and proposed winner match'});
  return detached({kind: 'selection-decision' as const, schemaVersion: 1 as const, allowed,
    status: allowed ? 'allow' as const : denied ? 'deny' as const : 'unknown' as const,
    reasons, checkedAt, selectionId: receipt?.selectionId ?? null,
    experimentId: manifest?.experimentId ?? null, selectedCandidateId, policy: manifest?.policy ?? null,
    bindings: {proposed, receipt: recorded, expected}});
}

/** Sequential callback driver. It imports no trainer and never returns a successful partial experiment. */
export async function runExperiment<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>(
  input: ExperimentRequest<M, D>,
): Promise<readonly SelectionCandidateResult<M, D>[]> {
  const manifest = readSelectionManifest<D>(input?.manifest);
  if (typeof input.executeCandidate !== 'function') fail('invalid-experiment-executor', 'executeCandidate must be a function');
  if (input.onResult !== undefined && typeof input.onResult !== 'function') fail('invalid-experiment-hook', 'onResult must be a function');
  if (input.now !== undefined) finiteNumber(input.now, 'now', 0);
  const results: SelectionCandidateResult<M, D>[] = [];
  for (let index = 0; index < manifest.candidates.length; index++) {
    const declaration = manifest.candidates[index];
    const raw = await input.executeCandidate(declaration, manifest.comparison);
    const result = resultAt<M, D>(raw, declaration, manifest, input.now ?? Date.now());
    results.push(result);
    if (input.onResult) await input.onResult(result, index);
  }
  return resultsAt<M, D>(results, manifest, input.now ?? Date.now());
}
