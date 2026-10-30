"""Actual checked publication, restored predictor and two closed monitoring windows."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

try:
    from footprint_ml_workflow import WorkflowCapture
    if not hasattr(WorkflowCapture, "check_monitoring"):
        raise ModuleNotFoundError("Matching source SDK required", name="footprint_ml_workflow")
except ModuleNotFoundError as error:
    if error.name != "footprint_ml_workflow": raise
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
    sys.modules.pop("footprint_ml_workflow", None)
    from footprint_ml_workflow import WorkflowCapture

import numpy as np
from numerical import FORMAT, JOIN_MODE, METHOD, PREPROCESSING, PROFILE, Backend, digest, encode, fit, joined, predictor, write_json


def now(): return int(time.time() * 1000)


def compact(value):
    if isinstance(value, list): return [compact(item) for item in value]
    if isinstance(value, dict):
        omitted = {"bindings"} if str(value.get("kind", "")).endswith("-decision") else set()
        if value.get("kind") == "model-release-publication": omitted.add("record")
        return {key: compact(item) for key,item in value.items() if key not in omitted}
    return value


class LocalPublisher:
    def __init__(self, configuration): self.configuration = configuration
    def call(self, operation, request):
        result = subprocess.run([shutil.which("node") or "node", str(Path(__file__).with_name("local-publisher.mjs")), operation,
            self.configuration["storeRoot"], self.configuration["publisherRoot"]], input=json.dumps(request, allow_nan=False),
            capture_output=True, text=True, timeout=10)
        if result.returncode: raise RuntimeError("Local receiver failed: " + result.stderr[-2000:])
        return json.loads(result.stdout)
    def lookup(self, request): return self.call("lookup", request)
    def publish(self, request): return self.call("publish", request)
    def target(self): return self.call("target", {"name": self.configuration["targetName"]})
    def state(self): return self.call("state", {})


def run(out, runtime_dir=None):
    root = Path(out).resolve(); root.mkdir(parents=True, exist_ok=False)
    store, published_store = root/"release-store", root/"local-publication"
    trained, deployed = Backend(), Backend()
    numerical = {"schema": "footprint-ml-monitoring-numerical-observations/v1", "windows": {}, "cases": {}}
    def put(capture, value, name, format="application/json"):
        return capture.put_release_artifact(write_json(root/"inputs"/(name+".json"), value), store_root=store, format=format)
    def content(reference, directory=store):
        data = (directory/reference["path"]).read_bytes()
        if len(data) != reference["bytes"] or digest(data) != reference["sha256"]: raise RuntimeError("Consumed artifact identity differs")
        return data
    def read(reference): return json.loads(content(reference))
    def data_ref(artifact, rows, handle, role="validation", session=None):
        return {"kind":"dataset","sessionId":session or deployed.session,"handle":handle,"artifact":artifact,
                "rows":rows,"shape":[rows,1],"role":role}
    with WorkflowCapture(root/"recording.json", runtime_dir=runtime_dir) as capture:
        with capture.stage("declare-before-training", name="Declare model, window schema and monitoring limits before numerical work") as s:
            anchor = now()
            s["protocol"] = {"schema":"footprint-ml-monitoring-protocol/v1","trainingRows":32,"validationRows":16,
                "windowRows":12,"xRange":[-1.5,1.5],"slope":2.,"intercept":1.,"labelOffsets":{"W1":0.,"W2":3.},
                "windowDeclarations":[{"windowId":"W1","startAt":anchor-20000,"endAt":anchor-10000,"inferenceId":"predict-W1"},
                                      {"windowId":"W2","startAt":anchor-10000,"endAt":anchor,"inferenceId":"predict-W2"}]}
            s["protocolRef"] = put(capture, s["protocol"], "protocol")
            s["expectedContract"] = capture.create_prediction_contract({"profile":PROFILE,
                "input":{"fields":[{"name":"x","dtype":"float64"}]},"output":{"fields":[{"name":"y","dtype":"float64"}]},
                "preprocessingVersion":PREPROCESSING,"parameters":{}})
            s["labelSource"] = {"name":"synthetic-outcomes","version":"fixed-label-process/v1"}
            s["monitoringEvaluation"] = {"preprocessingVersion":PREPROCESSING,"evaluationMethodVersion":METHOD,"parameters":{"joinMode":JOIN_MODE}}
            s["monitoringPolicy"] = {"metric":"mse","operator":"lte","threshold":1.,"minSamples":8,"minCoverage":1.,"maxAgeMs":300000}
            s["candidateDeclaration"] = {"candidateId":"approved-linear","configuration":{"algorithm":"ordinary-least-squares"}}
            s["qualityPolicy"] = {"metric":"mse","operator":"lte","threshold":.01}
            s["publisherConfiguration"] = {"storeRoot":str(store),"publisherRoot":str(published_store),"targetName":"monitoring-proof-model"}
            s["caseDeclarations"] = {
                "missingLabels":{"windowId":"W2","labelsFrom":None,"transform":None},
                "healthy":{"windowId":"W1","labelsFrom":"W1","transform":None},
                "reorderedLabels":{"windowId":"W1","labelsFrom":"W1","transform":"reorder"},
                "insufficientLabels":{"windowId":"W2","labelsFrom":"W2","transform":"partial"},
                "degraded":{"windowId":"W2","labelsFrom":"W2","transform":None},
                "duplicateLabels":{"windowId":"W2","labelsFrom":"W2","transform":"duplicate"},
                "unmatchedLabels":{"windowId":"W2","labelsFrom":"W2","transform":"unmatched"},
                "crossWindowLabels":{"windowId":"W2","labelsFrom":"W2","transform":"foreignBounds"},
                "borrowedReport":{"windowId":"W2","labelsFrom":"W2","transform":None,"borrowed":"healthy"}}
        with capture.stage("generate-declared-inputs", name="Generate disjoint training, validation and closed-window row memberships") as s:
            protocol = s["protocol"]
            for label, count, span, handle in (("training",protocol["trainingRows"],[-2.,2.],1),("validation",protocol["validationRows"],[-1.9,1.9],2)):
                document = {"schema":"footprint-ml-monitoring-training-data/v1","rows":[{"rowId":label+f"-{index:03}","x":float(x),
                    "y":float(protocol["slope"]*x+protocol["intercept"])} for index,x in enumerate(np.linspace(*span,count,dtype=np.float64))]}
                reference = put(capture, document, label)
                s[label+"Artifact"] = reference
                if label == "validation": s["validationDatasetRef"] = data_ref(reference,count,handle,session=trained.session)
            windows = {}
            for declaration in protocol["windowDeclarations"]:
                window = {key:declaration[key] for key in ("windowId","startAt","endAt")}
                rows = [{"rowId":window["windowId"]+f"-{index:03}","eventTime":window["startAt"]+(index+1)*(window["endAt"]-window["startAt"])//(protocol["windowRows"]+1),
                         "x":float(x)} for index,x in enumerate(np.linspace(*protocol["xRange"],protocol["windowRows"],dtype=np.float64))]
                input_ref = put(capture,{"schema":"footprint-ml-monitoring-input/v1","window":window,"rows":rows},window["windowId"]+"-input")
                membership_ref = put(capture,{"schema":"footprint-ml-monitoring-membership/v1","window":window,
                    "rowIds":[r["rowId"] for r in rows],"eventTimes":[r["eventTime"] for r in rows]},window["windowId"]+"-membership")
                windows[window["windowId"]] = {**window,"inputRef":input_ref,"membershipRef":membership_ref,
                    "expectedRows":protocol["windowRows"],"inferenceId":declaration["inferenceId"]}
            s["windows"] = windows
        with capture.stage("fit-and-evaluate-approved-model", name="Fit one actual model and measure its validation evidence") as s:
            weights = fit(read(s["trainingArtifact"]))
            bundle = predictor(weights,s["expectedContract"])
            artifact = put(capture,bundle,"approved-model",FORMAT)
            model = trained.retain(weights,s["expectedContract"],artifact)
            validation = read(s["validationArtifact"])
            prediction = np.asarray([r["x"] for r in validation["rows"]])*weights[0]+weights[1]
            mse = float(np.mean((prediction-np.asarray([r["y"] for r in validation["rows"]]))**2))
            s["approvedModelRef"] = model
            s["approvalComparison"] = {"datasetRef":s["validationDatasetRef"],"preprocessingVersion":PREPROCESSING,
                "evaluationMethodVersion":"held-out-linear-mse/v1","parameters":{}}
            s["approvalReceipt"] = capture.create_evaluation_receipt({**s["approvalComparison"],"modelRef":model,
                "evaluationId":"approved-validation","createdAt":now(),"metrics":{"mse":mse}})
            numerical["approvedModel"] = {"bundle":bundle,"artifact":artifact,"validationPredictions":prediction.tolist(),"mse":mse}
        with capture.stage("publish-exact-approved-model", name="Publish the exact single-candidate model through existing checked release") as s:
            declaration = s["candidateDeclaration"]
            manifest = capture.read_selection_manifest({"kind":"selection-manifest","schemaVersion":1,"experimentId":"monitoring-approval",
                "candidates":[declaration],"comparison":s["approvalComparison"],"policy":{"metric":"mse","direction":"min","tieBreak":"candidate-id-ascending"}})
            results = [{**declaration,"modelRef":s["approvedModelRef"],"evaluation":s["approvalReceipt"]}]
            selected = capture.create_selection_receipt({"selectionId":"approved-selection","createdAt":now(),"manifest":manifest,"results":results})
            configured = s["publisherConfiguration"]
            plan = capture.read_model_release_plan({"kind":"model-release-plan","schemaVersion":1,"releaseId":"monitoring-release","idempotencyKey":"monitoring-publication",
                "target":{"name":configured["targetName"],"expectedRevision":None},"modelArtifact":s["approvedModelRef"]["originArtifact"],
                "manifestRef":put(capture,manifest,"selection-manifest"),"resultsRef":put(capture,results,"selection-results"),
                "selectionReceiptRef":put(capture,selected,"selection-receipt"),"qualityPolicy":s["qualityPolicy"]})
            s["releasePlanRef"] = put(capture,plan,"release-plan")
            release = capture.release_model({"planRef":s["releasePlanRef"],"modelRef":s["approvedModelRef"]},
                store_root=store,publisher=LocalPublisher(configured),verify_model=trained.verify)
            if not release["allowed"]: raise RuntimeError("Actual local publication failed: "+str(release["reasons"]))
            s["releaseRef"] = put(capture,release,"full-release")
            s["release"] = compact(release)
            s["approvedPublicationRef"] = put(capture,release["publisherReceipt"],"approved-publication")
        with capture.stage("read-target-and-load-published-bytes", name="Read the actual current local target and restore its own artifact bytes") as s:
            configured = s["publisherConfiguration"]
            target = LocalPublisher(configured).target()
            if target is None: raise RuntimeError("The actual local target is absent")
            # Consume the publisher's installed copy, not the original release-store file.
            actual_bytes = content(target["artifact"],Path(configured["publisherRoot"]))
            loaded = deployed.load(actual_bytes,target["artifact"])
            s["observedTarget"] = target
            s["observedPublicationRef"] = put(capture,target,"observed-target")
            s["loadedModelRef"] = loaded
            s["loadedArtifactObservation"] = {"artifact":target["artifact"],"bytes":len(actual_bytes),"sha256":digest(actual_bytes),"source":"actual publisher-root store after readTarget"}
            numerical["loadedModel"] = {"bundle":json.loads(actual_bytes),"modelRef":loaded,"target":target}

        def predict_window(window_id):
            with capture.stage("predict-"+window_id,name="Observe the target snapshot and execute the actual "+window_id+" batch") as s:
                window = s["windows"][window_id]
                configured = s["publisherConfiguration"]
                target = LocalPublisher(configured).target()
                if target is None: raise RuntimeError("Target disappeared")
                observed_at, closed_at = now(), now()
                actual = deployed.actual(s["loadedModelRef"])
                output = deployed.predict(actual,read(window["inputRef"]))
                output["inferenceId"] = window["inferenceId"]
                output_ref = put(capture,output,window_id+"-predictions")
                prediction = capture.create_inference_receipt({"inferenceId":output["inferenceId"],"createdAt":now(),"inputRef":window["inputRef"],
                    "outputRef":output_ref,"inputRows":len(output["rows"]),"outputRows":len(output["rows"]),"modelRef":output["modelRef"],"contract":output["contract"]})
                observed = {"deployment":{"targetName":target["targetName"],"revision":target["revision"],"modelRef":actual,
                    "publicationRef":put(capture,target,window_id+"-observed-publication"),"observedAt":observed_at},
                    "window":{**{k:window[k] for k in ("windowId","startAt","endAt","inputRef","membershipRef")},"rows":len(output["rows"]),"closedAt":closed_at},"prediction":prediction}
                expected = capture.read_monitoring_manifest({"kind":"monitoring-manifest","schemaVersion":1,"monitorId":"monitor-"+window_id,
                    "deployment":{"targetName":configured["targetName"],"revision":s["release"]["publisherReceipt"]["revision"],
                        "modelRef":s["approvedModelRef"],"publicationRef":s["approvedPublicationRef"]},"window":window,"contract":s["expectedContract"],
                    "labelSource":s["labelSource"],"joinMode":JOIN_MODE,"evaluation":s["monitoringEvaluation"],"policy":s["monitoringPolicy"]})
                s[window_id+"Manifest"] = expected
                s[window_id+"BaseObservation"] = observed
                s[window_id+"PredictionRef"] = output_ref
                numerical["windows"][window_id] = {"inputRef":window["inputRef"],"membershipRef":window["membershipRef"],"predictionRef":output_ref}

        predict_window("W1"); predict_window("W2")

        def check_case(label):
            with capture.stage("monitor-"+label,name="Check actual monitoring evidence: "+label) as s:
                declaration = s["caseDeclarations"][label]
                window_id = declaration["windowId"]
                manifest = s[window_id+"Manifest"]
                observation = s[window_id+"BaseObservation"]
                output = read(s[window_id+"PredictionRef"])
                labels = None
                source_label_ref = None
                if declaration["labelsFrom"] is not None:
                    source_label_ref = s["labelBatchRefs"][declaration["labelsFrom"]]
                    labels = read(source_label_ref)
                    transform = declaration["transform"]
                    if transform:
                        labels["batchId"] = "derived-"+label
                    if transform == "reorder": labels["rows"].reverse()
                    elif transform == "partial": labels["rows"] = labels["rows"][:3]
                    elif transform == "duplicate": labels["rows"].append(copy.deepcopy(labels["rows"][0]))
                    elif transform == "unmatched": labels["rows"][0]["rowId"] = "unobserved-row"
                    elif transform == "foreignBounds": labels["window"].update({k:s["windows"]["W1"][k] for k in ("startAt","endAt")})
                join = joined(output,labels)
                join_ref = put(capture,join,label+"-join-report")
                evidence = {"joinRef":join_ref}
                if labels is not None:
                    label_ref = put(capture,labels,label+"-labels")
                    observation["labels"] = {"batchId":labels["batchId"],"windowId":labels["window"]["windowId"],"source":labels["source"],
                        "labelRef":label_ref,"availableAt":labels["availableAt"]}
                    facts = join["facts"]
                    observation["join"] = {"joinMode":JOIN_MODE,"windowId":output["window"]["windowId"],"inputRef":manifest["window"]["inputRef"],
                        "outputRef":s[window_id+"PredictionRef"],"labelRef":label_ref,"membershipRef":manifest["window"]["membershipRef"],"joinRef":join_ref,
                        "matchedRows":facts["matchedRows"],"missingRows":len(output["rows"])-facts["matchedRows"],"duplicateRows":facts["duplicateRows"],
                        "unmatchedRows":facts["unmatchedRows"],"crossWindowRows":facts["crossWindowRows"],"createdAt":now()}
                    if join["rows"]:
                        table_ref = put(capture,{"schema":"footprint-ml-monitoring-evaluation-table/v1","rows":join["rows"]},label+"-evaluation-table")
                        dataset = data_ref(table_ref,len(join["rows"]),100+len(numerical["cases"]),role="monitoring")
                        observation["join"]["joinedDatasetRef"] = dataset
                        observation["evaluation"] = capture.create_evaluation_receipt({**s["monitoringEvaluation"],"evaluationId":label+"-evaluation",
                            "createdAt":now(),"modelRef":deployed.actual(s["loadedModelRef"]),"datasetRef":dataset,"metrics":{"mse":join["mse"]}})
                        evidence["joinedDatasetRef"] = dataset
                    evidence["labelRef"] = label_ref
                s[label+"Observation"] = observation
                receipt = capture.create_monitoring_receipt({"monitoringId":label,"createdAt":now(),"manifest":manifest,"observation":s[label+"Observation"]})
                s[label+"Receipt"] = receipt
                offered = s[declaration["borrowed"]+"Receipt"] if declaration.get("borrowed") else s[label+"Receipt"]
                result = capture.check_monitoring({"receipt":offered,"manifest":manifest,"observation":s[label+"Observation"],"now":now()})
                s[label+"DecisionRef"] = put(capture,result,label+"-full-decision")
                s[label+"Decision"] = compact(result)
                numerical["cases"][label] = {"windowId":window_id,"evidence":evidence,"sourceLabelRef":source_label_ref}

        # Labels are intentionally absent at the first W2 check.
        check_case("missingLabels")
        with capture.stage("receive-label-batches",name="Create the separately arriving labeled outcome batches after prediction") as s:
            protocol = s["protocol"]
            batches = {}
            for window_id in ("W1","W2"):
                input_document = read(s["windows"][window_id]["inputRef"])
                batches[window_id] = {"schema":"footprint-ml-monitoring-labels/v1","batchId":"outcomes-"+window_id,
                    "source":s["labelSource"],"window":input_document["window"],"availableAt":now(),
                    "rows":[{"rowId":r["rowId"],"eventTime":r["eventTime"],"label":float(protocol["slope"]*r["x"]+protocol["intercept"]+protocol["labelOffsets"][window_id])} for r in input_document["rows"]]}
            s["labelBatchRefs"] = {key:put(capture,value,key+"-arriving-labels") for key,value in batches.items()}
        for label in ("healthy","reorderedLabels","insufficientLabels","degraded","duplicateLabels","unmatchedLabels","crossWindowLabels","borrowedReport"):
            check_case(label)
        with capture.stage("record-monitoring-findings",name="Retain health decisions without a serving-pause or rollback effect") as s:
            declarations = s["caseDeclarations"]
            decisions = {label:s[label+"Decision"] for label in declarations}
            publisher = LocalPublisher(s["publisherConfiguration"])
            s["postMonitoringTarget"] = publisher.target()
            s["localPublicationState"] = publisher.state()
            checks = {"modelWasActuallyPublished":s["release"]["status"]=="published",
                "loadedActualCurrentTargetArtifact":s["loadedArtifactObservation"]["sha256"]==s["observedTarget"]["artifact"]["sha256"]==s["approvedModelRef"]["originArtifact"]["sha256"],
                "sameLoadedModelForBothWindows":s["W1BaseObservation"]["prediction"]["modelRef"]==s["W2BaseObservation"]["prediction"]["modelRef"],
                "healthyWindowAllowed":decisions["healthy"]["allowed"] and decisions["healthy"]["health"]=="healthy",
                "reorderedIntactLabelsAllowed":decisions["reorderedLabels"]["allowed"] and decisions["reorderedLabels"]["health"]=="healthy",
                "delayedLabelsUnknown":decisions["missingLabels"]["status"]=="unknown" and decisions["missingLabels"]["health"] is None,
                "insufficientCoverageUnknown":decisions["insufficientLabels"]["status"]=="unknown" and decisions["insufficientLabels"]["health"] is None,
                "poorWindowDenied":decisions["degraded"]["status"]=="deny" and decisions["degraded"]["health"]=="degraded",
                "poorWindowRecommendsReview":decisions["degraded"]["recommendation"]=="review",
                "onePublicationUnchangedByMonitoring":len(s["localPublicationState"]["publications"])==1 and s["postMonitoringTarget"]["revision"]==s["release"]["publisherReceipt"]["revision"],
                "duplicateLabelsDenied":decisions["duplicateLabels"]["status"]=="deny",
                "unmatchedLabelsDenied":decisions["unmatchedLabels"]["status"]=="deny","foreignWindowBoundsDenied":decisions["crossWindowLabels"]["status"]=="deny",
                "borrowedW1ReportDeniedForW2":decisions["borrowedReport"]["status"]=="deny"}
            if not all(checks.values()): raise RuntimeError("Monitoring proof failed: "+", ".join(k for k,v in checks.items() if not v))
            outcome = {"schema":"footprint-ml-monitoring-proof-outcome/v1","checks":checks,"decisions":decisions,
                "fullDecisionRefs":{label:s[label+"DecisionRef"] for label in declarations},"publication":s["release"]["publisherReceipt"],
                "loadedModel":s["loadedModelRef"],"windows":s["windows"],"execution":{"orchestration":"Python with native foottrace capture",
                    "trainedModels":1,"predictionWindows":2,"numpy":np.__version__,"actualLocalPublication":True,"hostedServing":False,"servingPausePerformed":False},
                "boundaries":["Two predefined closed event-time batches are processed by a local restored backend now; no claim of historical hosted deployment.",
                    "W2 has an explicitly simulated changed target process with the same x pattern. The monitoring decision does not identify feature drift or a statistical root cause.",
                    "Labels and mapping facts remain trusted application observations; hashes cannot detect incorrect label truth assigned to otherwise valid IDs.",
                    "Keyed joins accept reordered intact rows. Partial, duplicate, unmatched and foreign-bounds inputs are explicitly derived controls.",
                    "Healthy/degraded/unknown is evidence for review, not an automatic serving pause, deployment rollback or durable streaming system.",
                    "Full native decisions are pinned artifacts; scope retains exact compact views without duplicated bindings. Numerical arrays remain outside scope."]}
            s["outcome"] = outcome
    write_json(root/"outcome.json",outcome); write_json(root/"numerical-observations.json",numerical)
    print(json.dumps({"out":str(root),"checks":checks,"decisions":{key:{k:v for k,v in value.items() if k in ("allowed","status","health","recommendation")} for key,value in decisions.items()}},indent=2))
    return outcome


if __name__ == "__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--out",required=True);parser.add_argument("--runtime-dir")
    args=parser.parse_args();run(args.out,runtime_dir=args.runtime_dir)
