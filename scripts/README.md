# Repository checks

These scripts build packages and test their installed consumers. They are not SDK runtime modules.

`native-copies.mjs` reads installed package identities for both the npm and Python installation checks. Aliases, scopes, hidden containers and nested `node_modules` are included; physical directory links are deduplicated. It reads manifests without importing package code. Unknown manifests, unreadable or external directory links, and an incomplete census refuse the singleton claim. `native-copies-cli.mjs` is the Python check's data adapter. Fixtures live beside the inspector and run through the normal Node test entry.
