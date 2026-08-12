---
description: Independently audit a Phasecraft plan for evidence and Nyquist coverage.
agent: phasecraft-plan-auditor
subtask: true
---

Load the `phasecraft` skill and perform only Verify Plan for `$ARGUMENTS`. Run the `verify-plan` preflight. Independently compare the current plan to user decisions, evidence, roadmap requirements, repository state, and risk records.

Run `knowledge-check`. Require requirements to map to observable checks, tasks to valid identities and commit groups, risks to state their current mitigation or explicit `none` decision, and proposed edits to identify their claimed before state and evidence status. Confirm that technical changes declare their relevant database, API, and flow impact and contain enough concrete before/proposed/result detail for the active phase to be implemented without guessing. Report stale, missing, weak, or conflicting evidence and missing detail according to their actual execution consequence; do not require exhaustive snapshots, branches, or future-phase detail solely for artifact completeness.

On a first/full audit, trace each active-phase non-`none` `Flow impact` far enough to confirm the real surface, entry point, material business decisions, persistence/external-side-effect ordering, fallback, and mapped code ownership. On a repeat/differential audit, trace only changed flows and directly affected paths. Require valid `F-*` and change-point mappings, but classify missing branches or examples by concrete execution risk instead of expanding every flow to theoretical completeness. Reject invented paths or an internal validator/index diagram presented as the feature flow.

Check dependencies, relevant negative cases and boundaries, stale hashes, unrelated scope, dirty baseline overlap, and human-only checks. Manual checks must be independently executable when they are required for approval. Run the restricted Markdown validator; inspect `plan.html` structurally for a phase-specific `<title>`, single-phase authorization, source binding, evidence references, and the review surfaces needed to understand the active change. For all active content on a first/full audit, or changed content on a repeat/differential audit, inspect validator-accepted Mermaid BEFORE/AFTER source, surgical change-point tables, concrete expected-result panels, and one row per manual check. Treat validator warnings and missing-detail panels as semantic completeness findings, not integrity failures.

Do not use Playwright, browser automation, screenshots, rendered-SVG inspection, or lack of a browser observation as a finding. Verify authoritative content, Mermaid source syntax/structure, and deterministic HTML generation; visual layout review belongs to the human, who may request a later artifact revision.

## Finding Classification And Human Disposition

First run the non-waivable integrity gate. It fails only for workflow or artifact conditions that make approval unbindable or unsafe to interpret: illegal preflight/state/revision, missing active plan, structural restricted-schema failures that prevent deterministic parsing or make identities ambiguous, plan/HTML source-hash mismatch, or exposed secrets/credentials. Stale/missing authority, stale/weak/conflicting evidence, unresolved evidence provenance, insufficient checks, and incomplete engineering detail are semantic findings with explicit consequences, not integrity failures. Integrity failures remain in `plan_draft`; human risk acceptance cannot override them.

Determine audit scope before semantic review:

- `first/full`: no exact prior audited plan is available, so review the active phase end to end once;
- `repeat/differential`: an archived prior plan and audit have matching hashes, so compare stable semantic IDs and inspect only changed anchors, direct dependencies, changed evidence, prior `fix-now`/`pending` findings, and due risk triggers;
- fall back to `first/full` only when the old exact artifacts are unavailable or the impact set cannot be trusted.

On a differential audit, do not reopen unchanged `defer`, `accept-risk`, or `non-blocking` decisions and do not search unchanged areas for new completeness improvements. Present one explicit carry-forward confirmation listing those decisions and bind the confirmed copies to the new PLAN SHA-256. Independently recheck anything changed or previously requested as `fix-now`. Always disclose a critical safety issue discovered incidentally, but stop when integrity and the delta are dispositioned rather than beginning another perfection pass.

Classify every other finding by execution relevance:

- `active-phase safety/correctness`: the approved phase could mutate the wrong target, corrupt data, violate a required contract, create a security/privacy issue, or cannot be implemented unambiguously;
- `active-phase completeness`: useful implementation or verification detail is missing, but the impact depends on engineering judgment;
- `future-phase`: belongs to a later roadmap phase and does not make the current phase impossible or irreversibly wrong;
- `artifact quality`: traceability, wording, formatting, or review ergonomics that do not change current execution behavior.

Never silently decide that a semantic finding blocks execution. Present each finding, or a clearly identified group with one shared disposition, to the human using the question tool. Include the auditor recommendation and concise consequence. Offer these exact choices:

1. `Fix now` — remain in `plan_draft` and return the finding to Plan.
2. `Defer` — record a named owner phase or trigger, reason, and any guardrails in `plan/DEFERRED-FINDINGS.md`.
3. `Accept risk for speed` — record the human rationale; mitigation and execution guardrails may explicitly be `none`, and approval is bound to this exact plan hash.
4. `Non-blocking` — record why no plan change is required.

Recommend `Fix now` for active-phase safety/correctness, but allow explicit human acceptance unless the integrity gate failed. Recommend `Defer` for future-phase findings. Recommend `Non-blocking` for artifact quality unless it prevents the executor from identifying authorized work. Ask a follow-up when `Defer` lacks an owner/trigger. For `Accept risk for speed`, require a rationale but accept `Mitigation: none` and `Guardrails: none` without another challenge. Record a materialization signal and revisit trigger when provided; otherwise use the described consequence being observed as the trigger. Do not infer acceptance from silence, prior general urgency, or the auditor's recommendation.

Write `PLAN-VERIFICATION.md` with these exact top-level sections: `Integrity Gate`, `Findings`, `Human Q&A`, and `Execution Gate`. Record whether the audit was `first/full` or `repeat/differential` and list compared hashes and changed semantic IDs. For each Q&A record the finding IDs, question, auditor recommendation, answer (`fix-now`, `defer`, `accept-risk`, `non-blocking`, or `pending`), the human's rationale, owner/trigger where applicable, guardrails including explicit `none`, and the exact PLAN SHA-256. A disposition applies only to that plan hash. Preserve every new or changed finding and every carried-forward disposition without requiring the human to answer unchanged findings individually again.

Create or update `plan/DEFERRED-FINDINGS.md` for every `defer` answer. Use one stable entry keyed by active phase, finding ID, and bound plan-hash prefix; record source verification path, description, rationale, owner/trigger, guardrails, and `open` status. Plan must revisit due entries when their owner phase starts or trigger occurs. Do not place accepted risks or non-blocking findings in the deferred backlog; they remain in the bound verification Q&A.

Create or update `plan/RISK-REGISTER.md` for every `accept-risk` answer, including no-mitigation acceptance. Record a stable ID, source verification path, bound plan hash, description and consequence, human rationale, mitigation (`none` is valid), guardrails (`none` is valid), materialization signal, revisit trigger, and `accepted` status. Executor and Verifier may change the status to `materialized` only with observed evidence. Plan revisits an accepted risk only when its trigger is due or the human asks; replanning and hash changes do not silently erase it.

Transition to `plan_verified` when the integrity gate passes, every finding has a recorded human disposition, and no answer is `fix-now` or `pending`. Use outcome `APPROVED` when there are no findings and `APPROVED WITH DISPOSITIONS` otherwise. Remain in `plan_draft` with outcome `CHANGES REQUESTED` for `fix-now`, `NEEDS HUMAN DECISION` for pending answers, or `BLOCKED BY INTEGRITY GATE` for non-waivable failures. Never edit application source or silently repair the planner's conclusions.

Run `handoff-list --all` and read the latest planner plus all prior auditor handoffs before auditing. Before every return, invoke `handoff-write --agent phasecraft-plan-auditor` with findings, checks, state/revision, blockers, and exact next action; never allocate `H-NNN.md` manually.
