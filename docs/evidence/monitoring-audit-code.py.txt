"""Recheck saved rows, installed bytes and keyed joins using only the stdlib."""
from __future__ import annotations

import argparse
from collections import Counter
import copy
import hashlib
import json
import math
from pathlib import Path
import re

CASES = {"missingLabels","healthy","reorderedLabels","insufficientLabels","degraded","duplicateLabels","unmatchedLabels","crossWindowLabels","borrowedReport"}
CASE_DECLARATIONS = {
    "missingLabels":{"windowId":"W2","labelsFrom":None,"transform":None},
    "healthy":{"windowId":"W1","labelsFrom":"W1","transform":None},
    "reorderedLabels":{"windowId":"W1","labelsFrom":"W1","transform":"reorder"},
    "insufficientLabels":{"windowId":"W2","labelsFrom":"W2","transform":"partial"},
    "degraded":{"windowId":"W2","labelsFrom":"W2","transform":None},
    "duplicateLabels":{"windowId":"W2","labelsFrom":"W2","transform":"duplicate"},
    "unmatchedLabels":{"windowId":"W2","labelsFrom":"W2","transform":"unmatched"},
    "crossWindowLabels":{"windowId":"W2","labelsFrom":"W2","transform":"foreignBounds"},
    "borrowedReport":{"windowId":"W2","labelsFrom":"W2","transform":None,"borrowed":"healthy"}}
PROFILE = "footprint-ml-monitoring/raw-linear/v1"
JOIN_MODE = "row-id-window-time/v1"


def require(condition, message):
    if not condition: raise ValueError(message)


def number(value, label="value"):
    require(type(value) in (int,float) and math.isfinite(value), label+" must be finite and non-boolean")
    return value


def count(value, label="count", minimum=0):
    require(type(value) is int and value >= minimum, label+" must be an integer")
    return value


def same(a,b):
    return json.dumps(a,sort_keys=True,separators=(",",":"),allow_nan=False)==json.dumps(b,sort_keys=True,separators=(",",":"),allow_nan=False)


def parse(content):
    def invalid(value): raise ValueError("Nonfinite JSON constant: "+value)
    return json.loads(content,parse_constant=invalid)


def managed(root,reference,directory="release-store"):
    require(type(reference) is dict and set(reference)=={"kind","path","sha256","bytes","format"},"Invalid managed reference")
    require(reference["kind"]=="artifact" and type(reference["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}",reference["sha256"]),"Invalid artifact identity")
    count(reference["bytes"],"artifact bytes")
    require(type(reference["format"]) is str and reference["format"],"Invalid format")
    filename="sha256-"+reference["sha256"]+"-"+hashlib.sha256(reference["format"].encode()).hexdigest()+".bin"
    require(reference["path"]==filename,"Artifact path does not match managed identity")
    path=root/directory/filename
    require(not path.is_symlink() and path.is_file() and path.stat().st_size==reference["bytes"],"Artifact type/size differs")
    content=path.read_bytes()
    require(len(content)==reference["bytes"] and hashlib.sha256(content).hexdigest()==reference["sha256"],"Artifact bytes differ")
    return parse(content)


def compact(value):
    if isinstance(value,list): return [compact(item) for item in value]
    if isinstance(value,dict):
        skip={"bindings"} if str(value.get("kind","")).endswith("-decision") else set()
        if value.get("kind")=="model-release-publication": skip.add("record")
        return {key:compact(item) for key,item in value.items() if key not in skip}
    return value


def window_rows(document,expected):
    count(expected["startAt"],"window start");count(expected["endAt"],"window end")
    require(expected["startAt"]<expected["endAt"],"Window must be nonempty")
    require(document["schema"]=="footprint-ml-monitoring-input/v1" and same(document["window"],{k:expected[k] for k in ("windowId","startAt","endAt")}),"Input window differs")
    rows=document["rows"];require(type(rows) is list and len(rows)==count(expected["expectedRows"],"expectedRows",1),"All input rows are required")
    ids=[]
    for row in rows:
        require(set(row)=={"rowId","eventTime","x"} and type(row["rowId"]) is str and row["rowId"],"Invalid input row")
        number(row["x"],"x");count(row["eventTime"],"event time")
        require(expected["startAt"]<=row["eventTime"]<expected["endAt"],"Input event is outside half-open bounds")
        ids.append(row["rowId"])
    require(len(ids)==len(set(ids)),"Duplicate input row IDs")
    return rows


def keyed_join(predictions,labels):
    rows=predictions["rows"];require(type(rows) is list and len(rows)>0,"Predictions must be nonempty")
    keys=[(row["rowId"],row["eventTime"]) for row in rows]
    require(len(keys)==len(set(keys)),"Duplicate prediction keys")
    incoming=[] if labels is None else labels["rows"]
    require(type(incoming) is list,"Label rows must be a list")
    frequencies=Counter()
    for row in incoming:
        require(set(row)=={"rowId","eventTime","label"} and type(row["rowId"]) is str and row["rowId"],"Invalid label row")
        count(row["eventTime"],"label event time");number(row["label"],"label")
        frequencies[(row["rowId"],row["eventTime"])]+=1
    duplicate=sum(n-1 for n in frequencies.values())
    unmatched=sum((row["rowId"],row["eventTime"]) not in set(keys) for row in incoming)
    w=predictions["window"]
    cross=sum(not (same(labels["window"],w) and w["startAt"]<=row["eventTime"]<w["endAt"]) for row in incoming)
    matched=[]
    if not (duplicate or unmatched or cross):
        by_key={(row["rowId"],row["eventTime"]):row for row in incoming}
        matched=[{"rowId":row["rowId"],"eventTime":row["eventTime"],"prediction":row["prediction"],"label":by_key[(row["rowId"],row["eventTime"])]["label"]}
                 for row in rows if (row["rowId"],row["eventTime"]) in by_key]
    mse=sum((number(row["prediction"])-row["label"])**2 for row in matched)/len(matched) if matched else None
    return matched,{"mode":JOIN_MODE,"predictionRows":len(rows),"labelRows":len(incoming),"matchedRows":len(matched),
                    "duplicateRows":duplicate,"unmatchedRows":unmatched,"crossWindowRows":cross},mse


def validate_evaluation(observation,table,model,context,expected_mse):
    require(type(table["rows"]) is list and len(table["rows"])>0,"Evaluation rows cannot be empty")
    joined=observation["join"];dataset=joined["joinedDatasetRef"]
    n=count(dataset["rows"],"dataset rows",1);shape=dataset["shape"]
    require(type(shape) is list and len(shape)==2 and all(type(x) is int for x in shape) and shape==[n,1] and n==len(table["rows"])==joined["matchedRows"],"Evaluation row count/shape differs")
    evaluation=observation["evaluation"]
    require(same(evaluation["datasetRef"],dataset) and same(evaluation["modelRef"],model),"Evaluation used another model or dataset")
    for key in ("preprocessingVersion","evaluationMethodVersion","parameters"): require(same(evaluation[key],context[key]),"Evaluation protocol differs")
    require(abs(number(evaluation["metrics"]["mse"],"MSE")-number(expected_mse,"scalar MSE"))<=1e-12,"Evaluation metric differs from actual joined rows")


def audit(directory):
    root=Path(directory).resolve();load=lambda name:parse((root/name).read_bytes())
    recording,outcome,numerical=(load(name) for name in ("recording.json","outcome.json","numerical-observations.json"))
    state=recording["snapshot"]["sharedState"];checks={}
    def check(name,value): require(value,name);checks[name]=True
    check("capturedOutcomeMatches",same(state["outcome"],outcome))
    check("allWorkflowChecksPass",len(outcome["checks"])==14 and all(type(value) is bool and value for value in outcome["checks"].values()))
    require(set(state["caseDeclarations"])==set(numerical["cases"])==set(outcome["decisions"])==set(outcome["fullDecisionRefs"])==CASES,"All nine independently declared cases are required")
    check("exactDeclaredControlProfilesRetained",same(state["caseDeclarations"],CASE_DECLARATIONS))
    protocol=managed(root,state["protocolRef"]);check("protocolMatchesCapturedDeclaration",same(protocol,state["protocol"]))
    number(protocol["slope"],"protocol slope");number(protocol["intercept"],"protocol intercept")
    for offset in protocol["labelOffsets"].values(): number(offset,"declared label offset")
    stages=[row["stageId"] for row in recording["snapshot"]["commitLog"]]
    check("declarationPrecedesTrainingAndPredictions",stages.index("declare-before-training")<stages.index("fit-and-evaluate-approved-model")<stages.index("predict-W1")<stages.index("predict-W2"))
    check("labelsWereWithheldUntilAfterMissingCheck",stages.index("monitor-missingLabels")<stages.index("receive-label-batches")<stages.index("monitor-degraded"))
    trained=managed(root,state["approvedModelRef"]["originArtifact"])
    installed=managed(root,state["observedTarget"]["artifact"],"local-publication")
    check("numericalTrainingSidecarBindsApprovedArtifact",same(numerical["approvedModel"]["artifact"],state["approvedModelRef"]["originArtifact"]) and same(numerical["approvedModel"]["bundle"],trained))
    check("loadedActualInstalledBytes",same(trained,installed) and same(installed,numerical["loadedModel"]["bundle"]) and same(state["loadedModelRef"],numerical["loadedModel"]["modelRef"]))
    check("measuredPredictorIdentityMatchesInstalledArtifact",installed["profile"]==PROFILE and state["loadedModelRef"]["inferenceIdentity"]["sha256"]==state["loadedModelRef"]["originArtifact"]["sha256"]==state["observedTarget"]["artifact"]["sha256"])
    check("loadedObservationNamesPublisherStore",state["loadedArtifactObservation"]["source"]=="actual publisher-root store after readTarget")
    full_release=managed(root,state["releaseRef"])
    check("releaseFullResponseMatchesCompactCapture",same(compact(full_release),state["release"]))
    require(same(managed(root,state["approvedPublicationRef"]),state["release"]["publisherReceipt"]),"Approved publication ref differs")
    require(same(managed(root,state["observedPublicationRef"]),state["observedTarget"]),"Actual target publication ref differs")
    registry=load("local-publication/registry.json")
    check("oneActualPublicationAndUnchangedTarget",len(registry["publications"])==1 and same(registry["publications"][0],state["observedTarget"]) and same(state["postMonitoringTarget"],state["observedTarget"]))
    weights=installed["weights"];slope,intercept=(number(weights[key],key) for key in ("slope","intercept"))
    training_document=managed(root,state["trainingArtifact"]);validation_document=managed(root,state["validationArtifact"])
    require(training_document["schema"]==validation_document["schema"]=="footprint-ml-monitoring-training-data/v1","Training/validation schema differs")
    training=training_document["rows"];validation=validation_document["rows"]
    for label,rows,expected_count in (("training",training,protocol["trainingRows"]),("validation",validation,protocol["validationRows"])):
        require(type(rows) is list and len(rows)==count(expected_count,label+" count",1),"Training/validation rows differ")
        require(len({row["rowId"] for row in rows})==len(rows),"Duplicate training/validation row IDs")
        for row in rows:
            require(set(row)=={"rowId","x","y"} and type(row["rowId"]) is str and row["rowId"],"Invalid training/validation row")
            number(row["x"]);number(row["y"])
        check(label+"FollowsFixedGeneratingRelation",all(abs(row["y"]-(protocol["slope"]*row["x"]+protocol["intercept"]))<=1e-12 for row in rows))
    check("trainingAndValidationMembershipsAreDisjoint",not {r["rowId"] for r in training}&{r["rowId"] for r in validation})
    validation_ref=state["validationDatasetRef"];shape=validation_ref["shape"]
    require(type(shape) is list and len(shape)==2 and all(type(x) is int for x in shape) and shape==[len(validation),1]
        and count(validation_ref["rows"],"validation rows",1)==len(validation) and same(validation_ref["artifact"],state["validationArtifact"]),"Approval validation dataset differs")
    approval=state["approvalReceipt"];comparison=state["approvalComparison"]
    check("approvalReceiptUsesActualModelDataAndProtocol",same(approval["modelRef"],state["approvedModelRef"]) and same(approval["datasetRef"],validation_ref) and same(comparison["datasetRef"],validation_ref)
        and all(same(approval[field],comparison[field]) for field in ("preprocessingVersion","evaluationMethodVersion","parameters")))
    release_plan=managed(root,state["releasePlanRef"]);release_results=managed(root,release_plan["resultsRef"]);release_manifest=managed(root,release_plan["manifestRef"])
    check("approvalMatchesActualPinnedReleaseInputs",type(release_results) is list and len(release_results)==1 and same(release_results[0]["evaluation"],approval)
        and same(release_results[0]["modelRef"],state["approvedModelRef"]) and same(release_manifest["comparison"],comparison)
        and same(release_manifest["candidates"],[state["candidateDeclaration"]]) and same(full_release["record"]["planRef"],state["releasePlanRef"]))
    sw=len(training);sx=sum(r["x"] for r in training);sy=sum(r["y"] for r in training);sxx=sum(r["x"]**2 for r in training);sxy=sum(r["x"]*r["y"] for r in training)
    scalar_slope=(sw*sxy-sx*sy)/(sw*sxx-sx*sx);scalar_intercept=(sy-scalar_slope*sx)/sw
    check("weightsMatchScalarLeastSquares",abs(slope-scalar_slope)<=1e-12 and abs(intercept-scalar_intercept)<=1e-12)
    validation_predictions=numerical["approvedModel"]["validationPredictions"]
    require(type(validation_predictions) is list and len(validation_predictions)==len(validation),"Every validation prediction is required")
    vmse=sum((slope*r["x"]+intercept-r["y"])**2 for r in validation)/len(validation)
    check("validationPredictionsAndMetricsMatch",all(abs(number(p)-(slope*r["x"]+intercept))<=1e-12 for p,r in zip(validation_predictions,validation)) and abs(number(numerical["approvedModel"]["mse"])-vmse)<=1e-12 and abs(number(state["approvalReceipt"]["metrics"]["mse"])-vmse)<=1e-12)
    require(set(state["windows"])==set(numerical["windows"])=={"W1","W2"},"Both windows must be retained")
    predicted={};input_rows={}
    for name,window in state["windows"].items():
        source=window_rows(managed(root,window["inputRef"]),window);input_rows[name]=source
        cohort=managed(root,window["membershipRef"])
        check(name+"MembershipMatchesActualInputRows",same(cohort["window"],{k:window[k] for k in ("windowId","startAt","endAt")}) and cohort["rowIds"]==[r["rowId"] for r in source] and cohort["eventTimes"]==[r["eventTime"] for r in source])
        metadata=numerical["windows"][name]
        require(same(metadata,{"inputRef":window["inputRef"],"membershipRef":window["membershipRef"],"predictionRef":state[name+"PredictionRef"]}),"Window sidecar references differ")
        prediction=managed(root,state[name+"PredictionRef"]);predicted[name]=prediction
        require(same(prediction["window"],{key:window[key] for key in ("windowId","startAt","endAt")}) and prediction["inferenceId"]==window["inferenceId"],"Actual prediction window/invocation differs")
        require(type(prediction["rows"]) is list and len(prediction["rows"])==len(source),"Every window prediction is required")
        for actual,operand in zip(prediction["rows"],source):
            require(set(actual)=={"rowId","eventTime","prediction"} and actual["rowId"]==operand["rowId"] and type(actual["eventTime"]) is int and actual["eventTime"]==operand["eventTime"],"Prediction membership differs")
            require(abs(number(actual["prediction"])-(slope*operand["x"]+intercept))<=1e-12,"Prediction arithmetic differs")
        base=state[name+"BaseObservation"];receipt=base["prediction"]
        check(name+"InferenceBindsActuallyLoadedModelAndRows",same(prediction["modelRef"],state["loadedModelRef"]) and same(receipt["modelRef"],prediction["modelRef"]) and same(prediction["contract"],installed["contract"]) and same(receipt["contract"],installed["contract"]) and receipt["inferenceId"]==prediction["inferenceId"] and same(receipt["inputRef"],window["inputRef"]) and same(receipt["outputRef"],state[name+"PredictionRef"]) and type(receipt["inputRows"]) is int and type(receipt["outputRows"]) is int and receipt["inputRows"]==receipt["outputRows"]==len(source))
        check(name+"ObservedPublicationBindsActualTarget",same(managed(root,base["deployment"]["publicationRef"]),state["observedTarget"]) and base["deployment"]["revision"]==state["observedTarget"]["revision"] and base["deployment"]["targetName"]==state["observedTarget"]["targetName"] and same(base["deployment"]["modelRef"],state["loadedModelRef"]))
        manifest=state[name+"Manifest"]
        check(name+"RequirementsMatchIndependentDeclarations",same(manifest["window"],window) and same(manifest["contract"],state["expectedContract"]) and same(manifest["contract"],installed["contract"]) and same(manifest["evaluation"],state["monitoringEvaluation"]) and same(manifest["policy"],state["monitoringPolicy"]) and same(manifest["labelSource"],state["labelSource"]) and same(manifest["deployment"]["modelRef"],state["approvedModelRef"]) and same(manifest["deployment"]["publicationRef"],state["approvedPublicationRef"]) and manifest["deployment"]["revision"]==state["release"]["publisherReceipt"]["revision"])
    check("sameXPatternAcrossDistinctWindows",[r["x"] for r in input_rows["W1"]]==[r["x"] for r in input_rows["W2"]] and not {r["rowId"] for r in input_rows["W1"]}&{r["rowId"] for r in input_rows["W2"]})
    batches={name:managed(root,ref) for name,ref in state["labelBatchRefs"].items()}
    for name,batch in batches.items():
        require(len(batch["rows"])==len(input_rows[name]),"Complete source label batch required")
        check(name+"ActualLabelsFollowDeclaredFixture",all(label["rowId"]==row["rowId"] and type(label["eventTime"]) is int and label["eventTime"]==row["eventTime"] and abs(number(label["label"])-(protocol["slope"]*row["x"]+protocol["intercept"]+protocol["labelOffsets"][name]))<=1e-12 for label,row in zip(batch["rows"],input_rows[name])))
    metric_rows=0
    for name,declaration in state["caseDeclarations"].items():
        window_name=declaration["windowId"];manifest=state[window_name+"Manifest"];observation=state[name+"Observation"];sidecar=numerical["cases"][name];evidence=sidecar["evidence"]
        require(sidecar["windowId"]==window_name,"Case window differs")
        base=state[window_name+"BaseObservation"]
        require(all(same(observation[key],base[key]) for key in ("deployment","window","prediction")),"A late-evidence case changed its actual deployment/window/prediction snapshot")
        labels=None
        if declaration["labelsFrom"] is not None:
            require(same(sidecar["sourceLabelRef"],state["labelBatchRefs"][declaration["labelsFrom"]]),"Actual label source ref differs")
            labels=copy.deepcopy(batches[declaration["labelsFrom"]]);transform=declaration["transform"]
            if transform: labels["batchId"]="derived-"+name
            if transform=="reorder": labels["rows"].reverse()
            elif transform=="partial": labels["rows"]=labels["rows"][:3]
            elif transform=="duplicate": labels["rows"].append(copy.deepcopy(labels["rows"][0]))
            elif transform=="unmatched": labels["rows"][0]["rowId"]="unobserved-row"
            elif transform=="foreignBounds": labels["window"].update({k:state["windows"]["W1"][k] for k in ("startAt","endAt")})
            require(same(managed(root,evidence["labelRef"]),labels) and same(observation["labels"],{"batchId":labels["batchId"],"windowId":labels["window"]["windowId"],"source":labels["source"],"labelRef":evidence["labelRef"],"availableAt":labels["availableAt"]}),"Consumed label artifact or metadata differs from declared source/control")
        else: require(sidecar["sourceLabelRef"] is None and "labels" not in observation,"Missing-label case acquired fabricated labels")
        actual_rows,facts,mse=keyed_join(predicted[window_name],labels)
        actual=managed(root,evidence["joinRef"])
        check(name+"ActualJoinRowsAndFactsMatch",same(actual["rows"],actual_rows) and same(actual["facts"],facts) and same(actual["window"],predicted[window_name]["window"]) and ((mse is None and actual["mse"] is None) or (mse is not None and abs(number(actual["mse"])-mse)<=1e-12)))
        if labels is not None:
            join=observation["join"]
            require(same(join["joinRef"],evidence["joinRef"]) and same(join["inputRef"],manifest["window"]["inputRef"]) and same(join["outputRef"],state[window_name+"PredictionRef"]) and same(join["membershipRef"],manifest["window"]["membershipRef"]),"Join operand refs differ")
            require(join["windowId"]==predicted[window_name]["window"]["windowId"] and join["joinMode"]==JOIN_MODE and same(join["labelRef"],evidence["labelRef"]),"Join window/protocol/consumed-label ref differs")
            for key in ("matchedRows","duplicateRows","unmatchedRows","crossWindowRows"): require(count(join[key],key)==facts[key],"Join reported count differs")
            require(count(join["missingRows"],"missingRows")==len(predicted[window_name]["rows"])-len(actual_rows),"Missing count differs")
        if actual_rows:
            dataset=evidence["joinedDatasetRef"];require(same(observation["join"]["joinedDatasetRef"],dataset),"Evaluated dataset ref differs")
            table=managed(root,dataset["artifact"]);require(same(table["rows"],actual_rows),"Evaluated rows differ from actual keyed join")
            validate_evaluation(observation,table,state["loadedModelRef"],state["monitoringEvaluation"],mse);metric_rows+=len(actual_rows)
        else: require("evaluation" not in observation and "joinedDatasetRef" not in observation.get("join",{}),"Invalid/empty join invented an evaluation")
        receipt=state[name+"Receipt"];require(same(receipt["manifest"],manifest) and same(receipt["observation"],observation),"Captured receipt differs from actual inputs")
        times=[observation["deployment"]["observedAt"],observation["window"]["closedAt"],observation["prediction"]["createdAt"]]
        require(times[0]<=times[2] and times[1]>=manifest["window"]["endAt"],"Deployment/prediction/window chronology differs")
        if labels is not None:
            times.extend([observation["labels"]["availableAt"],observation["join"]["createdAt"]])
            require(times[-1]>=max(times[:-1]),"Join predates an actual operand")
        if "evaluation" in observation:
            times.append(observation["evaluation"]["createdAt"]);require(times[-1]>=times[-2],"Metric predates its actual join")
        for stamp in times+[receipt["createdAt"]]: count(stamp,"observation timestamp")
        check(name+"ActualObservationChronologyValid",receipt["createdAt"]>=max(times))
        reference=outcome["fullDecisionRefs"][name];require(same(reference,state[name+"DecisionRef"]),"Native decision reference differs")
        original=managed(root,reference);offered=state[declaration["borrowed"]+"Receipt"] if declaration.get("borrowed") else receipt
        check(name+"NativeBindingsAndCompactViewMatch",same(original["bindings"]["expected"],{"manifest":manifest,"observation":observation}) and same(original["bindings"]["receipt"],offered) and same(compact(original),state[name+"Decision"]) and same(state[name+"Decision"],outcome["decisions"][name]))
    check("reorderedIntactLabelsProduceSameKeyedMetric",state["reorderedLabelsObservation"]["evaluation"]["metrics"]==state["healthyObservation"]["evaluation"]["metrics"])
    check("measuredPoorWindowExceedsFixedThreshold",number(state["degradedObservation"]["evaluation"]["metrics"]["mse"])>number(state["monitoringPolicy"]["threshold"]))
    check("noNumericalBuffersInScope",'"weights"' not in json.dumps(state) and '"predictions"' not in json.dumps(state))
    report={"schema":"footprint-ml-monitoring-saved-audit/v1","passed":True,"checks":checks,"auditedWindowPredictionRows":sum(len(v["rows"]) for v in predicted.values()),"auditedMetricRows":metric_rows,
        "sources":{name:{"sha256":hashlib.sha256((root/name).read_bytes()).hexdigest(),"bytes":(root/name).stat().st_size} for name in ("recording.json","outcome.json","numerical-observations.json")},
        "execution":{"savedArtifactsOnly":True,"scalarArithmetic":True,"numpyImported":False,"trainingRepeated":False,"guardRecomputed":False,"publicationPerformed":False},
        "boundaries":["Known synthetic label-generation rules can be checked here; the pure guard does not authenticate label truth or identify drift.","This validates one closed-batch local process, not hosted serving history, statistical confidence or an automatic pause effect."]}
    with (root/"audit.json").open("x") as file: json.dump(report,file,indent=2,allow_nan=False)
    print(json.dumps({"passed":True,"checks":len(checks),"predictionRows":report["auditedWindowPredictionRows"],"metricRows":metric_rows}))
    return report


if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--run",required=True);audit(parser.parse_args().run)
