import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createEvaluationReceipt, createSelectionReceipt, createDataLineageReceipt,
  prepareModelRelease, publishModelRelease, releaseModel, readModelReleasePlan} from '../dist/index.js';

// Synthetic byte/receipt fixtures test the boundary contracts, not numerical correctness.
const NOW = 1_800_000_000_000;
const copy = value => structuredClone(value);
const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const reason = (result, code) => result.reasons.some(item => item.code === code);
async function fixture() {
  const data = new Map();
  const store = {
    async put(bytes, {format}) {
      const snapshot = new Uint8Array(bytes), sha256 = digest(snapshot), path = `cas/${sha256}/${format}`;
      data.set(path, snapshot);
      return {kind: 'artifact', path, sha256, bytes: snapshot.length, format};
    },
    async read(ref) {const bytes = data.get(ref.path); if (!bytes) throw new Error('Artifact not found'); return new Uint8Array(bytes);},
    async putJson(value, format = 'application/json') {return this.put(encode(value), {format});},
  };
  const bytesA = encode('immutable synthetic checkpoint A'), bytesB = encode('immutable synthetic checkpoint B');
  const artifactA = await store.put(bytesA, {format: 'checkpoint-fixture/v1'});
  const artifactB = await store.put(bytesB, {format: 'checkpoint-fixture/v1'});
  const datasetRef = {kind: 'dataset', sessionId: 'worker-original', handle: 1, rows: 2, shape: [2, 1], role: 'validation',
    artifact: await store.put(encode('validation examples'), {format: 'dataset-fixture/v1'})};
  const models = [artifactA, artifactB].map((originArtifact, index) => ({kind: 'model', sessionId: 'worker-original',
    handle: index + 2, originArtifact, inferenceIdentity: {kind: 'inference-identity', schemaVersion: 1,
      profile: 'fixture-complete-inference/v1', sha256: ['a', 'b'][index].repeat(64)}}));
  const manifest = {kind: 'selection-manifest', schemaVersion: 1, experimentId: 'pinned-experiment',
    candidates: [{candidateId: 'candidate-a', configuration: {updates: 30}}, {candidateId: 'candidate-b', configuration: {updates: 100}}],
    comparison: {datasetRef, preprocessingVersion: 'raw/v1', evaluationMethodVersion: 'mse/original-units/v1', parameters: {}},
    policy: {metric: 'mse', direction: 'min', tieBreak: 'candidate-id-ascending'}};
  const results = models.map((modelRef, i) => ({...manifest.candidates[i], modelRef,
    evaluation: createEvaluationReceipt({modelRef, ...manifest.comparison,
      evaluationId: 'evaluation-' + i, createdAt: NOW, metrics: {mse: [0.04, 0.01][i]}})}));
  const selectionReceipt = createSelectionReceipt({selectionId: 'selection-1', createdAt: NOW + 5, manifest, results});
  const plan = {kind: 'model-release-plan', schemaVersion: 1, releaseId: 'release-1', idempotencyKey: 'publication-1',
    target: {name: 'production', expectedRevision: null}, modelArtifact: artifactB,
    manifestRef: await store.putJson(manifest), resultsRef: await store.putJson(results),
    selectionReceiptRef: await store.putJson(selectionReceipt), qualityPolicy: {metric: 'mse', operator: 'lte', threshold: 0.02}};
  const f = {store, data, bytesA, bytesB, models, manifest, results, selectionReceipt, plan,
    planRef: await store.putJson(plan), verifications: 0,
    live: new Map(models.map(model => [model.sessionId + ':' + model.handle, model]))};
  f.verifyModel = async ({modelRef}) => {
    f.verifications++;
    const actual = f.live.get(modelRef.sessionId + ':' + modelRef.handle);
    if (!actual) throw new Error('Model is not registered in the current backend');
    return copy(actual);
  };
  f.input = (modelRef = models[1], now = NOW + 10) => ({planRef: f.planRef, modelRef, store, verifyModel: f.verifyModel, now});
  f.changePlan = async mutate => {f.plan = copy(f.plan); mutate(f.plan); f.planRef = await store.putJson(f.plan);};
  return f;
}
function receiver() {
  const publications = [], targets = new Map(), keys = new Map(), requests = [];
  return {publications, requests, targets,
    async lookup(input) {
      const old = keys.get(input.payload.idempotencyKey);
      if (!old) return null;
      return old.payloadSha256 === input.payloadSha256
        ? {allowed: true, status: 'already-published', reasons: [], receipt: copy(old)}
        : {allowed: false, status: 'deny', reasons: [{code: 'idempotency-conflict', message: 'Key already binds another payload'}], receipt: null};
    },
    async publish(input) {
      requests.push(input);
      const bytes = new Uint8Array(input.modelBytes);
      if (digest(bytes) !== input.payload.artifact.sha256 || bytes.length !== input.payload.artifact.bytes)
        return {allowed: false, status: 'deny', reasons: [{code: 'model-artifact-mismatch', message: 'Wrong receiver bytes'}], receipt: null};
      const old = keys.get(input.payload.idempotencyKey);
      if (old) return old.payloadSha256 === input.payloadSha256
        ? {allowed: true, status: 'already-published', reasons: [], receipt: copy(old)}
        : {allowed: false, status: 'deny', reasons: [{code: 'idempotency-conflict', message: 'Key already binds another payload'}], receipt: null};
      if ((targets.get(input.payload.target.name) ?? null) !== input.payload.target.expectedRevision)
        return {allowed: false, status: 'deny', reasons: [{code: 'target-revision-conflict', message: 'Revision changed'}], receipt: null};
      const receipt = {kind: 'model-publication-receipt', schemaVersion: 1,
        releaseId: input.payload.releaseId, idempotencyKey: input.payload.idempotencyKey,
        targetName: input.payload.target.name, revision: input.payloadSha256, payloadSha256: input.payloadSha256,
        artifact: {kind: 'artifact', path: 'installed/' + digest(bytes), ...input.payload.artifact},
        preparedRef: copy(input.preparedRef), committedAt: NOW + 10};
      publications.push({receipt: copy(receipt), bytes}); keys.set(receipt.idempotencyKey, receipt);
      targets.set(receipt.targetName, receipt.revision);
      return {allowed: true, status: 'published', reasons: [], receipt};
    }};
}
async function prepared(f) {
  const result = await prepareModelRelease(f.input());
  assert.equal(result.allowed, true, JSON.stringify(result.reasons));
  assert.ok(result.preparedRef); return result;
}

test('preparation pins exact evidence and composes selection/quality over a live-verified winner', async () => {
  const f = await fixture(), result = await prepared(f);
  assert.equal(result.decision.kind, 'model-release-decision');
  assert.equal(result.record.qualityDecision.allowed, true);
  assert.equal(result.record.selectionDecision.allowed, true);
  assert.equal(result.record.lineageDecision, null);
  assert.equal(result.record.payload.artifact.sha256, f.plan.modelArtifact.sha256);
  assert.equal(result.record.payload.candidateId, 'candidate-b');
  assert.equal(f.verifications, 1);
  assert.ok(Object.isFrozen(result.record.payload.evidence));
  assert.ok(!JSON.stringify(result.record.payload).includes('worker-original'));
  assert.equal(result.record.payload.validUntil, null);
});

test('publication freshly verifies and consumes approved bytes rather than a model file path', async () => {
  const f = await fixture(), before = await prepared(f), publisher = receiver();
  const result = await publishModelRelease({...f.input(), preparedRef: before.preparedRef, publisher});
  assert.equal(result.status, 'published'); assert.equal(result.allowed, true);
  assert.equal(f.verifications, 2);
  assert.deepEqual(publisher.publications[0].bytes, f.bytesB);
  assert.equal(publisher.requests.length, 1);
  assert.equal(publisher.requests[0].modelBytes instanceof Uint8Array, true);
});

test('a valid worse model cannot prepare or replace the proposed winner before publication', async () => {
  const f = await fixture();
  assert.equal((await prepareModelRelease(f.input(f.models[0]))).allowed, false);
  const approved = await prepared(f), publisher = receiver();
  const swapped = await publishModelRelease({...f.input(f.models[0]), preparedRef: approved.preparedRef, publisher});
  assert.equal(swapped.status, 'deny'); assert.equal(publisher.requests.length, 0);
});

test('a changed model hidden behind the old handle is refused after preparation', async () => {
  const f = await fixture(), approved = await prepared(f), publisher = receiver();
  f.live.set('worker-original:3', {...copy(f.models[0]), handle: 3});
  const result = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher});
  assert.equal(result.allowed, false); assert.ok(reason(result, 'release-live-model-mismatch'));
  assert.equal(publisher.requests.length, 0);
});

test('a verifier cannot substitute another runtime handle even for the same durable model', async () => {
  const f = await fixture();
  const result = await prepareModelRelease({...f.input(), verifyModel: async () => ({...f.models[1], handle: 999})});
  assert.equal(result.allowed, false); assert.ok(reason(result, 'release-live-model-mismatch'));
});

test('the store must supply actual measured JSON bytes, not repeat expected digest metadata', async () => {
  const f = await fixture(); f.data.set(f.plan.manifestRef.path, encode({...f.manifest, experimentId: 'rewritten'}));
  const result = await prepareModelRelease(f.input());
  assert.equal(result.status, 'deny'); assert.ok(reason(result, 'release-artifact-mismatch'));
  assert.equal(f.verifications, 0);
});

test('model bytes swapped under the approved artifact ref are refused at publication', async () => {
  const f = await fixture(), approved = await prepared(f), publisher = receiver();
  const store = {...f.store, async read(ref) {return ref.sha256 === f.plan.modelArtifact.sha256 ? copy(f.bytesA) : f.store.read(ref);}};
  const result = await publishModelRelease({...f.input(), store, preparedRef: approved.preparedRef, publisher});
  assert.equal(result.status, 'deny'); assert.equal(publisher.requests.length, 0);
});

test('a transport-side byte swap is refused by a receiver that measures its own input', async () => {
  const f = await fixture(), approved = await prepared(f), destination = receiver();
  const publisher = {publish: request => destination.publish({...request, modelBytes: f.bytesA})};
  const result = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher});
  assert.equal(result.status, 'deny'); assert.equal(destination.publications.length, 0);
});

test('rewriting a plan under its old pinned ref cannot authorize a release', async () => {
  const f = await fixture(), approved = await prepared(f), publisher = receiver();
  f.data.set(f.planRef.path, encode({...f.plan, releaseId: 'rewritten'}));
  const result = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher});
  assert.equal(result.status, 'deny'); assert.equal(publisher.requests.length, 0);
});

test('a new authority plan requires its own matching preparation', async () => {
  const f = await fixture(), approved = await prepared(f), publisher = receiver();
  await f.changePlan(plan => {plan.releaseId = 'different-plan';});
  const result = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher});
  assert.equal(result.status, 'deny'); assert.ok(reason(result, 'release-plan-mismatch'));
  assert.equal(publisher.requests.length, 0);
});

test('a newly hashed forged preparation cannot change approved payload claims', async () => {
  const f = await fixture(), approved = await prepared(f), publisher = receiver();
  const forged = copy(approved.record); forged.payload.candidateId = 'candidate-a';
  const preparedRef = await f.store.putJson(forged);
  const result = await publishModelRelease({...f.input(), preparedRef, publisher});
  assert.equal(result.status, 'deny'); assert.equal(publisher.requests.length, 0);
});

test('forged archived guard details are reconstructed instead of trusted as an allowed flag', async () => {
  const f = await fixture(), approved = await prepared(f), publisher = receiver();
  const forged = copy(approved.record); forged.qualityDecision.receiptId = 'invented-evaluation';
  const preparedRef = await f.store.putJson(forged);
  const result = await publishModelRelease({...f.input(), preparedRef, publisher});
  assert.equal(result.status, 'deny'); assert.ok(reason(result, 'release-preparation-mismatch'));
  assert.equal(publisher.requests.length, 0);
});

test('required lineage cannot be omitted or replaced with an unknown observation', async () => {
  const f = await fixture();
  const splitManifest = await f.store.putJson({training: ['t1'], validation: ['v1']});
  const train = {...copy(f.manifest.comparison.datasetRef), role: 'train'};
  await f.changePlan(plan => {plan.lineage = {required: true, splitManifest, policy: {trainingDatasetRef: train}};});
  const result = await prepareModelRelease(f.input());
  assert.equal(result.status, 'deny'); assert.ok(reason(result, 'release-lineage-required'));
});

test('required data lineage is loaded from pinned bytes and participates in the joint gate', async () => {
  const f = await fixture();
  const splitManifest = await f.store.putJson({training: ['t1'], validation: ['v1']});
  const train = {...copy(f.manifest.comparison.datasetRef), role: 'train',
    artifact: await f.store.put(encode('training examples'), {format: 'dataset-fixture/v1'})};
  const evidenceArtifact = await f.store.putJson({trainEvaluationRows: 0, preprocessingEvaluationRows: 0});
  const preprocessingArtifact = await f.store.put(encode('fitted preprocessing'), {format: 'preprocessing-fixture/v1'});
  const lineage = createDataLineageReceipt({lineageId: 'lineage-1', createdAt: NOW, modelRef: f.models[1],
    datasetRef: f.manifest.comparison.datasetRef, splitManifest, trainingDatasetRef: train,
    overlap: {evidenceArtifact, trainEvaluationRows: 0, preprocessingEvaluationRows: 0},
    preprocessing: {artifact: preprocessingArtifact, fitDatasetRefs: [train]}});
  const receiptRef = await f.store.putJson(lineage);
  await f.changePlan(plan => {plan.lineage = {required: true, splitManifest, receiptRef, policy: {trainingDatasetRef: train}};});
  const result = await prepareModelRelease(f.input());
  assert.equal(result.allowed, true); assert.equal(result.record.lineageDecision.allowed, true);
  const bad = copy(lineage); bad.overlap.preprocessingEvaluationRows = 1;
  const badRef = await f.store.putJson(bad);
  await f.changePlan(plan => {plan.lineage.receiptRef = badRef;});
  const refused = await prepareModelRelease(f.input());
  assert.equal(refused.status, 'deny'); assert.ok(reason(refused, 'release-lineage-failed'));
});

test('an approval that expires after preparation is rechecked before publication', async () => {
  const f = await fixture(); await f.changePlan(plan => {plan.qualityPolicy.maxAgeMs = 100;});
  const approved = await prepared(f), publisher = receiver();
  assert.equal(approved.record.payload.validUntil, NOW + 100);
  const result = await publishModelRelease({...f.input(f.models[1], NOW + 101), preparedRef: approved.preparedRef, publisher});
  assert.equal(result.status, 'deny'); assert.equal(publisher.requests.length, 0);
});

test('lost acknowledgement remains unknown until a same-payload retry returns the original publication', async () => {
  const f = await fixture(), approved = await prepared(f), destination = receiver(); let lose = true;
  const publisher = {async publish(request) {const response = await destination.publish(request);
    if (lose) {lose = false; throw new Error('Acknowledgement lost after the durable side effect');} return response;}};
  const first = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher});
  assert.equal(first.status, 'unknown'); assert.equal(first.allowed, false); assert.equal(destination.publications.length, 1);
  const newModel = {...copy(f.models[1]), sessionId: 'worker-restarted', handle: 40};
  f.live.set('worker-restarted:40', newModel);
  const retried = await publishModelRelease({...f.input(newModel, NOW + 30), preparedRef: approved.preparedRef, publisher});
  assert.equal(retried.status, 'already-published'); assert.equal(retried.allowed, true);
  assert.equal(destination.publications.length, 1);
  assert.deepEqual(retried.publisherReceipt, destination.publications[0].receipt);
  assert.deepEqual(retried.preparedRef, approved.preparedRef);
  assert.equal(retried.record.modelRef.sessionId, 'worker-original');
  assert.equal(retried.decision.bindings.modelRef.sessionId, 'worker-restarted');
});

test('convenience retries use stable semantic payloads and preserve the original prepared reference', async () => {
  const f = await fixture(), publisher = receiver();
  const first = await releaseModel({...f.input(), publisher});
  const second = await releaseModel({...f.input(f.models[1], NOW + 40), publisher});
  assert.equal(first.status, 'published'); assert.equal(second.status, 'already-published');
  assert.deepEqual(second.preparedRef, first.preparedRef);
  assert.equal(second.record.preparedAt, first.record.preparedAt);
  assert.equal(second.decision.checkedAt, NOW + 40);
  assert.equal(publisher.publications.length, 1);
});

test('same idempotency key with another authorized payload is refused, leaving the original publication intact', async () => {
  const f = await fixture(), publisher = receiver();
  const first = await releaseModel({...f.input(), publisher}); assert.equal(first.allowed, true);
  await f.changePlan(plan => {plan.releaseId = 'different-release'; plan.target.name = 'different-target';});
  const conflict = await releaseModel({...f.input(), publisher});
  assert.equal(conflict.status, 'deny'); assert.equal(publisher.publications.length, 1);
});

test('a new key does not override the target conditional-version rule', async () => {
  const f = await fixture(), publisher = receiver();
  assert.equal((await releaseModel({...f.input(), publisher})).allowed, true);
  await f.changePlan(plan => {plan.idempotencyKey = 'another-key'; plan.releaseId = 'another-release';});
  assert.equal((await releaseModel({...f.input(), publisher})).status, 'deny');
  assert.equal(publisher.publications.length, 1);
});

test('the preparation writer cannot replace the record while returning a valid hash of different bytes', async () => {
  const f = await fixture();
  const original = f.store.put.bind(f.store);
  const store = {...f.store, async put(bytes, options) {
    return original(options.format.includes('prepared-model-release') ? encode({invented: true}) : bytes, options);
  }};
  const result = await prepareModelRelease({...f.input(), store});
  assert.equal(result.status, 'deny'); assert.ok(reason(result, 'release-artifact-mismatch'));
});

test('v0.5 exact-artifact plans do not silently authorize an optimizer-only checkpoint fork', async () => {
  const f = await fixture(), forkArtifact = await f.store.put(encode('different training checkpoint'), {format: 'checkpoint-fixture/v1'});
  const fork = {...copy(f.models[1]), originArtifact: forkArtifact};
  f.live.set('worker-original:3', fork);
  const result = await prepareModelRelease(f.input(fork));
  assert.equal(result.status, 'deny'); assert.ok(reason(result, 'release-checkpoint-mismatch'));
});

test('unavailable verification, invalid plan schemas and publisher confirmations fail closed', async () => {
  const f = await fixture();
  assert.throws(() => readModelReleasePlan({...f.plan, selectionAuthority: 'receipt-only'}), /unsupported/);
  const absent = await prepareModelRelease({...f.input(), verifyModel: undefined});
  assert.equal(absent.allowed, false);
  const approved = await prepared(f), destination = receiver();
  const publisher = {async publish(request) {const result = await destination.publish(request);
    result.receipt.artifact.sha256 = 'f'.repeat(64); return result;}};
  const invalid = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher});
  assert.equal(invalid.allowed, false); assert.ok(reason(invalid, 'model-publisher-receipt-mismatch'));
});

test('an existing exact publication is acknowledged after expiry without another live check or write', async () => {
  const f = await fixture(); await f.changePlan(plan => {plan.qualityPolicy.maxAgeMs = 100;});
  const approved = await prepared(f), publisher = receiver();
  const first = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher});
  assert.equal(first.status, 'published');
  const verifications = f.verifications;
  const recovered = await publishModelRelease({planRef: f.planRef, store: f.store, preparedRef: approved.preparedRef,
    publisher, now: NOW + 1000});
  assert.equal(recovered.status, 'already-published'); assert.equal(recovered.allowed, true);
  assert.equal(recovered.decision.basis, 'historical-acknowledgement');
  assert.ok(reason(recovered, 'historical-publication-confirmed'));
  assert.equal(recovered.decision.checkedAt, NOW + 1000);
  assert.equal(recovered.decision.checks.quality.checkedAt, NOW + 10);
  assert.equal(f.verifications, verifications); assert.equal(publisher.requests.length, 1);
  assert.deepEqual(recovered.publisherReceipt, first.publisherReceipt);
});

test('an expired preparation with no existing effect cannot create a publication, even without a backend', async () => {
  const f = await fixture(); await f.changePlan(plan => {plan.qualityPolicy.maxAgeMs = 100;});
  const approved = await prepared(f), publisher = receiver();
  const result = await publishModelRelease({planRef: f.planRef, store: f.store, preparedRef: approved.preparedRef,
    publisher, now: NOW + 1000});
  assert.equal(result.status, 'deny'); assert.ok(reason(result, 'release-approval-expired'));
  assert.equal(publisher.publications.length, 0); assert.equal(publisher.requests.length, 0);
});

test('a forged existing-effect acknowledgement is refused before calling the new-publication port', async () => {
  const f = await fixture(), approved = await prepared(f), destination = receiver();
  const first = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher: destination});
  assert.equal(first.status, 'published');
  const fake = copy(first.publisherReceipt); fake.artifact.sha256 = 'f'.repeat(64);
  let writes = 0;
  const publisher = {lookup: async () => ({allowed: true, status: 'already-published', reasons: [], receipt: fake}),
    async publish() {writes++; throw new Error('This must not run');}};
  const result = await publishModelRelease({planRef: f.planRef, store: f.store, preparedRef: approved.preparedRef, publisher, now: NOW + 30});
  assert.equal(result.allowed, false); assert.ok(reason(result, 'model-publisher-receipt-mismatch'));
  assert.equal(writes, 0);
});

test('unconfirmed or future-dated lookups never fall through into a new publication', async () => {
  const f = await fixture(), approved = await prepared(f); let writes = 0;
  const publisher = {async lookup() {throw new Error('Acknowledgement service unavailable');},
    async publish() {writes++; throw new Error('No fallback write is authorized');}};
  const unavailable = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher});
  assert.equal(unavailable.status, 'unknown'); assert.equal(writes, 0);
  const destination = receiver();
  const first = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher: destination});
  const future = copy(first.publisherReceipt); future.committedAt = NOW + 500;
  const falselyFuture = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef,
    publisher: {...publisher, lookup: async () => ({allowed: true, status: 'already-published', reasons: [], receipt: future})}});
  assert.equal(falselyFuture.allowed, false); assert.equal(writes, 0);
});

test('historical acknowledgement never approves a supplied different model or rolls back a newer target', async () => {
  const f = await fixture(), approved = await prepared(f), publisher = receiver(), originalPlanRef = f.planRef;
  const first = await publishModelRelease({...f.input(), preparedRef: approved.preparedRef, publisher});
  const swapped = await publishModelRelease({...f.input(f.models[0]), preparedRef: approved.preparedRef, publisher});
  assert.equal(swapped.allowed, false); assert.ok(reason(swapped, 'release-proposal-mismatch'));
  await f.changePlan(plan => {plan.releaseId = 'release-2'; plan.idempotencyKey = 'publication-2'; plan.target.expectedRevision = first.publisherReceipt.revision;});
  const newer = await releaseModel({...f.input(), publisher}); assert.equal(newer.status, 'published');
  const historical = await publishModelRelease({planRef: originalPlanRef, preparedRef: approved.preparedRef,
    store: f.store, publisher, now: NOW + 1000});
  assert.equal(historical.status, 'already-published');
  assert.equal(historical.publisherReceipt.revision, first.publisherReceipt.revision);
  assert.equal(publisher.targets.get('production'), newer.publisherReceipt.revision);
  assert.equal(publisher.publications.length, 2);
});

test('the convenience API can recover a retained preparation after expiry without a live backend', async () => {
  const f = await fixture(); await f.changePlan(plan => {plan.qualityPolicy.maxAgeMs = 100;});
  const publisher = receiver(), first = await releaseModel({...f.input(), publisher});
  const recovered = await releaseModel({planRef: f.planRef, preparedRef: first.preparedRef, store: f.store,
    publisher, now: NOW + 1000});
  assert.equal(recovered.status, 'already-published'); assert.equal(publisher.publications.length, 1);
  assert.deepEqual(recovered.preparedRef, first.preparedRef);
});

// Synthetic paired observations isolate the release boundary from numerical evaluation.
async function regressionFixture({candidateMse = 0.01, maxAgeMs} = {}) {
  const f = await fixture(), comparison = f.manifest.comparison;
  const manifest = {kind: 'regression-manifest', schemaVersion: 1, comparisonId: 'predeclared-group-comparison',
    baselineModelRef: f.models[0], candidateModelRef: f.models[1], comparison,
    groups: [{groupId: 'declared-group', definitionRef: await f.store.putJson({where: 'all fixture rows'}),
      membershipRef: await f.store.putJson([0, 1]), datasetRef: comparison.datasetRef, expectedRows: 2}],
    policies: [{groupId: 'declared-group', metric: 'mse', direction: 'min', maxDeterioration: 0, minSamples: 2}],
    ...(maxAgeMs === undefined ? {} : {maxAgeMs})};
  const observations = [{groupId: 'declared-group', definitionRef: manifest.groups[0].definitionRef,
    membershipRef: manifest.groups[0].membershipRef, rows: 2,
    baseline: createEvaluationReceipt({modelRef: f.models[0], ...comparison, evaluationId: 'baseline-group',
      createdAt: NOW - 20, metrics: {mse: 0.04}}),
    candidate: createEvaluationReceipt({modelRef: f.models[1], ...comparison, evaluationId: 'candidate-group',
      createdAt: NOW, metrics: {mse: candidateMse}})}];
  const {createRegressionReceipt} = await import('../dist/index.js');
  const receipt = createRegressionReceipt({regressionId: 'paired-group-evaluation', createdAt: NOW + 1, manifest, observations});
  const manifestRef = await f.store.putJson(manifest), observationsRef = await f.store.putJson(observations),
    receiptRef = await f.store.putJson(receipt);
  await f.changePlan(plan => {plan.regression = {manifestRef, observationsRef, receiptRef};});
  return Object.assign(f, {regressionManifest: manifest, regressionObservations: observations, regressionReceipt: receipt});
}

test('required group regression blocks an overall winner before a publisher is called', async () => {
  const f = await regressionFixture({candidateMse: 0.06}), publisher = receiver();
  const result = await releaseModel({...f.input(), publisher});
  assert.equal(result.status, 'deny'); assert.equal(result.decision.checks.selection.allowed, true);
  assert.equal(result.decision.checks.quality.allowed, true); assert.equal(result.decision.checks.regression.allowed, false);
  assert.ok(reason(result, 'release-regression-failed')); assert.equal(publisher.requests.length, 0);
});

test('passing regression evidence is loaded, bound in the semantic payload and repeated before publication', async () => {
  const f = await regressionFixture(), prepared = await prepareModelRelease(f.input());
  assert.equal(prepared.allowed, true, JSON.stringify(prepared.reasons));
  assert.equal(prepared.record.regressionDecision.allowed, true);
  for (const [key, ref] of [['regressionManifest', 'manifestRef'], ['regressionObservations', 'observationsRef'], ['regressionReceipt', 'receiptRef']])
    assert.equal(prepared.record.payload.evidence[key].sha256, f.plan.regression[ref].sha256);
  const publisher = receiver();
  const result = await publishModelRelease({...f.input(), preparedRef: prepared.preparedRef, publisher});
  assert.equal(result.status, 'published'); assert.equal(publisher.requests.length, 1);
  assert.equal(publisher.requests[0].payload.evidence.regressionReceipt.sha256, f.plan.regression.receiptRef.sha256);
  const retry = await publishModelRelease({planRef: f.planRef, store: f.store, preparedRef: prepared.preparedRef, publisher, now: NOW + 100_000});
  assert.equal(retry.status, 'already-published'); assert.equal(publisher.requests.length, 1);
});

test('required but missing regression receipt or observations cannot authorize publication', async () => {
  const f = await regressionFixture();
  await f.changePlan(plan => {delete plan.regression.receiptRef;});
  const missing = await prepareModelRelease(f.input());
  assert.equal(missing.status, 'unknown'); assert.equal(missing.allowed, false);
  assert.equal(missing.decision.checks.regression.status, 'unknown');
  const g = await regressionFixture();
  const incomplete = await g.store.putJson([]);
  await g.changePlan(plan => {plan.regression.observationsRef = incomplete;});
  assert.equal((await prepareModelRelease(g.input())).allowed, false);
});

test('the release measures required group definitions, membership and dataset bytes', async () => {
  for (const field of ['definitionRef', 'membershipRef', 'datasetRef']) {
    const f = await regressionFixture(), group = f.regressionManifest.groups[0];
    const reference = field === 'datasetRef' ? group.datasetRef.artifact : group[field];
    f.data.set(reference.path, encode('swapped bytes'));
    const result = await prepareModelRelease(f.input());
    assert.equal(result.status, 'deny'); assert.ok(reason(result, 'release-artifact-mismatch'));
  }
});

test('regression baseline age constrains publication even when quality evidence is newer', async () => {
  const f = await regressionFixture({maxAgeMs: 100}), prepared = await prepareModelRelease(f.input());
  assert.equal(prepared.allowed, true); assert.equal(prepared.record.payload.validUntil, NOW + 80);
  const publisher = receiver();
  const result = await publishModelRelease({...f.input(f.models[1], NOW + 81), preparedRef: prepared.preparedRef, publisher});
  assert.equal(result.status, 'deny'); assert.ok(reason(result, 'release-approval-expired'));
  assert.equal(publisher.requests.length, 0);
});

test('a changed independent regression plan or observation cannot reuse an approved preparation', async () => {
  const f = await regressionFixture(), prepared = await prepareModelRelease(f.input());
  const changed = copy(f.regressionObservations); changed[0].candidate.metrics.mse = 0.06;
  const changedRef = await f.store.putJson(changed);
  await f.changePlan(plan => {plan.regression.observationsRef = changedRef;});
  const publisher = receiver(), result = await publishModelRelease({...f.input(), preparedRef: prepared.preparedRef, publisher});
  assert.equal(result.status, 'deny'); assert.equal(publisher.requests.length, 0);
});

test('a required regression declaration cannot opt itself out with unsupported fields', async () => {
  const f = await regressionFixture();
  assert.throws(() => readModelReleasePlan({...f.plan, regression: {...f.plan.regression, required: false}}));
  const {readModelPublicationPayload} = await import('../dist/release.js');
  const prepared = await prepareModelRelease(f.input());
  const payload = copy(prepared.record.payload); delete payload.evidence.regressionObservations;
  assert.throws(() => readModelPublicationPayload(payload));
});

test('legacy plans keep their original preparation shape for historical reconstruction', async () => {
  const f = await fixture(), result = await prepareModelRelease(f.input());
  assert.equal(Object.hasOwn(result.record, 'regressionDecision'), false);
  assert.equal(Object.hasOwn(result.record.decision.checks, 'regression'), false);
  assert.equal(Object.hasOwn(result.record.payload.evidence, 'regressionReceipt'), false);
});
