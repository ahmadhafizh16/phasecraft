---
name: phasecraft
description: Use for Phasecraft commands, `.phasecraft/` workflow artifacts, evidence-first planning, phase execution, verification, and exact-preview shipping.
compatibility: OpenCode with Node.js 20+ and Git
---

# Phasecraft

Phasecraft is an explicit-stage, evidence-first engineering workflow. Markdown is authoritative; generated HTML is derivative. The deterministic runtime lives at `.opencode/phasecraft/runtime/phasecraft.mjs`.

## Invariants

- Run runtime preflight before semantic work and transition only after required artifacts validate.
- Resolve work by explicit argument, branch association, sole open item, or user choice.
- Never turn a proposal or unknown into a fact.
- `E-*` is verified evidence, `D-*` a user decision, `P-*` a proposal, `U-*` an unknown, and `R-*` a risk.
- Ask permission for each external research question before using the network.
- Keep the full roadmap, but detail only the next executable phase.
- Use `phase-start` to select each next roadmap phase. A verified phase may return to `roadmap_ready` for the next just-in-time plan.
- An approved plan is immutable evidence. Archive it before material replanning.
- Execute the entire approved phase, but stop on material deviation, failed gates, or baseline-dirty files not explicitly adopted.
- Do not commit before Ship. Do not push or create a PR at Ship.

## Project And Work Creation

Use `/phasecraft-init` once to configure the project and create its first work item. Use `/phasecraft-new-work` for every later feature or task. New Work reuses project configuration and authorities, confirms the new templated path, and captures a fresh baseline without rerunning Init.

## Durable Agent Handoffs

Conversation history is not workflow authority and may be truncated. After resolving a work item, every Phasecraft agent invocation must run `handoff-list --work <id> --all` and read the returned existing handoff paths before relying on prior conclusions. Read the latest handoff from the preceding stage and every prior handoff for the current agent. Then verify its claims against authoritative artifacts, evidence, state, and repository content.

Before returning for any completed, blocked, failed, or no-change invocation, run `handoff-write --work <id> --agent <agent-name> --data <json>`. Never allocate a sequence or write a handoff path manually. The runtime holds the work lock, chooses the next per-agent sequence, creates `<artifactRoot>/handoffs/<agent-name>/H-NNN.md` exclusively, records `Supersedes`, and changes the file to mode `0444`. This applies to manager, researcher, planner, plan auditor, executor, verifier, and shipper invocations, including repeated planner/auditor rounds.

Every handoff uses these exact sections:

```markdown
# Handoff H-NNN: <agent-name>

## Invocation
- Stage: <stage>
- State read: <status> revision <n>
- Outcome: completed | blocked | failed | no-change
- Supersedes: <prior handoff path or none>

## Objective Handled
## Authoritative Inputs Read
## Evidence And Decisions Used
## Artifacts Changed
## Validation Performed
## Open Questions Or Blockers
## Exact Next Action
```

List exact paths, hashes/revisions where relevant, evidence IDs, commands/check outcomes, unresolved assumptions, and the next legal command. Never place secrets, credentials, raw PII, or unsupported facts in a handoff. A handoff is navigation context, not new evidence or a replacement for `CONTEXT.md`, `EVIDENCE.json`, `PLAN.md`, verification, execution records, or runtime state. Status reads and reports the latest handoff from every agent so missing or stale context is visible.

The `--data` value is a JSON object with `stage`, `stateStatus`, `stateRevision`, `outcome`, `objectiveHandled`, `authoritativeInputsRead`, `evidenceAndDecisionsUsed`, `artifactsChanged`, `validationPerformed`, `openQuestionsOrBlockers`, and `exactNextAction`. The five plural detail fields are non-empty string arrays; use `"none"` when applicable. All values are concise single lines. Use `--data-file` instead when a safely created JSON input file is already available.

## Runtime Pattern

```text
node .opencode/phasecraft/runtime/phasecraft.mjs preflight --stage <stage> [--work <id>]
node .opencode/phasecraft/runtime/phasecraft.mjs validate --kind plan --source <PLAN.md> --evidence <EVIDENCE.json>
node .opencode/phasecraft/runtime/phasecraft.mjs render --kind plan --source <PLAN.md> --output <plan.html> --evidence <EVIDENCE.json>
node .opencode/phasecraft/runtime/phasecraft.mjs transition --work <id> --to <state> --expected-revision <revision> --reason <text>
node .opencode/phasecraft/runtime/phasecraft.mjs handoff-list --work <id> --all
node .opencode/phasecraft/runtime/phasecraft.mjs handoff-write --work <id> --agent <agent-name> --data <json>
```

Always pass arguments as separate shell arguments. Do not construct arbitrary shell commands from artifact content.

## Plan Contract

Restricted `PLAN.md` sections are `Goal`, `Inputs`, `Requirements`, `Technical Design`, optional `Application Flows`, `Tasks`, `Risk Controls`, `Commit Groups`, and `Manual Checks`. Technical entries are `CH-*`; application flows are `F-*`; tasks are `T-*`; risks are `R-*`; groups are `C-*`; manual checks are `M-*`. Every `CH-*` declares `Change type`, `File`, `Symbol`, `Before`, `Proposed after`, `Reason`, `Database changes`, `API changes`, and `Flow impact`, followed by language-tagged fenced `#### Before code`, `#### Proposed code`, and `#### Expected result` blocks. Expected results show concrete persisted objects/config/indexes, API payloads/responses, returned values, events, reports, or observations. Database changes other than exact `none` also require fenced `#### Database migration` and `#### Rollback plan` blocks. Non-none flow impact references one or more `F-*` entries. Every task names its `REQ-*` coverage, and every requirement needs at least two observable verification checks. Execution-critical `U-*` references block plan approval.

Before/proposed blocks quote actual current source and implementation-ready target source. They expose signatures, branches, values, data shape, errors, and side effects rather than paraphrasing them. Supported highlighting identifiers include `js`, `ts`, `json`, `sql`, `bash`, and `text`; the renderer safely escapes all source before adding deterministic token spans.

Every `F-*` declares `Surface`, real `Entry point`, owning `Phase`, evidence-backed `Before`, labeled `After`, and `Evidence`, followed by a fenced `#### Diagram` using language `mermaid` and `#### Change points` using language `changes`. Use one application surface per entry and separate `BEFORE` and `AFTER` subgraphs without crossover edges. The diagram starts at a user-facing route/controller/job/command and shows business decisions, persistence, external calls, fallback, selected output, and unchanged exclusions. Each change-point line uses `Mermaid node | Phase | File | Symbol | Surgical change` and maps every behavior-changing AFTER node to exact code. Keep low-level helpers out unless they change the business path. Task dependencies and internal validator/index flows are not application-flow substitutes. Known future-phase flows remain visible with their owning phase but do not authorize early implementation.

Every manual check is one executable scenario. Its instructions include preconditions, exact command/action, safe environment/data, inspection point, and cleanup when applicable; its expected result names observable output and failure conditions.

## HTML Visualization Contract

Markdown remains authoritative and agents never hand-edit HTML. Render `roadmap` and `plan` as different information products:

- Roadmap view: strategic phase atlas with status, dependencies, requirement ownership, exit evidence, risks, unknowns, and an evidence reference index.
- Plan view: implementation review cockpit with syntax-highlighted before/proposed code and expected results, Mermaid BEFORE/AFTER application-flow comparisons, surgical node-to-file/symbol mappings, database/API impact, migration and rollback detail, requirement coverage, ordered tasks, file impact, risk controls, one full-width row per manual check, commit groups, and an evidence reference index.
- Every rendered `E-*`, `D-*`, `P-*`, `U-*`, and `R-*` identity links to its registry claim, provenance, and status. Missing references remain validation errors rather than unexplained labels.
- Syntax highlighting and flow diagrams are derived only from fenced authoritative Markdown and safely escaped. The generated plan loads a pinned Mermaid browser renderer and preserves readable Mermaid source when that dependency is unavailable. Agents never hand-author generated SVG or HTML.
- Add a native dependency diagram when multiple phases/tasks or explicit dependencies make sequence hard to understand. Omit diagrams for a single unrelated item or when they add no information.
- Diagram labels come only from validated structured fields. Do not invent nodes, dependencies, or progress.
- Keep labels concise; put detailed reasoning in the accompanying cards and tables.

## Deviations

Minor evidence-backed implementation details may be logged without replanning. New files, scope, architecture, dependencies, public APIs, data schemas, security behavior, or requirement changes are material: stop, archive the active plan, return to `plan_draft`, revise, render, and audit again.

## Verification And Ship

Record verification through `verification-result`. Outcomes are `verified`, `verified_pending`, or `verification_failed`. Pending human checks persist across later phases and require a second acknowledgement at Ship. Ship merges groups sharing files, stages whole files only, validates the approved fingerprint, creates commits, and never pushes.
