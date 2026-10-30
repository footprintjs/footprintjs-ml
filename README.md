# footprintjs-ml

**Beta — APIs may change.** Check that a proposed model has matching evaluation evidence, then reopen the recorded release decision after training has stopped.

FootPrint coordinates the workflow. Your trainer keeps its models, tensors and numerical code. Scope holds small references, evaluation receipts and decisions. Lens and foottrace inspect the saved execution record, including the tracked inputs and writers behind an ML result.

[Feature guides](features/README.md) · [AI coding skill](skills/footprintjs-ml/SKILL.md) · [Quickstart](QUICKSTART.md) · [Visual story](https://footprintjs.github.io/footprintjs-ml/#1)

**Already working in Python?** Start with [Python installation](PYTHON.md). The same SDK now has a Python wheel, an explicit helper setup command and a read-only environment check. Your application keeps its training code and MLflow client. Node.js 22+ is still required for recording and saved investigation.

## Choose the feature you need

Each feature has a short README that explains its purpose, public API, example and verification boundary. The linked detailed guides remain the contract reference.

| Your task | Feature README |
| --- | --- |
| Identify the actual model, checkpoint and dataset | [References](features/references/README.md) |
| Keep a score with what was evaluated | [Evaluation receipts](features/evaluation/README.md) |
| Connect your existing trainer | [Trainer adapter](features/trainer-adapter/README.md) |
| Check matching evidence before release | [Model approval](features/approval/README.md) |
| Check the model and input/output meaning used for prediction | [Inference evidence](features/inference/README.md) |
| Explain a saved result or decision | [Investigation and backtracking](features/investigation/README.md) |
| Check training and preprocessing data use | [Data lineage](features/data-lineage/README.md) |
| Compare the declared model candidates | [Candidate selection](features/selection/README.md) |
| Check predefined groups against a baseline | [Regression guard](features/regression/README.md) |
| Bind later performance to the deployed model and actual outcomes | [Monitoring evidence](features/monitoring/README.md) |
| Publish the exact approved checkpoint | [Checked publication](features/publication/README.md) |

Python-owned workflows start with [Python installation](PYTHON.md) and [MLflow capture](MLFLOW.md). The Python helper exposes recording, evaluation receipts, model approval, data-lineage checks, candidate-selection checks, paired group-regression checks, production monitoring evidence, inference evidence and checked publication through the core TypeScript contracts. Python keeps its candidate loops and retries. For an actual registry handoff, the optional [MLflow promotion example](examples/mlflow-promotion/README.md) checks a complete predictor artifact before changing a pinned registered version's alias. The [Python guard example](examples/python-guards/README.md) separately exercises retained evidence without installing a numerical framework.

For inference orchestration, the [inference guide](INFERENCE.md) distinguishes the Python-owned capture path from an actual FootPrint `FlowChartExecutor` workflow. The native example uses existing function/decider stages and a native retry policy around the same numerical backend and inference guards. This strengthens the existing inference feature; it adds no new guard or runtime dependency.

## Build with an AI coding agent

The root [AGENTS.md](AGENTS.md) points repository-aware assistants to the skill. Give your agent the [FootPrint ML skill](skills/footprintjs-ml/SKILL.md) and your existing workflow. The skill routes to the relevant feature instead of requiring the agent to read every guide. It covers actual consumed references, evaluation binding, failure/retry semantics and saved investigation using existing Lens/foottrace tools.

For example:

> Use the FootPrint ML skill to add recording to this existing Python evaluation workflow. Keep the numerical code, record the model and fitted preprocessing actually consumed, and reopen a saved result to explain its reference history.

The portable skill directory is `skills/footprintjs-ml/`. Copy that folder into your coding agent's configured skill directory if it supports `SKILL.md`, or ask the agent to read it directly. Codex UI metadata is included; the instructions and feature guides are plain Markdown and require no agent service.

The npm package includes this same skill and guide tree. The Python wheel installs them under your environment's `share/footprintjs-ml/`, including `skills/footprintjs-ml/SKILL.md`. Installing the library does not automatically register a skill in an agent's personal configuration. The skill adds guidance, with no runtime dependency or process startup.

## Try the beta

The beta is distributed as a versioned GitHub release tarball. These commands do not depend on an npm registry release of `footprintjs-ml`:

```sh
npm install https://github.com/footprintjs/footprintjs-ml/releases/download/v0.6.0-beta.12/footprintjs-ml-0.6.0-beta.12.tgz footprintjs@10.0.0 agentfootprint@11.0.0 foottrace@1.8.0
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
- [Data-use checks](DATA-LINEAGE.md), [model selection](SELECTION.md), [group regression](REGRESSION.md), [monitoring](MONITORING.md), [checked release](RELEASE.md)
- [Visual story](https://footprintjs.github.io/footprintjs-ml/#1), [technical story](https://footprintjs.github.io/footprintjs-ml/technical-story.html#1), [saved evidence ledger](https://footprintjs.github.io/footprintjs-ml/EVIDENCE.md)
- [FootPrint](https://github.com/footprintjs/footPrint)

GitHub Pages serves the presentation in `docs/`. Its historical experiments and original versions remain evidence for that story; they are separate from the current beta quickstart. The [publication manifest](https://footprintjs.github.io/footprintjs-ml/publication-manifest.json) distinguishes original retained-source fingerprints from public copies with personal paths removed.

MIT licensed. The presentation includes the [StoryDeck MIT notice](https://footprintjs.github.io/footprintjs-ml/STORYDECK-LICENSE.txt).

For an existing Python workflow, the [optional MLflow integration](MLFLOW.md) keeps orchestration in Python and records explicit reference reads and writes through the native foottrace writer. The Python helper uses only the standard library and accepts an application-supplied MLflow client. The Node recording helper is started explicitly.
