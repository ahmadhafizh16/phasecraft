---
description: Independently audit a Phasecraft plan for evidence and Nyquist coverage.
agent: phasecraft-plan-auditor
subtask: true
---

Load the `phasecraft` skill and perform only Verify Plan for `$ARGUMENTS`. Run the `verify-plan` preflight. Independently compare the current plan to user decisions, evidence, roadmap requirements, repository state, and risk records.

Run `knowledge-check`. Require every requirement to map to observable checks, every task to valid evidence and a commit group, every risk to mitigation work, and every proposed edit to have a verified before state. Confirm that each technical change declares type, database impact, API impact, and flow impact; includes accurate language-tagged before/proposed code plus a concrete expected-result snapshot; and provides migration plus rollback detail whenever database impact is not `none`. Database expected results must show realistic complete persisted documents/config/indexes, and API changes must show exact request/response or payload shape. Report vague placeholders or snippets insufficient to reconstruct signatures, control branches, data shape, output, error handling, or side effects, but classify their actual active-phase execution impact instead of automatically making every completeness gap blocking.

Independently trace each non-`none` `Flow impact` through the repository and require it to reference a valid `F-*` entry. Verify every `Application Flows` entry names the real surface, entry point, owning phase, evidence-backed before behavior, and proposed after behavior. Mermaid diagrams must use separate BEFORE/AFTER subgraphs without crossover edges, expose business decisions and fallback, and remain readable rather than enumerating every low-level helper. Require a `changes` mapping for every surgically changed AFTER node and verify each phase, file, symbol, and edit intent against repository evidence. For estimate flows, verify tariff API ordering, flat eligibility, complete regular/flat discount stages, final-price comparison, tie policy, selected SLA, and fallback. For creation flows, verify persistence before external side effects, both boolean classifications, retry/pay-later reuse, payload mapping, errors, and unchanged excluded paths. Reject internal validator/index diagrams presented as the feature flow, decorative diagrams, invented paths, task-only diagrams, or unmapped application changes.

Check dependencies, negative cases, boundaries, stale hashes, unrelated scope, dirty baseline overlap, and human-only checks. Manual checks must be independently executable with preconditions, exact action/command, safe environment/data, expected observations, failure criteria, and cleanup where needed. Run the restricted Markdown validator; inspect `plan.html` structurally for a matching phase-specific `<title>`/meta/banner/footer, an explicit single-phase authorization statement, correct `Current phase` versus `Future context` flow labels, deterministic syntax-token spans, concrete expected-result panels, validator-accepted Mermaid BEFORE/AFTER source and its pinned runtime/fallback markup, surgical change-point tables, database/API/flow/rollback panels with every `CH-*` to `F-*` relationship visible, one full-width row per manual check, complete evidence claim/provenance/status references, no missing-detail placeholders, and the correct HTML source hash.

Do not use Playwright, browser automation, screenshots, rendered-SVG inspection, or lack of a browser observation as a finding. Verify authoritative content, Mermaid source syntax/structure, and deterministic HTML generation; visual layout review belongs to the human, who may request a later artifact revision.

## Finding Classification And Human Disposition

First run the non-waivable integrity gate. It fails only for workflow or artifact conditions that make approval unbindable or unsafe to interpret: illegal preflight/state/revision, missing or stale confirmed authority, restricted-schema validation errors, missing active plan, unresolved evidence identities, plan/HTML source-hash mismatch, or exposed secrets/credentials. Integrity failures remain in `plan_draft`; human risk acceptance cannot override them.

Classify every other finding by execution relevance:

- `active-phase safety/correctness`: the approved phase could mutate the wrong target, corrupt data, violate a required contract, create a security/privacy issue, or cannot be implemented unambiguously;
- `active-phase completeness`: useful implementation or verification detail is missing, but the impact depends on engineering judgment;
- `future-phase`: belongs to a later roadmap phase and does not make the current phase impossible or irreversibly wrong;
- `artifact quality`: traceability, wording, formatting, or review ergonomics that do not change current execution behavior.

Never silently decide that a semantic finding blocks execution. Present each finding, or a clearly identified group with one shared disposition, to the human using the question tool. Include the auditor recommendation and concise consequence. Offer these exact choices:

1. `Fix now` — remain in `plan_draft` and return the finding to Plan.
2. `Defer` — record a named owner phase or trigger, reason, and any guardrails in `plan/DEFERRED-FINDINGS.md`.
3. `Accept risk for speed` — record the human rationale and execution guardrails; approval is bound to this exact plan hash.
4. `Non-blocking` — record why no plan change is required.

Recommend `Fix now` for active-phase safety/correctness, but allow explicit human acceptance unless the integrity gate failed. Recommend `Defer` for future-phase findings. Recommend `Non-blocking` for artifact quality unless it prevents the executor from identifying authorized work. Ask a follow-up when `Defer` lacks an owner/trigger or `Accept risk for speed` lacks concrete guardrails. Do not infer answers from silence, prior general urgency, or the auditor's recommendation.

Write `PLAN-VERIFICATION.md` with these exact top-level sections: `Integrity Gate`, `Findings`, `Human Q&A`, and `Execution Gate`. For each Q&A record the finding IDs, question, auditor recommendation, answer (`fix-now`, `defer`, `accept-risk`, `non-blocking`, or `pending`), the human's rationale, owner/trigger where applicable, guardrails, and the exact PLAN SHA-256. A disposition applies only to that plan hash. Preserve every finding even when the human does not treat it as blocking.

Create or update `plan/DEFERRED-FINDINGS.md` for every `defer` answer. Use one stable entry keyed by active phase, finding ID, and bound plan-hash prefix; record source verification path, description, rationale, owner/trigger, guardrails, and `open` status. Plan must revisit due entries when their owner phase starts or trigger occurs. Do not place accepted risks or non-blocking findings in the deferred backlog; they remain in the bound verification Q&A.

Transition to `plan_verified` when the integrity gate passes, every finding has a recorded human disposition, and no answer is `fix-now` or `pending`. Use outcome `APPROVED` when there are no findings and `APPROVED WITH DISPOSITIONS` otherwise. Remain in `plan_draft` with outcome `CHANGES REQUESTED` for `fix-now`, `NEEDS HUMAN DECISION` for pending answers, or `BLOCKED BY INTEGRITY GATE` for non-waivable failures. Never edit application source or silently repair the planner's conclusions.

Run `handoff-list --all` and read the latest planner plus all prior auditor handoffs before auditing. Before every return, invoke `handoff-write --agent phasecraft-plan-auditor` with findings, checks, state/revision, blockers, and exact next action; never allocate `H-NNN.md` manually.
