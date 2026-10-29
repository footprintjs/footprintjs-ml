# Choose the feature for your task

Start with the matching feature, then its guide and verification example.

| Task | Start here |
| --- | --- |
| Identify a model, checkpoint or dataset | [References](references/README.md) |
| Retain what an evaluator actually measured | [Evaluation](evaluation/README.md) |
| Connect an existing numerical trainer | [Trainer adapter](trainer-adapter/README.md) |
| Decide whether matching evidence passes policy | [Approval](approval/README.md) |
| Explain a saved value or decision | [Investigation](investigation/README.md) |
| Check training/held-out and preprocessing use | [Data lineage](data-lineage/README.md) |
| Check the winner of a declared comparison | [Selection](selection/README.md) |
| Hand off the exact approved artifact | [Publication](publication/README.md) |

For an existing **Python workflow**, start with [Python installation and capture](../PYTHON.md) and [the MLflow integration](../MLFLOW.md). Python keeps its orchestration. Its bridge exposes `create_evaluation_receipt` and `check_release`; selection, lineage and publication remain TypeScript/JavaScript APIs. Read the trainer-adapter feature only if you are changing the numerical boundary.

For AI coding assistants: identify the caller's task and language, read the relevant feature, inspect its public source, and run its focused verification. Preserve actual consumed references and captured reads. Do not infer missing dependencies, treat a receipt as independent authority, or describe a passing guard as proof of numerical quality. [Compatibility](../COMPATIBILITY.md) and [testing boundaries](../TESTING.md) apply across features.
