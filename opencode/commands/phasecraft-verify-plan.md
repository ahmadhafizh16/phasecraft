---
description: Independently audit a Phasecraft plan for evidence and Nyquist coverage.
agent: phasecraft-plan-auditor
subtask: true
---

Load the `phasecraft` skill and perform only Verify Plan for `$ARGUMENTS`. Run the `verify-plan` preflight. Independently compare the current plan to user decisions, evidence, roadmap requirements, repository state, and risk records.

Run `knowledge-check`. Require every requirement to map to observable checks, every task to valid evidence and a commit group, every risk to mitigation work, and every proposed edit to have a verified before state. Check dependencies, negative cases, boundaries, stale hashes, unrelated scope, dirty baseline overlap, and human-only checks. Run the restricted Markdown validator and verify the HTML source hash.

Write `PLAN-VERIFICATION.md` with findings ordered by severity. Transition to `plan_verified` only when no blocking finding remains; otherwise leave `plan_draft`. Never edit application source or silently repair the planner's conclusions.
