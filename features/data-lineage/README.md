# Check whether evaluation data stayed held out

Use data-lineage evidence when a correct model reference and a passing score are insufficient: training or fitted preprocessing may have consumed an evaluation partition.

The TypeScript/JavaScript APIs are `createDataLineageReceipt`, `readDataLineageReceipt` and `checkDataLineage`. A started Python `WorkflowCapture` calls the same contracts with `create_data_lineage_receipt`, `read_data_lineage_receipt` and `check_data_lineage`; JSON fields keep their camelCase names. A receipt records the actual evaluated model/dataset, split-manifest artifact, training dataset, overlap evidence/counts and fitted-preprocessing artifact with its actual fit inputs. The guard compares it with the proposed model/dataset/split and independently supplied policy naming the authorized training dataset.

Known overlap, forbidden roles or unauthorized preprocessing fit inputs deny. Without a known violation, missing overlap/preprocessing evidence returns `unknown`; it never becomes zero. The current policy authorizes one exact training partition. Large membership lists stay in referenced artifacts, outside scope.

The core does not inspect row lists, recompute overlap or discover undisclosed leakage. The backend must measure and report actual use. Applying a previously fitted transform to validation data differs from fitting that transform on validation data. A passing accuracy threshold cannot repair a failed lineage decision; compose this check with [approval](../approval/README.md).

Verify that zero reported overlap cannot excuse an unauthorized fit partition in the [lineage tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/lineage.test.mjs).

The [Python guard example](../../examples/python-guards/README.md) checks separate retained clean/faulty digit-lineage observations and a missing-evidence control. It does not assign that lineage to its independent JAX candidate comparison.

Read the [complete data-lineage guide](../../DATA-LINEAGE.md), [contract and guard source](../../src/lineage.ts) and [saved-lineage integration tests](https://github.com/footprintjs/footprintjs-ml/blob/main/tests/data-lineage-lens.test.mjs).
