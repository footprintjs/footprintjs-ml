# Experiments, model selection and release

A model can have a valid evaluation and pass an absolute error threshold while still being the wrong candidate to choose. Selection answers a separate question: **did this workflow choose the winner from its complete declared candidate set using the declared metric and direction?**

The core root import supplies `runExperiment`, `readSelectionManifest`, `createSelectionReceipt`, `readSelectionReceipt` and `checkSelection`. They add no trainer, worker, numerical engine, runtime dependency or Node-only import. Models and numerical arrays remain in the backend. Configuration JSON, references and evaluation records belong in workflow scope.

## Declare before execution

```ts
import {
  readSelectionManifest, runExperiment, createSelectionReceipt,
  checkSelection, checkRelease,
} from 'footprintjs-ml';

const declared = readSelectionManifest({
  kind: 'selection-manifest',
  schemaVersion: 1,
  experimentId: 'regression-budget-comparison-1',
  candidates: [
    { candidateId: 'steps-30', configuration: { steps: 30, learningRate: 0.01 } },
    { candidateId: 'steps-60', configuration: { steps: 60, learningRate: 0.01 } },
    { candidateId: 'steps-100', configuration: { steps: 100, learningRate: 0.01 } },
  ],
  comparison: {
    datasetRef: validationDatasetRef,
    preprocessingVersion: 'raw-scalar-input/v1',
    evaluationMethodVersion: 'regression-mse/original-target-units/v1',
    parameters: {},
  },
  policy: { metric: 'mse', direction: 'min', tieBreak: 'candidate-id-ascending' },
});

// Persist/pin this declaration independently before running any candidate.
// Do not later replace it with the manifest found inside an offered receipt.
```

`readSelectionManifest` validates and deeply freezes the declaration. Candidate IDs must be unique and nonempty; each configuration is plain finite JSON. The declared set must be nonempty. Comparison data, role, dimensions, preprocessing version, evaluation method and parameters define the common evaluation contract.

The policy supports one metric with `min` or `max`. Exact numerical ties use ascending candidate IDs in locale-independent UTF-16 order. It does not apply an epsilon or statistical test. The evaluator's named `evaluationMethodVersion` must define the metric's meaning and units. The core cannot detect a backend that labels normalized error as original-unit error while claiming the same method version.

Candidate/configuration and result arrays normalize into candidate-ID order. The example IDs above therefore execute **steps-100, steps-30, steps-60**. Input array order cannot change selection or tie breaking. Use padded IDs if a particular deterministic execution order is useful.

## Run existing numerical work

The following is an application integration sketch. `trainer` is an already connected adapter; the caller supplies `validationDatasetRef` and the actual training configurations.

```ts
const results = await runExperiment({
  manifest: declared,
  async executeCandidate(candidate, comparison) {
    const trained = await trainer.train(candidate.configuration);
    const { receipt: evaluation } = await trainer.evaluate({
      modelRef: trained.modelRef,
      ...comparison,
    });
    return {
      candidateId: candidate.candidateId,
      configuration: candidate.configuration,
      modelRef: trained.modelRef,
      evaluation,
    };
  },
});

// Persist these observed results independently of any later offered receipt.
```

`executeCandidate` receives frozen candidate/comparison values and must return a `SelectionCandidateResult`: candidate ID, configuration, model reference and an existing `EvaluationReceipt`. Results must match that candidate/configuration and the common comparison. The receipt must cover its model using the existing v1/v2 identity semantics, include a finite value for the selected metric, and not be dated after the completion check.

The driver awaits candidates sequentially and returns a frozen complete result array only after all succeed. It rejects missing, duplicate, undeclared, mismatched or incomparable results. A failed callback or progress hook throws; no successful partial experiment is returned. The caller owns retries, parallel scheduling, backend side effects, disposal and cleanup. The optional `onResult(result, index)` hook can retain completed references for FootPrint provenance or cleanup, including before a later failure. It does not turn a partial subset into a valid experiment.

The optional `now` supplies a fixed wall-clock check time, mainly for saved-data tests. Production code normally omits it so completion uses the current clock. A newly created evaluation dated after a supplied fixed `now` is refused.

The callback's reported configuration remains a trusted observation. Checking that it matches the declaration does not prove the numerical backend actually used those settings. Use explicit trainer/plugin observations and profiles when stronger configuration provenance is required. The helper itself neither computes gradients nor verifies numerical correctness.

## Record the comparison

```ts
const selection = createSelectionReceipt({
  selectionId: 'selection-1',
  createdAt: Date.now(),
  manifest: declared,
  results,
});

const chosen = results.find(r => r.candidateId === selection.selectedCandidateId)!;
```

The constructor computes the ranking, selected candidate ID and selected model reference. It accepts no caller-provided ranking, score or chosen winner. The frozen JSON receipt retains the complete declaration and observed results, including model/evaluation references and all their metrics. `readSelectionReceipt(saved)` validates the stated schema and recomputes its ranking and winner; altered saved scores, rank order or winner fields do not become accepted facts.

A self-consistent rewritten receipt can still contain a different manifest or fabricated evaluation. Reading it is structural consistency checking. The publication guard compares it against separately retained expected authority.

## Verify before publication

```ts
// Inspect the actual registered live handle immediately before publication.
const liveModel = await trainer.verifyModel({ modelRef: chosen.modelRef });
const now = Date.now();

const selectionDecision = checkSelection({
  receipt: selection,
  manifest: declared,  // independently pinned declaration
  results,             // independently retained observed results
  modelRef: liveModel,
  now,
});

const qualityDecision = checkRelease({
  modelRef: liveModel,
  ...declared.comparison,
  receipt: chosen.evaluation,
  policy: { metric: 'mse', operator: 'lte', threshold: 0.01 },
  now,
});

if (!selectionDecision.allowed || !qualityDecision.allowed) {
  throw new Error('The proposed model does not qualify for this local release');
}
// Your publication stage performs its own side effect after both checks.
```

The real quality threshold should also be declared before evaluation. Selection does not impose a quality threshold, data-lineage rule or freshness maximum; compose the existing checks required by the application. `checkRelease` can enforce a winning evaluation's `maxAgeMs` when that policy is declared. Selection rejects future-dated evaluation/selection evidence, but otherwise does not expire old results.

`checkSelection` requires the independent manifest and independent result set on every call. It returns a frozen `SelectionDecision` with `allowed`, `status`, reasons, check time, expected selected candidate and auditable proposed/receipt/expected bindings. Missing or malformed evidence returns `allowed: false` and `unknown`. Valid but conflicting evidence returns `deny`. A receipt cannot omit a declared competitor, rewrite its configuration/direction/comparison or change an observed metric while the independent expected inputs remain intact.

Do not pass `receipt.manifest` and `receipt.results` back as the expected authority. That only checks the receipt against itself. Pin and load expected inputs through the application's trusted storage/provenance boundary; these plain JSON consistency records are not signatures or authenticated attestations.

The pure guard does not contact the backend and cannot prove that a supplied handle is live. It compares durable content identities and deliberately ignores runtime handle/session changes. Live verification is the adapter's responsibility. For v2 evaluations, the proposed model must match the winning **inference identity**; an optimizer-only checkpoint change can still qualify. This does not assert identical training state or faithful resume. V1 evidence retains exact checkpoint coverage and cannot silently gain v2 inference-only coverage. SHA hex case and artifact location are not content differences; digest, byte count, format, profile, role, dimensions and identity presence retain their existing meanings.

## Reopen saved evidence in Lens

The optional saved-run binding can identify the selection manifest, results, receipt, decision and chosen candidate scope keys. It reuses existing Lens/foottrace tools:

```ts
import { openAdapterWorkflowRun } from 'footprintjs-ml/lens';

const investigation = openAdapterWorkflowRun(savedRecording, existingLensBridge);
await investigation.investigate('selection');
```

The recording must provide its explicit `mlInvestigation.selection` bindings. No training or worker starts to inspect the saved comparison. Existing missing-dependency/coverage warnings remain evidence limits.

## Current boundary and verification

The result means “winner of this complete declared finite comparison,” not best possible model, unbiased generalization, safe deployment or correct gradients. Eligibility filters, missing-candidate recovery, adaptive search, cross-validation aggregation, multiple objectives, confidence intervals, subgroup/baseline gates and distributed scheduling are not implemented here. Validation must remain separate from fitting; selection consistency cannot establish valid data use on its own.

The selection suite exercises min/max, exact ties, winner swaps, complete-set/configuration/metric spoofing against independently retained inputs, comparability, future timestamps, malformed evidence, casing/location/handle changes, v1/v2 coverage and failed experiment callbacks. Run from the package directory:

```sh
node --permission --allow-fs-read='*' tests/selection.test.mjs
```

The 39 core selection tests passed with child processes denied. They use references and synthetic evaluation records; the separate JAX model-selection example supplies real numerical/backend and saved-Lens evidence.
