# Beta compatibility

The current SDK beta is `0.6.0-beta.5`. APIs and supported integration profiles may change during the beta.

Beta 2 adds a saved-record entry point without release bindings and explicit CLI investigation targets. It reuses the existing FootPrint/foottrace toolpack. Its selection proof recomputes ranking from retained JAX evaluations; it does not repeat numerical training. The reference quickstart separately trains its NumPy model. See [BACKTRACKING.md](BACKTRACKING.md) for capture requirements and limits.

Beta 3 adds an optional standard-library Python workflow helper and injected MLflow artifact binding. Python controls its own stages and retries; an explicitly started Node helper records reference reads and writes through the native foottrace writer. This path uses no FootPrint executor and does not capture arbitrary Python locals. MLflow and numerical packages are application dependencies, not SDK runtime dependencies. The reference MLflow proof uses Python 3.12, MLflow 3.17.2, scikit-learn 1.7.2 and NumPy 2.2.6 with a local SQLite store. See [MLFLOW.md](MLFLOW.md).

## Runtime scope

Beta 5 bundles a reusable coding skill, feature READMEs and inspectable API/example sources in both distributions. The Python documentation tree lives under the environment's `share/footprintjs-ml/`; it adds no required Python packages or compiled Node runtime. The recording helper remains an explicit setup operation. The main README routes developers and agents to the appropriate feature; installing the SDK does not register a skill in personal agent configuration.

Beta 4 adds a Python wheel (`0.6.0b4`, matching npm `0.6.0-beta.4`) from this same repository. It has no required Python dependencies. `python -m footprint_ml_workflow setup` explicitly installs the pinned Node helper packages into the active virtual environment; importing the Python module does not install anything. `doctor` checks the selected helper without training or contacting MLflow. See [PYTHON.md](PYTHON.md) for the installation and dependency boundary.

| Component | Requirement or scope |
| --- | --- |
| SDK core | Node.js 22+ for the supported application path; no root runtime dependencies. |
| Python adapter | Python 3.11+ and NumPy; numerical frameworks are supplied by the application. |
| Reference quickstart | Python 3.11 or 3.12 with NumPy 2.2.6, CPU, local process and trusted local files. |
| Workflow/investigation example | `footprintjs` 10.0.0, `agentfootprint` 11.0.0 and `foottrace` 1.8.0. |
| Optional local publisher | One host with cooperating processes and the documented filesystem/locking assumptions. |

The core has browser-compatible contracts, but this beta’s end-to-end supported path is Node plus a local Python worker. Browser numerical training, GPU synchronization, multi-host publication and distributed checkpoint recovery are not established by the quickstart.

## CI targets

The beta workflow is configured for these combinations on GitHub-hosted Ubuntu:

| Node | Python | NumPy |
| --- | --- | --- |
| 22 | 3.11 | 2.2.6 |
| 22 | 3.12 | 2.2.6 |
| 24 | 3.11 | 2.2.6 |
| 24 | 3.12 | 2.2.6 |

A configured CI target is not a test result. Check the [repository’s Actions runs](https://github.com/footprintjs/footprintjs-ml/actions) for the current revision’s completed checks. macOS and Windows may run the local adapter, but they are not covered by this matrix.

## Optional loading

Importing `footprintjs-ml` does not import the Node-only Python, filesystem publisher or conformance implementations. Importing an optional entry does not start a worker. Trainer creation and conformance execution are explicit operations.

Python, NumPy and JAX are not installed automatically. The reference quickstart does not require JAX. Existing JAX proofs in the presentation are historical evidence with their own environments, not compatibility claims for every JAX release.

## Evidence and persistence

Evaluation receipts, model identities and exact training checkpoints have different purposes. See [README.md](README.md), [ADAPTER.md](ADAPTER.md) and [RELEASE.md](RELEASE.md) before implementing a custom profile or publisher.

The Python identity protocol currently limits a numerical array to 64 MiB and total array payload to 128 MiB. Large-model streaming and general distributed training are outside this adapter profile. A saved reference is not a live model after its worker exits; restore a retained checkpoint into a fresh session when further computation is required.

The reference trainer and hooks are trusted application code. Hashes establish the compared content identity; they do not authenticate an untrusted producer or prove numerical correctness. The application owns access control, retention and appropriate capture/redaction settings.
