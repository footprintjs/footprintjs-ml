# Testing the beta

Use Node.js 22 or 24 and Python 3.11 or newer. Install the pinned development dependencies with `npm ci`. Run `npm test` to build and execute the portable JavaScript contract, lifecycle, publication and saved-state tests. `npm run test:python` separately requires NumPy and checks the Python identity, NPZ and runtime boundary.

The optional import-graph observation uses Node registerHooks and explicitly skips on Node versions without that API. Python protocol tests explicitly skip when their configured Python executable is unavailable; CI installs Python so these run there. The fixture worker tests are not mathematical validation of a numerical framework.

## Paired baseline/group regression

The [regression proof](examples/regression/README.md) declares an imbalanced two-population dataset, configurations, group definition and acceptance limits before evaluation. Actual NumPy weighted and pooled least squares show an overall improvement with a worse predefined group. The shared guard checks paired evidence; composed publication refuses the group regression although overall quality and selection pass. A separately declared unchanged-model control demonstrates successful publication. Missing/insufficient evidence, wrong model/context, swapped pinned artifacts, freshness and historical retry are separate controls.

The focused contract tests use synthetic metrics to isolate schema and guard behavior. The numerical example retains actual predictions outside scope and reopens native Lens/foottrace history with trainer spawning forbidden. A separate saved audit checks arithmetic and artifact bindings without numerical packages. The [audit acceptance controls](examples/regression/audit-controls.py) mutate disposable saved copies to reject empty paired sets, missing native responses, rewritten policies/metrics and rebound evidence. The original run remains unchanged. These checks do not establish statistical significance, group-discovery ability, fairness, independent adoption or an investigation-speed advantage over complete logs.

## Python checked MLflow promotion

The [promotion example](examples/mlflow-promotion/README.md) performs actual local NumPy training and evaluation, registers two complete predictor bundles with MLflow, and exercises the same core checked-release APIs through Python callbacks. It includes stale A evidence for B, a B proposal against an independent A plan, wrong registered bytes refused before alias mutation, exact A promotion with a lost outer reply, an uncertain setter after its effect, and a separate alias occupied by an uncoordinated writer. The latter controls distinguish a committed local journal from an unresolved pending intent; they do not establish MLflow CAS or distributed exactly-once behavior.

Its separate [saved verifier](examples/mlflow-promotion/verify.py) uses only the standard library to check retained byte identities, scalar prediction arithmetic, receipt metrics and journal observations. Its [investigator](examples/mlflow-promotion/investigate.mjs) runs the existing Lens/foottrace toolpack with child-process permission absent, following the actual consumed version binding and independently pinned evidence. Saved investigation imports no Python numerical code or MLflow client, performs no new release, and preserves native missing-control warnings. This is a controlled local integration proof, not a human debugging-speed study or authentication of the producer.

The [saved-audit regressions](https://github.com/footprintjs/footprintjs-ml/blob/main/python/tests/test_promotion_audit.py) use synthetic metadata fixtures without training. They refuse empty/truncated/extra prediction rows, unbound or mismatched validation operands, invalid recorded row counts, boolean/nonfinite values, substituted bundle references and altered sidecar metrics. The real saved audit binds its validation/training sidecars to the actual captured length/hash-checked managed artifacts before checking every predicted row.

The Python publisher tests use fake clients for protocol/error boundaries; the example separately checks compatibility with the real local MLflow client. SDK imports and constructors remain inert with no MLflow/NumPy installed. Callback timeout tests do not imply cancellation of external effects. See [the release guide](RELEASE.md#python-release-callbacks-and-mlflow-promotion) for the supported bounds.

## Beta 9 reliability regressions

The [evidence regressions](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/review-evidence-hardening.test.mjs), [platform regressions](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/review-platform-hardening.test.mjs) and [Python I/O regressions](https://github.com/footprintjs/footprintjs-ml/blob/main/python/tests/test_review_io_hardening.py) cover seven fixes:

| Boundary | Regression scope |
| --- | --- |
| Investigation output | Every report mode preserves a colliding source recording; source hardlinks/symlinks and unrelated existing files are refused; normal repeat reports remain replaceable. Oversized prior report targets are refused without replacement. |
| Approval policy | Misspelled or unsupported fields, including `maxAgeMS`, cannot silently drop a constraint; the supported `maxAgeMs` expiry check remains enforced. |
| Legacy trainer handles | A successful evaluation remembers an externally created legacy handle; a later checkpoint change is refused. A failed evaluation does not register unvalidated output. |
| Publisher lock cleanup | An injected owner-file write failure preserves its original error and removes the owned lock; a subsequent publication and idempotent acknowledgement succeed. |
| File consumption | Oversized sparse files are refused before content reads; growth, shrinkage and FIFOs fail closed. Registry JSON accepts its 16 MiB boundary and rejects an oversized update without replacing committed state. Python checkpoint and bound MLflow-cache reads have separate descriptor/bounded-read checks. |
| Saved envelopes | Both readers refuse conflicting `snapshot`/`footprint` aliases before opening tools, refuse accessors without invoking them, and accept equivalent aliases with reordered object keys. |
| Conformance report | A returned report naming a different plan is rejected; equivalent plans with reordered object keys remain accepted. This checks correspondence, not whether an untrusted runner truthfully executed the plan. |

These tests exercise existing evidence and I/O contracts without numerical training. They do not establish hostile-filesystem safety, power-loss durability, streaming model transfer or complete trainer semantics.

## Saved-result backtracking

The generic reader delegates to the installed public Lens toolpack. Its contract tests check recording-envelope normalization, required snapshot data, native response preservation and exclusive commit-index bounds. The [selection backtracking proof](examples/selection-backtracking/README.md) separately checks an actual recorded read chain through the native toolpack.

The proof uses saved candidate scores. Its selection stages and investigation may execute, but numerical training and score computation do not. The closure case deliberately omits a tracked input read. The corrected case consumes the scores through scope. A complete recording can then expose that relationship. This comparison checks capture completeness and reader integration, not the statistical cause of a model's error or an advantage over equally complete logs.

## Optional Python/MLflow integration

`python3 -I -S python/tests/test_workflow.py -v` checks the standard-library helper without site packages, including an import blocker for MLflow and numerical frameworks. Node capture tests drive the public native writer through real Python requests. They check actual reads, failure discard, retry labels, bounded messages, persistence failure and import isolation.

On Node 24, `npm run test:optional-dependencies` independently checks the package dependency declarations, isolated Python imports and deferred foottrace loading. The installed-tarball smoke also starts the shipped Python helper without site packages, then reopens its saved record with child-process creation forbidden.

The separate optional MLflow CI job explicitly installs `examples/mlflow/requirements.txt`, executes a real Python-orchestrated training run, reopens its JSON evidence and checks saved predictions with a standard-library-only auditor. These numerical packages are not installed by the SDK or by the other CI jobs. The native investigation binds the outcome sidecar to the outcome captured inside the recording. A consistent recording is not authentication of an untrusted producer.

## Prediction contracts and inference receipts

The core inference tests cover declared input/output meaning, actual-model and invocation/input agreement, missing observations, timestamps and persisted receipt validation. The installed Python smoke calls the five facade methods and compares the resulting JSON decisions with the direct public TypeScript guard. Its synthetic cases verify packaging and contract parity; they are not numerical model tests.

The [separate inference proof](examples/inference/README.md) uses a real local numerical backend with explicit example-only dependencies. It deliberately keeps a changed model in the backend cache while the workflow expects the approved model, retains output privately until the inference check permits delivery, then repairs the cache. A separate control changes feature order while preserving dimensions. The backend observes actual loaded predictor state and its executed contract; scope stores references and small evidence. Saved investigation does not repeat prediction. The guard still trusts supplied backend observations and cannot prove a dishonest producer, correct arithmetic, general model quality or production serving reliability. The local numerical backend emitted matrix-operation warnings that were retained rather than suppressed; their cause remains undiagnosed. Model/reference agreement is not a numerical audit. The example's separate [standard-library auditor](examples/inference/audit.py) checks retained byte identities and live-state fingerprints, recomputes predicted labels with scalar arithmetic and checks A's saved validation accuracy. It does not verify training, every numerical intermediate or the cause of those warnings.

## Native FootPrint inference orchestration

The [native inference example](examples/inference/README.md) runs an actual `FlowChartExecutor` chart with function stages, decider branches and a declared stage retry policy. It retains the executor's real snapshot and public recorder observations. This is separate from the Python application's `WorkflowCapture` profile, whose retry labels describe Python-owned control flow through the foottrace writer.

Native integration checks inspect the recorded branch outcomes, retry attempt/error evidence, committed state and the reference chain into the inference decision and output handoff. Saved investigation runs with backend spawning disallowed. These checks reuse the inference contracts; they do not introduce a new numerical guard. The separate standard-library numerical audit has its own scope and does not certify engine control flow or external side effects.

A native retry does not undo worker, file or registry effects, and the controlled retry proof does not establish crash recovery or distributed durability. The native investigator compares the default snapshot-only reader, which reports missing control lookup, with the example adapter that reopens explicitly retained public control-recorder lookups. The [control adapter tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/native-inference-control.test.mjs) check run/commit/decider identity, preceding governing decisions and rejected malformed or foreign observations. It does not infer control from chart order or supply producer/end-to-end capture attestation; remaining completeness and authentication limits stay visible.

## Historical test boundary

The local v0.5 suite had one optional historical Lens integration test requiring sibling workspace directories containing the external JAX proof and a bundled Lens bridge. That workspace-only test is not part of this public checkout. The current beta smoke test instead installs the packed package into a clean consumer, runs the new trainer workflow, stops the trainer, and reopens its recording through the public Lens and foottrace installation. It reports its own outcomes; it must not be counted as the old historical JAX integration.

The original v0.1 receipt reader is retained only in tests/fixtures/legacy-v0.1-reader as a small frozen compatibility fixture. Its source hashes are documented there. It is not shipped as a runtime compatibility layer.
