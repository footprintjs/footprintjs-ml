# Monitor the model actually loaded, after its labels arrive

This executed NumPy proof first trains, validates and publishes one linear predictor through the existing checked release API and local Node receiver. It then calls the actual receiver's `readTarget`, reads the installed artifact from the publisher's own store, checks its length/hash, and restores that exact predictor into a fresh numerical backend. The approved training reference and the observed restored-process reference have different runtime sessions but the same exact checkpoint and inference identity.

Two predefined closed event-time batches are processed by that local backend now. This is an observed local target/model snapshot; it does not claim that a hosted model served those historical event times. Input schema, window bounds/IDs/counts, label-source version, keyed-join protocol and monitoring limits are declared before model fitting or window evaluation. Both batches have the same x pattern and twelve distinct row IDs each.

W1 labels follow the training relation `y = 2x + 1`. W2 deliberately follows `y = 2x + 4`. The same loaded model therefore has near-zero measured W1 MSE and measured W2 MSE about 9, above the fixed ceiling of 1. The experiment knows its simulated target-process change. The monitoring guard reports the measured threshold violation; it does not identify feature drift or infer a statistical root cause.

## Run and reopen

Use the matching SDK and its explicitly installed Node helper. NumPy is an explicit example dependency:

```sh
python -m pip install -r examples/monitoring/requirements.txt
python examples/monitoring/run.py --out ./monitoring-run
python -I -S examples/monitoring/audit.py --run ./monitoring-run
node --permission --allow-fs-read=. --allow-fs-write=./monitoring-run examples/monitoring/investigate.mjs --run ./monitoring-run
```

`--runtime-dir DIR` selects a separately installed helper. Choose a new output directory; earlier runs are never overwritten. The saved investigator runs the existing Lens/foottrace toolpack without child-process permission. It reads JSON after Python exits and repeats no training, prediction, label join, guard or publication operation.

## Evidence and controls

| Case | Recorded result |
| --- | --- |
| Complete W1 labels | Healthy, allowed, no intervention recommended. |
| The same intact W1 label rows in reverse order | Healthy and allowed. This is a keyed join, not positional pairing. |
| W2 prediction before labels are made available | Unknown health; wait for evidence. |
| Derived subset of three W2 labels out of twelve | Unknown: below the independently declared eight-row floor and complete-coverage requirement. |
| Complete W2 labels | Degraded; recommend review after measuring MSE about 9. |
| Duplicated or unmatched label IDs | Deny the mapping evidence; review evidence, without claiming model degradation. |
| W2 labels with the same IDs but foreign window bounds | The backend measures cross-window conflicts; deny that mapping evidence. |
| W1's saved report offered for W2 | Deny the borrowed context, even though W1 itself was healthy. |

Reversing intact keyed rows is valid. Changing label values while keeping their IDs valid is a different problem: metadata alone cannot prove that a label source told the truth. The supplied scalar audit can corroborate this known synthetic fixture's label-generation rule; the pure monitoring contract does not authenticate label truth.

Numerical models, arrays, window rows and label/prediction tables stay in the backend or length/hash-bound artifacts. Scope holds actual publication/model/input/membership references, measured join facts, ordinary inference/evaluation receipts and compact native decisions. Label consumers read the actual `labelBatchRefs` through scope inside the consuming stage. Full original native responses are pinned separately, and the saved audit checks their exact bindings and compact-view correspondence. No invented commit log or control edge is used. Python owns stage order; native missing-control warnings remain visible when reopening its foottrace capture.

The monitoring decision follows its independently consumed expected publication through scope. Backtracking the external `readTarget` result alone does not automatically discover the earlier filesystem writer. The returned target receipt and the saved installed-byte audit provide separate consistency evidence; this example does not invent that missing external producer edge.

The monitoring decisions cause no serving pause, alias update or rollback. The original approved publication remains the sole local publication and its target remains unchanged. Review is a recommendation for the application, not an external action implemented by this guard. This closed-batch proof supplies neither a streaming scheduler, online label connector, hosted-serving attestation, statistical guarantee nor distributed durability.
