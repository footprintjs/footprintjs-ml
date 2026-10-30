# Check a challenger against a baseline for predefined groups

An overall winner can perform worse on an important group. The regression guard checks paired measurements against independently declared group policies. It records what evidence was used; your evaluator calculates the metrics.

This is an absolute numerical regression check, not a test of statistical significance, fairness, general model suitability or a discovery tool for unknown groups. Declare groups and tolerances before looking at evaluation results. Keep training, predictions and arrays in the numerical backend or artifacts.

## Declare the comparison

`readRegressionManifest` validates and freezes an exact JSON declaration:

```ts
const manifest = readRegressionManifest({
  kind: 'regression-manifest', schemaVersion: 1,
  comparisonId: 'pooled-vs-balanced',
  baselineModelRef, candidateModelRef,
  comparison: {
    datasetRef: heldOutDatasetRef,
    preprocessingVersion: 'raw/v1',
    evaluationMethodVersion: 'mean-squared-error/v1', parameters: {},
  },
  groups: [{
    groupId: 'rare', definitionRef, membershipRef,
    datasetRef: rareSubsetRef, expectedRows: 20,
  }],
  policies: [{
    groupId: 'rare', metric: 'mse', direction: 'min',
    maxDeterioration: 0.1, minSamples: 20,
  }],
  maxAgeMs: 86_400_000,
});
```

`comparison.datasetRef` names the parent held-out set. Each group's dataset reference names its actual evaluated subset, with `expectedRows` equal to that subset's declared row count. `definitionRef` identifies the group rule; `membershipRef` identifies the retained row membership. These are application-defined content references, not automatically computed memberships. Every declared group needs a policy. An overall metric may be another declared group covering the parent set. Groups may overlap; the guard performs no statistical correction.

Policies use `min` for a lower-is-better metric or `max` for higher-is-better. `maxDeterioration` is a nonnegative absolute allowance in the metric's own units. For MSE, deterioration is candidate minus baseline; for accuracy it is baseline minus candidate. Equality with the allowance passes. `minSamples` is a declared coverage floor; a passing count does not establish statistical reliability.

## Retain actual observations

For each group, supply `{groupId, definitionRef, membershipRef, rows, baseline, candidate}`. `baseline` and `candidate` are ordinary `EvaluationReceipt` objects made from the two actual evaluator observations on that subset. Their model content, data, preprocessing, evaluation method and parameters must match the independently declared comparison. Model comparison includes the exact checkpoint and any measured inference identity, while permitting relocated paths or new runtime handles for the same durable contents.

`createRegressionReceipt({regressionId, createdAt, manifest, observations})` records a detached immutable bundle. It does not train, evaluate or grant approval. `readRegressionReceipt(value)` validates a saved bundle without repeating evaluation. Incomplete observations can be retained so investigation can explain missing evidence.

Call `checkRegression({receipt, manifest, observations, modelRef, now?})` with the independently pinned manifest and separately retained observations. Do not copy those authorities from the offered receipt. A self-consistent offered receipt cannot replace a different pinned observation.

- `allow`: all required groups, metrics, bindings, sample floors, tolerances and time requirements pass.
- `deny`: a known model/context/group binding conflict, conflicting observations, or measured regression violates policy.
- `unknown`: required observations/metrics/receipt are missing, evidence is invalid or required coverage is too small. Neither `unknown` nor `deny` permits publication.

If `maxAgeMs` is declared, it applies to the comparison receipt and both models' evaluation receipts in every group. A newly wrapped old evaluation does not refresh its measurement. Future-dated evidence does not pass.

## Compose with checked publication

An independently pinned `ModelReleasePlan` can add:

```ts
regression: { manifestRef, observationsRef, receiptRef }
```

Presence makes the check required. There is no `required: false` bypass. An omitted receipt stays unknown. Preparation and new publication load and hash-check those actual JSON artifacts, the parent data and every declared definition, membership and subset artifact, then run the guard alongside quality, selection and any required lineage. Hash checks establish content identity; they do not verify that an application's group rule produced the claimed membership or that its numerical scores are truthful.

The manifest's candidate must cover the verified proposed model. Required evidence identities enter the semantic publication payload. `validUntil` is the earliest applicable quality or paired-evaluation/receipt expiry. New publication rechecks the pinned evidence; a confirmed historical retry still acknowledges the original exact effect without claiming current model quality. Older plans without the optional block retain their original behavior and preparation shape.

See [checked release](RELEASE.md), the [executed Python example](examples/regression/README.md), and [evaluation receipts](features/evaluation/README.md).

## Python and saved investigation

A started `WorkflowCapture` exposes `read_regression_manifest`, `create_regression_receipt`, `read_regression_receipt` and `check_regression` through the same TypeScript core. Arguments keep camelCase JSON fields. Read the actual manifest, observations, receipt and proposed model through scope, then assign the returned decision to scope. Python keeps its numerical work and control flow.

The example pins full native guard/release responses as managed JSON artifacts and captures compact decision views alongside their references. This respects the recorder's per-value limit while retaining the original reasons, comparisons and complete response bytes. Models and prediction arrays remain outside scope.

Reopen `recording.json` with the existing [Lens/foottrace tools](BACKTRACKING.md). Backtracking follows the captured reads from the refused release to its group evidence and declaration. It starts no trainer and computes no new metric. It explains a policy decision from recorded inputs, not the statistical cause of the model's errors. Complete structured logs can retain the same facts; FootPrint supplies reusable state/read history and investigation tools.
