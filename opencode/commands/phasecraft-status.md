---
description: Report Phasecraft state, evidence freshness, blockers, and the next legal command.
agent: phasecraft-manager
---

Load the `phasecraft` skill and perform only Status for `$ARGUMENTS`. Resolve an explicit work argument first, then branch association, then the sole open item; ask when ambiguous. Read state without transitioning it.

Run `feedback-list` and `review-status`. Report current stage and revision, active plan version/hash, authority drift, unresolved unknowns, pending plan-verification Q&A, accepted risks from `plan/RISK-REGISTER.md` including explicit no-mitigation decisions, materialization status, and revisit triggers, due/open deferred findings, published feedback batches without resolutions, clarification-needed resolutions, local review server status/URL availability, pending manual checks, baseline adoption, completed and next phases, the latest handoff path/outcome from every Phasecraft agent, missing handoff gaps, and the next legal command. Do not edit source, plans, feedback, reviews, or state.

Start with runtime `doctor --work <id>` and `feedback-list --pending`. Use the read-only readiness report for approval drift, durable completed/remaining tasks, Ship commits and interruption recovery, pending HTML feedback, blockers, and the host-correct next command.

Run `handoff-list --all` to build the report. After reporting, invoke `handoff-write --agent phasecraft-manager` with the status snapshot and next legal action; never allocate `H-NNN.md` manually. This navigation write must not modify runtime state or semantic artifacts.
