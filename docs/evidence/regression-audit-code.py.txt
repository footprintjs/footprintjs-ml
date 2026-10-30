"""Saved scalar audit; imports no NumPy, trainer, MLflow or Node helper."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re


PROFILE = "footprint-ml-regression/raw-linear/v1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, label):
    require(type(value) in (int, float) and math.isfinite(value), label + " must be a finite non-boolean number")
    return value


def same(first, second):
    # Preserve JSON types, including boolean versus integer metadata.
    return json.dumps(first, sort_keys=True, separators=(",", ":"), allow_nan=False) == json.dumps(second, sort_keys=True, separators=(",", ":"), allow_nan=False)


def parse(content):
    def invalid(value):
        raise ValueError("Nonfinite JSON constant: " + value)
    return json.loads(content, parse_constant=invalid)


def managed(root, ref):
    require(type(ref) is dict and set(ref) == {"kind", "path", "sha256", "bytes", "format"}, "Invalid managed reference")
    require(ref["kind"] == "artifact" and type(ref["bytes"]) is int and ref["bytes"] >= 0, "Invalid byte count")
    require(type(ref["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", ref["sha256"]), "Invalid digest")
    require(type(ref["format"]) is str and bool(ref["format"]), "Invalid format")
    expected = "sha256-" + ref["sha256"] + "-" + hashlib.sha256(ref["format"].encode()).hexdigest() + ".bin"
    require(ref["path"] == expected, "Artifact path differs from its managed identity")
    file = root / "release-store" / expected
    require(not file.is_symlink() and file.is_file() and file.stat().st_size == ref["bytes"], "Artifact type/length differs")
    content = file.read_bytes()
    require(len(content) == ref["bytes"] and hashlib.sha256(content).hexdigest() == ref["sha256"], "Artifact bytes differ")
    return parse(content)


def rows(document):
    require(document.get("schema") == "footprint-ml-regression-data/v1", "Unsupported data profile")
    data = document["rows"]
    require(type(data) is list and len(data) > 0, "A nonempty full data table is required")
    ids = []
    for row in data:
        require(type(row) is dict and set(row) == {"rowId", "population", "x", "y"}, "Invalid observation row")
        require(type(row["rowId"]) is str and row["rowId"] and row["population"] in ("majority", "rare"), "Invalid row identity/population")
        number(row["x"], "x"); number(row["y"], "y")
        ids.append(row["rowId"])
    require(len(ids) == len(set(ids)), "Duplicate row IDs")
    return data


def validate_table(observed, model, dataset, receipt, predictor, document, comparison):
    data = rows(document)
    count = dataset["rows"]
    shape = dataset["shape"]
    require(type(count) is int and count > 0 and count == len(data) and type(shape) is list
            and len(shape) == 2 and all(type(dimension) is int for dimension in shape)
            and shape == [count, 1], "Dataset row count/shape differs")
    require(observed["modelRef"] == receipt["modelRef"] == model, "Evaluation model differs from the measured model")
    require(observed["datasetRef"] == receipt["datasetRef"] == dataset, "Evaluation dataset differs from the bound table")
    require(observed["rowIds"] == [row["rowId"] for row in data], "Evaluation membership/order differs")
    require(predictor["schema"] == "footprint-ml-regression-predictor/v1" and predictor["profile"] == PROFILE, "Unsupported predictor profile")
    for field in ("preprocessingVersion", "evaluationMethodVersion", "parameters"):
        require(receipt[field] == comparison[field], "Evaluation protocol differs: " + field)
    predictions = observed["predictions"]
    require(type(predictions) is list and len(predictions) == count, "Every prediction row must be retained")
    slope, intercept = (number(predictor["weights"][key], key) for key in ("slope", "intercept"))
    actual = [number(slope * row["x"] + intercept, "scalar prediction") for row in data]
    for expected, value in zip(actual, predictions):
        require(abs(expected - number(value, "saved prediction")) <= 1e-12, "Saved prediction differs from scalar arithmetic")
    mse = number(sum((prediction - row["y"]) ** 2 for prediction, row in zip(actual, data)) / count, "scalar MSE")
    require(abs(mse-number(observed["mse"], "sidecar MSE")) <= 1e-12, "Sidecar MSE differs")
    require(abs(mse-number(receipt["metrics"]["mse"], "receipt MSE")) <= 1e-12, "Receipt MSE differs")
    return mse


def projection(value):
    if isinstance(value, list):
        return [projection(item) for item in value]
    if isinstance(value, dict):
        excluded = {"bindings"} if str(value.get("kind", "")).endswith("-decision") else set()
        if value.get("kind") == "model-release-publication": excluded.add("record")
        return {key: projection(item) for key, item in value.items() if key not in excluded}
    return value


def audit(directory):
    root = Path(directory).resolve()
    load = lambda name: parse((root / name).read_bytes())
    recording, outcome, numerical = (load(name) for name in ("recording.json", "outcome.json", "numerical-observations.json"))
    state = recording["snapshot"]["sharedState"]
    checks = {}
    def check(name, condition):
        require(condition, name)
        checks[name] = True
    check("capturedOutcomeMatchesSidecar", state["outcome"] == outcome)
    check("allWorkflowControlsPass", len(outcome["checks"]) == 16 and all(type(v) is bool and v for v in outcome["checks"].values()))
    commits = [commit["stageId"] for commit in recording["snapshot"]["commitLog"]]
    check("declarationPrecedesGenerationTrainingAndEvaluation", commits.index("declare-before-training") < commits.index("generate-declared-data") < commits.index("train-two-models") < commits.index("evaluate-baseline"))
    protocol = managed(root, state["protocolArtifact"])
    check("protocolMatchesCapturedDeclaration", protocol == state["dataProtocol"])
    check("actualConfigurationsMatchDeclaredExperiment", state["candidateConfigurations"] == [
        {"candidateId": "baseline", "configuration": {"algorithm": "least-squares", "weighting": "equal-population-mass"}},
        {"candidateId": "pooled", "configuration": {"algorithm": "least-squares", "weighting": "equal-row-mass"}}])
    training = managed(root, state["trainingArtifact"])
    parent = managed(root, state["validationDatasetRef"]["artifact"])
    training_rows, validation_rows = rows(training), rows(parent)
    check("trainingAndValidationIDsAreDisjoint", not {r["rowId"] for r in training_rows} & {r["rowId"] for r in validation_rows})
    for split, data in (("training", training_rows), ("validation", validation_rows)):
        expected_counts = protocol["splits"][split]["rows"]
        check(split + "DeclaredPopulationCounts", {group: sum(r["population"] == group for r in data) for group in protocol["populations"]} == expected_counts)
        check(split + "DeclaredGeneratingRelation", all(abs(r["y"]-(protocol["slope"]*r["x"]+protocol["intercepts"][r["population"]])) <= 1e-12 for r in data))
    tables = {"overall": (state["validationDatasetRef"], parent)}
    require(len(state["groups"]) == 2 and {g["groupId"] for g in state["groups"]} == {"majority", "rare"}, "Both predeclared groups must be retained")
    for group in state["groups"]:
        name = group["groupId"]
        definition = managed(root, group["definitionRef"])
        membership = managed(root, group["membershipRef"])
        subset = managed(root, group["datasetRef"]["artifact"])
        expected = [row for row in validation_rows if row["population"] == name]
        check(name + "DefinitionMatchesIndependentMetadata", definition["groupId"] == name and definition["rule"] == {"field": "population", "operator": "eq", "value": name})
        check(name + "MembershipMatchesActualParentRows", membership["parentArtifact"] == state["validationDatasetRef"]["artifact"] and membership["groupId"] == name and membership["rowIds"] == [r["rowId"] for r in expected])
        check(name + "SubsetAndCountMatchMembership", rows(subset) == expected and type(group["expectedRows"]) is int and len(expected) == group["expectedRows"] == group["datasetRef"]["rows"] == state["expectedGroupRows"][name])
        tables[name] = (group["datasetRef"], subset)
    require(set(numerical["models"]) == {"baseline", "pooled"} and set(numerical["evaluations"]) == {"baseline", "pooled", "unchanged"}, "Complete model and evaluation sets are required")
    models, predictors = {}, {}
    for label, key in (("baseline", "baselineModelRef"), ("pooled", "candidateModelRef")):
        observed = numerical["models"][label]
        model = state[key]
        predictor = managed(root, observed["artifact"])
        check(label + "PredictorBindsActualModel", observed["artifact"] == model["originArtifact"] == outcome["models"][label]["originArtifact"] and observed["bundle"] == predictor and model["inferenceIdentity"]["profile"] == PROFILE and model["inferenceIdentity"]["sha256"] == model["originArtifact"]["sha256"])
        # Independent scalar two-by-two normal equations for this narrow linear profile.
        counts = {group: sum(r["population"] == group for r in training_rows) for group in protocol["populations"]}
        weighted = [(row, 1/counts[row["population"]] if label == "baseline" else 1.) for row in training_rows]
        sw = sum(w for r,w in weighted); sx = sum(w*r["x"] for r,w in weighted); sy = sum(w*r["y"] for r,w in weighted)
        sxx = sum(w*r["x"]**2 for r,w in weighted); sxy = sum(w*r["x"]*r["y"] for r,w in weighted)
        slope = (sw*sxy-sx*sy)/(sw*sxx-sx*sx); intercept = (sy-slope*sx)/sw
        check(label + "WeightsMatchDeclaredLeastSquares", abs(number(predictor["weights"]["slope"], "slope")-slope) <= 1e-12 and abs(number(predictor["weights"]["intercept"], "intercept")-intercept) <= 1e-12)
        models[label], predictors[label] = model, predictor
    metrics = {}
    for label in ("baseline", "pooled", "unchanged"):
        model_label = "baseline" if label == "unchanged" else label
        observed_tables = numerical["evaluations"][label]
        require(set(observed_tables) == set(tables), "All evaluation groups and overall rows are required")
        metrics[label] = {}
        for name, (ref, table) in tables.items():
            receipt = state[label + "Receipts"][name]["receipt"]
            metrics[label][name] = validate_table(observed_tables[name], models[model_label], ref, receipt, predictors[model_label], table, state["comparison"])
            check(label + name + "CompletePredictionsAndMetricsBound", abs(metrics[label][name] - number(outcome["metrics"][label][name], "outcome MSE")) <= 1e-12)
    for label in ("pooled", "unchanged"):
        manifest = state[label + "Manifest"]
        check(label + "ManifestPreservesPredeclaredGroupsAndPolicy", manifest["groups"] == state["groups"] and manifest["policies"] == state["predeclaredPolicies"] and manifest["comparison"] == state["comparison"])
        observations = state[label + "Observations"]
        require(type(observations) is list and len(observations) == 2
                and {item["groupId"] for item in observations} == {"majority", "rare"}, "Exactly one paired observation per predefined group is required")
        check(label + "CapturedEvidenceMatchesPinnedArtifacts", same(managed(root, state[label + "ManifestRef"]), manifest)
            and same(managed(root, state[label + "ObservationsRef"]), observations)
            and same(managed(root, state[label + "ReceiptRef"]), state[label + "Receipt"])
            and same(state[label + "Receipt"]["manifest"], manifest) and same(state[label + "Receipt"]["observations"], observations))
        for observation in observations:
            name = observation["groupId"]
            check(label + name + "PairedEvidenceMatchesActualEvaluation", observation["baseline"] == state["baselineReceipts"][name]["receipt"] and observation["candidate"] == state[label + "Receipts"][name]["receipt"] and observation["rows"] == tables[name][0]["rows"])
    require(type(outcome["fullNativeResponses"]) is dict and set(outcome["fullNativeResponses"]) == {"pooledDecision", "unchangedDecision", "blockedRelease", "retainedRelease", "retryRelease"}, "All five full native responses must be retained")
    for name, reference in outcome["fullNativeResponses"].items():
        require(same(reference, state[name + "Ref"]), "Full native response ref differs from its captured reference")
        original = managed(root, reference)
        check(name + "CompactViewExactlyMatchesPinnedNativeResponse", projection(original) == state[name])
        label = "pooled" if name in ("pooledDecision", "blockedRelease") else "unchanged"
        native_guard = original if name.endswith("Decision") else original["decision"]["checks"]["regression"]
        check(name + "NativeBindingsMatchConsumedInputs", same(native_guard["bindings"]["expected"], {"manifest": state[label + "Manifest"], "observations": state[label + "Observations"]})
            and same(native_guard["bindings"]["receipt"], state[label + "Receipt"])
            and same(native_guard["bindings"]["proposed"]["modelRef"], state["candidateModelRef" if label == "pooled" else "baselineModelRef"]))
    check("averageImprovementAndRareRegressionAreObserved", metrics["pooled"]["overall"] < metrics["baseline"]["overall"] and metrics["pooled"]["rare"] > metrics["baseline"]["rare"])
    for row in state["pooledDecision"]["comparisons"]:
        expected = metrics["pooled"][row["groupId"]] - metrics["baseline"][row["groupId"]]
        check(row["groupId"] + "NativeDeteriorationMatchesScalarDifference", abs(number(row["deterioration"], "deterioration")-expected) <= 1e-12)
    check("singleExactBaselinePublication", len(state["localPublicationState"]["publications"]) == 1 and outcome["publication"] == state["approvedPublication"] and outcome["publication"]["artifact"]["sha256"] == models["baseline"]["originArtifact"]["sha256"])
    check("noModelWeightsOrPredictionsInScope", '"weights"' not in json.dumps(state) and '"predictions"' not in json.dumps(state))
    report = {"schema": "footprint-ml-regression-saved-audit/v1", "passed": True, "checks": checks,
        "auditedPredictionRows": sum(len(table[1]["rows"]) for table in tables.values()) * 3,
        "source": {name: {"sha256": hashlib.sha256((root/name).read_bytes()).hexdigest(), "bytes": (root/name).stat().st_size} for name in ("recording.json", "outcome.json", "numerical-observations.json")},
        "execution": {"savedArtifactsOnly": True, "scalarArithmetic": True, "numpyImported": False, "trainingRepeated": False, "guardRecomputed": False, "publicationPerformed": False},
        "boundaries": ["Scalar normal equations and predictions validate only this explicit fixed linear profile, not arbitrary numerical trainers.", "Saved hashes and consistent recording do not authenticate a producer or establish statistical significance."]}
    with (root/"audit.json").open("x") as file: json.dump(report, file, indent=2, allow_nan=False)
    print(json.dumps({"passed": True, "checks": len(checks), "auditedPredictionRows": report["auditedPredictionRows"]}))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--run", required=True)
    audit(parser.parse_args().run)
