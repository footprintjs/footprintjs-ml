# footprintjs-ml

**Beta — APIs may change.** Check that a proposed model has matching evaluation evidence, then reopen the recorded release decision after training has stopped.

FootPrint coordinates the workflow. Your trainer keeps its models, tensors and numerical code. Scope holds small references, evaluation receipts and decisions. Lens and foottrace inspect the saved execution record, including the tracked inputs and writers behind an ML result.

[Try the quickstart](QUICKSTART.md) · [Explore the visual story](https://footprintjs.github.io/footprintjs-ml/#1) · [Compatibility](COMPATIBILITY.md)

## Try the beta

The beta is distributed as a versioned GitHub release tarball. These commands do not depend on an npm registry release of `footprintjs-ml`:

```sh
npm install https://github.com/footprintjs/footprintjs-ml/releases/download/v0.6.0-beta.2/footprintjs-ml-0.6.0-beta.2.tgz footprintjs@10.0.0 agentfootprint@11.0.0 foottrace@1.8.0
python3 -m venv .venv
.venv/bin/python -m pip install numpy==2.2.6
npx --no-install footprint-ml demo --out ./quickstart-run --python .venv/bin/python
npx --no-install footprint-ml investigate --run ./quickstart-run --decision stale
```

Use Node.js 22+ and Python 3.11 or 3.12 for this pinned NumPy reference trainer. See [QUICKSTART.md](QUICKSTART.md) for Windows paths and full setup. The three workflow/investigation packages above are used by the example; the SDK core has no runtime dependencies.

## What the example does

1. Train model A and evaluate it.
2. Continue training to model B.
3. Reject A’s evaluation receipt when B is proposed for release.
4. Evaluate B and accept its matching evidence.
5. Stop the Python worker and investigate the saved decisions in a separate process.

The example supplies a small NumPy reference trainer so the full path is reproducible on a CPU. An allowed decision here does not upload or deploy a model to a registry. To connect your own training code, implement the documented [Python hooks](python/README.md) behind the same [trainer adapter](ADAPTER.md). The numerical trainer can stay in Python.

## Package entry points

| Import | Purpose |
| --- | --- |
| `footprintjs-ml` | References, evaluation receipts, trainer contract, selection and release checks. |
| `footprintjs-ml/adapter` | Optional local Python worker and existing-trainer hooks. |
| `footprintjs-ml/lens` | Saved-run investigation bindings for an existing Lens/foottrace bridge. |
| `footprintjs-ml/conformance` | Explicit adapter conformance runner. |
| `footprintjs-ml/release` | Optional local artifact store and single-host publisher. |

Optional entry points start no processes on import. Applications explicitly create a trainer and provide the recording/investigation tools they use. Python and numerical dependencies are explicit installations.

## What the evidence establishes

FootPrint records stage execution, tracked scope changes and decisions. The trainer adapter reports model, dataset, checkpoint and numerical evaluation facts; the ML layer validates their declared bindings and applies the requested guards. It does not automatically inspect arbitrary uninstrumented Python code or prove that an adapter’s identity profile includes every relevant component.

Saved replay reconstructs recorded state. It does not resume training or recreate numerical arrays. A passing guard establishes the checks configured for that operation, not general model suitability, authenticated evidence, production readiness or distributed release guarantees. The examples have not established a human investigation advantage over complete structured logs.

## Develop and verify

```sh
git clone https://github.com/footprintjs/footprintjs-ml.git
cd footprintjs-ml
npm ci
npm run build
npm test
python3 -m venv .venv
.venv/bin/python -m pip install -r examples/quickstart/requirements.txt
PYTHON="$PWD/.venv/bin/python" npm run beta:smoke
```

The smoke check packs the SDK, installs it into a temporary consumer, runs the model-swap example, and reopens its saved record in a separate process. See [COMPATIBILITY.md](COMPATIBILITY.md) for CI targets and limits.

## Guides and evidence

- [Quickstart](QUICKSTART.md) and [supported/tested environments](COMPATIBILITY.md)
- [Trainer adapter](ADAPTER.md) and [Python plugin protocol](python/README.md)
- [Saved-result backtracking](BACKTRACKING.md), including generic value tracing and the closure-input boundary
- [Data-use checks](DATA-LINEAGE.md), [model selection](SELECTION.md), [checked release](RELEASE.md)
- [Visual story](https://footprintjs.github.io/footprintjs-ml/#1), [technical story](https://footprintjs.github.io/footprintjs-ml/technical-story.html#1), [saved evidence ledger](docs/EVIDENCE.md)
- [FootPrint](https://github.com/footprintjs/footPrint)

GitHub Pages serves the presentation in `docs/`. Its historical experiments and original versions remain evidence for that story; they are separate from the current beta quickstart. The [publication manifest](docs/publication-manifest.json) distinguishes original retained-source fingerprints from public copies with personal paths removed.

MIT licensed. The presentation includes the [StoryDeck MIT notice](docs/STORYDECK-LICENSE.txt).
