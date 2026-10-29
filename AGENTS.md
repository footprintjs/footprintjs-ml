# FootPrint ML agent entry point

For an ML integration or saved-result investigation, read the [FootPrint ML skill](skills/footprintjs-ml/SKILL.md), then use the [feature index](features/README.md) to load only the relevant guide. The main [README](README.md) covers installation and supported paths.

Use the installed version's public exports, declarations and Python module as the API authority. The skill supports both Python-owned workflows and TypeScript orchestration; it does not imply every TypeScript contract has a Python method.

When changing this library, preserve the existing numerical and recording boundaries described in the feature guides. Run checks relevant to the change. Documentation and packaging changes use `npm run check:agent-docs`; distribution changes also need the documented clean-install checks. Those checks verify that agents receive usable skill/guide files in both the npm package and Python wheel.

The current beta and runtime limits are in [COMPATIBILITY.md](COMPATIBILITY.md); evidence and test scope are in [TESTING.md](TESTING.md).
