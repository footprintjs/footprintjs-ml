# Pre-pilot protocol: saved ML release investigation

Status: fixed before pilot submissions are collected. This protocol creates no human-study result. The first run is an automated-agent pilot of the apparatus; independent developers remain untested.

## Question and population

Can investigators determine whether a local ML release followed its declared candidate-selection objective, using either existing Lens/foottrace navigation or complete searchable structured logs?

The independent-developer study population excludes the workflow authors, trial authors and anyone who already knows the case. Record prior ML, FootPrint and Lens experience. Start with a four-cell feasibility study. Results remain descriptive until a separately planned sample and analysis justify broader inference.

## Fixed case and tool matrix

Use two opaque cases: one actual FootPrint execution with a reversed MSE selection comparison, and one actual clean control. Both use verified saved JAX model/checkpoint/evaluation artifacts. Neither case retrains or recomputes validation. Preserve source-artifact hashes and explicitly attribute the numerical facts to their retained audited runs.

The four cells are Lens/fault, logs/fault, Lens/control and logs/control. Each participant receives exactly one case in exactly one tool. The control is essential: assuming every run contains a bug should lower correctness rather than appear successful. The participant prompt says “determine whether the release followed the declared policy”, rather than promising a bug in every packet.

Assign independent developers in shuffled blocks of four, one participant per cell. Generate and store the block permutation before participant answers exist. Use pseudonymous participant IDs; do not collect names, email addresses or other unnecessary identifying information. Do not reassign a participant after seeing performance. Keep the unused assignment and incomplete responses in the study record.

The automated pilot uses four fresh agents with no inherited conversation, one per cell. Each receives no inherited conversation, no generation source and no facilitator key. Agents are pilot workers, not independent external developers. Since one agent fills each cell, do not compute a tool-effect estimate or statistical significance from that pilot.

## Evidence equality and blinding

Derive the log packet from the exact same captured workflow evidence supplied to Lens. Include the declared MSE objective, candidate model and evaluation bindings, all recorded metrics, actual stage reads/writes, complete before/after state, selection and approval decisions, commit/discard/retry status, callback observations and native coverage warnings. Preserve neutral event identifiers for citations.

Before exposing the packet, verify an explicitly enumerated canonical fact inventory is nonempty and equal in both representations. Include negative verifier checks showing that an omitted input or altered metric breaks parity. The parity claim concerns retained facts; interface layout, ordering, native relationships and navigation are the treatment. This design does not measure the cost of writing and maintaining an independent structured logger.

The log arm permits ordinary full-text search, stage filters, complete expandable records and raw download. The Lens arm permits the existing native saved-state/writer/backtrack/stage tools. Both arms get the same task, background, time limit and neutral instructions. Neither arm includes a custom button naming the answer or a prewritten diagnostic explanation.

Keep participant case names, URLs, model labels and file names opaque. The facilitator key, generation code, parity inventories containing expected diagnoses, scoring results and prior pilot submissions live outside the participant-serving directory. Normal recorded comparison inputs are legitimate evidence; a “faulty” badge, truth-named file or answer key is not.

## Participant questions

1. Which model was released? Cite its identifier and validation measurement.
2. Which candidate should the declared objective select? Was this release compliant? Cite the compared values and objective.
3. Which stage first establishes or contradicts that choice? Explain why the later model/evaluation release check allowed the recorded model.
4. What is the smallest justified change, if any, and what concrete verification would detect a selection regression?
5. What remains uncertain, and which evidence locations support the diagnosis?

The same questions apply to the clean control. “The release is correct and needs no selection change” is an acceptable control answer when justified with evidence.

## Fixed ten-point rubric

Score each item 0, 1 or 2. Two requires the relevant correct conclusion and a supporting evidence identifier/value; one is partially correct or lacks the necessary evidence; zero is wrong, unsupported or missing.

- Released model and its own validation binding: 0–2.
- Declared selection objective, candidate comparison and correct compliant/noncompliant conclusion: 0–2.
- Earliest relevant selection stage and explanation of the later guard's narrower model/evaluation consistency check: 0–2.
- Proportionate correction or justified no-change finding, plus a concrete regression check: 0–2.
- Traceable citations and appropriate limits on the diagnosis: 0–2.

The faulty case requires identifying the reversed MSE comparison rather than blaming stale model evidence or assuming JAX's gradients were wrong. The control requires recognizing that the lower-MSE model was selected. The existing broad threshold and model-bound receipt can permit a candidate without proving it was the best candidate. This paragraph belongs only to facilitator materials.

Keep the key fixed before submissions. Remove tool labels from human scoring packets. Use an evidence-based scorer, preserve item-level decisions and allow adjudication rather than relying on exact prose matching. For the pilot, a facilitator may score against the fixed key; identify this as case-author scoring, not independent blinded human adjudication. Automatic ID/value checks corroborate facts but do not establish causal explanation quality by themselves.

## Measurement and stopping

Start timing on the explicit Begin action and stop on Submit or a predeclared 15-minute limit. Record unpaused wall elapsed time, searches, navigation/tool actions and evidence locations opened. No pause feature is provided. Keep timeout and incomplete submissions. Do not drop incorrect responses before comparing times. Report correct diagnosis rate first and time with its timeout/censoring rule; confidence and missing evidence are secondary.

UI action counts should use the same visible-action definition in both arms. For agents, separately record tool calls and attempted out-of-packet access. Agent wall time includes reasoning and service latency, so it is a descriptive apparatus measurement rather than human debugging time. Do not convert it into a productivity claim.

A pilot ends after the four preassigned fresh-context attempts, or after a documented apparatus failure blocks a cell. Preserve compromised attempts. If a packet defect requires a replacement, label the revision and replacement attempt rather than silently keeping the better result. Missing cells or failed diagnoses remain findings.

## Allowed conclusions and growing story

The automated pilot can establish that both packets expose sufficient facts, the interfaces function, the scoring key distinguishes the faulty case from the control, and submissions can record diagnoses and effort. It cannot establish independent developer adoption, faster human investigation, production efficacy or universal FootPrint superiority.

Append completed story chapters for the fair packet and the observed pilot findings, with actual per-arm correctness and limits. Mark those findings explicitly automated. Leave independent developer investigation OPEN until eligible people complete the trial. Keep complete logs as a capable comparator even if a pilot agent performs poorly.

## Agent blinding boundary

The pilot uses packet and instruction blinding. Fresh contexts do not isolate the shared filesystem. Agents must use only their assigned session and the provided client, report any outside access, and preserve a compromised attempt if those instructions are violated. The web service exposes only public UI files and a participant’s assigned evidence; it never serves the facilitator keys or generation source. This is not a claim that a shell-capable agent could not read other workspace files.

## Pre-start implementation clarification

Before any pilot Begin action, the wording above was aligned with the implemented apparatus: shared neutral instructions, searchable/stage-filtered logs, unpaused wall time, and optional ML/FootPrint/Lens background fields. The cases, allocation, fifteen-minute limit, ten-point rubric and stopping rules did not change. The previous protocol hash and this clarification are retained in the assignment record.
