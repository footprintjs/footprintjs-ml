/** A real FootPrint flowchart; numerical models and arrays remain in Python. */
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {flowChart, FlowChartExecutor, decide} from 'footprintjs';
import {controlDepRecorder} from 'footprintjs/trace';
import {createPredictionContract, createInferenceReceipt, checkInference,
  createEvaluationReceipt, checkRelease} from 'footprintjs-ml';
import {PersistentNumericalBackend, NumericalBackendError, NUMERICAL_THREAD_ENV} from './native-client.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const sha256 = blob => createHash('sha256').update(blob).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const summary = decision => Object.fromEntries(Object.entries(decision).filter(([key]) => key !== 'bindings'));
const require = (condition, message) => { if (!condition) throw new Error(message); };
const fields = Array.from({length: 64}, (_, index) => ({name: `pixel_${index}`, dtype: 'float64', unit: 'intensity-0-to-16'}));

function predictionRequest(scope, prefix, reverseFields = false) {
  // The independently approved model is deliberately not part of this request.
  return {inferenceId: scope[`${prefix}InferenceId`], inputRef: plain(scope.predictionInputRef), reverseFields};
}

function retainActualPrediction(scope, observed, prefix) {
  const cache = plain(scope.cacheObservation);
  const actual = observed.observation;
  require(actual.workerPid === cache.workerPid && actual.sessionId === cache.sessionId &&
    actual.cacheGeneration === cache.cacheGeneration &&
    same(actual.beforeModelRef.inferenceIdentity, cache.modelRef.inferenceIdentity),
  'Actual prediction does not belong to the recorded cache-load observation');
  const input = Object.fromEntries(['inferenceId', 'createdAt', 'inputRef', 'outputRef', 'inputRows', 'outputRows', 'modelRef']
    .map(key => [key, observed[key]]));
  scope[`${prefix}Receipt`] = plain(createInferenceReceipt({...input, contract: createPredictionContract(observed.contract)}));
  scope[`${prefix}BackendObservation`] = plain(actual);
}

function checkPrediction(scope, prefix) {
  return plain(checkInference({receipt: plain(scope[`${prefix}Receipt`]), modelRef: plain(scope.approvedModelRef),
    contract: plain(scope.expectedContract), inputRef: plain(scope.predictionInputRef), rows: scope.predictionRows,
    inferenceId: scope[`${prefix}InferenceId`], now: Date.now()}));
}

/** Runs once into a new output directory. No numerical work runs on import. */
export async function runNativeProof({out, python = process.env.PYTHON || 'python3', fixtures} = {}) {
  require(typeof out === 'string' && out.length > 0, 'Use --out NEW_DIRECTORY');
  const root = resolve(out);
  const fixtureDir = resolve(fixtures || fileURLToPath(new URL('./fixtures/', import.meta.url)));
  const sourceBlob = await readFile(resolve(fixtureDir, 'source.json'));
  await mkdir(dirname(root), {recursive: true});
  await mkdir(root); // A retained recording is never overwritten.
  const save = (name, value) => writeFile(resolve(root, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
  let backend;
  const controls = controlDepRecorder({id: 'native-inference-controls'});
  const flowEvents = [];

  function declarePlan(scope) {
    // This is the explicit external ingress, before evaluating any model.
    scope.backendPlan = {modelBC: 0.0001, predictionRows: 64, fixtureManifestSha256: sha256(sourceBlob)};
    scope.fixtureSource = JSON.parse(sourceBlob.toString('utf8'));
    scope.qualityPolicy = {metric: 'accuracy', operator: 'gte', threshold: 0.90};
    scope.nativeRetryPolicy = {attempts: 2, backoffMs: 0, retryOn: 'TransientInferenceFault only'};
    scope.numericalEnvironment = plain(NUMERICAL_THREAD_ENV);
    scope.releasedPredictionRef = null;
    scope.retryScratch = null;
  }

  async function initializeBackend(scope) {
    backend = new PersistentNumericalBackend({root: resolve(root, 'backend'), fixtures: fixtureDir, python});
    const actual = await backend.call('initialize', plain(scope.backendPlan));
    scope.backend = plain(actual);
    scope.modelARef = plain(actual.modelARef);
    scope.modelBRef = plain(actual.modelBRef);
    scope.predictionInputRef = plain(actual.inputRef);
    scope.predictionRows = scope.backendPlan.predictionRows;
    scope.expectedContract = plain(createPredictionContract({profile: 'digits-64-named-pixels-to-class-label/v1',
      input: {fields}, output: {fields: [{name: 'digit', dtype: 'int64'}]},
      preprocessingVersion: `standardscaler-state/sha256:${actual.scalerStateSha256}`,
      classLabels: Array.from({length: 10}, (_, index) => index), parameters: {method: 'ordered-class-argmax'}}));
  }

  async function loadApprovedA(scope) {
    scope.cacheBinding = plain(scope.modelARef);
    scope.cacheObservation = plain(await backend.call('load_cache', {modelRef: plain(scope.cacheBinding)}));
  }

  async function evaluateApprovedA(scope) {
    const observed = await backend.call('evaluate');
    const cache = plain(scope.cacheObservation);
    require(observed.workerPid === cache.workerPid && observed.sessionId === cache.sessionId &&
      same(observed.modelRef.inferenceIdentity, cache.modelRef.inferenceIdentity),
    'Actual evaluation does not match the recorded cache load');
    scope.evaluationReceipt = plain(createEvaluationReceipt(Object.fromEntries([
      'modelRef', 'datasetRef', 'preprocessingVersion', 'evaluationMethodVersion', 'parameters', 'metrics', 'evaluationId', 'createdAt',
    ].map(key => [key, observed[key]]))));
    scope.validationBackendObservation = {workerPid: observed.workerPid, sessionId: observed.sessionId};
  }

  function approveModelA(scope) {
    const receipt = plain(scope.evaluationReceipt);
    const decision = checkRelease({modelRef: plain(scope.modelARef), datasetRef: receipt.datasetRef,
      preprocessingVersion: scope.expectedContract.preprocessingVersion, evaluationMethodVersion: receipt.evaluationMethodVersion,
      parameters: {}, receipt, policy: plain(scope.qualityPolicy), now: Date.now()});
    scope.approvalDecision = plain(decision);
    require(decision.allowed, 'A did not pass the fixed validation policy');
    scope.approvedModelRef = plain(scope.modelARef);
  }

  async function loadWrongCache(scope) {
    scope.cacheBinding = plain(scope.modelBRef);
    scope.cacheObservation = plain(await backend.call('load_cache', {modelRef: plain(scope.cacheBinding)}));
  }

  async function predictStale(scope) {
    scope.staleInferenceId = randomUUID();
    retainActualPrediction(scope, await backend.call('predict', predictionRequest(scope, 'stale')), 'stale');
  }

  function guardStale(scope) {
    const decision = checkPrediction(scope, 'stale');
    scope.wrongInferenceDecision = decision;
    scope.staleAllowed = decision.allowed;
    scope.staleOutputExposed = false;
    require(scope.releasedPredictionRef === null, 'An output escaped before the inference decision');
  }

  async function repairCache(scope) {
    scope.cacheBinding = plain(scope.approvedModelRef);
    scope.cacheObservation = plain(await backend.call('load_cache', {modelRef: plain(scope.cacheBinding)}));
    scope.repairChoice = 'reload-approved-A';
  }

  function prepareCorrectedInvocation(scope) {
    // This commits BEFORE the retried stage. A discarded first attempt must
    // not mint a different invocation and trigger the fault again.
    scope.correctedInferenceId = randomUUID();
  }

  async function predictCorrected(scope) {
    const scratch = scope.retryScratch;
    require(scratch === null, 'A failed attempt leaked its pending scope write into the next attempt');
    scope.retryScratch = {status: 'pending', inferenceId: scope.correctedInferenceId};
    const observed = await backend.call('predict_transient_once', predictionRequest(scope, 'corrected'));
    retainActualPrediction(scope, observed, 'corrected');
    scope.correctedRetryObservation = plain(observed.retryObservation);
    scope.retryScratch = {status: 'success', inferenceId: scope.correctedInferenceId, initialPendingValueAbsent: true};
  }

  function guardCorrected(scope) {
    const decision = checkPrediction(scope, 'corrected');
    scope.correctedInferenceDecision = decision;
    scope.correctedAllowed = decision.allowed;
  }

  function permitOutput(scope) {
    // Only this actual decider-selected branch exposes an output reference.
    scope.releasedPredictionRef = plain(scope.correctedReceipt.outputRef);
    scope.handoffChoice = 'accepted-corrected-output';
  }

  async function predictReversed(scope) {
    scope.reversedInferenceId = randomUUID();
    retainActualPrediction(scope, await backend.call('predict', predictionRequest(scope, 'reversed', true)), 'reversed');
  }

  function guardReversed(scope) {
    const decision = checkPrediction(scope, 'reversed');
    scope.reversedInferenceDecision = decision;
    require(!decision.allowed && decision.status === 'deny', 'Reversed actual feature fields were not denied');
    require(same(plain(scope.releasedPredictionRef), plain(scope.correctedReceipt.outputRef)),
      'A refused output replaced the accepted handoff');
  }

  function guardMissing(scope) {
    const recorded = plain(scope.correctedReceipt);
    const missing = Object.fromEntries(Object.entries(recorded).filter(([key]) => !['kind', 'schemaVersion', 'modelRef'].includes(key)));
    scope.missingReceipt = plain(createInferenceReceipt(missing));
    scope.missingInferenceDecision = plain(checkInference({receipt: plain(scope.missingReceipt), modelRef: plain(scope.approvedModelRef),
      contract: plain(scope.expectedContract), inputRef: plain(scope.predictionInputRef), rows: scope.predictionRows,
      inferenceId: scope.correctedInferenceId, now: Date.now()}));
    scope.missingObservationControl = 'Derived by removing actual model evidence; this was not another backend prediction';
    require(scope.missingInferenceDecision.status === 'unknown', 'Missing actual model evidence was not unknown');
  }

  async function compareOutputs(scope) {
    scope.observedOutputComparison = plain(await backend.call('compare_outputs', {
      left: plain(scope.staleReceipt.outputRef), right: plain(scope.correctedReceipt.outputRef)}));
  }

  async function closeBackend(scope) {
    const exit = await backend.close();
    require(exit?.code === 0 && exit.signal === null, 'The numerical worker did not close cleanly');
    const blob = await readFile(backend.stderrPath);
    scope.backendLifecycle = {closed: backend.closed, workerPid: backend.process.pid,
      stderrArtifact: {kind: 'artifact', path: 'backend.stderr.log', sha256: sha256(blob), bytes: blob.length, format: 'text/plain'},
      stderrTruncated: backend.stderrTruncated};
  }

  function summarize(scope) {
    const cases = Object.fromEntries(['stale', 'corrected', 'reversed'].map(name => [name, {
      receipt: plain(scope[`${name}Receipt`]),
      decision: summary(plain(scope[`${name === 'stale' ? 'wrong' : name}InferenceDecision`])),
      backendObservation: plain(scope[`${name}BackendObservation`]),
    }]));
    const observations = Object.values(cases).map(value => value.backendObservation);
    const info = plain(scope.backend);
    const retry = plain(scope.correctedRetryObservation);
    const checks = {AApprovedByFreshEvaluation: scope.approvalDecision.allowed,
      distinctModelParameters: !same(plain(scope.modelARef.inferenceIdentity), plain(scope.modelBRef.inferenceIdentity)),
      staleActualB: same(cases.stale.receipt.modelRef.inferenceIdentity, plain(scope.modelBRef.inferenceIdentity)),
      staleOutputBlocked: !cases.stale.decision.allowed && !scope.staleOutputExposed,
      correctedActualA: same(cases.corrected.receipt.modelRef.inferenceIdentity, plain(scope.approvedModelRef.inferenceIdentity)),
      correctedOutputAccepted: cases.corrected.decision.allowed,
      reorderedFieldsBlocked: !cases.reversed.decision.allowed,
      sameAStateForReorderedFields: same(cases.reversed.receipt.modelRef.inferenceIdentity, cases.corrected.receipt.modelRef.inferenceIdentity),
      missingObservationUnknown: scope.missingInferenceDecision.status === 'unknown',
      sameWorkerAcrossRepair: observations.every(item => item.workerPid === info.workerPid && item.sessionId === info.sessionId),
      stateMeasuredBeforeAndAfter: observations.every(item => item.stateUnchangedDuringPrediction),
      onlyApprovedOutputExposed: same(plain(scope.releasedPredictionRef), cases.corrected.receipt.outputRef),
      workerClosed: scope.backendLifecycle.closed,
      repairBranchExecuted: scope.repairChoice === 'reload-approved-A',
      handoffBranchExecuted: scope.handoffChoice === 'accepted-corrected-output',
      transientFaultBeforeComputation: retry.failedBeforeComputation && retry.actualPredictionCalls === 1 && retry.injectedFailures === 1,
      transientFaultCreatedNoNumericalArtifact: retry.privateArtifactsBeforeFault === retry.privateArtifactsAfterFault,
      sameInvocationRetried: retry.attempts === 2 && retry.inferenceId === scope.correctedInferenceId,
      failedPendingWriteDiscarded: scope.retryScratch.initialPendingValueAbsent && scope.retryScratch.status === 'success'};
    require(Object.values(checks).every(Boolean), 'A native inference proof check failed');
    scope.outcome = {schema: 'footprint-ml-inference-proof-outcome/v1', source: plain(scope.fixtureSource),
      backendPlan: plain(scope.backendPlan), backend: info, expectedContract: plain(scope.expectedContract),
      approvedModelRef: plain(scope.approvedModelRef), evaluationReceipt: plain(scope.evaluationReceipt),
      approvalDecision: summary(plain(scope.approvalDecision)), cases,
      missingObservation: {receipt: plain(scope.missingReceipt), decision: summary(plain(scope.missingInferenceDecision)),
        control: scope.missingObservationControl},
      releasedPredictionRef: plain(scope.releasedPredictionRef), observedOutputComparison: plain(scope.observedOutputComparison),
      backendLifecycle: plain(scope.backendLifecycle), checks,
      execution: {orchestration: 'footprintjs-flowchart', pythonOrchestration: false,
        backendModelTrainingCalls: 1, freshValidationCalls: 1, realPredictionCalls: 3,
        persistentNumericalWorker: true, hostedInferencePlatform: false, registryWrites: false},
      nativeExecution: {engine: 'footprintjs/FlowChartExecutor', retryPolicy: plain(scope.nativeRetryPolicy),
        environment: plain(scope.numericalEnvironment),
        retryObservation: retry, finalRetryScratch: plain(scope.retryScratch), repairChoice: scope.repairChoice, handoffChoice: scope.handoffChoice},
      boundaries: [
        'Controlled stale-cache, transient-error and field-order failures in one local numerical worker, not a deployed serving system.',
        'FootPrint executes this chart, chooses its branches and retries predict-corrected. The earlier run.py example keeps orchestration in Python and uses native data capture only.',
        'The caller checks the worker PID, session, cache generation and actual model identity before retaining prediction evidence. Native scope tracking does not automatically observe worker internals.',
        'The failed attempt occurs before numerical computation or artifact creation. Native retry discards staged scope writes; it does not roll back arbitrary external side effects.',
        'The native commit log has one successful predict-corrected commit. Its retry event separately records the failed attempt; failed pending writes are not fabricated as commits.',
        'Public controlDepRecorder lookup results are saved separately as explicit application observations. The untouched executor snapshot does not contain an engine-attested control-dependency recorder.',
        'Evaluation approval and prediction-observation checks are separate decisions; neither establishes general model suitability or numerical quality.',
        'Model source hashes are checked on load. Prediction identity is measured from actual in-memory classifier/scaler state before and after computation.',
        'Blocked output artifacts remain private debugging evidence. Only the accepted A output reference is exposed by the application handoff scope key.',
        'Label differences are observed for the fixed models and batch; they are not a precondition for denying a mismatched model.',
        'Numerical warnings are retained and forwarded, not suppressed or automatically diagnosed.',
      ]};
  }

  let chart = flowChart('Declare fixed inference proof settings', declarePlan, 'declare-plan');
  chart.addFunction('Initialize the persistent numerical backend', initializeBackend, 'initialize-backend');
  chart.addFunction('Load actual A for validation', loadApprovedA, 'load-approved-A');
  chart.addFunction('Evaluate actual A on the held-out validation rows', evaluateApprovedA, 'evaluate-approved-A');
  chart.addFunction('Approve A against its fresh evaluation', approveModelA, 'approve-model-A');
  chart.addFunction('Mistakenly load actual B into the cache', loadWrongCache, 'load-wrong-cache');
  chart.addFunction('Predict with the actual stale cache', predictStale, 'predict-stale');
  chart.addFunction('Check stale output against independently approved A', guardStale, 'guard-stale');
  const repair = chart.addDeciderFunction('Choose how to handle the stale prediction', scope => decide(scope,
    [{when: {staleAllowed: {eq: false}}, then: 'repair-cache', label: 'Denied prediction: reload the approved model'}],
    {branch: 'unexpected-stale-handoff', label: 'Unexpected stale acceptance must stop the proof'}), 'route-stale');
  repair.addFunctionBranch('repair-cache', 'Reload approved A in the same worker', repairCache);
  repair.addFunctionBranch('unexpected-stale-handoff', 'Fail on an unexpected stale acceptance', function unexpectedStaleAcceptance() {
    throw new Error('Stale actual B was incorrectly accepted');
  });
  chart = repair.end();
  chart.addFunction('Commit one stable corrected invocation ID', prepareCorrectedInvocation, 'prepare-corrected-invocation');
  chart.addFunction('Predict with A, retrying one explicit transient worker failure', predictCorrected, 'predict-corrected')
    .retry({attempts: 2, backoffMs: 0, retryOn: error =>
      error instanceof NumericalBackendError && error.backendType === 'TransientInferenceFault'});
  chart.addFunction('Check the new corrected prediction', guardCorrected, 'guard-corrected');
  const handoff = chart.addDeciderFunction('Choose whether to expose the corrected output', scope => decide(scope,
    [{when: {correctedAllowed: {eq: true}}, then: 'permit-output', label: 'Matching actual A evidence permits this exact output'}],
    {branch: 'refuse-corrected-output', label: 'A refused prediction must not be exposed'}), 'route-corrected');
  handoff.addFunctionBranch('permit-output', 'Expose the exact accepted output reference', permitOutput);
  handoff.addFunctionBranch('refuse-corrected-output', 'Fail if the repaired prediction is refused', function refusedCorrection() {
    throw new Error('The corrected actual A prediction was refused');
  });
  chart = handoff.end();
  chart.addFunction('Predict with actual A and reversed columns', predictReversed, 'predict-reversed');
  chart.addFunction('Reject the observed field-order mismatch', guardReversed, 'guard-reversed');
  chart.addFunction('Retain a derived missing-observation unknown control', guardMissing, 'guard-missing');
  chart.addFunction('Compare the actual blocked and accepted labels', compareOutputs, 'compare-outputs');
  chart.addFunction('Close the persistent numerical worker', closeBackend, 'close-backend');
  chart.addFunction('Retain native inference findings', summarize, 'summarize');

  const executor = new FlowChartExecutor(chart.build());
  executor.setReadTracking('full');
  executor.setWriteTracking('full');
  executor.attachCombinedRecorder(controls);
  const observe = (type, event) => flowEvents.push({type, ...plain(event)});
  executor.attachFlowRecorder({id: 'native-inference-flow-events',
    onRunStart: event => observe('onRunStart', event),
    onRunEnd: event => observe('onRunEnd', event),
    onRunFailed: event => observe('onRunFailed', event),
    onStageExecuted: event => observe('onStageExecuted', event),
    onDecision: event => observe('onDecision', event),
    onStageRetry: event => {
      observe('onStageRetry', {...event, retryScratchAfterDiscard: executor.getSnapshot().sharedState.retryScratch ?? null});
    },
    onError: event => observe('onError', event),
  });
  try {
    await executor.run();
    const snapshot = plain(executor.getSnapshot());
    const dependencies = {};
    for (const event of flowEvents) {
      const id = event.traversalContext?.runtimeStageId;
      if (!id || event.type !== 'onStageExecuted') continue;
      const dependency = controls.lookup(id);
      if (dependency !== undefined) dependencies[id] = plain(dependency);
    }
    const recording = {schema: 'native-inference-recording/v1',
      workflow: {kind: 'native-footprint-inference/v1', orchestration: 'footprintjs-flowchart'}, snapshot,
      supplemental: {flowEvents, nativeDecisions: plain(controls.getDecisions()),
        nativeControl: {schema: 'footprint-control-lookup-snapshot/v1', runId: snapshot.runId, dependencies},
        boundary: 'Flow events and public controlDepRecorder lookup results are explicit retained application observations; snapshot remains the unmodified executor snapshot.'}};
    const outcome = snapshot.sharedState.outcome;
    await save('recording.json', recording);
    await save('outcome.json', outcome);
    return {root, recording, outcome};
  } catch (error) {
    await save('failed-recording.json', {schema: 'native-inference-failed-recording/v1',
      snapshot: plain(executor.getSnapshot()), supplemental: {flowEvents, nativeDecisions: plain(controls.getDecisions())},
      error: {name: error.name, message: error.message}});
    throw error;
  } finally {
    if (backend && !backend.closed) await backend.close();
  }
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    require(['--out', '--python', '--fixtures'].includes(argv[index]) && argv[index + 1],
      'Use --out NEW_DIRECTORY [--python PYTHON] [--fixtures DIRECTORY]');
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNativeProof(options(process.argv.slice(2))).then(({root, recording, outcome}) => {
    console.log(JSON.stringify({schema: outcome.schema, out: root, orchestration: outcome.execution.orchestration,
      validationAccuracy: outcome.evaluationReceipt.metrics.accuracy, predictionRows: outcome.backend.rows,
      observedDifferentLabels: outcome.observedOutputComparison.differentLabels,
      decisions: Object.fromEntries(Object.entries(outcome.cases).map(([name, value]) => [name, value.decision.status])),
      missingObservation: outcome.missingObservation.decision.status,
      nativeCommits: recording.snapshot.commitLog.length,
      nativeDecisions: recording.supplemental.nativeDecisions.length,
      retryEvents: recording.supplemental.flowEvents.filter(event => event.type === 'onStageRetry').length,
      checks: outcome.checks}, null, 2));
  }).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
