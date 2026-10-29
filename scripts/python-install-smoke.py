"""Install the wheel outside its checkout and exercise explicit native setup.

The optional Node runtime is installed only by the explicit setup command. No
MLflow, numerical framework or Python runtime dependency is installed here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile


def run(executable, arguments, cwd):
    result = subprocess.run([str(executable), *map(str, arguments)], cwd=cwd,
                            text=True, capture_output=True, check=False, timeout=180)
    if result.returncode:
        raise RuntimeError(f"Install smoke command failed ({result.returncode}):\n{result.stdout}\n{result.stderr}")
    return result.stdout


def smoke(wheel, archive):
    wheel, archive = Path(wheel).resolve(strict=True), Path(archive).resolve(strict=True)
    with zipfile.ZipFile(wheel) as package:
        prefix = next(name for name in package.namelist() if name.endswith(".data/data/share/footprintjs-ml/README.md")).removesuffix("README.md")
        guidance_bytes = {name.removeprefix(prefix): package.read(name) for name in package.namelist()
                          if name.startswith(prefix) and not name.endswith("/")}
    required_guides = ["skills/footprintjs-ml/SKILL.md", "skills/footprintjs-ml/agents/openai.yaml", "features/README.md"]
    required_guides += ["features/" + name + "/README.md" for name in
                       ("references", "evaluation", "trainer-adapter", "approval", "inference", "investigation", "data-lineage", "selection", "publication")]
    if not all(name in guidance_bytes for name in required_guides):
        raise ValueError("Wheel is missing the skill or an individual feature guide")
    with tempfile.TemporaryDirectory(prefix="footprint-python-install-") as temporary:
        root = Path(temporary).resolve()
        environment = root / "venv"
        run(sys.executable, ["-m", "venv", environment], root)
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        run(python, ["-m", "pip", "install", "--no-index", "--no-deps", wheel], root)
        installed_guidance = environment / "share" / "footprintjs-ml"
        for name, expected in guidance_bytes.items():
            if (installed_guidance / name).read_bytes() != expected:
                raise ValueError("Installed guidance differs from the wheel: " + name)
        guidance_links = 0
        for name, content in guidance_bytes.items():
            if not name.endswith(".md"):
                continue
            for match in re.finditer(r"\]\((?:<([^>]+)>|([^\s)]+))(?:\s+\"[^\"]*\")?\)", content.decode("utf-8")):
                target = match[1] or match[2]
                if re.match(r"^(?:[a-z][a-z0-9+.-]*:|#)", target, re.IGNORECASE):
                    continue
                path = target.split("#", 1)[0].split("?", 1)[0]
                if not path:
                    continue
                resolved = (installed_guidance / name).parent.joinpath(path).resolve()
                if not resolved.is_relative_to(installed_guidance.resolve()) or not resolved.is_file():
                    raise ValueError("Installed guidance link is broken: " + name + " -> " + target)
                guidance_links += 1
        imported = json.loads(run(python, ["-I", "-c", r'''
import importlib.abc,importlib.metadata,json,pathlib,subprocess,sys
class BlockHeavyImports(importlib.abc.MetaPathFinder):
    def find_spec(self,fullname,path=None,target=None):
        if fullname.split('.')[0] in {'numpy','mlflow','sklearn','pandas','torch','jax','tensorflow'}:
            raise RuntimeError('Unexpected heavy import: '+fullname)
sys.meta_path.insert(0,BlockHeavyImports())
def no_process(*args,**kwargs):
    raise RuntimeError('Import or construction started a process')
subprocess.Popen=no_process
import footprint_ml_workflow,footprint_ml_setup,footprint_ml_versions
capture=footprint_ml_workflow.WorkflowCapture(pathlib.Path('constructor-only.json'))
distribution=importlib.metadata.distribution('footprintjs-ml')
assert not distribution.requires, 'Wheel has runtime dependencies'
assert pathlib.Path(footprint_ml_workflow.__file__).resolve().is_relative_to(pathlib.Path(sys.prefix).resolve())
print(json.dumps({'version':distribution.version,'installedFromWheel':True,'runtimeDependencies':distribution.requires or [],
 'isolatedImport':True,'heavyImportsBlocked':True,'constructorStartedNoProcess':True,
 'nativePins':{'footprintjs-ml':footprint_ml_versions.SDK_VERSION,'footprintjs':footprint_ml_versions.FOOTPRINTJS_VERSION,
   'foottrace':footprint_ml_versions.FOOTTRACE_VERSION,'agentfootprint':footprint_ml_versions.AGENTFOOTPRINT_VERSION}}))
'''], root))
        missing = json.loads(run(python, ["-I", "-c", r'''
import json,pathlib,sys
from footprint_ml_workflow import WorkflowCapture
try:
    with WorkflowCapture(pathlib.Path('missing-runtime.json'),runtime_dir=pathlib.Path('absent-runtime')):
        raise AssertionError('A missing native runtime was accepted')
except Exception as error:
    text=str(error)
    assert 'setup' in text.lower() and 'runtime' in text.lower(), 'Missing runtime error is not actionable: '+text
    print(json.dumps({'actionable':True,'message':text}))
'''], root))
        # Explicit installation into the documented default location lets the
        # later constructor exercise automatic venv discovery without a second
        # runtime installation.
        runtime = environment / "share" / "footprintjs-ml" / imported["nativePins"]["footprintjs-ml"]
        setup = json.loads(run(python, ["-I", "-m", "footprint_ml_workflow", "setup", "--archive", archive,
                                       "--runtime-dir", runtime], root))
        repeated_setup = json.loads(run(python, ["-I", "-m", "footprint_ml_workflow", "setup", "--archive", archive,
                                                "--runtime-dir", runtime], root))
        if repeated_setup.get("status") != "already-installed" or repeated_setup.get("ok") is not True:
            raise ValueError("Repeated native setup did not report the existing installation")
        doctor = json.loads(run(python, ["-I", "-m", "footprint_ml_workflow", "doctor"], root))
        if doctor.get("ok") is not True:
            raise ValueError("Default venv runtime did not pass doctor")
        versions = {}
        for name, expected in imported["nativePins"].items():
            package = json.loads((runtime / "node_modules" / name / "package.json").read_bytes())
            if package["version"] != expected:
                raise ValueError("Installed native dependency version differs: " + name)
            versions[name] = package["version"]
        for name, expected in guidance_bytes.items():
            if (runtime / "node_modules" / "footprintjs-ml" / name).read_bytes() != expected:
                raise ValueError("npm and Python guidance copies disagree: " + name)
        recording = root / "installed-recording.json"
        execution = json.loads(run(python, ["-I", "-c", r'''
import json,pathlib,sys
from footprint_ml_workflow import WorkflowCapture
path=pathlib.Path(sys.argv[1])
with WorkflowCapture(path) as capture:
    with capture.stage('installed-input') as scope:
        scope['input']=7
    with capture.stage('installed-result') as scope:
        scope['result']=scope['input']*2
    with capture.stage('installed-contracts') as scope:
        artifact={'kind':'artifact','path':'synthetic-model.json','sha256':'1'*64,'bytes':1,'format':'install-smoke/synthetic/v1'}
        model={'kind':'model','sessionId':'synthetic-install-check','handle':1,'originArtifact':artifact,
          'inferenceIdentity':{'kind':'inference-identity','schemaVersion':1,'profile':'install-smoke/synthetic/v1','sha256':'3'*64}}
        dataset={'kind':'dataset','sessionId':'synthetic-install-check','handle':1,'rows':1,'shape':[1],'role':'validation',
          'artifact':{'kind':'artifact','path':'synthetic-data.json','sha256':'2'*64,'bytes':1,'format':'install-smoke/synthetic/v1'}}
        observed={'modelRef':model,'datasetRef':dataset,'preprocessingVersion':'synthetic/v1','evaluationMethodVersion':'synthetic/v1',
          'parameters':{},'evaluationId':'synthetic-install-check','createdAt':1,'metrics':{'accuracy':1.0}}
        receipt=capture.create_evaluation_receipt(observed)
        decision=capture.check_release({**observed,'receipt':receipt,'policy':{'metric':'accuracy','operator':'gte','threshold':1.0},'now':1})
        assert decision['allowed'] is True and receipt['schemaVersion']==2
        scope['syntheticContractCheckPassed']=True
    # These synthetic contracts exercise the installed facade, not numerical
    # correctness or automatic provenance. Calls intentionally need no stage.
    assert capture.read_evaluation_receipt(receipt)==receipt
    make_artifact=lambda digit,label: {'kind':'artifact','path':label+'.json','sha256':digit*64,'bytes':1,'format':'install-smoke/synthetic/v1'}
    training={**dataset,'handle':2,'rows':2,'shape':[2],'role':'train','artifact':make_artifact('6','synthetic-train')}
    split=make_artifact('7','synthetic-split')
    observed_lineage={'lineageId':'synthetic-lineage','createdAt':1,'modelRef':model,'datasetRef':dataset,
      'trainingDatasetRef':training,'splitManifest':split,
      'overlap':{'evidenceArtifact':make_artifact('8','synthetic-membership'),'trainEvaluationRows':0,'preprocessingEvaluationRows':0},
      'preprocessing':{'artifact':make_artifact('9','synthetic-scaler'),'fitDatasetRefs':[training]}}
    lineage=capture.create_data_lineage_receipt(observed_lineage)
    assert capture.read_data_lineage_receipt(lineage)==lineage
    lineage_request={'receipt':lineage,'modelRef':model,'datasetRef':dataset,'splitManifest':split,
      'policy':{'trainingDatasetRef':training}}
    missing_input={key:value for key,value in observed_lineage.items() if key not in ('overlap','preprocessing')}
    missing_lineage=capture.create_data_lineage_receipt(missing_input)
    leaked_lineage=capture.create_data_lineage_receipt({**observed_lineage,
      'preprocessing':{**observed_lineage['preprocessing'],'fitDatasetRefs':[dataset]}})
    lineage_requests={'allowed':lineage_request,'unknown':{**lineage_request,'receipt':missing_lineage},
      'leaked':{**lineage_request,'receipt':leaked_lineage}}
    lineage_decisions={name:capture.check_data_lineage(request) for name,request in lineage_requests.items()}
    assert lineage_decisions['allowed']['allowed'] is True
    assert lineage_decisions['unknown']['allowed'] is False and lineage_decisions['unknown']['status']=='unknown'
    assert lineage_decisions['leaked']['allowed'] is False and lineage_decisions['leaked']['status']=='deny'
    model_b={**model,'handle':2,'originArtifact':make_artifact('4','synthetic-model-b'),
      'inferenceIdentity':{**model['inferenceIdentity'],'sha256':'5'*64}}
    receipt_b=capture.create_evaluation_receipt({**observed,'modelRef':model_b,'evaluationId':'synthetic-evaluation-b','metrics':{'accuracy':0.5}})
    manifest_input={'kind':'selection-manifest','schemaVersion':1,'experimentId':'synthetic-comparison',
      'candidates':[{'candidateId':'a','configuration':{'steps':1}},{'candidateId':'b','configuration':{'steps':2}}],
      'comparison':{'datasetRef':dataset,'preprocessingVersion':'synthetic/v1','evaluationMethodVersion':'synthetic/v1','parameters':{}},
      'policy':{'metric':'accuracy','direction':'max','tieBreak':'candidate-id-ascending'}}
    declared=capture.read_selection_manifest(manifest_input)
    independent_results=[{'candidateId':'a','configuration':{'steps':1},'modelRef':model,'evaluation':receipt},
      {'candidateId':'b','configuration':{'steps':2},'modelRef':model_b,'evaluation':receipt_b}]
    selection=capture.create_selection_receipt({'selectionId':'synthetic-selection','createdAt':1,
      'manifest':declared,'results':independent_results})
    assert capture.read_selection_receipt(selection)==selection and selection['selectedCandidateId']=='a'
    selection_request={'receipt':selection,'manifest':declared,'results':independent_results,'now':1}
    selection_requests={'wrong':{**selection_request,'modelRef':model_b},'correct':{**selection_request,'modelRef':model}}
    selection_decisions={name:capture.check_selection(request) for name,request in selection_requests.items()}
    assert selection_decisions['wrong']['allowed'] is False and selection_decisions['wrong']['status']=='deny'
    assert selection_decisions['correct']['allowed'] is True
    with capture.stage('installed-lineage-selection-contracts') as scope:
        scope['syntheticLineageContractCheckPassed']=True
        scope['syntheticSelectionContractCheckPassed']=True
    raw_contract={'profile':'synthetic-predictor/v1',
      'input':{'fields':[{'name':'distance','dtype':'float64','unit':'m'},{'name':'duration','dtype':'float64','unit':'s'}]},
      'output':{'fields':[{'name':'negative_probability','dtype':'float64'},{'name':'positive_probability','dtype':'float64'}]},
      'preprocessingVersion':'synthetic-scaler/v1','classLabels':['negative','positive']}
    expected_contract=capture.create_prediction_contract(raw_contract)
    assert expected_contract['parameters']=={} and capture.read_prediction_contract(expected_contract)==expected_contract
    reversed_contract=capture.create_prediction_contract({**raw_contract,
      'input':{'fields':list(reversed(raw_contract['input']['fields']))}})
    actual_inference={'inferenceId':'synthetic-inference','createdAt':1,
      'inputRef':make_artifact('a','synthetic-inference-input'),'outputRef':make_artifact('b','synthetic-inference-output'),
      'inputRows':2,'outputRows':2}
    observed_inferences={
      'correct':capture.create_inference_receipt({**actual_inference,'modelRef':model,'contract':expected_contract}),
      'wrongModel':capture.create_inference_receipt({**actual_inference,'modelRef':model_b,'contract':expected_contract}),
      'wrongOrder':capture.create_inference_receipt({**actual_inference,'modelRef':model,'contract':reversed_contract}),
      'unknown':capture.create_inference_receipt(actual_inference),
    }
    for inference_receipt in observed_inferences.values():
        assert capture.read_inference_receipt(inference_receipt)==inference_receipt
    inference_expected={'modelRef':model,'contract':expected_contract,'inputRef':actual_inference['inputRef'],
      'rows':2,'inferenceId':actual_inference['inferenceId'],'now':1}
    inference_requests={name:{**inference_expected,'receipt':value} for name,value in observed_inferences.items()}
    inference_decisions={name:capture.check_inference(request) for name,request in inference_requests.items()}
    assert inference_decisions['correct']['allowed'] is True
    assert all(inference_decisions[name]['allowed'] is False and inference_decisions[name]['status']=='deny'
      for name in ('wrongModel','wrongOrder'))
    assert inference_decisions['unknown']['allowed'] is False and inference_decisions['unknown']['status']=='unknown'
    with capture.stage('installed-inference-contracts') as scope:
        scope['syntheticInferenceContractCheckPassed']=True
recording=json.loads(path.read_bytes())
print(json.dumps({'recordingWritten':True,'schema':recording['schema'],'state':recording['snapshot']['sharedState'],
  'guardRequests':{'lineage':lineage_requests,'selection':selection_requests,'inference':inference_requests},
  'guardDecisions':{'lineage':lineage_decisions,'selection':selection_decisions,'inference':inference_decisions}}))
''', recording], root))
        if execution["state"]["result"] != 14 or not all(execution["state"].get(key) is True for key in
                ("syntheticContractCheckPassed", "syntheticLineageContractCheckPassed", "syntheticSelectionContractCheckPassed", "syntheticInferenceContractCheckPassed")):
            raise ValueError("Installed Python capture did not preserve tracked state")
        original_recording = recording.read_bytes()
        # Exercise the installed SDK's real CLI under Node's permission model.
        # No --allow-child-process is supplied, so the investigator cannot start
        # a trainer even if implementation accidentally tries to do so.
        node = shutil.which("node")
        if not node:
            raise ValueError("Node.js is needed for the explicit native investigation")
        # Compare the facade's JSON decisions with direct public TypeScript
        # guards from the installed SDK, using the same explicit inputs/time.
        direct_guards = json.loads(run(node, ["--input-type=module", "-e", r"""
import {checkDataLineage,checkSelection,checkInference} from 'footprintjs-ml';
const requests=JSON.parse(process.argv[1]);
const apply=(values,guard)=>Object.fromEntries(Object.entries(values).map(([name,input])=>[name,guard(input)]));
console.log(JSON.stringify({lineage:apply(requests.lineage,checkDataLineage),selection:apply(requests.selection,checkSelection),inference:apply(requests.inference,checkInference)}));
""", json.dumps(execution["guardRequests"])], runtime))
        if direct_guards != execution["guardDecisions"]:
            raise ValueError("Installed Python guard decisions differ from the direct TypeScript contracts")
        cli = runtime / "node_modules" / "footprintjs-ml" / "examples" / "quickstart" / "cli.mjs"
        permission = ("--experimental-permission" if doctor["node"]["major"] == 22
                      and doctor["node"]["minor"] < 13 else "--permission")
        native_stdout = run(node, [permission, "--allow-fs-read=" + str(runtime),
                                   "--allow-fs-read=" + str(root), "--allow-fs-write=" + str(root),
                                   cli, "investigate", "--run", recording, "--variable", "result"], root)
        native_report = json.loads((root / "investigation-variable.json").read_bytes())
        native_slice = native_report["transcript"][0]["result"]
        if "installed-input#0" not in native_slice or "installed-result#1" not in native_slice:
            raise ValueError("Installed native investigation omitted the tracked producer chain")
        if recording.read_bytes() != original_recording:
            raise ValueError("Investigation changed the original recording")
        python_investigation = json.loads(run(python, ["-I", "-m", "footprint_ml_workflow", "investigate",
                                                      "--run", recording, "--variable", "result"], root))
        if (python_investigation.get("ok") is not True or python_investigation.get("childProcessesAllowed") is not False
                or python_investigation.get("trainingStarted") is not False):
            raise ValueError("The installed Python investigation front door did not preserve offline execution limits")
        if recording.read_bytes() != original_recording:
            raise ValueError("Python investigation changed the original recording")
        return {"schema": "footprint-ml-python-install-smoke/v1", "passed": True,
                "wheel": {"file": wheel.name, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest()},
                "checks": {"freshVenvOutsideCheckout": True, "noIndexWheelInstall": True,
                           "zeroPythonRuntimeDependencies": True, "isolatedImportsAndConstructor": True,
                           "explicitLocalArchiveSetup": True, "pinnedNativeVersions": True,
                           "doctorPassed": True, "idempotentSetup": True, "missingRuntimeActionable": True,
                           "defaultVenvRuntimeDiscovery": True, "installedLiveCapture": True,
                           "nativeSyntheticReceiptAndGuard": True,
                           "nativePythonLineageAllowUnknownAndDeny": True,
                           "nativePythonSelectionWrongDeniedWinnerAllowed": True,
                           "pythonGuardDecisionsMatchPublicTypeScript": True,
                           "nativePredictionContractAndInferenceReceiptRoundTrip": True,
                           "nativeInferenceMismatchControlsAndMissingEvidence": True,
                           "pythonInferenceDecisionsMatchPublicTypeScript": True,
                           "nativeCliBacktracking": True, "investigatorChildProcessesForbidden": True,
                           "installedPythonInvestigationCommand": True,
                           "recordingUnchangedAfterInvestigation": True,
                           "wheelGuidanceInstalledIntact": True, "featureGuideLinksResolveAfterInstall": True,
                           "npmAndWheelGuidanceAgree": True},
                "guidance": {"files": len(guidance_bytes), "localLinks": guidance_links,
                             "skillSha256": hashlib.sha256(guidance_bytes["skills/footprintjs-ml/SKILL.md"]).hexdigest(),
                             "featureCount": 9, "nativeCompiledRuntimeBundled": False},
                "import": imported, "nativeVersions": versions, "setup": setup, "repeatedSetup": repeated_setup,
                "doctor": doctor, "missingRuntime": missing,
                "investigation": {"report": native_report, "stdout": native_stdout,
                                  "pythonCommand": python_investigation},
                "guardParity": {"sameJsonDecisions": True, "directTypeScript": direct_guards,
                                "syntheticCases": {"lineage": 3, "selection": 2, "inference": 4}},
                "execution": execution, "boundaries": ["This install smoke starts no numerical trainer or MLflow service.",
                    "Explicit native setup may fetch the pinned Node runtime dependencies; importing the wheel never installs them."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheel", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--report", "--out", dest="report", help="Save the JSON smoke report to this file")
    arguments = parser.parse_args()
    report = smoke(arguments.wheel, arguments.archive)
    if arguments.report:
        Path(arguments.report).write_text(json.dumps(report, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
