# Checked MLflow promotion from a Python workflow

This local example trains two tiny NumPy regression models, records real validation results, and registers their complete predictor bundles in a local MLflow registry. Python owns orchestration and retry; the existing TypeScript release API checks the pinned evidence through the explicit Node helper. `MlflowModelPublisher` consumes the exact approved bytes before changing a registered-model alias.

The profile is one safe JSON artifact containing the fitted scaler, numerical weights and ordered input/output semantics. It is not an MLflow flavor directory, hosted serving integration or arbitrary model packager. Models and numerical arrays stay in Python or artifact files. Scope holds references, configurations, observations and decisions.

After the documented [Python setup](https://github.com/footprintjs/footprintjs-ml/blob/main/PYTHON.md), launch the installed example:

```sh
python -m pip install numpy==2.2.6 mlflow==3.17.2
python -m footprint_ml_workflow example-promotion --out ./promotion-proof
python -m footprint_ml_workflow investigate --run ./promotion-proof --variable approvedMlflowPromotion
```

From a source checkout or extracted npm archive, the example and its two separate saved-evidence checkers can be run directly:

```sh
python -m pip install -r examples/mlflow-promotion/requirements.txt
python examples/mlflow-promotion/run.py --out ./promotion-proof
python examples/mlflow-promotion/verify.py --run ./promotion-proof
node --permission --allow-fs-read=. --allow-fs-write=./promotion-proof examples/mlflow-promotion/investigate.mjs --run ./promotion-proof
```

Use `--runtime-dir DIR` for a separately installed helper. Choose a new output directory for every proof; no existing run is overwritten. The local SQLite database, MLflow artifacts and registry versions are created only inside that directory. The investigator uses the existing Lens/foottrace toolpack in a process without child-process permission. It reads the saved record after Python exits and contacts no MLflow client or trainer.

The controls distinguish different kinds of mistake and uncertainty:

| Case | Required result |
| --- | --- |
| A's passing receipt offered for B | Native quality guard refuses the stale model binding. |
| B offered against the independently pinned A release plan | Native preparation refuses the different model and produces no allowed preparation. |
| Independent A release plan, registered B bundle | Publisher downloads actual B bytes and refuses before alias mutation. |
| Exact A promotion, outer reply deliberately lost after the publisher commits | A matching retry returns the historical committed receipt; the alias is changed once. |
| Timeout raised inside the alias setter after its real effect | The journal remains pending. Retry stays unknown and performs no second mutation. A matching alias read cannot establish commit. |
| Separate alias occupied by an uncoordinated application writer | Publisher refuses to overwrite it. This is a controlled conflict, not proof of distributed concurrency safety. |

`recording.json` retains the actual native scope reads/writes. Publisher configurations—including model version, run, source, artifact path and alias—are read from scope when constructing each receiver. `outcome.json` equals the recorded final scope value. `numerical-observations.json` keeps arrays and bundles outside scope for a separate standard-library scalar audit. Journals retain pending versus committed observations. Saved investigation follows publication decisions back to their consumed registry binding and independently pinned evidence.

The actual development run selected A with validation MSE `0.0003776324418315604`; B measured `2.72242102558279`. Its 15 workflow controls, 19 saved-audit checks and 16 native investigation checks passed. The investigator made 12 existing-tool queries after Python exited. These values describe this controlled synthetic experiment; accuracy or numerical quality comes from its trainer/evaluation, not FootPrint.

All writers to a target must cooperate through the same one-host journal and lock. The receiver does not add an MLflow compare-and-swap primitive, distributed exactly-once publication, automatic recovery of pending effects, crash/power-loss durability, producer authentication or numerical-correctness proof. An acknowledged historical publication does not claim that its version is still current. Client credentials, network timeouts, registry identity and predictor completeness remain application responsibilities.
