# Phasecraft v0.1 Specification

This document is the behavioral contract for Phasecraft v0.1. `ARTIFACT-SCHEMAS.md` is authoritative for file and Markdown shape.

## Product Boundary

Phasecraft is an OpenCode-only, project-local engineering workflow. It requires Node.js 20 or newer and a Git worktree. Runtime and tests have no third-party dependencies.

Phasecraft does not assume Jira, branch naming, a remote ticket system, CI, push access, or pull-request access. Ship creates local commits only.

## Invariants

1. Every command performs one explicit stage and stops.
2. Runtime preflight precedes semantic work; artifact validation precedes state transition.
3. Repository facts require evidence. User choices are decisions. Proposals and unknowns remain labeled.
4. External research requires a separately persisted approval for each question.
5. The roadmap covers all phases; only the next phase receives a detailed plan.
6. An approved plan is historical evidence. Material deviations archive it before replanning.
7. Execution creates no commits. Ship creates no push or pull request.
8. Pre-existing unrelated changes are never reverted or silently staged.
9. Markdown is authoritative. Generated HTML is escaped, deterministic, offline, and SHA-bound.
10. Runtime state uses atomic writes, revisions, and same-work locks.

## Work Resolution

The project config stores a template such as `features/{feature}/tasks/{id}-{slug}`. Placeholder values must be safe single path segments. Literal `/` characters define hierarchy. Absolute paths, traversal, separators in values, malformed placeholders, and escapes from `.phasecraft/work/` are rejected.

Commands resolve a work item in this order:

1. Explicit work id or key.
2. Unique current-branch association.
3. The sole open work item.
4. An ambiguity error requiring user selection.

## Commands

### Init

Init runs once. It confirms `local` or `reviewable` artifact tracking, configures the project work-path template, creates the first work item, and captures its baseline. It discovers known authority candidates (`AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, and documentation indexes), asks which are authoritative, and persists their ordered paths and SHA-256 hashes. If project configuration already exists, Init directs the user to New Work rather than reconfiguring it.

No feature/task syntax is inferred from a branch. A branch may be associated with the confirmed work item only for later resolution.

### New Work

New Work requires an initialized project. It reuses artifact mode, work-path template, and confirmed authorities. It checks authority drift, asks for the new work id/title/template values and optional branch association, shows the exact path for confirmation, and invokes `init-work` to create isolated artifacts, state, and a fresh Git baseline.

New Work never changes project configuration or existing work items. Arguments are suggestions rather than confirmed identifiers. Full PRD, database, and integration context belongs in the subsequent Discuss command.

### Discuss

Discuss records objective, scope, non-goals, constraints, acceptance evidence, decisions, unknowns, risks, impact, mitigation, and possible solutions. It checks authority drift before using project knowledge.

Before each network lookup, Discuss presents the question and intended source classes. After explicit approval, `research-approve` persists that exact request before a network tool is used. Results record URL or query, retrieval time, content hash, and the evidence claim they support.

### Plan

Plan checks authority drift, maintains the full roadmap, and details only the next executable phase. Each technical change names a file, symbol, evidence-backed before state, labeled proposed after state, and reason. Each task names evidence, dependencies, files, change, checks, and commit group. Risks include impact, mitigation, possible solution, and evidence.

Plan validates restricted Markdown and generates `roadmap.html` and `plan.html` in both artifact modes.

### Verify Plan

The plan auditor runs in an independent OpenCode subtask. It validates:

- Current authority and evidence hashes.
- Every requirement and its observable checks.
- At least two semicolon-separated observations for each task.
- Before-state evidence and proposal labels.
- Dependencies and commit groups.
- Risk mitigation and manual checks.
- Dirty baseline overlap and unrelated scope.
- The HTML source hash.

Blocking findings leave the work in `plan_draft`. A clean audit transitions to `plan_verified`.

### Execute

Execute verifies the approved plan revision and runs the entire phase in dependency order. It edits only approved source files, records commands and observations, and writes a cumulative patch after each completed task.

New scope, files, architecture, dependencies, public APIs, schemas, or security behavior are material deviations. Execute stops, archives the current plan, returns to `plan_draft`, and requires a new audit. Minor evidence-backed implementation details are logged without rewriting the approved plan.

Execute never commits, pushes, resets, switches branches, or cleans the tree.

### Verify

The verifier runs independently and compares decisions, evidence, approved plan, actual diff, execution record, automatic checks, negative cases, boundaries, and baseline exclusions.

Outcomes are:

- `verified`: all required checks pass.
- `verified_pending`: automatic checks pass and human-only checks remain pending.
- `verification_failed`: implementation or automatic checks fail.

Pending human checks do not prevent the verification stage from completing, but Ship requires a second acknowledgement bound to the exact preview.

### Ship

Ship merges groups sharing files, uses whole-file staging, and refuses unadopted baseline-dirty files. The Git index must be clean before preview. Its preview contains `HEAD`, branch, complete worktree fingerprint, merged groups, exact binary-capable diffs and hashes, file hashes, commit messages, check results, excluded changed files, and pending manual checks.

One user approval authorizes that exact fingerprint. `verified_pending` requires a separate acknowledgement using the same fingerprint. Drift in any approved input aborts Ship. Ship verifies the staged file set before each commit, creates local commits, and never pushes.

### Status

Status is read-only. It reports the work state and revision, active plan version, authority drift, unknowns, pending checks, adoption, and the next legal stage.

## Evidence Identities

| Prefix | Contract |
| --- | --- |
| `E-*` | Verified repository, command, project-document, or approved external evidence with provenance. |
| `D-*` | Explicit user decision and its discussion source. |
| `P-*` | Proposed solution, not a present fact. |
| `U-*` | Unresolved unknown with a follow-up. |
| `R-*` | Risk with impact, mitigation, possible solution, and supporting evidence. |

Execution-critical `U-*` references block plan approval. Current-state `Before` fields require `E-*`. Future-state fields include `PROPOSED` or `P-*`.

## State Machine

```text
initialized -> researching -> discussed -> roadmap_ready -> plan_draft
plan_draft -> plan_verified -> executing -> execution_complete -> verifying
verifying -> verified | verified_pending | verification_failed
verified | verified_pending -> shipped | roadmap_ready
```

Legal recovery edges are:

```text
discussed -> researching
roadmap_ready -> researching
plan_draft -> discussed
plan_verified -> plan_draft
executing -> plan_draft
execution_complete -> executing
verified_pending -> verified | verification_failed
verification_failed -> executing | plan_draft
```

`phase-start` uses the verified-to-roadmap edge, records the previous phase as completed, selects the next `P-NN`, resets that phase's plan version, and preserves unresolved manual checks for final Ship acknowledgement.

Every state has a monotonically increasing revision. Transition may require an expected revision and fails on a conflict. Same-work lock directories contain owner metadata and are never silently broken.

## Artifact Tracking

`local` adds `/.phasecraft/` to the repository's local `.git/info/exclude`. `reviewable` excludes only `/.phasecraft/.local/`. Phasecraft does not edit `.gitignore`.

Review artifacts can therefore be shared in `reviewable` mode, while state, execution logs, previews, results, and patches remain local. Phasecraft Ship never adds `.phasecraft` files to application commit groups.

## Git Safety

Baseline captures `HEAD`, branch, porcelain status, staged/untracked/deleted state, and per-file hashes. `.phasecraft` is excluded from the baseline.

A planned file in the baseline dirty set is blocked. Before execution, the user may restore it to `HEAD` and persist that observation with `baseline-clean`, or explicitly adopt it. Adoption means all pre-existing content in that whole file becomes part of the work item. Phasecraft does not attempt hunk-based separation.

Patch snapshots use binary Git patches, include approved tracked and untracked files, are mode `0600`, enforce a configured byte limit, and reject `.phasecraft` or configured sensitive paths unless separately approved.

Commit groups are connected components over shared file paths and are topologically ordered by declared dependencies. Both paths of a rename must be approved together. Whole-file staging is verified against each final group. Any staged file blocks preview until it is unstaged without discarding its working-tree content. Hooks are not bypassed; hook-created drift stops the remaining Ship sequence and is reported.

## Installer

The installer copies by default and supports `--link`, `--check`, and `--uninstall`. Its target is the project root. It installs command, agent, skill, and runtime files into discovered `.opencode` locations without editing `opencode.json`.

The manifest stores source path, target path, source hash, installed hash, mode, version, and link target. Unmanaged conflicts stop installation. A managed target changed since installation is neither replaced nor removed. Link mode creates individual file symlinks. OpenCode must restart after changes.

## Agent Permissions

Manager, researcher, planner, auditor, and verifier may write workflow artifacts but not application source. Executor may edit source but cannot commit, push, reset, switch, or clean. Shipper cannot edit application source or invoke Git directly; it may invoke only the approval-enforcing runtime Ship path. Models are inherited from project configuration.

## Conformance

Phasecraft v0.1 is conformant when syntax checks and the `node:test` suite pass, the installer can copy/link/check/uninstall safely, the OpenCode package contains all nine commands and seven stage agents, and the CLI fixture completes baseline capture through local grouped commits without push.
