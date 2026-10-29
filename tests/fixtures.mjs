export const NOW = 1_800_000_000_000;
export const clone = value => structuredClone(value);
export const checkpointArtifact = () => ({ kind: 'artifact', path: 'checkpoints/candidate.pkl',
  sha256: 'a'.repeat(64), bytes: 1024, format: 'trusted-model/v1' });
export const model = () => ({ kind: 'model', sessionId: 'worker-A', handle: 7,
  candidateId: 'candidate-A', originArtifact: checkpointArtifact() });
export const dataset = () => ({ kind: 'dataset', sessionId: 'worker-A', handle: 2,
  role: 'validation', rows: 50, shape: [50, 64], artifact: { kind: 'artifact',
    path: 'datasets/validation.json', sha256: 'b'.repeat(64), bytes: 512, format: 'dataset/json-v1' } });
export const request = () => ({ modelRef: model(), datasetRef: dataset(),
  preprocessingVersion: 'standard-scaler/train-only/v1', evaluationMethodVersion: 'held-out-classification/v1',
  parameters: { predictionMode: 'labels', options: { seed: 7 } } });
export const evaluated = () => ({ ...request(), evaluationId: 'evaluation-A', createdAt: NOW,
  metrics: { accuracy: 0.97, logLoss: 0.11 } });
export const releaseRequest = receipt => ({ ...request(), receipt,
  policy: { metric: 'accuracy', operator: 'gte', threshold: 0.95 }, now: NOW + 100 });

export function fakePort(overrides = {}) {
  const calls = { train: [], evaluate: [], load: [], dispose: [] };
  const port = {
    sessionId: 'worker-A',
    async train(input) { calls.train.push(clone(input)); return { modelRef: model(), checkpoint: checkpointArtifact() }; },
    async evaluate(input) { calls.evaluate.push(clone(input)); return { ...clone(input),
      evaluationId: 'evaluation-A', metrics: { accuracy: 0.97, logLoss: 0.11 } }; },
    async load(input) { calls.load.push(clone(input)); return { modelRef: model(), actualArtifact: clone(input.checkpoint.artifact) }; },
    async dispose(input) { calls.dispose.push(clone(input)); return { modelRef: clone(input.modelRef), released: true }; },
    ...overrides,
  };
  return { port, calls };
}
