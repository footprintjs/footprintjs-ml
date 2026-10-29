# Use the native selection and data-lineage guards from Python

Python owns this workflow's loops, proposals and stage ordering. `WorkflowCapture` sends receipt and guard operations to the existing TypeScript contracts. This example adds no Python ranking algorithm or leakage-policy implementation and imports no numerical framework.

With the matching SDK helper installed, choose a new output directory:

```sh
python -m footprint_ml_workflow example-guards --out ./python-guards-run
python -m footprint_ml_workflow investigate --run ./python-guards-run --variable wrongSelectionDecision
```

From a built source checkout, `python examples/python-guards/run.py --out ./python-guards-run` also works. An installed `footprint_ml_workflow` module takes precedence. A source checkout can fall back to its `python/` module and built helper. `--runtime-dir DIR` selects an explicit installed helper. See [Python setup](https://github.com/footprintjs/footprintjs-ml/blob/main/PYTHON.md).

The recording contains two separate sections:

- **Selection:** three actual retained JAX Gaussian-process evaluations use the same comparison context. The plan is pinned before offered receipts. A proposed `steps-30` model passes its own MSE threshold but fails selection against a legitimate minimum-MSE winner receipt. A second control offers a reversed-direction receipt; the independent declaration still rejects it. `steps-100` passes the declared comparison.
- **Data lineage:** separate actual retained digit-classifier runs have the same recorded accuracy, approximately 96.18%. The clean run fitted preprocessing on 1,149 training rows. The faulty run also fitted on all 288 validation rows. Their retained original row-ID artifacts support a new byte/hash and set-intersection audit. The native lineage guard allows clean evidence and denies the faulty fit. These are not lineage claims about the JAX models.

Missing-receipt and removed-overlap controls remain `unknown`; they do not invent zero overlap. Scores, training, preprocessing fits and numerical evaluations are not repeated. Only selection/guard calculations and retained-membership set intersections run again.

`recording.json` is captured live. `outcome.json` equals its recorded `outcome` scope value; full native decisions remain under the scope keys listed in that outcome. All business operands reach the guards through actual scope reads. [Native investigation](https://github.com/footprintjs/footprintjs-ml/blob/main/BACKTRACKING.md) can subsequently inspect this JSON without starting numerical work.

`observations.json` retains original source-trace digests, typed references and numerical/data-use facts. `evidence/*.json` contains original membership bytes, not model arrays. The projection script verifies referenced original model, data and scaler bytes before extraction; those binaries are not bundled. Hashes do not authenticate the original backend or establish numerical correctness.

To reproduce the projection from the original retained proofs, write a new destination:

```sh
python -I -S examples/python-guards/extract_observations.py \
  --selection /path/to/model-selection/run/trace.json \
  --lineage-root /path/to/data-lineage/run \
  --out /new/folder/observations.json
```

The original recordings remain untouched. Verify a completed run with `python -I -S examples/python-guards/verify.py --run ./python-guards-run`. This checks saved outcomes and their recording binding; it does not repeat the native guard or numerical work.

The [saved investigation example](https://github.com/footprintjs/footprintjs-ml/blob/main/examples/python-guards/investigate.mjs) uses the existing public Lens/foottrace tools for the selection, lineage and missing-evidence decisions. From a source checkout with the documented Node dependencies installed, run `node examples/python-guards/investigate.mjs --run ./python-guards-run`. It preserves the original JSON and writes `investigation.json` with native responses and checks. Neither this investigation nor the single-value Python command reruns a guard, trains or evaluates a model.
