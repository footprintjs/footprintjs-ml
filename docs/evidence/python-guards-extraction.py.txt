"""Project retained real observations; preserve original recordings and bytes."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def artifact(ref):
    path = PurePosixPath(ref["path"])
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("Expected an original relative artifact label")
    return {key: ref[key] for key in ("kind", "path", "sha256", "bytes", "format")}


def model(ref):
    return {"kind": ref["kind"], "sessionId": ref["sessionId"], "handle": ref["handle"],
            "originArtifact": artifact(ref["originArtifact"]),
            **({"inferenceIdentity": ref["inferenceIdentity"]} if "inferenceIdentity" in ref else {})}


def dataset(ref):
    return {key: ref[key] for key in ("kind", "sessionId", "handle", "role", "rows", "shape")} | {
        "artifact": artifact(ref["artifact"])}


def evaluation(receipt):
    result = {key: receipt[key] for key in ("kind", "schemaVersion", "evaluationId", "createdAt",
                                           "preprocessingVersion", "evaluationMethodVersion", "parameters", "metrics")}
    result.update(modelRef=model(receipt["modelRef"]), datasetRef=dataset(receipt["datasetRef"]))
    if receipt["schemaVersion"] == 2:
        result.update(inferenceIdentity=receipt["inferenceIdentity"],
                      checkpointForAudit={"kind": "checkpoint", "artifact": artifact(receipt["checkpointForAudit"]["artifact"])})
    else:
        result["checkpoint"] = {"kind": "checkpoint", "artifact": artifact(receipt["checkpoint"]["artifact"])}
    return result


def lineage(receipt):
    return {key: receipt[key] for key in ("kind", "schemaVersion", "lineageId", "createdAt")} | {
        "modelRef": model(receipt["modelRef"]), "datasetRef": dataset(receipt["datasetRef"]),
        "splitManifest": artifact(receipt["splitManifest"]), "trainingDatasetRef": dataset(receipt["trainingDatasetRef"]),
        "overlap": {"evidenceArtifact": artifact(receipt["overlap"]["evidenceArtifact"]),
                    "trainEvaluationRows": receipt["overlap"]["trainEvaluationRows"],
                    "preprocessingEvaluationRows": receipt["overlap"]["preprocessingEvaluationRows"]},
        "preprocessing": {"artifact": artifact(receipt["preprocessing"]["artifact"]),
                          "fitDatasetRefs": [dataset(ref) for ref in receipt["preprocessing"]["fitDatasetRefs"]]}}


def verified_bytes(root, ref):
    ref = artifact(ref)
    blob = (root / ref["path"]).read_bytes()
    if len(blob) != ref["bytes"] or digest(blob) != ref["sha256"]:
        raise ValueError("Original artifact bytes do not match their retained reference: " + ref["path"])
    return blob


def write_new(path, blob):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(blob)


def extract(selection_path, lineage_root, destination):
    selection_path, lineage_root, destination = map(Path, (selection_path, lineage_root, destination))
    selection_blob = selection_path.read_bytes()
    original = json.loads(selection_blob)
    if original["schema"] != "footprint-model-selection/v1":
        raise ValueError("Expected the retained real JAX selection trace")
    state = original["footprint"]["sharedState"]
    manifest = dict(state["experimentManifest"])
    manifest["comparison"] = dict(manifest["comparison"], datasetRef=dataset(manifest["comparison"]["datasetRef"]))
    results = []
    source_artifacts = []
    for result in state["candidateResults"]:
        results.append({"candidateId": result["candidateId"], "configuration": result["configuration"],
                        "modelRef": model(result["modelRef"]), "evaluation": evaluation(result["evaluation"])})
        for ref in (result["modelRef"]["originArtifact"], result["evaluation"]["datasetRef"]["artifact"]):
            verified_bytes(selection_path.parent, ref)
            source_artifacts.append(artifact(ref))
    selection = {"manifest": manifest, "candidateResults": results,
                 "checkTime": max(result["evaluation"]["createdAt"] for result in results) + 1,
                 "qualityPolicy": {"metric": "mse", "operator": "lte", "threshold": 0.01},
                 "source": {"label": "footprint-ml-model-selection/run/trace.json", "schema": original["schema"],
                            "sha256": digest(selection_blob), "bytes": len(selection_blob),
                            "declarationPointer": "/footprint/sharedState/experimentManifest",
                            "observationsPointer": "/footprint/sharedState/candidateResults",
                            "verifiedOriginalArtifacts": source_artifacts}}
    lineage_cases = {}
    for mode in ("clean", "faulty"):
        root = lineage_root / mode
        trace_blob = (root / "trace.json").read_bytes()
        trace = json.loads(trace_blob)
        state = trace["footprint"]["sharedState"]
        observed = lineage(state["dataLineage"])
        evidence = {}
        for label, ref in (("split", state["splitManifest"]),
                           ("memberships", state["preprocessingFit"]["membershipArtifact"]),
                           ("overlap", state["overlap"]["evidenceArtifact"])):
            blob = verified_bytes(root, ref)
            if b"/Users/" in blob or b"file:///" in blob:
                raise ValueError("Unexpected machine-local path in retained membership JSON")
            retained = "evidence/lineage-" + mode + "-" + label + ".json"
            write_new(destination.parent / retained, blob)
            evidence[label] = {"retainedFile": retained, "artifact": artifact(ref)}
        verified = []
        for ref in (state["activePredictor"]["originArtifact"], state["partitions"]["train"]["artifact"],
                    state["partitions"]["validation"]["artifact"], state["preprocessingFit"]["artifact"]):
            verified_bytes(root, ref)
            verified.append(artifact(ref))
        lineage_cases[mode] = {
            "declaration": {"modelRef": model(state["activePredictor"]), "datasetRef": dataset(state["partitions"]["validation"]),
                            "splitManifest": artifact(state["splitManifest"]),
                            "policy": {"trainingDatasetRef": dataset(state["partitions"]["train"])}},
            "observed": observed, "evaluation": evaluation(state["approval"]),
            "qualityPolicy": state["plan"]["releasePolicy"], "membershipEvidence": evidence,
            "source": {"label": "footprint-ml-data-lineage/run/" + mode + "/trace.json", "schema": trace["schema"],
                       "sha256": digest(trace_blob), "bytes": len(trace_blob),
                       "declarationPointers": ["/footprint/sharedState/partitions", "/footprint/sharedState/splitManifest"],
                       "observationPointer": "/footprint/sharedState/dataLineage", "verifiedOriginalArtifacts": verified}}
    payload = {"selection": selection, "lineageCases": lineage_cases}
    document = {"schema": "footprint-ml-python-guard-observations/v1", **payload,
                "projection": {"schemaVersion": 1, "sha256": digest(encoded(payload)),
                               "description": "Core typed references and original recorded metrics/data-use facts. Original relative artifact labels, hashes, sizes and IDs retained; trainer display metadata omitted.",
                               "binaryArtifactsVerifiedDuringExtraction": True, "binaryArtifactsBundled": False}}
    write_new(destination, json.dumps(document, sort_keys=True, indent=2, allow_nan=False).encode() + b"\n")
    return document


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--selection", required=True)
    parser.add_argument("--lineage-root", required=True)
    parser.add_argument("--out", required=True, help="A new observations.json beside its new evidence/ directory")
    args = parser.parse_args()
    result = extract(args.selection, args.lineage_root, args.out)
    print(json.dumps({"schema": result["schema"], "projectionSha256": result["projection"]["sha256"],
                      "candidates": len(result["selection"]["candidateResults"]), "lineageCases": list(result["lineageCases"])}))
