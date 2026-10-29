# Testing the beta

Use Node.js 22 or 24 and Python 3.11 or newer. Install the pinned development dependencies with `npm ci`. Run `npm test` to build and execute the portable JavaScript contract, lifecycle, publication and saved-state tests. `npm run test:python` separately requires NumPy and checks the Python identity, NPZ and runtime boundary.

The optional import-graph observation uses Node registerHooks and explicitly skips on Node versions without that API. Python protocol tests explicitly skip when their configured Python executable is unavailable; CI installs Python so these run there. The fixture worker tests are not mathematical validation of a numerical framework.

## Historical test boundary

The local v0.5 suite had one optional historical Lens integration test requiring sibling workspace directories containing the external JAX proof and a bundled Lens bridge. That workspace-only test is not part of this public checkout. The current beta smoke test instead installs the packed package into a clean consumer, runs the new trainer workflow, stops the trainer, and reopens its recording through the public Lens and foottrace installation. It reports its own outcomes; it must not be counted as the old historical JAX integration.

The original v0.1 receipt reader is retained only in tests/fixtures/legacy-v0.1-reader as a small frozen compatibility fixture. Its source hashes are documented there. It is not shipped as a runtime compatibility layer.
