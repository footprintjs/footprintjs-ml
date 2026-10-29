/**
 * Saved ML workflow bindings over existing Lens and foottrace APIs.
 * No trainer, model implementation, graph engine, or model provider is loaded.
 */
export function openAdapterWorkflowRun(input, bridge, options = {}) {
  const snapshot = input?.footprint ?? input?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.commitLog) || snapshot.executionTree === undefined)
    throw new Error('A saved FootPrint snapshot with commitLog and executionTree is required.');
  const descriptor = input?.mlInvestigation;
  if (descriptor?.schemaVersion !== 1 || !descriptor.bindings || typeof descriptor.bindings !== 'object')
    throw new Error('mlInvestigation schemaVersion 1 and explicit scope-key bindings are required.');
  const bindings = {};
  for (const name of ['model', 'receipt', 'decision', 'allowed', 'releasedModel']) {
    const key = descriptor.bindings[name];
    if (typeof key !== 'string' || !key.trim()) throw new Error(`Missing or invalid ML investigation binding: ${name}`);
    bindings[name] = key;
  }
  if (new Set(Object.values(bindings)).size !== 5) throw new Error('ML investigation bindings must name distinct scope keys.');
  Object.freeze(bindings);
  let dataLineageBindings;
  if (descriptor.dataLineage !== undefined) {
    if (!descriptor.dataLineage || typeof descriptor.dataLineage !== 'object' || Array.isArray(descriptor.dataLineage))
      throw new Error('ML dataLineage bindings must be an object when supplied.');
    dataLineageBindings = {};
    for (const name of ['receipt', 'decision', 'preprocessing', 'manifest']) {
      const key = descriptor.dataLineage[name];
      if (typeof key !== 'string' || !key.trim()) throw new Error(`Missing or invalid ML dataLineage binding: ${name}`);
      dataLineageBindings[name] = key;
    }
    if (new Set([...Object.values(bindings), ...Object.values(dataLineageBindings)]).size !== 9)
      throw new Error('ML investigation and dataLineage bindings must name distinct scope keys.');
    Object.freeze(dataLineageBindings);
  }
  let selectionBindings;
  if (descriptor.selection !== undefined) {
    if (!descriptor.selection || typeof descriptor.selection !== 'object' || Array.isArray(descriptor.selection))
      throw new Error('ML selection bindings must be an object when supplied.');
    selectionBindings = {};
    for (const name of ['manifest', 'results', 'receipt', 'decision', 'candidate']) {
      const key = descriptor.selection[name];
      if (typeof key !== 'string' || !key.trim()) throw new Error(`Missing or invalid ML selection binding: ${name}`);
      selectionBindings[name] = key;
    }
    const keys = [...Object.values(bindings), ...Object.values(dataLineageBindings ?? {}), ...Object.values(selectionBindings)];
    if (new Set(keys).size !== keys.length) throw new Error('ML investigation, dataLineage and selection bindings must name distinct scope keys.');
    Object.freeze(selectionBindings);
  }
  let publicationBindings;
  if (descriptor.publication !== undefined) {
    if (!descriptor.publication || typeof descriptor.publication !== 'object' || Array.isArray(descriptor.publication))
      throw new Error('ML publication bindings must be an object when supplied.');
    publicationBindings = {};
    for (const name of ['pin', 'plan', 'preparation', 'publication', 'attempt']) {
      const key = descriptor.publication[name];
      if (typeof key !== 'string' || !key.trim()) throw new Error(`Missing or invalid ML publication binding: ${name}`);
      publicationBindings[name] = key;
    }
    const keys = [...Object.values(bindings), ...Object.values(dataLineageBindings ?? {}),
      ...Object.values(selectionBindings ?? {}), ...Object.values(publicationBindings)];
    if (new Set(keys).size !== keys.length) throw new Error('All ML investigation bindings must name distinct scope keys.');
    Object.freeze(publicationBindings);
  }
  for (const name of ['openRecording', 'traceToolpack', 'callTraceTool', 'stateAt', 'findLastWriter', 'timeTravel'])
    if (typeof bridge?.[name] !== 'function') throw new Error(`The injected public Lens/foottrace bridge is missing ${name}.`);

  const log = snapshot.commitLog;
  const boundValue = (state, key) => state && Object.hasOwn(state, key) ? state[key] : undefined;
  const callbacks = Array.isArray(input.rows) ? input.rows : input.supplemental?.footprintCallbacks ?? [];
  if (!Array.isArray(callbacks)) throw new Error('Saved workflow callbacks must be an array when supplied.');
  const recording = { snapshot, workflow: { kind: 'ml-adapter-workflow/v1' },
    mlInvestigation: { schemaVersion: 1, bindings, ...(dataLineageBindings ? { dataLineage: dataLineageBindings } : {}),
      ...(selectionBindings ? { selection: selectionBindings } : {}),
      ...(publicationBindings ? { publication: publicationBindings } : {}) },
    supplemental: { footprintCallbacks: callbacks } };
  const artifacts = bridge.openRecording(recording);
  const tools = bridge.traceToolpack(artifacts, { previewChars: 600, valueMaxChars: 8000 });
  const cursor = bridge.timeTravel(snapshot);
  const writerAt = (key, through) => bridge.findLastWriter(log, key, through + 1);
  // A first writer means the earliest captured, non-null value through the
  // selected commit. It does not assert that no earlier external fit occurred.
  const firstCapturedWriterAt = (key, through) => {
    let before = through + 1, first;
    while (before > 0) {
      const writer = bridge.findLastWriter(log, key, before);
      if (!writer) break;
      const index = log.indexOf(writer);
      if (index < 0 || index >= before) throw new Error('The bridge returned a lineage writer outside the source commit log.');
      const value = boundValue(bridge.stateAt(snapshot, index).state, key);
      if (value !== null && value !== undefined) first = writer;
      before = index;
    }
    return first;
  };
  const decisions = [];
  let before = log.length;
  while (before > 0) {
    const writer = bridge.findLastWriter(log, bindings.decision, before);
    if (!writer) break;
    const index = log.indexOf(writer);
    if (index < 0 || index >= before) throw new Error('The bridge returned a decision writer outside the source commit log.');
    const decision = boundValue(bridge.stateAt(snapshot, index).state, bindings.decision);
    if (decision !== null && decision !== undefined) {
      if (typeof decision !== 'object' || !['release-decision', 'model-release-decision'].includes(decision.kind) || typeof decision.allowed !== 'boolean')
        throw new Error(`The bound decision at ${writer.runtimeStageId} is not recorded release decision evidence.`);
      if (typeof writer.runtimeStageId !== 'string' || !writer.runtimeStageId)
        throw new Error('A recorded decision has no runtimeStageId.');
      decisions.push({ runtimeStageId: writer.runtimeStageId, stageName: writer.stage ?? writer.runtimeStageId,
        commitIdx: index, allowed: decision.allowed, status: decision.status });
    }
    before = index;
  }
  decisions.reverse();
  if (!decisions.length) throw new Error(`No committed decision evidence was captured for bound key ${bindings.decision}.`);
  const choice = options.decisionStageId === undefined ? decisions.at(-1) :
    decisions.find(decision => decision.runtimeStageId === options.decisionStageId);
  if (!choice) throw new Error(`The requested decision stage is not a committed writer of ${bindings.decision}: ${options.decisionStageId}`);
  const selected = bridge.stateAt(snapshot, choice.commitIdx);
  const final = bridge.stateAt(snapshot, log.length - 1);
  const sameArtifact = (a, b) => a && b && typeof a.sha256 === 'string' && typeof b.sha256 === 'string' &&
    typeof a.bytes === 'number' && typeof b.bytes === 'number' && typeof a.format === 'string' && typeof b.format === 'string' ?
    a.sha256.toLowerCase() === b.sha256.toLowerCase() && a.bytes === b.bytes && a.format === b.format : undefined;
  const sameInference = (a, b) => a && b && typeof a.profile === 'string' && typeof b.profile === 'string' &&
    typeof a.sha256 === 'string' && typeof b.sha256 === 'string' ?
    a.profile === b.profile && a.sha256.toLowerCase() === b.sha256.toLowerCase() : undefined;
  const projectState = state => {
    const model = boundValue(state, bindings.model), receipt = boundValue(state, bindings.receipt), decision = boundValue(state, bindings.decision);
    const evaluatedCheckpoint = receipt?.schemaVersion === 2 ? receipt.checkpointForAudit?.artifact : receipt?.checkpoint?.artifact;
    const checkpointMatches = sameArtifact(model?.originArtifact, evaluatedCheckpoint);
    const inferenceMatches = receipt?.schemaVersion === 2 ? sameInference(model?.inferenceIdentity, receipt.inferenceIdentity) : undefined;
    return { model, receipt, decision, allowed: boundValue(state, bindings.allowed), releasedModel: boundValue(state, bindings.releasedModel),
      ...(checkpointMatches === undefined ? {} : { checkpointMatches }),
      ...(inferenceMatches === undefined ? {} : { inferenceMatches }),
      ...(dataLineageBindings ? { dataLineage: {
        receipt: boundValue(state, dataLineageBindings.receipt), decision: boundValue(state, dataLineageBindings.decision),
        preprocessing: boundValue(state, dataLineageBindings.preprocessing), manifest: boundValue(state, dataLineageBindings.manifest),
      } } : {}),
      ...(selectionBindings ? { selection: Object.fromEntries(Object.entries(selectionBindings)
        .map(([name, key]) => [name, boundValue(state, key)])) } : {}),
      ...(publicationBindings ? { publication: Object.fromEntries(Object.entries(publicationBindings)
        .map(([name, key]) => [name, boundValue(state, key)])) } : {}) };
  };
  const values = projectState(selected.state);
  const modelWriter = writerAt(bindings.model, choice.commitIdx), receiptWriter = writerAt(bindings.receipt, choice.commitIdx);
  const releaseWriter = boundValue(final.state, bindings.releasedModel) == null ? undefined : writerAt(bindings.releasedModel, log.length - 1);
  const lineageWriters = dataLineageBindings ? {
    receipt: writerAt(dataLineageBindings.receipt, choice.commitIdx),
    decision: writerAt(dataLineageBindings.decision, choice.commitIdx),
    preprocessing: writerAt(dataLineageBindings.preprocessing, choice.commitIdx),
    manifest: writerAt(dataLineageBindings.manifest, choice.commitIdx),
    firstPreprocessing: firstCapturedWriterAt(dataLineageBindings.preprocessing, choice.commitIdx),
  } : undefined;
  const selectionWriters = selectionBindings ? Object.fromEntries(Object.entries(selectionBindings)
    .map(([name, key]) => [name, writerAt(key, choice.commitIdx)])) : undefined;
  const publicationWriters = publicationBindings ? Object.fromEntries(Object.entries(publicationBindings)
    .map(([name, key]) => [name, writerAt(key, choice.commitIdx)])) : undefined;
  const anchors = { decision: choice.runtimeStageId, guard: choice.runtimeStageId, identityCheck: choice.runtimeStageId,
    recovery: modelWriter?.runtimeStageId, validation: receiptWriter?.runtimeStageId, receipt: receiptWriter?.runtimeStageId,
    release: releaseWriter?.runtimeStageId,
    ...(lineageWriters ? { dataLineage: lineageWriters.receipt?.runtimeStageId,
      lineageDecision: lineageWriters.decision?.runtimeStageId,
      preprocessing: lineageWriters.preprocessing?.runtimeStageId,
      firstPreprocessingFit: lineageWriters.firstPreprocessing?.runtimeStageId,
      splitManifest: lineageWriters.manifest?.runtimeStageId } : {}),
    ...(selectionWriters ? { selectionManifest: selectionWriters.manifest?.runtimeStageId,
      selectionResults: selectionWriters.results?.runtimeStageId, selectionReceipt: selectionWriters.receipt?.runtimeStageId,
      selectionDecision: selectionWriters.decision?.runtimeStageId, selectedCandidate: selectionWriters.candidate?.runtimeStageId } : {}),
    ...(publicationWriters ? { releasePin: publicationWriters.pin?.runtimeStageId,
      releasePlan: publicationWriters.plan?.runtimeStageId, releasePreparation: publicationWriters.preparation?.runtimeStageId,
      publication: publicationWriters.publication?.runtimeStageId, publicationAttempt: publicationWriters.attempt?.runtimeStageId } : {}) };
  const transcript = [];
  const call = async (tool, args = {}) => {
    const result = await bridge.callTraceTool(tools, tool, args);
    const entry = { ordinal: transcript.length + 1, tool, args: { ...args }, result,
      owner: 'agentfootprint/observe: existing Lens toolpack' };
    transcript.push(entry); return entry;
  };
  // who_wrote's beforeStageId is exclusive. The following commit includes the
  // selected decision while excluding every later revision of the same key.
  const writerArgsAt = (key, through) => ({ key, ...(log[through + 1]?.runtimeStageId ?
    { beforeStageId: log[through + 1].runtimeStageId } : {}) });
  const writerArgs = key => writerArgsAt(key, choice.commitIdx);
  const value = key => ['get_value', { runtimeStageId: choice.runtimeStageId, key }];
  const node = ['trace_node', { runtimeStageId: choice.runtimeStageId }];
  const lineageCalls = () => {
    if (!dataLineageBindings) throw new Error('Lineage investigation requires explicit mlInvestigation.dataLineage bindings.');
    const calls = [['run_overview', {}], ['find_context_errors', {}]];
    for (const key of Object.values(dataLineageBindings))
      calls.push(['who_wrote', writerArgs(key)], value(key));
    calls.push(value(bindings.model), value(bindings.receipt), value(bindings.decision), node,
      ['backtrack', { variable: dataLineageBindings.receipt, before: choice.commitIdx + 1 }],
      ['backtrack', { variable: dataLineageBindings.preprocessing, before: choice.commitIdx + 1 }]);
    const first = lineageWriters.firstPreprocessing;
    if (first?.runtimeStageId) {
      const index = log.indexOf(first);
      calls.push(['who_wrote', writerArgsAt(dataLineageBindings.preprocessing, index)],
        ['get_value', { runtimeStageId: first.runtimeStageId, key: dataLineageBindings.preprocessing }]);
    }
    return calls;
  };
  const selectionCalls = () => {
    if (!selectionBindings) throw new Error('Selection investigation requires explicit mlInvestigation.selection bindings.');
    const calls = [['run_overview', {}], ['find_context_errors', {}]];
    for (const key of Object.values(selectionBindings))
      calls.push(['who_wrote', writerArgs(key)], value(key));
    calls.push(value(bindings.model), value(bindings.receipt), value(bindings.decision), value(bindings.allowed), node,
      ['backtrack', { variable: selectionBindings.decision, before: choice.commitIdx + 1 }],
      ['backtrack', { variable: selectionBindings.candidate, before: choice.commitIdx + 1 }]);
    return calls;
  };
  const publicationCalls = () => {
    if (!publicationBindings) throw new Error('Publication investigation requires explicit mlInvestigation.publication bindings.');
    const calls = [['run_overview', {}], ['find_context_errors', {}]];
    for (const key of Object.values(publicationBindings))
      calls.push(['who_wrote', writerArgs(key)], value(key));
    calls.push(value(bindings.model), value(bindings.receipt), value(bindings.decision), value(bindings.allowed), node,
      ['backtrack', { variable: publicationBindings.preparation, before: choice.commitIdx + 1 }],
      ['backtrack', { variable: publicationBindings.publication, before: choice.commitIdx + 1 }],
      ['backtrack', { variable: publicationBindings.attempt, before: choice.commitIdx + 1 }]);
    return calls;
  };
  const callsFor = question => question === 'publication' ? publicationCalls() : question === 'selection' ? selectionCalls() : question === 'lineage' ? lineageCalls() : question === 'writer' ? [
    ['who_wrote', writerArgs(bindings.model)], value(bindings.model), ['who_wrote', writerArgs(bindings.receipt)],
  ] : question === 'gate' ? [node, ['who_wrote', writerArgs(bindings.allowed)], value(bindings.allowed), value(bindings.decision)] : [
    ['run_overview', {}], ['find_context_errors', {}],
    ['who_wrote', writerArgs(bindings.model)], value(bindings.model),
    ['who_wrote', writerArgs(bindings.receipt)], value(bindings.receipt),
    value(bindings.decision), value(bindings.allowed), node,
    ['backtrack', { variable: bindings.decision, before: choice.commitIdx + 1 }],
  ];
  const investigate = async (question = 'release') => {
    transcript.length = 0;
    for (const [tool, args] of callsFor(question)) await call(tool, args);
    return transcript;
  };
  const stop = target => {
    const movement = cursor.jumpTo(target), current = cursor.at();
    const alreadyThere = typeof target === 'number' ? current?.step === target : current?.runtimeStageId === target;
    if (!movement.moved && !alreadyThere) throw new Error(`Recorded stop is unavailable: ${movement.reason}`);
    return { stop: current, folded: cursor.stateAt(), changedKeys: [...cursor.changedSince()] };
  };
  const pointerBase = Array.isArray(input.rows) ? '/rows' : '/supplemental/footprintCallbacks';
  const supplemental = callbacks.flatMap((row, index) => {
    const id = row?.event?.runtimeStageId ?? row?.event?.traversalContext?.runtimeStageId;
    const relatedBackend = row?.type === 'backend' && id === choice.runtimeStageId;
    return row?.type === 'decision' || row?.type === 'retry' || relatedBackend ? [{
      kind: row.type === 'decision' ? 'Decision callback' : row.type === 'retry' ? 'Retry callback' : 'Backend callback',
      pointer: `${pointerBase}/${index}/event`, pointerSource: 'Input recording passed to openAdapterWorkflowRun', event: row.event,
    }] : [];
  });
  return { recording, snapshot, callbacks, artifacts, tools, cursor, anchors, final, selected, bindings,
    ...(dataLineageBindings ? { dataLineageBindings } : {}),
    ...(selectionBindings ? { selectionBindings } : {}),
    ...(publicationBindings ? { publicationBindings } : {}),
    selectedDecisionStageId: choice.runtimeStageId, decisionChoices: decisions, projectState,
    transcript, call, investigate, stop, supplemental,
    summary: { isAdapterWorkflow: true, selectedDecisionStageId: choice.runtimeStageId,
      selectedDecisionStageName: choice.stageName, selectedCommitIdx: choice.commitIdx,
      activeModel: values.model, validatedModel: values.receipt?.modelRef,
      evaluationReceipt: values.receipt, releaseDecision: values.decision, releaseAllowed: values.allowed,
      releasedModel: boundValue(final.state, bindings.releasedModel),
      ...(values.checkpointMatches === undefined ? {} : { checkpointMatches: values.checkpointMatches }),
      ...(values.inferenceMatches === undefined ? {} : { inferenceMatches: values.inferenceMatches }),
      modelWriterStageId: modelWriter?.runtimeStageId, receiptWriterStageId: receiptWriter?.runtimeStageId,
      finalReleaseWriterStageId: releaseWriter?.runtimeStageId,
      ...(dataLineageBindings ? { dataLineage: {
        ...values.dataLineage,
        receiptWriterStageId: lineageWriters.receipt?.runtimeStageId,
        decisionWriterStageId: lineageWriters.decision?.runtimeStageId,
        preprocessingWriterStageId: lineageWriters.preprocessing?.runtimeStageId,
        firstCapturedPreprocessingFitWriterStageId: lineageWriters.firstPreprocessing?.runtimeStageId,
        manifestWriterStageId: lineageWriters.manifest?.runtimeStageId,
      } } : {}),
      ...(selectionBindings ? { selection: { ...values.selection,
        writerStageIds: Object.fromEntries(Object.entries(selectionWriters).map(([name, writer]) => [name, writer?.runtimeStageId])),
      } } : {}),
      ...(publicationBindings ? { publication: { ...values.publication,
        writerStageIds: Object.fromEntries(Object.entries(publicationWriters).map(([name, writer]) => [name, writer?.runtimeStageId])),
      } } : {}) },
    boundaries: [
      'The selected decision is a saved commit. A later recorded publication is shown separately; it does not change the earlier decision.',
      'Explicit scope-key bindings select the model, receipt and decision. Existing Lens tools execute every evidence query; foottrace folds committed state.',
      'This scripted investigation starts no trainer, Python worker or language model and does not restore live model handles.',
      'No live control-dependency lookup or typed AgentFootprint event tail was supplied. Native missing-evidence warnings are preserved.',
      'Decision/retry callbacks from the run and backend callbacks at the selected decision are supplemental evidence, not manufactured agent events.',
      'Displayed identity matches compare recorded references; this viewer does not measure live numerical state or authenticate backend claims.',
      ...(dataLineageBindings ? [
        'Data lineage values and decisions are captured evidence selected through explicit bindings; the viewer does not recompute overlap or refit preprocessing.',
        'The first preprocessing-fit writer is the earliest captured non-null commit through the selected decision, not proof that no external fit happened earlier.',
      ] : []),
      ...(selectionBindings ? [
        'Selection manifest, candidate results, receipt, proposal and guard decision are saved values through the selected release commit. Later corrections are not borrowed.',
        'The viewer displays recorded selection evidence and its writers; it does not retrain, re-evaluate, authenticate receipts or infer unrecorded candidate experiments.',
      ] : []),
      ...(publicationBindings ? [
        'Pinned plan, preparation, publication result and attempt are captured values through the selected decision. Later publication outcomes remain separate.',
        'Opening this recording does not read a live registry, verify artifact bytes, restore model handles or publish again. Publisher-specific guarantees depend on the actual adapter.',
        'Retry callbacks and publisher acknowledgements are supplemental observations. A lost acknowledgement must not be presented as a successful workflow commit.',
      ] : []),
    ] };
}
