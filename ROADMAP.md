# Phasecraft Implementation Roadmap

The roadmap tracks implementation of [the v0.1 specification](docs/SPEC.md). Detailed future planning is created just in time; this repository does not use Phasecraft to commit itself yet because Git initialization is intentionally deferred.

## Phases

| Phase | Goal | Exit Evidence | Status |
| --- | --- | --- | --- |
| P-01 | Freeze workflow and artifact contracts. | Specification records commands, states, evidence, Git policy, and installer behavior. | completed |
| P-02 | Build state and work-resolution kernel. | Safe templates, atomic revisions, locking, preflight, transitions, registry resolution, and CLI tests pass. | completed |
| P-03 | Build evidence, authority, and artifact system. | Authority drift, consent persistence, evidence validation, restricted plans, plan archives, and deterministic HTML tests pass. | completed |
| P-04 | Build Git safety and Ship. | Baseline block-or-adopt, snapshots, overlap merging, preview fingerprints, drift rejection, grouped local commits, and no-push tests pass. | completed |
| P-05 | Package for OpenCode. | Nine commands, including recurring New Work, seven stage agents, shared skill, scoped permissions, and no hardcoded models exist. | completed |
| P-06 | Build reusable installer. | Copy, link, check, update safety, modified-target preservation, and uninstall tests pass. | completed |
| P-07 | Conformance and dogfooding. | Syntax check, full `node:test`, installer fixture, CLI Init-to-Ship fixture, and OpenCode resolved-config validation pass. | completed |
| P-08 | Build local interactive artifact review. | Deterministic anchors, immutable feedback, authenticated loopback UI, planner resolutions, security tests, and installer coverage pass. | completed |
| P-09 | Package a host-neutral workflow. | Public npm metadata, MIT licensing, and tested OpenCode, Claude Code, Codex, and Pi projections exist. | completed |

## Current Phase: P-09

### Goal

Deliver one installable package without duplicating or weakening the deterministic Phasecraft core.

### Requirements

- REQ-001: One public npm CLI installs Phasecraft project-locally for OpenCode, Claude Code, Codex, and Pi.
- REQ-002: Host prompts are generated from the canonical workflow instead of maintained as divergent copies.
- REQ-003: Independent manifests preserve conflict detection, modified-file protection, health checks, and uninstall safety.
- REQ-004: Codex receives Agent Skills and role TOML, Claude receives commands/agents/skills, and Pi receives prompts/skills/tool guards.
- REQ-005: Host limitations and safety parity are explicit.
- REQ-006: Syntax, host projection, installer, package-content, and full workflow tests pass.

### Risks

- Host prompt formats may drift. Mitigation: generate projections from one canonical source and test exact command/role counts.
- Claude Code and Codex cannot express OpenCode's exact path permissions. Mitigation: combine native host controls with mandatory role policies and document residual risk.
- Pi has no equivalent named-agent isolation. Mitigation: native prompt templates activate role guards and disclose the same-session limitation.

### Exit

P-09 completed with a public MIT package definition, coexistence-safe host manifests, generated host projections, Pi tool guards, documentation, and passing conformance checks.

## Delivered After v0.1

- Local authenticated plan/roadmap review with element and selected-text comments.
- Immutable exact-hash-bound feedback batches and planner resolutions.
- Differential risk-aware plan re-verification.
- OpenCode, Claude Code, Codex, and Pi host adapters from one npm package.

## Deferred

- Push and pull-request creation.
- Issue-tracker APIs.
- CI orchestration.
- Native Windows outside WSL.
- Hunk-based separation of pre-existing edits.
- Automatic secret redaction.
- Remote hosted collaboration or dashboard.
