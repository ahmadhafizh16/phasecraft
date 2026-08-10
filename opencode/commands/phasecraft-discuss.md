---
description: Establish scope, decisions, evidence, risks, and approved research for a Phasecraft work item.
agent: phasecraft-researcher
---

Load the `phasecraft` skill and perform only the Discuss stage for `$ARGUMENTS`. Run the `discuss` preflight before writing. Resolve the work deterministically; ask if resolution is ambiguous.

Run `knowledge-check` and stop on stale authorities. Inspect repository and approved project authorities first. Ask focused questions for objective, scope, non-goals, constraints, acceptance evidence, risks, impact, mitigation, and possible solutions. Label verified evidence `E-*`, user decisions `D-*`, proposals `P-*`, unknowns `U-*`, and risks `R-*`. Before every external research request, show the exact question and intended source class and request permission. After approval and before any network call, persist it with `research-approve`. Record provenance and retrieval date for approved research.

Write or update `CONTEXT.md`, `research/RESEARCH.md`, and `research/EVIDENCE.json`. Never convert an unknown or proposal into a fact. Transition through `researching` to `discussed` only when required artifacts are coherent. Stop after Discuss.
