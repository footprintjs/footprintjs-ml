"""Protocol fixture: no numerical training, imports or model state."""
import argparse
import json
import sys
import time

parser = argparse.ArgumentParser()
for name in ("plugin", "config", "plan", "out"):
    parser.add_argument("--" + name, required=True)
args = parser.parse_args()
config, plan = json.loads(args.config), json.loads(args.plan)
mode = config.get("mode", "success")
if mode == "sleep":
    time.sleep(5)
if mode == "overflow":
    sys.stdout.write("x" * 100_000)
    sys.exit(0)
if mode == "malformed":
    sys.stdout.write("not-json")
    sys.exit(0)
if mode == "malformed-stderr":
    sys.stderr.write("diagnostic-" * 1000 + "final-marker")
    sys.stdout.write("not-json")
    sys.exit(0)

cases = [
    {"name": "structural-fixture", "passed": True, "status": "passed", "required": True,
     "category": "structural", "details": {}},
    {"name": "numerical-fixture", "passed": True, "status": "passed", "required": True,
     "category": "numerical", "details": {}},
]
if mode == "failure":
    cases[1].update(passed=False, status="failed")
elif mode == "partial":
    cases[1].update(passed=None, status="skipped", required=False)
counts = {name: sum(case["status"] == name for case in cases) for name in ("passed", "failed", "skipped")}
report = {
    "schema": "footprint-ml-adapter-conformance/v1",
    "passed": all(case["passed"] is True for case in cases),
    "structuralPassed": True,
    "numericalPassed": cases[1]["passed"] is True,
    "requiredPassed": all(case["passed"] is True for case in cases if case["required"]),
    "status": "failed" if counts["failed"] else "partial" if counts["skipped"] else "passed",
    "counts": counts, "cases": cases,
    "backend": {"fixture": True, "receivedPlugin": args.plugin, "receivedOut": args.out, "receivedConfig": config},
    "plan": plan, "observations": {}, "artifacts": {}, "coverage": {},
    "limitations": ["Protocol fixture; no trainer was executed."],
}
if mode == "wrong-count":
    report["counts"]["passed"] += 1
if mode == "contradictory-status":
    report["passed"] = False
if mode == "wrong-plan":
    report["plan"] = {"train": {"steps": 999}, "source": "another-plan"}
if mode == "reordered-plan":
    report["plan"] = dict(reversed(list(plan.items())))
sys.stdout.write(json.dumps(report))
sys.exit(7 if mode == "unexpected-exit" else 1 if mode in ("failure", "passing-error") else 0)
