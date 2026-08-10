# Phasecraft v0.1 Implementation Roadmap

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

## Current Phase: P-07

### Goal

Confirm that repository documentation, runtime behavior, installed OpenCode assets, and safety tests describe one coherent v0.1 product.

### Requirements

- REQ-001: `npm run check` passes for every runtime and installer module.
- REQ-002: `npm test` passes without network or third-party dependencies.
- REQ-003: Installer copy and link outputs contain all command, agent, skill, and runtime files.
- REQ-004: A temporary Git fixture completes Init, baseline adoption, patch snapshot, preview, and grouped local Ship without push.
- REQ-005: Documentation matches implemented evidence identities, artifact paths, CLI flags, state names, and tracking modes.

### Risks

- Documentation drift could teach behavior the runtime rejects. Mitigation: schema examples are copied into tests and reviewed against exported validators.
- Git hooks can mutate content after approval. Mitigation: Ship checks staged sets, remaining file hashes, and post-commit drift, then stops after any hook mutation.
- OpenCode loads configuration only at startup. Mitigation: installer output always reports that restart is required.

### Exit

P-07 completed with syntax, unit, integration, installer, temporary Git workflow, and OpenCode package-loading checks passing.

## Deferred Beyond v0.1

- Push and pull-request creation.
- Issue-tracker APIs.
- CI orchestration.
- Native Windows outside WSL.
- Hunk-based separation of pre-existing edits.
- Automatic secret redaction.
- A browser application or remote dashboard.
