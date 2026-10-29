# Backtrack a model-selection decision without repeating training

This proof retains three actual JAX Gaussian-process evaluation observations from the earlier selection experiment. It runs a **new** FootPrint metadata workflow: rank the retained candidates incorrectly, reject that proposal, rank correctly and accept the matching selection evidence. It does not rerun numerical training, recompute a metric, restore a model or publish anything.

From the package root, with the optional workflow/investigation packages installed:

```sh
node examples/selection-backtracking/run.mjs --out ./selection-backtracking-run
node examples/selection-backtracking/investigate.mjs ./selection-backtracking-run/recording.json ./selection-backtracking-run/reopened.json
node examples/selection-backtracking/controls.mjs ./selection-backtracking-run
```

`observations.json` is an explicit projection of the original retained run. It contains references, configurations and observed metrics, with the original recording and manifest digests and source JSON pointers. Extra trainer labels and callbacks were removed; relative artifact labels and measured identities remain. Its integrity hash detects accidental changes; it does not authenticate the original trainer or its numerical claims. The original recording is unchanged.

The producer stage puts the retained candidate observations in `scope.candidateResults`. Both ranking stages and both guards read that scope field and the pinned `scope.manifest`. The native Lens `backtrack` tool can therefore follow each attempt through its guard and ranking to the distinct observation producer. Unrelated display telemetry must be absent from that dependency slice.

This fixes an evidence-capture gap in the earlier demonstration: reading equivalent values from a JavaScript closure bypasses tracked scope reads. A complete writer history alone cannot recover those missing input dependencies.

The output includes new wrong/correct selection receipts, actual guard decisions, the committed snapshot and verbatim native tool responses. Reopening only requires saved JSON. Historical session handles remain labels; they are not live model access.

The optional controls command retains two negative controls beside the proof: an intentional closure-input capture gap and a run with read tracking disabled. Their recordings and native transcripts show the missing producer, with the native missing-read warning preserved for the latter. They do not manufacture a dependency from the known input history.
