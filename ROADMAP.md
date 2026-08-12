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

## Current Phase: P-08

### Goal

Deliver local interactive review without making browser state or generated HTML authoritative.

### Requirements

- REQ-001: Generated plan and roadmap HTML expose deterministic semantic review anchors and plain-text manifests.
- REQ-002: Drafts persist privately and published feedback/resolutions are immutable and exact-hash-bound.
- REQ-003: The review server is loopback-only, capability-protected, CSRF-protected, path-contained, and stale-safe.
- REQ-004: The responsive shell supports semantic and same-anchor text-selection comments without browser automation.
- REQ-005: Plan consumes only an explicit feedback batch, writes every disposition, regenerates HTML, and reopens review.
- REQ-006: Syntax, unit, workflow, installer, lifecycle, and security tests pass.

### Risks

- A same-origin remote Mermaid script could access the authenticated review API. Mitigation: review-mode artifact CSP blocks every artifact script and preserves Mermaid source.
- Browser comments could drift onto changed content. Mitigation: exact source/HTML hashes and unique quote/context validation reject stale publication.
- Feedback could be mistaken for evidence or command authority. Mitigation: immutable projections label it untrusted, and Plan independently verifies technical claims.

### Exit

P-08 completed with deterministic rendering, immutable feedback, authenticated review, planner integration, installer checks, and the full test suite passing.

## Delivered After v0.1

- Local authenticated plan/roadmap review with element and selected-text comments.
- Immutable exact-hash-bound feedback batches and planner resolutions.
- Differential risk-aware plan re-verification.

## Deferred

- Push and pull-request creation.
- Issue-tracker APIs.
- CI orchestration.
- Native Windows outside WSL.
- Hunk-based separation of pre-existing edits.
- Automatic secret redaction.
- Remote hosted collaboration or dashboard.
