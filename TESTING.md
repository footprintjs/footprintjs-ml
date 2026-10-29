# Testing the beta

Use Node.js 22 or 24 and Python 3.11 or newer. Install the pinned development dependencies with `npm ci`. Run `npm test` to build and execute the portable JavaScript contract, lifecycle, publication and saved-state tests. `npm run test:python` separately requires NumPy and checks the Python identity, NPZ and runtime boundary.

The optional import-graph observation uses Node registerHooks and explicitly skips on Node versions without that API. Python protocol tests explicitly skip when their configured Python executable is unavailable; CI installs Python so these run there. The fixture worker tests are not mathematical validation of a numerical framework.

## Saved-result backtracking

The generic reader delegates to the installed public Lens toolpack. Its contract tests check recording-envelope normalization, required snapshot data, native response preservation and exclusive commit-index bounds. The [selection backtracking proof](examples/selection-backtracking/README.md) separately checks an actual recorded read chain through the native toolpack.

The proof uses saved candidate scores. Its selection stages and investigation may execute, but numerical training and score computation do not. The closure case deliberately omits a tracked input read. The corrected case consumes the scores through scope. A complete recording can then expose that relationship. This comparison checks capture completeness and reader integration, not the statistical cause of a model's error or an advantage over equally complete logs.

## Historical test boundary

The local v0.5 suite had one optional historical Lens integration test requiring sibling workspace directories containing the external JAX proof and a bundled Lens bridge. That workspace-only test is not part of this public checkout. The current beta smoke test instead installs the packed package into a clean consumer, runs the new trainer workflow, stops the trainer, and reopens its recording through the public Lens and foottrace installation. It reports its own outcomes; it must not be counted as the old historical JAX integration.

The original v0.1 receipt reader is retained only in tests/fixtures/legacy-v0.1-reader as a small frozen compatibility fixture. Its source hashes are documented there. It is not shipped as a runtime compatibility layer.
