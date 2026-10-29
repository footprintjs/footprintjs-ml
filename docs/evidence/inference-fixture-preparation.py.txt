"""Copy the retained real digit artifacts after checking their original hashes."""
import argparse
import hashlib
import json
from pathlib import Path


def prepare(source_run, out):
    source_run, out = Path(source_run), Path(out)
    outcome_blob = (source_run / "outcome.json").read_bytes()
    outcome = json.loads(outcome_blob)
    actual = outcome["baseline"]["consumption"]
    mapping = {"model-A.json": ("model/weights.json", actual["modelWeightsSha256"]),
               "scaler-S1.json": ("preprocessing/s1.json", actual["preprocessorSha256"]),
               "train.json": ("data/train.json", None),
               "validation.json": ("data/validation.json", actual["rawValidationSha256"])}
    source = {"schema": "footprint-ml-inference-fixtures/v1", "sourceLabel": "footprint-ml-mlflow-proof",
              "outcomeSha256": hashlib.sha256(outcome_blob).hexdigest(), "files": {}}
    out.mkdir(parents=True, exist_ok=False)
    for name, (relative, expected) in mapping.items():
        blob = (source_run / "source-artifacts" / relative).read_bytes()
        measured = hashlib.sha256(blob).hexdigest()
        if expected is not None and measured != expected:
            raise ValueError("Original artifact differs: " + relative)
        with (out / name).open("xb") as stream:
            stream.write(blob)
        source["files"][name] = {"sha256": measured, "bytes": len(blob), "sourceArtifact": "source-artifacts/" + relative}
    train_hash = source["files"]["train.json"]["sha256"]
    for name in ("model-A.json", "scaler-S1.json"):
        doc = json.loads((out / name).read_bytes())
        if doc.get("trainingDataSha256", doc.get("fitDataSha256")) != train_hash:
            raise ValueError("The retained training-data binding disagrees: " + name)
    with (out / "source.json").open("x") as stream:
        json.dump(source, stream, sort_keys=True, indent=2)
        stream.write("\n")
    return source


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-run", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source_run, args.out), indent=2))
