# Testing the beta

Use Node.js 22 or 24 and Python 3.11 or newer. Install the pinned development dependencies with `npm ci`. Run `npm test` to build and execute the portable JavaScript contract, lifecycle, publication and saved-state tests. `npm run test:python` separately requires NumPy and checks the Python identity, NPZ and runtime boundary.

The optional import-graph observation uses Node registerHooks and explicitly skips on Node versions without that API. Python protocol tests explicitly skip when their configured Python executable is unavailable; CI installs Python so these run there. The fixture worker tests are not mathematical validation of a numerical framework.

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

## Historical test boundary

The local v0.5 suite had one optional historical Lens integration test requiring sibling workspace directories containing the external JAX proof and a bundled Lens bridge. That workspace-only test is not part of this public checkout. The current beta smoke test instead installs the packed package into a clean consumer, runs the new trainer workflow, stops the trainer, and reopens its recording through the public Lens and foottrace installation. It reports its own outcomes; it must not be counted as the old historical JAX integration.

The original v0.1 receipt reader is retained only in tests/fixtures/legacy-v0.1-reader as a small frozen compatibility fixture. Its source hashes are documented there. It is not shipped as a runtime compatibility layer.
