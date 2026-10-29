import { canonicalJson, detached, fail, finiteNumber, jsonObject, nonempty, readCheckpointRef,
  readDatasetRef, readModelRef, sameArtifact, sameDataset, sameModelContent, sameRuntime } from './contracts.js';
import type { BackendEvaluation, CheckpointRef, DatasetRef, DisposeResult, EvaluationReceipt,
  EvaluationRequest, JsonObject, JsonValue, ModelRef, TrainerPort, TrainResult } from './contracts.js';
import { createEvaluationReceipt } from './receipts.js';
import { artifactRef, checkpointRef } from './contracts.js';

export const ML_EVENTS = Object.freeze({
  trainStarted: 'footprintjs.ml.train.started', trainCompleted: 'footprintjs.ml.train.completed',
  evaluateStarted: 'footprintjs.ml.evaluate.started', evaluateCompleted: 'footprintjs.ml.evaluate.completed',
  loadStarted: 'footprintjs.ml.load.started', loadCompleted: 'footprintjs.ml.load.completed',
  disposeStarted: 'footprintjs.ml.dispose.started', disposeCompleted: 'footprintjs.ml.dispose.completed',
  inspectStarted: 'footprintjs.ml.inspect.started', inspectCompleted: 'footprintjs.ml.inspect.completed',
  failed: 'footprintjs.ml.operation.failed',
});
export interface TrainerAdapterOptions {
  readonly clock?: () => number;
  readonly emit?: (name: string, payload: JsonValue) => void;
}
export interface TrainerAdapter<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef> {
  train(request: JsonObject): Promise<TrainResult<M> & { readonly checkpointRef: CheckpointRef }>;
  evaluate(request: EvaluationRequest<M, D>): Promise<{ readonly receipt: EvaluationReceipt<M, D>; readonly backendResult: BackendEvaluation<M, D> }>;
  loadCheckpoint(request: { readonly checkpoint: CheckpointRef }): Promise<M>;
  dispose(request: { readonly modelRef: M }): Promise<DisposeResult<M>>;
  /** Always requires an actual backend inspection, including for legacy refs. */
  verifyModel(request: { readonly modelRef: M }): Promise<M>;
}

/** Thin ownership/identity boundary. Numerical work belongs to the supplied port. */
export function createTrainerAdapter<M extends ModelRef = ModelRef, D extends DatasetRef = DatasetRef>(
  port: TrainerPort<M, D>, options: TrainerAdapterOptions = {},
): TrainerAdapter<M, D> {
  const clock = options.clock ?? Date.now;
  const disposed = new Set<string>(), published = new Map<string, M>();
  const key = (ref: ModelRef) => JSON.stringify([ref.sessionId, ref.handle]);
  // Remember a possible handle without invoking an accessor on malformed output.
  const candidateRef = (result: unknown): unknown => {
    if (result === null || typeof result !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(result, 'modelRef');
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const session = () => nonempty(port.sessionId, 'backend sessionId');
  const notify = (name: string, payload: unknown) => options.emit?.(name, detached(payload) as JsonValue);
  const failed = (operation: string, error: unknown) => {
    try { notify(ML_EVENTS.failed, { operation, error: error instanceof Error ? error.message : String(error) }); }
    catch { /* Do not replace the original operation failure with an observer failure. */ }
  };
  const current = (ref: M, expected: string) => {
    if (session() !== expected || ref.sessionId !== expected) fail('stale-runtime-reference', 'Model reference belongs to a stale or foreign backend session');
    if (disposed.has(key(ref))) fail('released-model', 'Model reference has already been released');
    const previous = published.get(key(ref));
    if (previous && !sameModelContent(previous, ref))
      fail('runtime-handle-reused', 'A runtime handle changed its checkpoint or inference identity');
  };
  const inspect = async (ref: M, expected: string, purpose: string, required: boolean, remember = false): Promise<M> => {
    current(ref, expected);
    if (port.inspect === undefined) {
      if (required || ref.inferenceIdentity !== undefined)
        fail('inspection-required', 'Live model inspection is required for this operation and inference-aware references');
      return ref;
    }
    notify(ML_EVENTS.inspectStarted, { modelRef: ref, purpose });
    const result = detached(await port.inspect(detached({ modelRef: ref })), 'inspection result');
    const observed = readModelRef<M>(result.modelRef);
    current(observed, expected);
    if (!sameRuntime(ref, observed) || !sameModelContent(ref, observed))
      fail('live-model-mismatch', 'Backend inspection observed a different live model, checkpoint, or inference identity');
    notify(ML_EVENTS.inspectCompleted, { modelRef: observed, purpose });
    if (remember) published.set(key(observed), observed);
    return observed;
  };
  const cleanup = async (candidate: unknown, expected: string) => {
    let ref: M;
    try { ref = readModelRef<M>(candidate); }
    catch { return; /* No validated handle is available to release. */ }
    if (published.has(key(ref)) || disposed.has(key(ref))) return;
    const context = { purpose: 'unpublished-result-cleanup', modelRef: ref };
    const reportFailure = (error: unknown) => {
      try { notify(ML_EVENTS.failed, { operation: 'dispose', ...context,
        error: error instanceof Error ? error.message : String(error) }); }
      catch { /* Preserve the original rejected-result error even if observation fails. */ }
    };
    let returned: M;
    try {
      if (session() !== expected || ref.sessionId !== expected)
        fail('cleanup-session-mismatch', 'Cannot release an unpublished result from a stale or foreign backend session');
      // Observation must not prevent an already required cleanup operation.
      try { notify(ML_EVENTS.disposeStarted, context); } catch { /* Best effort. */ }
      const result = detached(await port.dispose(detached({ modelRef: ref })), 'cleanup result');
      returned = readModelRef<M>(result.modelRef);
      if (session() !== expected || !sameRuntime(ref, returned) || !sameModelContent(ref, returned))
        fail('cleanup-reference-mismatch', 'Backend cleanup confirmation refers to a different runtime model');
      if (result.released !== true) fail('cleanup-not-confirmed', 'Backend did not confirm unpublished model disposal');
      disposed.add(key(ref));
    } catch (error) { reportFailure(error); return; }
    try { notify(ML_EVENTS.disposeCompleted, { ...context, modelRef: returned, released: true }); }
    catch { /* Disposal was confirmed; an observer failure does not change that fact. */ }
  };
  return {
    async train(request) {
      const expected = session();
      const input = detached(jsonObject(request, 'training request'));
      let candidate: unknown;
      try {
        notify(ML_EVENTS.trainStarted, { request: input, sessionId: expected });
        if (input.modelRef !== undefined) {
          const sourceRef = readModelRef<M>(input.modelRef);
          await inspect(sourceRef, expected, 'training-source', sourceRef.inferenceIdentity !== undefined, true);
        }
        const raw = await port.train(input); candidate = candidateRef(raw);
        const result = detached(raw, 'training result');
        const ref = readModelRef<M>(result.modelRef), checkpoint = artifactRef(result.checkpoint);
        current(ref, expected);
        if (!sameArtifact(ref.originArtifact, checkpoint)) fail('training-checkpoint-mismatch', 'Training checkpoint differs from the returned model origin');
        const observed = await inspect(ref, expected, 'training-result', ref.inferenceIdentity !== undefined);
        const output = detached({ ...result, modelRef: observed, checkpoint, checkpointRef: checkpointRef(checkpoint) });
        notify(ML_EVENTS.trainCompleted, output); published.set(key(observed), observed);
        return output;
      } catch (error) { await cleanup(candidate, expected); failed('train', error); throw error; }
    },
    async evaluate(request) {
      const expected = session();
      try {
        const rawInput = jsonObject(request, 'evaluation request');
        const proposedModel = readModelRef<M>(rawInput.modelRef), datasetRef = readDatasetRef<D>(rawInput.datasetRef);
        current(proposedModel, expected);
        if (datasetRef.sessionId !== expected) fail('stale-dataset-reference', 'Dataset reference belongs to a stale or foreign backend session');
        const modelRef = await inspect(proposedModel, expected, 'before-evaluation', proposedModel.inferenceIdentity !== undefined, true);
        const input: EvaluationRequest<M, D> = detached({ modelRef, datasetRef,
          preprocessingVersion: nonempty(rawInput.preprocessingVersion, 'preprocessingVersion'),
          evaluationMethodVersion: nonempty(rawInput.evaluationMethodVersion, 'evaluationMethodVersion'),
          parameters: rawInput.parameters === undefined ? {} : jsonObject(rawInput.parameters, 'parameters') });
        notify(ML_EVENTS.evaluateStarted, input);
        const raw = await port.evaluate(input);
        const result = detached(raw, 'evaluation result');
        const observedModel = readModelRef<M>(result.modelRef), observedDataset = readDatasetRef<D>(result.datasetRef);
        current(observedModel, expected);
        if (!sameRuntime(modelRef, observedModel) || !sameModelContent(modelRef, observedModel))
          fail('evaluation-model-mismatch', 'Backend evaluated a different runtime model, checkpoint, or inference identity');
        if (!sameRuntime(datasetRef, observedDataset) || !sameDataset(datasetRef, observedDataset))
          fail('evaluation-dataset-mismatch', 'Backend evaluated a different runtime dataset or durable dataset identity');
        if (result.preprocessingVersion !== input.preprocessingVersion || result.evaluationMethodVersion !== input.evaluationMethodVersion)
          fail('evaluation-method-mismatch', 'Backend preprocessing/evaluation identities differ from the request or are missing');
        const actualParameters = result.parameters === undefined ? {} : jsonObject(result.parameters, 'backend parameters');
        if (canonicalJson(actualParameters) !== canonicalJson(input.parameters ?? {}))
          fail('evaluation-parameters-mismatch', 'Backend evaluation parameters differ or omitted requested nonempty parameters');
        await inspect(observedModel, expected, 'after-evaluation', observedModel.inferenceIdentity !== undefined, true);
        const receipt = createEvaluationReceipt<M, D>({ ...result, modelRef: observedModel, datasetRef: observedDataset,
          parameters: actualParameters, createdAt: finiteNumber(clock(), 'clock', 0) });
        const output = detached({ receipt, backendResult: result });
        notify(ML_EVENTS.evaluateCompleted, { receipt });
        return output;
      } catch (error) { failed('evaluate', error); throw error; }
    },
    async loadCheckpoint(request) {
      const expected = session(); let candidate: unknown;
      try {
        const input = jsonObject(request, 'load request'), checkpoint = readCheckpointRef(input.checkpoint);
        notify(ML_EVENTS.loadStarted, { checkpoint, sessionId: expected });
        const raw = await port.load(detached({ checkpoint })); candidate = candidateRef(raw);
        const result = detached(raw, 'load result');
        const ref = readModelRef<M>(result.modelRef), actual = artifactRef(result.actualArtifact);
        current(ref, expected);
        if (!sameArtifact(checkpoint.artifact, actual) || !sameArtifact(ref.originArtifact, actual))
          fail('loaded-checkpoint-mismatch', 'Actually loaded checkpoint differs from the requested checkpoint or returned model origin');
        const observed = await inspect(ref, expected, 'loaded-result', ref.inferenceIdentity !== undefined);
        notify(ML_EVENTS.loadCompleted, { ...result, modelRef: observed }); published.set(key(observed), observed);
        return observed;
      } catch (error) { await cleanup(candidate, expected); failed('load', error); throw error; }
    },
    async dispose(request) {
      const expected = session();
      try {
        const input = jsonObject(request, 'dispose request'), proposed = readModelRef<M>(input.modelRef);
        const ref = await inspect(proposed, expected, 'before-disposal', proposed.inferenceIdentity !== undefined, true);
        current(ref, expected); notify(ML_EVENTS.disposeStarted, { modelRef: ref });
        const raw = await port.dispose(detached({ modelRef: ref }));
        const result = detached(raw, 'dispose result'), returned = readModelRef<M>(result.modelRef);
        if (session() !== expected || !sameRuntime(ref, returned) || !sameModelContent(ref, returned))
          fail('dispose-reference-mismatch', 'Backend disposal confirmation refers to a different runtime model');
        if (result.released !== true) fail('dispose-not-confirmed', 'Backend did not confirm model disposal');
        disposed.add(key(ref)); published.delete(key(ref));
        const output = detached({ modelRef: returned, released: true });
        notify(ML_EVENTS.disposeCompleted, output); return output;
      } catch (error) { failed('dispose', error); throw error; }
    },
    async verifyModel(request) {
      const expected = session();
      try {
        const input = jsonObject(request, 'verify request'), ref = readModelRef<M>(input.modelRef);
        return await inspect(ref, expected, 'verify-model', true, true);
      } catch (error) { failed('verify-model', error); throw error; }
    },
  };
}
