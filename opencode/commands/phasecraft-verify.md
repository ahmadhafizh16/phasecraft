---
description: Independently verify the implementation against decisions, plan, diff, and checks.
agent: phasecraft-verifier
subtask: true
---

Load the `phasecraft` skill and perform only Verify for `$ARGUMENTS`. Run the `verify` preflight and transition from `execution_complete` to `verifying`. Independently inspect the actual diff, approved plan version and hash, bound PLAN-VERIFICATION dispositions, decisions, evidence, execution log, planned tests/checks, relevant negative cases, and baseline exclusions. Verify accepted-risk guardrails when present; explicit `Guardrails: none` is valid. Report whether an accepted risk materialized or its revisit trigger fired, but do not fail merely because the human knowingly accepted an unmitigated risk or because a still-open deferred finding was intentionally left outside this phase. Do not turn implementation verification into a new plan-completeness audit.

Write `VERIFICATION.md` with requirement-by-requirement evidence and findings ordered by severity. Record the outcome through `verification-result`: use `verified` when every required check passes, `verified_pending` with structured pending checks when automatic checks pass but human-only checks remain, and `verification_failed` for any implementation or automatic-check failure. Do not edit application source or rationalize deviations.

Run `handoff-list --all` and read the latest executor plus all prior verifier handoffs before verification. Before every return, invoke `handoff-write --agent phasecraft-verifier` with checks, findings, pending human evidence, outcome, and exact next action; never allocate `H-NNN.md` manually.
