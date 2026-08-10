# Phasecraft Artifact Schemas

Version 1 artifacts use JSON for machine state and restricted Markdown for reviewable engineering records. Markdown is authoritative; HTML is derivative.

## Project Tree

```text
.phasecraft/
├── config.json
├── general_knowledge/
│   ├── SOURCES.json
│   └── PROJECT.md
├── work/
│   └── <confirmed template path>/
│       ├── CONTEXT.md
│       ├── research/
│       │   ├── RESEARCH.md
│       │   └── EVIDENCE.json
│       ├── plan/
│       │   ├── ROADMAP.md
│       │   ├── roadmap.html
│       │   └── phases/P-01-<slug>/
│       │       ├── PLAN.md
│       │       ├── plan.html
│       │       ├── PLAN-VERIFICATION.md
│       │       └── versions/v1/
│       │           ├── PLAN.md
│       │           ├── plan.html
│       │           └── SUPERSEDED.json
│       ├── verification/phases/P-01-<slug>/VERIFICATION.md
│       └── ship/SHIP.md
└── .local/
    ├── registry.json
    ├── locks/
    └── work/<stable-key>/
        ├── state.json
        ├── BASELINE.json
        ├── execution/phases/P-01/patches/T-001.patch
        └── ship/
            ├── preview.json
            └── result.json
```

Init creates project configuration and the first work directories. New Work creates the same isolated work directories for every later feature/task. Stage agents create semantic Markdown as work advances.

## Config

`.phasecraft/config.json`:

```json
{
  "schemaVersion": 1,
  "artifactMode": "local",
  "workPathTemplate": "features/{feature}/tasks/{id}-{slug}",
  "sensitivePaths": [".env", ".env.*", "*.pem", "*.key", "*credentials*", "*secret*"],
  "snapshotMaxBytes": 10485760,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

`artifactMode` is `local` or `reviewable`. Template placeholders are prompted values; `{id}` comes from the confirmed work id and `{slug}` may be derived from the title.

## Authority Registry

`general_knowledge/SOURCES.json` contains `schemaVersion`, `hashAlgorithm`, `confirmedAt`, and ordered `sources`. Each source has `path`, `authority`, `reason`, `order`, `hash`, and `bytes`. Drift checks recompute every hash and report `current`, `stale`, or `missing`.

## Evidence Registry

`research/EVIDENCE.json`:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "E-001",
      "type": "evidence",
      "claim": "Observed behavior",
      "source": {
        "kind": "repository",
        "locator": "src/file.mjs:createThing",
        "hash": "64 lowercase hex characters"
      },
      "status": "verified"
    }
  ]
}
```

Allowed types and matching prefixes are `evidence/E`, `decision/D`, `proposal/P`, `unknown/U`, and `risk/R`. IDs use at least three digits and are unique. Every entry requires a claim, source kind, source locator, and status. `E-*` requires a source SHA-256.

## Roadmap Markdown

`ROADMAP.md` requires one level-one title and these exact level-two sections:

```text
Objective
Requirements
Phases
Risks
Unknowns
```

Requirements use:

```markdown
- REQ-001: Testable requirement.
```

Every phase is a level-three entry:

```markdown
### P-01: Phase title
- Goal: Summary outcome.
- Requirements: REQ-001
- Depends on: none
- Exit evidence: Observable completion evidence.
- Status: next
```

Risks may be `None.` or use the risk entry grammar below.

## Plan Markdown

`PLAN.md` requires one level-one title and these exact level-two sections:

```text
Goal
Inputs
Requirements
Technical Design
Tasks
Risk Controls
Commit Groups
Manual Checks
```

Requirements use `- REQ-001: description`.

### Technical Change

```markdown
### CH-001: Change title
- File: src/file.mjs
- Symbol: exportedFunction
- Before: E-001 describes the verified current state.
- Proposed after: PROPOSED P-001 describes the target state.
- Reason: Why this change is required.
```

`Before` must cite `E-*`. `Proposed after` must contain `PROPOSED` or cite `P-*`.

### Task

```markdown
### T-001: Task title
- Requirements: REQ-001
- Evidence: E-001, D-001, P-001
- Depends on: none
- Files: src/file.mjs, test/file.test.mjs
- Change: Implement CH-001.
- Verification: Observe the positive case; observe the negative case
- Commit group: C-001
```

Requirements name existing `REQ-*` entries and dependencies name existing `T-*` entries. Execution-critical `U-*` evidence is invalid. Across all tasks covering a requirement, at least two semicolon-separated verification observations are required.

### Risk

```markdown
### R-001: Risk title
- Impact: Blast radius.
- Mitigation: Preventive or detective control.
- Possible solution: P-001 or another labeled proposal.
- Evidence: E-001, R-001
```

At least one risk control is required in a plan.

### Commit Group

```markdown
### C-001: Group title
- Files: src/file.mjs, test/file.test.mjs
- Message: fix: concise message
- Depends on: none
```

Every task's group must exist. Groups sharing files are merged by Ship.

### Manual Check

The section may contain `None.` or entries:

```markdown
### M-001: Manual check title
- Requirement: REQ-001
- Instructions: Exact user action.
- Expected: Observable result.
- Status: pending
```

## HTML Derivative

`roadmap.html` and `plan.html` are generated in both artifact modes. They are standalone UTF-8 documents with inline CSS, no JavaScript, no remote assets, and escaped source text.

The head includes:

```html
<meta name="phasecraft-source-sha256" content="<source SHA-256>">
<meta name="phasecraft-schema-version" content="1">
```

Generation includes no timestamp or random identifier. The same Markdown and evidence registry produce byte-identical output. HTML is never authoritative.

## Plan Versions

The active files retain `PLAN.md` and `plan.html`. Before a material replan, `archive-plan` copies both into `versions/vN/`, verifies that HTML is bound to the current Markdown hash, writes `SUPERSEDED.json`, and changes archived files to mode `0444`.

## Runtime State

`state.json` contains schema and revision, work identity and paths, branch, status, active and completed phases, phase plan version, pending checks, adopted and explicitly cleaned baseline files, external research approvals, timestamps, and transition history. Status changes occur only through legal transitions. Other updates increment the same revision without changing status.

`registry.json` maps id, stable key, title, artifact path, branch, and status. It supports deterministic work resolution but is not semantic evidence.

## Git Artifacts

`BASELINE.json` records root, `HEAD`, branch, capture time, dirty file records, staged files, and content hashes. `.phasecraft` entries are excluded.

Task patches are binary-capable cumulative Git patches stored with mode `0600`. `preview.json` stores exact merged groups, binary-capable diff text and hashes, file hashes, checks, pending checks, excluded changed files, worktree hash, and approval fingerprint. `result.json` records local commit hashes and `pushed: false`.
