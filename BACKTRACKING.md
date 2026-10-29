# Backtrack a saved ML result

**Beta 0.6.0-beta.2. APIs may change.** This guide covers the generic saved-recording reader and the existing ML decision reader in the same optional `/lens` entry point.

A surprising ML result is a useful starting point for investigation: a selected candidate, a score, a checkpoint reference or a release decision. Reopen the saved workflow and follow the recorded value to its writer, then to the inputs that writer read. No browser or live trainer is required.

## Existing tools, with ML meaning

| Layer | What it contributes |
| --- | --- |
| FootPrint | Workflow stages, tracked scope reads/writes, branches, retries and the saved execution record. |
| foottrace and the existing Lens toolpack | State reconstruction, prior writers and backward dependency slices. Explainable UI and Lens can present that same evidence visually. |
| `footprintjs-ml/lens` | A small entry point for saved recordings, plus optional ML bindings that identify model references, evaluation receipts and decisions. |
| Your trainer | Model computation, numerical evaluation and the artifact observations the adapter reports. |

The ML package reuses the existing backtracking engine. Generic value tracing does not require a model-release descriptor, a custom query or an agent conversation.

## Read a recording from code

The host injects its installed public Lens toolpack. This keeps the optional ML reader independent of one particular toolpack installation.

```js
import fs from 'node:fs/promises';
import { openRecording, traceToolpack, callTraceTool } from 'agentfootprint/observe';
import { openWorkflowRecording } from 'footprintjs-ml/lens';

const recording = JSON.parse(await fs.readFile('./quickstart-run/recording.json', 'utf8'));
const run = openWorkflowRecording(recording, {
  openRecording,
  traceToolpack,
  callTraceTool,
});

// The quickstart stores its current model under this tracked scope key.
const answer = await run.backtrack('modelRef');
console.log(answer.result);
```

`openWorkflowRecording` accepts a raw FootPrint snapshot, `{ snapshot }`, or the existing `{ footprint }` recording envelope. The snapshot must contain `commitLog` and `executionTree`. It returns the native tool response unchanged and retains each call in `run.transcript`.

To ask about an earlier point, pass `{ before: index }` to `backtrack`. `before` is an **exclusive commit-array index**: the slice can use only commits before that boundary. This prevents later state from explaining an earlier decision. The underlying toolpack owns query validation, depth limits and missing-evidence messages.

For a nested field, use the public path codec. A dotted string can name a literal root key; it is not always a nested-field alias.

```js
import { normaliseStateKey } from 'foottrace/paths';

const score = await run.call('get_value', {
  runtimeStageId: 'evaluate-a#2',
  key: normaliseStateKey(['evaluationReceipt', 'metrics', 'mse']),
});
console.log(score.result);
```

## Read a recording from the command line

```sh
npx --no-install footprint-ml investigate --run ./quickstart-run --variable modelRef
```

Replace `modelRef` with a scope key your workflow actually wrote. `--run` accepts a directory containing `recording.json` or a JSON file. The command writes `investigation-variable.json` beside the recording. An optional `--before INDEX` limits the question to an earlier commit boundary.

Release-decision investigation still supports `--decision stale` or `--decision fresh` for the quickstart. Use `--stage DECISION_RUNTIME_ID` to select an exact recorded decision when multiple decisions have the same status. Stage selection and variable tracing are separate modes.

## Why a dependency can be missing

Consider a selection stage that chooses the smallest recorded error:

```js
// The data exists, but this stage reads it outside tracked scope.
const cachedScores = scores;
function chooseFromClosure(scope) {
  scope.chosenCandidate = pickSmallestError(cachedScores);
}

// The same decision reads its inputs through tracked scope.
function chooseFromScope(scope) {
  scope.chosenCandidate = pickSmallestError(scope.candidateScores);
}
```

The first recording can show who wrote `chosenCandidate`. It cannot supply a recorded read edge from that stage to `candidateScores`. Storing scores somewhere in scope does not establish that the stage consumed them.

The second version records the actual scope read, so the existing slice can connect the selected candidate to its scores and their earlier writers. Keep the actual decision input in tracked scope. Do not add a ceremonial read merely to make the diagram look complete.

A dependency slice explains the recorded data flow. It does not prove a model's quality, discover every hidden dependency or infer the cause of an accuracy drop from an unexplained number.

## Decisions and ML receipts

`openAdapterWorkflowRun` remains useful when the recording has the explicit `mlInvestigation` bindings from the [adapter guide](ADAPTER.md). It selects recorded release decisions and presents their model, receipt and publication context. The generic reader is the smaller entry point for an arbitrary scope key.

Reopening a saved decision reads the decision that ran. It does not execute the release guard again, measure live model identity, publish a model or recreate backend arrays. A new policy or changed model requires new live checks and a new record.

## Reproduction and limits

The [selection backtracking example](examples/selection-backtracking/README.md) uses recorded candidate scores to isolate the workflow boundary. It compares a closure input with a tracked scope input. Those scores remain saved observations from the retained training proof. Replaying the selection and investigating its recording do not train a model or recompute its numerical scores.

Read tracking must be enabled for read dependencies. Code, closures, external services and backend tensor operations outside the observed boundary remain outside that history. Retain the recorders needed for retry, error or timing details. Deep subflow evidence and the available navigation stops depend on what the original recording retained.

These examples establish that the captured chains are inspectable. They do not establish faster investigation than complete structured logs, deterministic numerical replay, arbitrary adapter completeness or production readiness. See [TESTING.md](TESTING.md) for the verification boundary.
