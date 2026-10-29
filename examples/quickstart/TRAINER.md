# Reference trainer

`trainer.py` is a small CPU training example behind the public Python plugin protocol. It fits `prediction = weight × x + bias` to synthetic `target = 2 × x + 1` data using full-batch gradient descent. It helps explain the integration hooks; it is not a general numerical framework.

Install the explicit dependency with Python 3.11 or newer:

```sh
python3 -m pip install -r examples/quickstart/requirements.txt
```

`create_plugin(config)` accepts `seed` (default 2026), `learningRate` (0.2), `trainRows` (32) and `validationRows` (16). Separate deterministic generators create training and validation examples. No validation examples are used for fitting, and preprocessing is the identity operation. This synthetic task is an integration check, not a realistic accuracy benchmark.

Call `train({steps: 20}, source=None)` for model A, then `train({steps: 20}, source=A)` for changed model B. The source is copied; A remains unchanged. `evaluate(state, validation_arrays, {})` returns mean squared error as `mse`. Unknown options are rejected rather than silently ignored. The worker supplies the actual model and data references; TypeScript creates the evaluation receipt.

The snapshot contains the weight, bias, step counter, learning rate/configuration and training-data fingerprint. Training is deterministic full-batch gradient descent without momentum or further random draws, so there are no evolving optimizer or RNG buffers to save. Restoring refuses a different source/configuration/data/dependency contract.

The inference identity covers weight, bias, the architecture and input/output schemas, identity preprocessing, this plugin file's SHA-256, Python major/minor version and the NumPy version. Paths are excluded so relocating the same plugin does not change identity. The SDK worker also records the exact plugin source bytes that it loaded. This declared profile remains the plugin author's responsibility; the core cannot prove that an arbitrary trainer reported every dependency.

For your own trainer, replace the numerical methods while keeping the plugin hooks documented in `python/README.md`. All model and dataset arrays stay in Python; workflow scope holds references and receipts.
