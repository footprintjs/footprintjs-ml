# A better average can conceal a worse predefined group

This executed NumPy example compares two ordinary linear regressors on a fixed synthetic population. It declares the data protocol, two model configurations, groups and main limits before generating data, fitting models or measuring errors. Group membership comes from a `population` metadata field; it is not chosen from prediction errors.

The training and validation populations each contain 90 majority rows and 10 rare rows. Both groups share balanced x grids and slope 2, while their generating intercepts are 4 and 1. The baseline fits least squares with equal population mass; the challenger fits least squares with equal row mass. The simple linear predictor uses x alone. This deliberate model limitation and imbalance create a controlled tradeoff without tuning the validation set.

In the retained development run, the observed mean squared errors were:

| Evaluation | Baseline | Pooled challenger |
| --- | ---: | ---: |
| Overall, 100 rows | 2.25 | 0.81 |
| Majority, 90 rows | 2.25 | 0.09 |
| Rare, 10 rows | 2.25 | 7.29 |

Both models pass the independently declared overall MSE ceiling of 3, and overall selection chooses the pooled challenger. Its rare-group deterioration is approximately 5.04, above the predeclared absolute limit of 0.1. The regression guard therefore refuses it. These are synthetic controlled observations, not a statistical-significance, protected-class fairness or production-representativeness result.

## Run and reopen

Use the matching SDK and its explicitly installed Node helper. NumPy is the only numerical example dependency:

```sh
python -m pip install -r examples/regression/requirements.txt
python examples/regression/run.py --out ./regression-run
python -I -S examples/regression/audit.py --run ./regression-run
node --permission --allow-fs-read=. --allow-fs-write=./regression-run examples/regression/investigate.mjs --run ./regression-run
```

`--runtime-dir DIR` selects an installed helper explicitly. Use a new output directory; earlier runs are never overwritten. The investigator uses the existing Lens/foottrace toolpack with child-process permission absent. It reopens JSON after Python exits and performs no training, evaluation, guard recomputation or publication.

Scope contains model/data/artifact references, ordinary evaluation receipts, manifest declarations and exact decision statuses/reasons/comparisons. Models and prediction arrays remain in the numerical backend or artifacts. Full original guard/release JSON can exceed the 64 KiB scope-value limit, so it is retained as managed JSON artifacts. Compact scope views omit duplicated `bindings` and preparation `record` fields; the saved audit checks their exact projection and retained full responses. Warnings and reasons are preserved.

## Controls and actual handoff

- A mismatched proposed model and changed evaluation protocol are refused.
- Missing receipt evidence remains unknown. A separately labeled what-if policy requiring 11 rare samples for the actual 10 is also unknown; it does not retroactively replace the original minimum of 5.
- The baseline is evaluated again with distinct receipts as an unchanged-model control. Its required group checks pass. This is three evaluation passes across two unique trained models: the historical outcome key `execution.evaluatedModels: 3` counts those passes.
- The pooled release composes real overall quality, full two-candidate selection and the required regression evidence. Quality and selection allow it; regression prevents the publisher from receiving a new effect.
- A separately declared singleton selection retains the unchanged baseline. It is not a correction of the original two-way winner or a new improved challenger. The existing Node local publisher consumes its exact checked bytes once. Read-only retry acknowledges the same committed receipt.

Python owns stage order and retry. Its explicit scope reads/writes use the native foottrace writer; no arbitrary Python locals or native executor control edges are invented. The example-only publisher adapter forwards references through a bounded local Node subprocess to the existing `createLocalModelPublisher`; it does not duplicate that receiver's CAS/idempotency algorithm in Python.

The saved scalar audit checks all 600 predicted rows, actual data/model/definition/membership bytes, ordinary receipt context and counts, declared scalar weighted/pooled normal equations, group deltas and compact/full-response correspondence. It validates this narrow linear profile, not arbitrary trainers or a dishonest producer. The local receiver still has its documented one-host cooperating-writer, trusted-filesystem and non-durable boundaries. A passing group contract is not proof that the groups or policy are suitable for another application.
