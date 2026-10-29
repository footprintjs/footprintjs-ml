import assert from 'node:assert/strict';
import test from 'node:test';
import {createEvaluationReceipt, createSelectionReceipt, readSelectionManifest,
  readSelectionReceipt, checkSelection, runExperiment, checkRelease} from '../dist/index.js';

const NOW = 1_800_000_000_000;
const copy = value => structuredClone(value);
const artifact = (letter, path = 'artifacts/model.npz') => ({kind: 'artifact', path,
  sha256: letter.repeat(64), bytes: 1024, format: 'model-npz/v1'});
const dataset = () => ({kind: 'dataset', sessionId: 'session-a', handle: 1, rows: 40,
  shape: [40, 1], role: 'validation', artifact: {...artifact('d', 'data/validation.npz'), format: 'dataset-npz/v1'}});
const comparison = () => ({datasetRef: dataset(), preprocessingVersion: 'raw-input/v1',
  evaluationMethodVersion: 'regression-metrics/original-target-units/v1', parameters: {target: 'posterior-mean'}});
const declared = () => ['candidate-a', 'candidate-b', 'candidate-c'].map((candidateId, i) => ({candidateId,
  configuration: {updates: [30, 100, 60][i], learningRate: 0.01, seed: 42}}));
const manifest = () => ({kind: 'selection-manifest', schemaVersion: 1, experimentId: 'declared-experiment',
  candidates: declared(), comparison: comparison(),
  policy: {metric: 'mse', direction: 'min', tieBreak: 'candidate-id-ascending'}});
function fixture() {
  const expected = manifest();
  const results = expected.candidates.map((declaration, index) => {
    const modelRef = {kind: 'model', sessionId: 'session-a', handle: index + 2,
      originArtifact: artifact(['a', 'b', 'c'][index]), inferenceIdentity: {kind: 'inference-identity',
        schemaVersion: 1, sha256: ['e', 'f', '1'][index].repeat(64), profile: 'complete-predictor/v1'}};
    const evaluation = createEvaluationReceipt({modelRef, ...expected.comparison,
      evaluationId: 'evaluation-' + declaration.candidateId, createdAt: NOW,
      metrics: {mse: [0.04, 0.01, 0.025][index], utility: [0.7, 0.9, 0.8][index]}});
    return {...declaration, configuration: copy(declaration.configuration), modelRef, evaluation};
  });
  return {manifest: expected, results};
}
function receiptOf(value = fixture(), extra = {}) {
  return createSelectionReceipt({selectionId: 'selection-1', createdAt: NOW + 10, ...value, ...extra});
}
function requestOf(value = fixture(), receipt = receiptOf(value)) {
  return {...value, receipt, modelRef: value.results[1].modelRef, now: NOW + 20};
}
const reason = (decision, code) => decision.reasons.some(item => item.code === code);

test('selection computes the complete minimum-MSE ranking and winning reference', () => {
  const value = fixture(), before = copy(value), receipt = receiptOf(value);
  assert.deepEqual(receipt.ranking, [
    {candidateId: 'candidate-b', value: 0.01}, {candidateId: 'candidate-c', value: 0.025},
    {candidateId: 'candidate-a', value: 0.04},
  ]);
  assert.equal(receipt.selectedCandidateId, 'candidate-b');
  assert.deepEqual(receipt.selectedModelRef, value.results[1].modelRef);
  assert.equal(checkSelection(requestOf(value, receipt)).allowed, true);
  assert.ok(Object.isFrozen(receipt.results[0].evaluation.metrics));
  assert.deepEqual(value, before);
});

test('maximizing a declared utility metric is supported independently of minimizing loss', () => {
  const value = fixture(); value.manifest.policy = {metric: 'utility', direction: 'max', tieBreak: 'candidate-id-ascending'};
  const receipt = receiptOf(value);
  assert.equal(receipt.selectedCandidateId, 'candidate-b');
  assert.deepEqual(receipt.ranking.map(r => r.value), [0.9, 0.8, 0.7]);
  assert.equal(checkSelection(requestOf(value, receipt)).allowed, true);
});

test('an exact tie uses explicit, locale-independent candidate-ID order', () => {
  const value = fixture();
  const ids = ['z', 'a', 'A'];
  value.manifest.candidates = value.manifest.candidates.map((c, i) => ({...c, candidateId: ids[i]}));
  value.results = value.results.map((r, i) => ({...r, candidateId: ids[i],
    evaluation: {...copy(r.evaluation), metrics: {mse: 0.01}}}));
  const receipt = receiptOf(value);
  assert.equal(receipt.selectedCandidateId, 'A');
  assert.deepEqual(receipt.ranking.map(r => r.candidateId), ['A', 'a', 'z']);
});

test('candidate and result array ordering cannot rewrite the set or tie outcome', () => {
  const value = fixture(), receipt = receiptOf(value);
  value.manifest.candidates.reverse(); value.results.reverse();
  const request = {...requestOf(value, receipt), modelRef: fixture().results[1].modelRef};
  assert.equal(checkSelection(request).allowed, true);
  assert.deepEqual(readSelectionReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
});

test('a valid receipt cannot approve a different released model', () => {
  const value = fixture();
  const decision = checkSelection({...requestOf(value), modelRef: value.results[0].modelRef});
  assert.equal(decision.status, 'deny');
  assert.ok(reason(decision, 'selection-proposed-model-mismatch'));
});

test('a self-consistent reversed ranking cannot rewrite the external declared policy', () => {
  const expected = fixture(), rewritten = copy(expected);
  rewritten.manifest.policy.direction = 'max';
  const receipt = receiptOf(rewritten);
  assert.equal(readSelectionReceipt(receipt).selectedCandidateId, 'candidate-a');
  const decision = checkSelection({...requestOf(expected, receipt), modelRef: expected.results[0].modelRef});
  assert.equal(decision.status, 'deny');
  assert.ok(reason(decision, 'selection-policy-mismatch'));
  assert.ok(reason(decision, 'selection-winner-mismatch'));
});

test('changing the ranked metric is refused even if the resulting winner happens to match', () => {
  const expected = fixture(), rewritten = copy(expected);
  rewritten.manifest.policy.metric = 'utility'; rewritten.manifest.policy.direction = 'max';
  const decision = checkSelection(requestOf(expected, receiptOf(rewritten)));
  assert.equal(decision.allowed, false);
  assert.ok(reason(decision, 'selection-policy-mismatch'));
});

test('omitting the best candidate from a self-consistent receipt cannot shrink the expected experiment', () => {
  const expected = fixture(), omitted = copy(expected);
  omitted.manifest.candidates.splice(1, 1); omitted.results.splice(1, 1);
  const receipt = receiptOf(omitted);
  assert.equal(receipt.selectedCandidateId, 'candidate-c');
  const decision = checkSelection({...requestOf(expected, receipt), modelRef: expected.results[2].modelRef});
  assert.equal(decision.status, 'deny');
  assert.ok(reason(decision, 'selection-candidate-set-mismatch'));
  assert.ok(reason(decision, 'selection-results-mismatch'));
});

test('adding an undeclared candidate/configuration cannot expand the trusted search set', () => {
  const expected = fixture(), changed = copy(expected), extra = copy(changed.results[0]);
  extra.candidateId = 'unplanned'; extra.configuration.updates = 999;
  changed.manifest.candidates.push({candidateId: extra.candidateId, configuration: extra.configuration});
  changed.results.push(extra);
  const decision = checkSelection(requestOf(expected, receiptOf(changed)));
  assert.equal(decision.status, 'deny');
  assert.ok(reason(decision, 'selection-candidate-set-mismatch'));
});

test('rewriting a declared configuration in both manifest and receipt is detected against expected configuration', () => {
  const expected = fixture(), changed = copy(expected);
  changed.manifest.candidates[0].configuration.learningRate = 0.9;
  changed.results[0].configuration.learningRate = 0.9;
  const decision = checkSelection(requestOf(expected, receiptOf(changed)));
  assert.equal(decision.allowed, false);
  assert.ok(reason(decision, 'selection-candidate-set-mismatch'));
  assert.ok(reason(decision, 'selection-results-mismatch'));
});

test('self-consistent forged metric values are refused against separately retained evaluation observations', () => {
  const expected = fixture(), forged = copy(expected);
  forged.results[0].evaluation.metrics.mse = 0.000001;
  const receipt = receiptOf(forged);
  assert.equal(receipt.selectedCandidateId, 'candidate-a');
  const decision = checkSelection({...requestOf(expected, receipt), modelRef: expected.results[0].modelRef});
  assert.equal(decision.status, 'deny');
  assert.ok(reason(decision, 'selection-results-mismatch'));
});

test('changing experiment identity cannot replay a receipt into another declaration', () => {
  const expected = fixture(), another = copy(expected); another.manifest.experimentId = 'another-experiment';
  const decision = checkSelection(requestOf(expected, receiptOf(another)));
  assert.equal(decision.status, 'deny');
  assert.ok(reason(decision, 'selection-experiment-mismatch'));
});

test('missing, duplicate and undeclared candidate results never create a complete selection receipt', () => {
  const missing = fixture(); missing.results.pop();
  assert.throws(() => receiptOf(missing), /Exactly one result/);
  const duplicate = fixture(); duplicate.results[2] = copy(duplicate.results[0]);
  assert.throws(() => receiptOf(duplicate), /more than one/);
  const undeclared = fixture(); undeclared.results[0].candidateId = 'outside';
  assert.throws(() => receiptOf(undeclared), /not declared/);
  const wrongConfig = fixture(); wrongConfig.results[0].configuration.seed = 100;
  assert.throws(() => receiptOf(wrongConfig), /configuration differs/);
});

test('all candidates must use the declared validation dataset identity and role', () => {
  const value = fixture(); value.results[1].evaluation = copy(value.results[1].evaluation);
  value.results[1].evaluation.datasetRef.artifact.sha256 = '2'.repeat(64);
  assert.throws(() => receiptOf(value), /dataset-mismatch/);
  const role = fixture(); role.results[1].evaluation = copy(role.results[1].evaluation);
  role.results[1].evaluation.datasetRef.role = 'test';
  assert.throws(() => receiptOf(role), /dataset-mismatch/);
});

for (const field of ['preprocessingVersion', 'evaluationMethodVersion', 'parameters']) {
  test(`one candidate with incomparable ${field} cannot enter the ranking`, () => {
    const value = fixture(); value.results[0].evaluation = copy(value.results[0].evaluation);
    value.results[0].evaluation[field] = field === 'parameters' ? {target: 'normalized'} : 'different/v2';
    assert.throws(() => receiptOf(value), /invalid|mismatch|evidence/i);
  });
  test(`a self-consistent receipt cannot change the externally declared ${field}`, () => {
    const expected = fixture(), changed = copy(expected);
    const replacement = field === 'parameters' ? {target: 'normalized'} : 'different/v2';
    changed.manifest.comparison[field] = replacement;
    for (const result of changed.results) result.evaluation[field] = copy(replacement);
    const decision = checkSelection(requestOf(expected, receiptOf(changed)));
    assert.equal(decision.status, 'deny');
    assert.ok(reason(decision, 'selection-comparison-mismatch'));
  });
}

test('changing all dataset references in a rewritten receipt cannot change the external comparison', () => {
  const expected = fixture(), changed = copy(expected);
  changed.manifest.comparison.datasetRef.artifact.sha256 = '2'.repeat(64);
  for (const result of changed.results) result.evaluation.datasetRef = copy(changed.manifest.comparison.datasetRef);
  const decision = checkSelection(requestOf(expected, receiptOf(changed)));
  assert.equal(decision.status, 'deny');
  assert.ok(reason(decision, 'selection-comparison-mismatch'));
});

test('a candidate result must be covered by its own model-bound evaluation', () => {
  const value = fixture(); value.results[0].modelRef = copy(value.results[1].modelRef);
  assert.throws(() => receiptOf(value), /inference-mismatch/);
});

test('the selected metric must be present and finite in every candidate evaluation', () => {
  const missing = fixture(); missing.results[0].evaluation = copy(missing.results[0].evaluation);
  delete missing.results[0].evaluation.metrics.mse;
  assert.throws(() => receiptOf(missing), /metric-unavailable/);
  for (const bad of [NaN, Infinity, -Infinity]) {
    const value = fixture(); value.results[0].evaluation = copy(value.results[0].evaluation);
    value.results[0].evaluation.metrics.mse = bad;
    assert.throws(() => receiptOf(value), /finite/);
    assert.equal(checkSelection({...requestOf(fixture()), results: value.results}).allowed, false);
  }
});

test('extreme finite metrics rank without overflowing a subtraction comparator', () => {
  const value = fixture(); value.results = value.results.map((r, i) => ({...r,
    evaluation: {...copy(r.evaluation), metrics: {mse: [Number.MAX_VALUE, -Number.MAX_VALUE, 0][i]}}}));
  assert.deepEqual(receiptOf(value).ranking.map(r => r.value), [-Number.MAX_VALUE, 0, Number.MAX_VALUE]);
});

test('future candidate evaluations cannot support an earlier selection or publication check', () => {
  const value = fixture();
  assert.throws(() => receiptOf(value, {createdAt: NOW - 1}), /receipt-from-future/);
  const decision = checkSelection({...requestOf(value), now: NOW - 1});
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 'unknown');
});

test('a future-dated selection receipt is rejected even when all evaluations already existed', () => {
  const value = fixture(); const receipt = receiptOf(value, {createdAt: NOW + 500});
  const decision = checkSelection(requestOf(value, receipt));
  assert.equal(decision.status, 'deny');
  assert.ok(reason(decision, 'selection-receipt-from-future'));
});

test('reading recomputes saved rank values, ordering, chosen ID and chosen model', () => {
  const value = fixture();
  for (const mutate of [
    r => {r.ranking.reverse();},
    r => {r.ranking[0].value = -1;},
    r => {r.selectedCandidateId = 'candidate-a';},
    r => {r.selectedModelRef = copy(value.results[0].modelRef);},
  ]) {
    const offered = copy(receiptOf(value)); mutate(offered);
    assert.throws(() => readSelectionReceipt(offered), /ranking|winner|selected model/);
    assert.equal(checkSelection(requestOf(value, offered)).allowed, false);
  }
});

test('fresh runtime handles and artifact locations do not change content-based selection coverage', () => {
  const value = fixture(), receipt = receiptOf(value);
  const proposed = copy(value.results[1].modelRef); proposed.sessionId = 'fresh'; proposed.handle = 88;
  proposed.originArtifact.path = 'restored/same.npz';
  const expected = copy(value); expected.manifest.comparison.datasetRef.sessionId = 'fresh';
  expected.manifest.comparison.datasetRef.handle = 89;
  expected.manifest.comparison.datasetRef.artifact.path = 'moved/validation.npz';
  assert.equal(checkSelection({...requestOf(expected, receipt), modelRef: proposed}).allowed, true);
});

test('SHA hex casing is immaterial for known model, checkpoint, inference and dataset identities', () => {
  const value = fixture(), changed = copy(value);
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    if (item.kind === 'artifact' || item.kind === 'inference-identity') item.sha256 = item.sha256.toUpperCase();
    for (const child of Object.values(item)) visit(child);
  };
  visit(changed);
  const decision = checkSelection(requestOf(value, receiptOf(changed)));
  assert.equal(decision.allowed, true);
});

test('v2 accepts a different training checkpoint only when the proposed inference identity still matches', () => {
  const value = fixture(), proposed = copy(value.results[1].modelRef);
  proposed.originArtifact = artifact('3');
  assert.equal(checkSelection({...requestOf(value), modelRef: proposed}).allowed, true);
  proposed.inferenceIdentity.profile = 'different-profile/v1';
  assert.equal(checkSelection({...requestOf(value), modelRef: proposed}).allowed, false);
  delete proposed.inferenceIdentity;
  assert.equal(checkSelection({...requestOf(value), modelRef: proposed}).status, 'unknown');
});

test('v1 preserves checkpoint coverage and cannot gain inference-only coverage after a checkpoint change', () => {
  const value = fixture();
  value.results = value.results.map(result => {
    const modelRef = copy(result.modelRef); delete modelRef.inferenceIdentity;
    const evaluation = createEvaluationReceipt({modelRef, ...value.manifest.comparison,
      evaluationId: result.evaluation.evaluationId, createdAt: NOW, metrics: result.evaluation.metrics});
    return {...result, modelRef, evaluation};
  });
  const receipt = receiptOf(value);
  assert.equal(checkSelection(requestOf(value, receipt)).allowed, true);
  const proposed = copy(value.results[1].modelRef); proposed.originArtifact = artifact('3');
  assert.equal(checkSelection({...requestOf(value, receipt), modelRef: proposed}).allowed, false);
});

test('a rewritten v1 receipt cannot silently downgrade independently retained v2 observations', () => {
  const expected = fixture(), downgraded = copy(expected);
  downgraded.results = downgraded.results.map(result => {
    const modelRef = copy(result.modelRef); delete modelRef.inferenceIdentity;
    return {...result, modelRef, evaluation: createEvaluationReceipt({modelRef, ...downgraded.manifest.comparison,
      evaluationId: result.evaluation.evaluationId, createdAt: NOW, metrics: result.evaluation.metrics})};
  });
  const decision = checkSelection(requestOf(expected, receiptOf(downgraded)));
  assert.equal(decision.allowed, false);
  assert.ok(reason(decision, 'selection-results-mismatch'));
});

test('missing evidence, unsupported tie policies and unknown fields fail closed', () => {
  for (const patch of [{manifest: null}, {results: []}, {receipt: null}, {modelRef: null}, {now: NaN}])
    assert.equal(checkSelection({...requestOf(), ...patch}).allowed, false);
  const value = fixture(); delete value.manifest.policy.tieBreak;
  assert.throws(() => receiptOf(value), /explicit/);
  const duplicate = fixture(); duplicate.manifest.candidates[1].candidateId = duplicate.manifest.candidates[0].candidateId;
  assert.throws(() => readSelectionManifest(duplicate.manifest), /unique/);
  const added = copy(receiptOf()); added.hiddenEligibility = {omitLosers: true};
  assert.equal(checkSelection(requestOf(fixture(), added)).allowed, false);
});

test('accessors and executable configuration are rejected without invoking a getter', () => {
  const value = fixture(); let invoked = false;
  Object.defineProperty(value.manifest.candidates[0].configuration, 'trigger', {enumerable: true, get() {invoked = true; return 1;}});
  assert.throws(() => receiptOf(value), /accessor/);
  assert.equal(invoked, false);
});

test('selection success is separate from the application quality threshold', () => {
  const value = fixture(), receipt = receiptOf(value);
  assert.equal(checkSelection(requestOf(value, receipt)).allowed, true);
  const release = checkRelease({modelRef: value.results[1].modelRef, ...value.manifest.comparison,
    receipt: value.results[1].evaluation, policy: {metric: 'mse', operator: 'lte', threshold: 0.001}, now: NOW + 20});
  assert.equal(release.allowed, false);
});

test('experiment runner executes frozen declarations sequentially in canonical ID order', async () => {
  const value = fixture(); value.manifest.candidates.reverse();
  const calls = [], hooks = []; let active = 0, maxActive = 0;
  const results = await runExperiment({manifest: value.manifest, now: NOW + 10,
    async executeCandidate(candidate, context) {
      assert.ok(Object.isFrozen(candidate.configuration)); assert.ok(Object.isFrozen(context.datasetRef.artifact));
      active++; maxActive = Math.max(maxActive, active); calls.push(candidate.candidateId);
      await Promise.resolve(); active--;
      return value.results.find(result => result.candidateId === candidate.candidateId);
    },
    onResult(result, index) {assert.ok(Object.isFrozen(result.evaluation)); hooks.push([result.candidateId, index]);},
  });
  assert.deepEqual(calls, ['candidate-a', 'candidate-b', 'candidate-c']);
  assert.equal(maxActive, 1); assert.equal(results.length, 3); assert.ok(Object.isFrozen(results));
  assert.deepEqual(hooks, calls.map((id, index) => [id, index]));
  assert.equal(checkSelection(requestOf({...value, results}, receiptOf({...value, results}))).allowed, true);
});

test('a wrong candidate/configuration callback aborts before any successful partial experiment returns', async () => {
  const value = fixture(); let calls = 0, hooks = 0;
  await assert.rejects(runExperiment({manifest: value.manifest, now: NOW + 10,
    executeCandidate() {calls++; return value.results[1];}, onResult() {hooks++;}}), /identifier\/configuration/);
  assert.equal(calls, 1); assert.equal(hooks, 0);
});

test('a later backend failure preserves progress notifications but returns no complete selection', async () => {
  const value = fixture(), completed = []; let calls = 0;
  await assert.rejects(runExperiment({manifest: value.manifest, now: NOW + 10,
    executeCandidate(candidate) {if (++calls === 2) throw new Error('backend unavailable');
      return value.results.find(result => result.candidateId === candidate.candidateId);},
    onResult(result) {completed.push(result.modelRef);}}), /backend unavailable/);
  assert.equal(calls, 2); assert.equal(completed.length, 1);
  assert.throws(() => receiptOf({...value, results: value.results.slice(0, 1)}), /Exactly one result/);
});

test('invalid runner hooks, future callback results and failing progress hooks abort', async () => {
  const value = fixture();
  await assert.rejects(runExperiment({manifest: value.manifest, executeCandidate: null}), /executeCandidate/);
  await assert.rejects(runExperiment({manifest: value.manifest, executeCandidate() {}, onResult: 3}), /onResult/);
  await assert.rejects(runExperiment({manifest: value.manifest, now: NOW - 1,
    executeCandidate(candidate) {return value.results.find(r => r.candidateId === candidate.candidateId);}}), /receipt-from-future/);
  let calls = 0;
  await assert.rejects(runExperiment({manifest: value.manifest, now: NOW + 10,
    executeCandidate(candidate) {calls++; return value.results.find(r => r.candidateId === candidate.candidateId);},
    onResult() {throw new Error('provenance storage unavailable');}}), /provenance storage unavailable/);
  assert.equal(calls, 1);
});
