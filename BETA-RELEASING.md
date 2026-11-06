# GitHub beta release procedure

This repository distributes a JavaScript archive, a Python wheel, a source manifest and a verification receipt through GitHub prereleases. This route does not publish to npm or PyPI.

## Review and human authority

The designated release reviewer dispatches only after reviewing the exact merged source and version changes and obtaining the owner's go for that version. In this project's review process that reviewer is Claude. The workflow cannot distinguish people using a shared account and cannot verify this human procedure. It has no actor-name or PR-comment approval check and creates no environment, credential or repository setting.

A source merge is not release permission. Do not cut a new beta solely to test the route. Existing beta assets are immutable.

## Before dispatch

Use the reviewed main tip, its exact canonical SDK version (for example a separately approved beta), and the corresponding Python version. The package manifest, its own lock entries, Python project and version constants must agree. Keep the reviewed helper cohort pins; do not chase another upstream release during publication.

Commit release notes as release-notes/VERSION.md. The complete Beta CI run on that main commit must have every expected job named in scripts/beta-release/data/checks.json successful, including all required steps. Empty, missing, skipped, cancelled, partial or mixed-run evidence refuses.

Dispatch publish.yml on main with three data inputs:

- sha: the full reviewed main SHA;
- version: the exact SDK beta version;
- dry_run: true by default.

The real main dry-run proofs include a wrong version and a dispatch while the new main commit's checks are still incomplete. Do not edit the expected-check table to manufacture a refusal. Missing-name behavior is also covered with explicitly offline HTTP fixtures.

## Jobs and evidence

The read-only admit job executes the existing locked FootPrint chart. Each machine gate records a native decide row, and its recording is retained on refusal too. Failed or unknown reads are refusals, not absence. The record describes observations; it does not save permission for another run.

The read-only build job produces one archive and one wheel, inspects their complete source/build membership and wheel RECORD, and generates the two receipts. The immutable candidate artifact also carries the reviewed notes as a hashed sidecar. The notes are the release body, not a fifth public asset. Its exact source, tree, workflow, run, attempt, artifact and file hashes are retained.

Only publish gets contents:write and actions:read. It has no checkout, npm, installed dependency or candidate-code execution. Fixed standard-tool glue compares the retained artifact with actual build outputs and producer metadata, rechecks current main and CI, creates its own draft prerelease, uploads exactly four files once, reads their hashes back, then undrafts that exact release. Requests use fixed GitHub hosts and no automatic retry.

The read-only verify job downloads each public file once and compares the complete bytes against the retained candidate. A public match after a lost reply does not retrospectively prove that submission succeeded. A failed publish job remains failed even when GET-only verification finds matching public files. Hashes compare content; they do not authenticate a producer, verify signatures, prove numerical correctness or establish consumer adoption.

## Cross-run uncertainty and holds

Native workflow history can only deny publication, never permit it. Every prior live run for that version is inspected, across all attempts. If its publish job started, any conclusion consumes the version; an unreadable or missing job is treated as started. A fully observed skipped publish job did not write. Dry runs do not consume a version.

The native census must be complete through the current run, with no deleted or lagged run-number gap, duplicated identity or unparseable title. All pages are read up to 1,000 runs; missing, changing or larger history is HOLD. The publisher repeats this denial check immediately before effects. A complete authenticated release listing in that job also excludes same-tag drafts; a by-tag404 alone cannot prove draft absence.

Reruns, existing versions and all unknown outcomes are GET-only/HOLD. The route never retries an uncertain create, upload or undraft, never deletes or overwrites assets, and never force-moves a tag. A leftover draft stays for a person. If a version was consumed without publication, use a new version through the normal review procedure. There is no journal, saved grant, override or automatic repair.

These guarantees cover this reviewed workflow and cooperating repository writers. They are not distributed compare-and-swap against an independent external writer.

## Tests

The unchanged normal Node22/24 test command includes admission/history fixtures, the real FootPrint chart, exact extracted publisher-glue tests under offline HTTP, hostile archive/wheel controls and public-byte mismatch controls. Existing CI's four clean-install jobs additionally inspect the actual packages they already built; this inspection does not fabricate release admission or a running publisher.
