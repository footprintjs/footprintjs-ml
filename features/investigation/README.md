# Backtrack a saved ML value without repeating training

Use TypeScript/JavaScript `openWorkflowRecording` from `footprintjs-ml/lens` to explain a scope value from saved JSON. Inject the existing public `openRecording`, `traceToolpack` and `callTraceTool` bridge. The session exposes `backtrack(variable, options)`, `call(tool, args)` and a transcript of unchanged native responses. It requires no release decision or browser.

An optional `before` is an exclusive commit-array index, preserving the earlier evidence boundary. `openAdapterWorkflowRun` adds explicit model/receipt/decision bindings and saved ML context when release-oriented inspection is useful. The [command-line guide](../../BACKTRACKING.md) and [Python front door](../../PYTHON.md) use these same tools.

Actual decision inputs must be read through tracked scope. Merely storing a value there while consuming a closure does not create a read edge. Missing reads, unavailable control dependencies and truncated slices remain visible limitations. Saved replay reconstructs references and observations; it does not rerun guards, restore tensors or prove the numerical cause of a metric change.

Verify the distinction with the [selection backtracking proof](../../examples/selection-backtracking/README.md): its corrected chain reaches the distinct candidate-observation producer, while closure and disabled-read controls retain the gap.

Read the [public session implementation](../../lens/session.mjs), [focused native tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/headless-investigation.test.mjs) and [backtracking guide](../../BACKTRACKING.md).
