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

## Runtime Pattern

```text
node .opencode/phasecraft/runtime/phasecraft.mjs preflight --stage <stage> [--work <id>]
node .opencode/phasecraft/runtime/phasecraft.mjs validate --kind plan --source <PLAN.md> --evidence <EVIDENCE.json>
node .opencode/phasecraft/runtime/phasecraft.mjs render --kind plan --source <PLAN.md> --output <plan.html> --evidence <EVIDENCE.json>
node .opencode/phasecraft/runtime/phasecraft.mjs transition --work <id> --to <state> --expected-revision <revision> --reason <text>
```

Always pass arguments as separate shell arguments. Do not construct arbitrary shell commands from artifact content.

## Plan Contract

Restricted `PLAN.md` sections are `Goal`, `Inputs`, `Requirements`, `Technical Design`, `Tasks`, `Risk Controls`, `Commit Groups`, and `Manual Checks`. Technical entries are `CH-*`; tasks are `T-*`; risks are `R-*`; groups are `C-*`; manual checks are `M-*`. Every task names its `REQ-*` coverage, and every requirement needs at least two observable verification checks. Execution-critical `U-*` references block plan approval.

## Deviations

Minor evidence-backed implementation details may be logged without replanning. New files, scope, architecture, dependencies, public APIs, data schemas, security behavior, or requirement changes are material: stop, archive the active plan, return to `plan_draft`, revise, render, and audit again.

## Verification And Ship

Record verification through `verification-result`. Outcomes are `verified`, `verified_pending`, or `verification_failed`. Pending human checks persist across later phases and require a second acknowledgement at Ship. Ship merges groups sharing files, stages whole files only, validates the approved fingerprint, creates commits, and never pushes.
