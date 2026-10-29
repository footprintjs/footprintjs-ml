import test from 'node:test';
import assert from 'node:assert/strict';
import { openAdapterWorkflowRun } from '../lens/session.mjs';

// Synthetic bridge harness only. These responses are not presented as native
// Lens output; the real saved-workflow integration is checked separately.
function syntheticBridge() {
  const calls = [];
  const stateAt = (snapshot, through) => ({ basis: 'synthetic-fixture', state: snapshot.commitLog.slice(0, through + 1)
    .reduce((state, commit) => Object.assign(state, structuredClone(commit.overwrite)), {}) });
  return { calls, stateAt,
    openRecording(recording) { assert.equal(recording.events, undefined); return { snapshot: recording.snapshot }; },
    traceToolpack(artifacts) { return { synthetic: true, artifacts }; },
    async callTraceTool(tools, name, args) {
      assert.equal(tools.synthetic, true); calls.push({ name, args: structuredClone(args) });
      return `SYNTHETIC BRIDGE RESULT ${name} ${JSON.stringify(args)}`;
    },
    findLastWriter(log, key, before = log.length) {
      for (let i = Math.min(before, log.length) - 1; i >= 0; i--)
        if (Object.hasOwn(log[i].overwrite, key)) return log[i];
    },
    timeTravel(snapshot) {
      let index = 0;
      const stops = [{ step: 0, commitIdx: -1, runtimeStageId: '', label: 'Synthetic start' },
        ...snapshot.commitLog.map((commit, i) => ({ step: i + 1, commitIdx: i, runtimeStageId: commit.runtimeStageId, label: commit.stage }))];
      return { stops, at: () => stops[index], stateAt: () => stateAt(snapshot, stops[index].commitIdx), changedSince: () => [],
        jumpTo(target) { const next = typeof target === 'number' ? target : stops.findIndex(stop => stop.runtimeStageId === target);
          if (next < 0 || next >= stops.length) return { moved: false, reason: 'miss' };
          if (next === index) return { moved: false, reason: 'clamped' };
          index = next; return { moved: true }; } };
    } };
}

function fixture(rename = {}) {
  const bindings = { model: 'chosenItem', receipt: 'testTicket', decision: 'policyResult', allowed: 'publishOK', releasedModel: 'deployedItem', ...rename };
  const artifact = digit => ({ kind: 'artifact', path: `fixture-${digit}`, sha256: digit.repeat(64), bytes: 1, format: 'synthetic-fixture' });
  const model = digit => ({ kind: 'model', sessionId: 'synthetic-session', handle: Number(digit), originArtifact: artifact(digit),
    inferenceIdentity: { kind: 'inference-identity', schemaVersion: 1, profile: 'synthetic-fixture/v1', sha256: digit.repeat(64) } });
  const a = model('1'), b = model('2');
  const receipt = modelRef => ({ kind: 'evaluation-receipt', schemaVersion: 2, modelRef,
    checkpointForAudit: { kind: 'checkpoint', artifact: modelRef.originArtifact }, inferenceIdentity: modelRef.inferenceIdentity });
  const decision = allowed => ({ kind: 'release-decision', schemaVersion: 1, allowed, status: allowed ? 'allow' : 'deny', reasons: [], bindings: { coverage: 'inference' } });
  const changes = [
    { [bindings.releasedModel]: null }, { [bindings.model]: a }, { [bindings.receipt]: receipt(a) },
    { [bindings.model]: b }, { [bindings.decision]: decision(false), [bindings.allowed]: false },
    { [bindings.receipt]: receipt(b) }, { [bindings.decision]: decision(true), [bindings.allowed]: true },
    { [bindings.releasedModel]: b },
  ];
  const names = ['seed-fox', 'fit-cobalt', 'approve-mango', 'refit-kiwi', 'check-ash', 'assess-navy', 'gate-copper', 'publish-cedar'];
  const commitLog = changes.map((overwrite, idx) => ({ idx, stage: `Synthetic ${names[idx]}`, stageId: names[idx],
    runtimeStageId: `${names[idx]}#${idx}`, overwrite, trace: Object.keys(overwrite).map(path => ({ path, verb: 'set' })) }));
  return { workflow: { kind: 'ml-adapter-workflow/v1' }, mlInvestigation: { schemaVersion: 1, bindings },
    footprint: { commitLog, executionTree: { id: 'synthetic-only' } }, rows: [], fixtureModels: { a, b } };
}

test('synthetic harness: arbitrary keys and stage names select the latest recorded decision', () => {
  const input = fixture(), bridge = syntheticBridge(), session = openAdapterWorkflowRun(input, bridge);
  assert.deepEqual(session.decisionChoices.map(choice => choice.runtimeStageId), ['check-ash#4', 'gate-copper#6']);
  assert.equal(session.selectedDecisionStageId, 'gate-copper#6');
  assert.equal(session.summary.releaseDecision.allowed, true); assert.equal(session.summary.checkpointMatches, true);
  assert.equal(session.summary.inferenceMatches, true);
  assert.strictEqual(session.snapshot, input.footprint); assert.strictEqual(session.recording.supplemental.footprintCallbacks, input.rows);
  assert.equal(session.recording.events, undefined); assert.equal(session.artifacts.controlDeps, undefined);
});

test('synthetic harness: selecting an earlier denial never substitutes the later receipt', async () => {
  const input = fixture(), bridge = syntheticBridge();
  const session = openAdapterWorkflowRun(input, bridge, { decisionStageId: 'check-ash#4' });
  assert.equal(session.summary.releaseDecision.allowed, false); assert.equal(session.summary.inferenceMatches, false);
  assert.equal(session.summary.evaluationReceipt.modelRef.handle, 1); assert.equal(session.summary.activeModel.handle, 2);
  assert.equal(session.summary.releasedModel.handle, 2, 'Later final release must remain a distinct fact');
  assert.equal(session.anchors.receipt, 'approve-mango#2');
  await session.investigate();
  const writer = bridge.calls.find(call => call.name === 'who_wrote' && call.args.key === 'testTicket');
  assert.equal(writer.args.beforeStageId, 'assess-navy#5');
  const backtrack = bridge.calls.find(call => call.name === 'backtrack');
  assert.deepEqual(backtrack.args, { variable: 'policyResult', before: 5 });
  assert.ok(session.transcript.every(row => row.result.startsWith('SYNTHETIC BRIDGE RESULT')));
});

test('synthetic harness: renaming every binding changes queries without editing a workflow profile', async () => {
  const rename = { model: 'runtimeObjectQ', receipt: 'evaluationMemoR', decision: 'eligibilityS', allowed: 'mayShipT', releasedModel: 'sentObjectU' };
  const input = fixture(rename), bridge = syntheticBridge(), original = JSON.stringify(input);
  input.footprint.commitLog.forEach((commit, index) => { commit.stageId = `independent-${index}`; commit.runtimeStageId = `independent-${index}#${index}`; });
  const renamedOriginal = JSON.stringify(input);
  const session = openAdapterWorkflowRun(input, bridge);
  await session.investigate('gate');
  assert.ok(bridge.calls.some(call => call.name === 'get_value' && call.args.key === 'eligibilityS'));
  assert.ok(bridge.calls.some(call => call.name === 'get_value' && call.args.key === 'mayShipT'));
  assert.notEqual(renamedOriginal, original);
  assert.equal(JSON.stringify(input), renamedOriginal);
  assert.ok(bridge.calls.every(call => !call.args.runtimeStageId || call.args.runtimeStageId.startsWith('independent-')));
  assert.deepEqual(session.projectState(session.selected.state).model, input.fixtureModels.b);
});

test('synthetic harness: absent inference evidence is omitted rather than asserted false', () => {
  const input = fixture();
  for (const commit of input.footprint.commitLog) {
    const receipt = commit.overwrite.testTicket;
    if (receipt) { receipt.schemaVersion = 1; receipt.checkpoint = receipt.checkpointForAudit; delete receipt.checkpointForAudit; delete receipt.inferenceIdentity; }
  }
  const session = openAdapterWorkflowRun(input, syntheticBridge());
  assert.equal(Object.hasOwn(session.summary, 'inferenceMatches'), false);
});

test('synthetic harness: missing bindings, unsupported schema, and non-decision stage selection reject clearly', () => {
  const input = fixture(); delete input.mlInvestigation.bindings.receipt;
  assert.throws(() => openAdapterWorkflowRun(input, syntheticBridge()), /binding: receipt/);
  const unsupported = fixture(); unsupported.mlInvestigation.schemaVersion = 2;
  assert.throws(() => openAdapterWorkflowRun(unsupported, syntheticBridge()), /schemaVersion 1/);
  assert.throws(() => openAdapterWorkflowRun(fixture(), syntheticBridge(), { decisionStageId: 'fit-cobalt#1' }), /not a committed writer/);
  const missing = fixture(); delete missing.mlInvestigation;
  assert.throws(() => openAdapterWorkflowRun(missing, syntheticBridge()), /explicit scope-key bindings/);
});

test('synthetic harness: repeated cursor selection is a no-op and unavailable stops fail', () => {
  const session = openAdapterWorkflowRun(fixture(), syntheticBridge());
  session.stop('refit-kiwi#3'); assert.equal(session.stop('refit-kiwi#3').stop.runtimeStageId, 'refit-kiwi#3');
  assert.throws(() => session.stop('invented#99'), /unavailable/);
});
