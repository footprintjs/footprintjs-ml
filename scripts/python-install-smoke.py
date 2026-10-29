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
                       ("references", "evaluation", "trainer-adapter", "approval", "investigation", "data-lineage", "selection", "publication")]
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
recording=json.loads(path.read_bytes())
print(json.dumps({'recordingWritten':True,'schema':recording['schema'],'state':recording['snapshot']['sharedState']}))
''', recording], root))
        if execution["state"]["result"] != 14 or execution["state"].get("syntheticContractCheckPassed") is not True:
            raise ValueError("Installed Python capture did not preserve tracked state")
        original_recording = recording.read_bytes()
        # Exercise the installed SDK's real CLI under Node's permission model.
        # No --allow-child-process is supplied, so the investigator cannot start
        # a trainer even if implementation accidentally tries to do so.
        node = shutil.which("node")
        if not node:
            raise ValueError("Node.js is needed for the explicit native investigation")
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
                           "nativeCliBacktracking": True, "investigatorChildProcessesForbidden": True,
                           "installedPythonInvestigationCommand": True,
                           "recordingUnchangedAfterInvestigation": True,
                           "wheelGuidanceInstalledIntact": True, "featureGuideLinksResolveAfterInstall": True,
                           "npmAndWheelGuidanceAgree": True},
                "guidance": {"files": len(guidance_bytes), "localLinks": guidance_links,
                             "skillSha256": hashlib.sha256(guidance_bytes["skills/footprintjs-ml/SKILL.md"]).hexdigest(),
                             "featureCount": 8, "nativeCompiledRuntimeBundled": False},
                "import": imported, "nativeVersions": versions, "setup": setup, "repeatedSetup": repeated_setup,
                "doctor": doctor, "missingRuntime": missing,
                "investigation": {"report": native_report, "stdout": native_stdout,
                                  "pythonCommand": python_investigation},
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
