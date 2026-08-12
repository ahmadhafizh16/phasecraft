# Commentable Artifact Review Plan

**Status:** Implemented locally; pending release
**Scope:** Phasecraft-generated HTML artifacts

## Objective

Turn every Phasecraft-generated HTML artifact into a local human review surface without making HTML or browser state authoritative.

After Plan generates the current roadmap and phase plan, Phasecraft starts a loopback-only review server and opens the active plan in the user's default browser. The reviewer can comment on a semantic element or selected text, collect comments in a sidebar, and publish an exact-source-bound feedback batch. The UI then copies an explicit `/phasecraft-plan --work <id> --feedback <batch>` command for the user to run.

The planner validates and dispositions that immutable batch, revises authoritative Markdown when appropriate, regenerates HTML, and starts a new review session.

## Confirmed Product Decisions

- Automatically open the active plan in the default browser after a successful Plan stage.
- Print the localhost review URL when browser opening fails or is disabled.
- Apply one generic review layer to all Phasecraft-generated HTML artifacts.
- Support comments on semantic elements and selected text in v1.
- Defer direct clicking of rendered Mermaid nodes; v1 targets the flow card, Mermaid source block, or change-point row.
- Keep canonical detailed feedback privately under `.phasecraft/.local/` and publish a complete reviewable Markdown batch under the work artifact.
- Publishing feedback does not automatically launch an agent or authorize source changes.
- After publication, copy and display an explicit planner command.
- Keep generated HTML deterministic and independent from comments, drafts, sessions, reviewer identity, and timestamps.
- Do not use Playwright or browser automation for review or validation.

## Non-Goals

- Hosted collaboration, accounts, remote synchronization, or multi-user identity.
- Writing comments into generated HTML or authoritative Markdown.
- Treating comments as verified evidence or confirmed decisions.
- Browser-only authoritative storage.
- WYSIWYG editing, raw HTML comments, image uploads, or arbitrary file attachments.
- Pixel, XPath, or screen-coordinate anchors.
- Automatic source edits or unattended OpenCode execution from the browser.
- Direct annotation of generated Mermaid SVG nodes in v1.

## Architecture

```text
PLAN.md / ROADMAP.md
        |
        v
deterministic renderer
        |
        +----> byte-exact generated HTML
        |                |
        |                v
        |       localhost review shell
        |       - same-origin iframe
        |       - annotation overlay
        |       - comments sidebar
        |       - Markdown composer
        |
        +----> exact source hash
                         |
                         v
             private drafts and batch JSON
                         |
                         v
             reviewable FB-NNN.md batch
                         |
                         v
      /phasecraft-plan --work <id> --feedback FB-NNN
```

### Separation Of Authority

- Markdown remains authoritative for roadmap and plan content.
- Generated HTML remains deterministic and derivative.
- Private feedback JSON is authoritative for detailed submitted comment data.
- Reviewable `FB-NNN.md` is a complete deterministic projection of the private batch.
- Planner resolution is a separate artifact; original human feedback is immutable.
- Browser state may cache UI preferences but is never workflow authority.

## User Flow

### Open Review

1. Plan validates and renders `roadmap.html` and the active `plan.html`.
2. Plan invokes `review-start` for the active work and plan artifact.
3. The runtime revalidates source/HTML hash binding.
4. A server starts on an OS-assigned `127.0.0.1` port.
5. Phasecraft opens the review URL in the default browser.
6. If opening fails, Plan returns the URL without failing planning.
7. The review shell offers an artifact switcher for every valid generated HTML artifact under the resolved work item.

### Add Comments

1. The reviewer enables `Comment mode`.
2. Hover or keyboard focus highlights the nearest semantic review anchor.
3. Clicking the anchor opens a compact composer.
4. Selecting text exposes `Comment on selection`.
5. The composer shows the artifact, semantic breadcrumb, and selected quote.
6. The reviewer writes Markdown and may preview it.
7. Drafts autosave to the local review server.
8. Saved comments appear in the sidebar in artifact order.

### Publish Feedback

1. The reviewer selects `Publish feedback`.
2. The UI shows artifact path, source hash, comment count, and stale-comment warnings.
3. The server validates every comment and anchor against the fixed session artifact.
4. The runtime allocates `FB-NNN` while holding the work lock.
5. It writes immutable private JSON and reviewable Markdown projections.
6. The UI displays and copies:

```text
/phasecraft-plan --work <id> --feedback FB-NNN
```

7. Published comments become read-only. Clarification or follow-up creates a new event or batch.

### Planner Resolution

1. Plan resolves and validates the requested batch.
2. It verifies that the source hash belongs to the current or archived artifact version.
3. It treats comments as untrusted human input, not evidence.
4. It verifies technical claims against repository evidence.
5. Each comment receives one disposition:
   - `applied`
   - `declined`
   - `deferred`
   - `needs-clarification`
   - `obsolete`
6. Applied feedback maps to resulting `REQ-*`, `CH-*`, `F-*`, `T-*`, or other semantic anchors.
7. Plan writes `FB-NNN-RESOLUTION.md`, including old and resulting plan hashes.
8. Plan regenerates artifacts and opens the new review session.
9. The planner may mark feedback `addressed`; only a later human action marks it `resolved`.

## Stable Review Anchors

The renderer adds deterministic `data-phasecraft-anchor` values. They are derived only from restricted Markdown structure and stable identities.

Examples:

```text
roadmap/objective
roadmap/phases/P-03
roadmap/requirements/REQ-005
roadmap/risks/R-014
plan/goal
plan/inputs
plan/requirements/REQ-001
plan/technical-design/CH-002
plan/technical-design/CH-002/field/database-changes
plan/technical-design/CH-002/block/proposed-code
plan/technical-design/CH-002/block/expected-result
plan/application-flows/F-001
plan/application-flows/F-001/change-point/A4
plan/tasks/T-003
plan/risks/R-021
plan/commit-groups/C-002
plan/manual-checks/M-001
plan/references/E-015
```

### Text Selection Anchor

Each selected-text comment stores:

- Parent semantic anchor.
- Exact selected text.
- Bounded prefix and suffix context.
- Start/end offsets in a deterministic plain-text projection of the parent anchor.
- Exact Markdown source hash.
- Exact generated HTML hash.
- Optional DOM path only for same-HTML diagnostics.

### Re-Anchoring

When reviewing a newer source hash:

1. Match the semantic anchor.
2. Match the exact quote uniquely inside that anchor.
3. Use prefix/suffix context to disambiguate.
4. Use text offsets only as a hint.
5. Mark zero or ambiguous matches as `stale`.

Never silently attach a comment to a different target.

## Feedback Storage

### Private Local Data

```text
.phasecraft/.local/work/<stable-key>/reviews/
├── sessions/
│   └── current.json
├── drafts/
│   └── <artifact-key>/<source-hash>/<comment-id>.json
└── batches/
    └── FB-001.json
```

- Drafts are mutable and atomically replaced.
- Published batch JSON is immutable, mode `0600`, and exclusively created.
- The private batch contains complete anchors and comment Markdown.
- Session records are disposable and never contain workflow authority.

### Reviewable Work Artifacts

```text
.phasecraft/work/<work>/feedback/
├── FB-001.md
└── FB-001-RESOLUTION.md
```

- `FB-001.md` is generated from the private batch and contains every submitted comment.
- It is bound to artifact path, source hash, HTML hash, phase, and publication time.
- `FB-001-RESOLUTION.md` preserves planner dispositions and resulting source hashes.
- A partial publish is recovered from the immutable private JSON; the Markdown projection can be regenerated byte-for-byte.

### Private Batch Schema

```json
{
  "schemaVersion": 1,
  "id": "FB-001",
  "work": "MRS-4983",
  "artifact": {
    "kind": "plan",
    "path": "plan/phases/P-01-example/plan.html",
    "sourcePath": "plan/phases/P-01-example/PLAN.md",
    "sourceHash": "<sha256>",
    "htmlHash": "<sha256>",
    "phase": "P-01"
  },
  "publishedAt": "<ISO-8601>",
  "comments": [
    {
      "id": "FC-001",
      "anchor": {
        "semantic": "plan/technical-design/CH-002/block/proposed-code",
        "quote": "selected text",
        "prefix": "bounded prefix",
        "suffix": "bounded suffix",
        "start": 120,
        "end": 133
      },
      "bodyMarkdown": "Please make the second-run behavior explicit.",
      "createdAt": "<ISO-8601>",
      "status": "submitted"
    }
  ]
}
```

## Reviewable Feedback Markdown

```markdown
# Feedback FB-001

- Work: MRS-4983
- Artifact: plan/phases/P-01-example/plan.html
- Source: plan/phases/P-01-example/PLAN.md
- Source SHA-256: <hash>
- HTML SHA-256: <hash>
- Published: <ISO-8601>
- Comments: 1

## Comments

### FC-001: plan/technical-design/CH-002/block/proposed-code
- Selected text: `selected text`
- Context before: `bounded prefix`
- Context after: `bounded suffix`
- Status: submitted

#### Comment
```markdown
Please make the second-run behavior explicit.
```
```

## Review UI

### Desktop

- Fixed review toolbar with artifact identity, source-hash prefix, comment count, and Comment mode toggle.
- Document remains in a same-origin iframe and keeps its original layout.
- A 380px right sidebar lists drafts and submitted comments.
- Selecting a sidebar comment scrolls and focuses its anchor.
- The sidebar filters `Draft`, `Open`, `Submitted`, `Addressed`, and `Stale`.

### Mobile

- Replace the fixed sidebar with a full-height drawer.
- Use tap-to-target mode without hijacking scrolling or long-press selection.
- Composer appears as a keyboard-safe bottom sheet.
- Preserve horizontal scrolling for code, tables, and diagrams.

### Mini Markdown Editor

- Plain textarea, not `contenteditable`.
- Toolbar: bold, italic, inline code, fenced code, list, and link.
- Escaped safe preview; raw HTML is unsupported.
- `Add comment`, `Cancel`, and `Preview` actions.
- Autosave status and accessible error messages.

### Accessibility

- Equivalent pointer and keyboard targeting.
- `aria-pressed` Comment mode toggle.
- One focusable comment action per semantic anchor, not every child element.
- Escape closes the composer and restores focus.
- Polite live announcements for save, publish, stale anchor, and server loss.
- Visible focus, reduced-motion support, high contrast, and 400% reflow.
- Controls meet a minimum 44x44 CSS pixel target.

## Local Review Server

### Runtime Commands

```text
phasecraft review-start --work <id> --artifact plan [--no-open]
phasecraft review-status --work <id>
phasecraft review-stop --work <id>
phasecraft feedback-list --work <id>
phasecraft feedback-show --work <id> --feedback FB-001
phasecraft feedback-resolve --work <id> --feedback FB-001 --data-file <path>
```

`review-start` returns structured JSON containing URL, artifact identity, source hash, PID, port, and whether the browser opened. It reuses an existing healthy session for the same work/artifact/hash and replaces stale sessions safely.

### Browser Launch

- Linux: `xdg-open`.
- macOS: `open`.
- Windows: `cmd.exe /c start` using argument-safe spawning.
- Unsupported/headless environment: return `opened:false` and print the URL.
- `--no-open` and `PHASECRAFT_NO_BROWSER=1` disable automatic opening.
- Browser-launch failure never invalidates Plan or HTML generation.

### Lifecycle

- Bind only to `127.0.0.1` with port `0`.
- Keep one active review session per work item in v1.
- Use an explicit UI stop action, CLI stop, signal handling, and a two-hour idle timeout.
- Preserve drafts and published batches after shutdown.
- Detect stale PID/session metadata without killing unrelated processes.

## Security

- Generate a high-entropy session capability token.
- Put the bootstrap token in the URL fragment, never query or path.
- Exchange the token for an HttpOnly, SameSite=Strict session cookie before loading the artifact iframe.
- Require same-origin mutation requests, JSON content type, CSRF/custom headers, and the capability session.
- Emit no CORS headers.
- Validate exact `Host` and `Origin` values.
- Add `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, and appropriate CSP/frame headers.
- Serve only resolved, allowlisted Phasecraft-generated HTML whose metadata matches an available source hash.
- Reject traversal, symlink escape, arbitrary paths, uploads, shell execution, Git operations, and proxy behavior.
- Enforce body, comment-count, Markdown-length, anchor-depth, and field-count limits.
- Escape all comment output and sanitize the supported Markdown subset.
- Never log capability tokens or comment bodies.
- Warn and require confirmation when likely credentials or sensitive data appear before publication.
- Treat feedback as untrusted planner input that cannot authorize commands, research, transitions, or source changes.

## Planned Source Changes

### Runtime

- `runtime/review.mjs`
  - Loopback HTTP server, session authentication, artifact serving, APIs, lifecycle, and browser opening.
- `runtime/review-ui.mjs`
  - Review shell HTML, CSS, client JavaScript, annotation behavior, sidebar, composer, and safe Markdown preview.
- `runtime/feedback.mjs`
  - Draft validation/storage, batch allocation, private JSON, reviewable Markdown projection, listing, and resolution validation.
- `runtime/render.mjs`
  - Deterministic semantic anchors on all plan and roadmap review units.
- `runtime/phasecraft.mjs`
  - Review and feedback command routing/help.
- `runtime/state.mjs`
  - Reuse paths and work locks; add no workflow state solely for an open review session.

### OpenCode Contracts

- `opencode/commands/phasecraft-plan.md`
  - Read explicit feedback batches, write resolution artifacts, and start browser review after successful render.
- `opencode/agents/phasecraft-planner.md`
  - Treat feedback as human input, verify claims, preserve dispositions, and never infer resolution.
- `opencode/commands/phasecraft-status.md`
  - Report pending feedback batches and clarification requests.
- `opencode/skills/phasecraft/SKILL.md`
  - Document review/feedback runtime pattern and authority boundaries.

### Documentation

- `README.md`
- `docs/SPEC.md`
- `docs/ARTIFACT-SCHEMAS.md`

### Tests

- `test/render.test.mjs`
  - Stable anchors, uniqueness, deterministic output, all artifact kinds, code blocks, tables, and text projection.
- `test/feedback.test.mjs`
  - Validation, path safety, atomic drafts, immutable batches, sequence allocation, projection determinism, stale hash handling, and resolution records.
- `test/review.test.mjs`
  - Loopback binding, auth, host/origin checks, CSRF, route allowlist, source/hash binding, publish behavior, size limits, and clean shutdown.
- `test/workflow.test.mjs`
  - Feedback-aware planner handoff and no workflow transition from comment publication.
- `test/opencode.test.mjs`
  - Prompt contracts for feedback ingestion, explicit command trigger, and browser review without Playwright.
- `test/installer.test.mjs`
  - New runtime modules install, update, check, and uninstall safely.

## Delivery Phases

### Phase 1: Durable Anchors And Feedback Core

- Add deterministic semantic anchors to plan and roadmap HTML.
- Define plain-text projection and text-selection anchor schema.
- Implement draft and immutable batch storage.
- Generate deterministic reviewable `FB-NNN.md`.
- Add validation, path safety, sequence, and hash-binding tests.

Exit evidence:

- Existing HTML remains deterministic for identical input.
- Every supported review unit has a unique stable anchor.
- Publishing creates immutable private JSON and a complete reviewable Markdown batch bound to exact hashes.

### Phase 2: Local Review Server And UI

- Implement authenticated loopback server.
- Serve byte-exact generated artifacts in a same-origin iframe.
- Add element targeting, text selection, sidebar, drafts, editor, preview, and publish flow.
- Add responsive and accessibility behavior.
- Add browser opening, URL fallback, status, stop, and idle timeout.

Exit evidence:

- A plan opens in the default browser without modifying generated HTML.
- Comments survive browser/server restart.
- Old-tab publication is rejected after artifact drift.
- Security and lifecycle tests pass.

### Phase 3: Planner Feedback Loop

- Add `--feedback FB-NNN` Plan behavior.
- Validate exact or archived source bindings.
- Generate `FB-NNN-RESOLUTION.md` with per-comment dispositions.
- Re-render and reopen reviewed artifacts after revision.
- Report pending clarification and unresolved feedback in Status.

Exit evidence:

- The planner consumes only the requested immutable batch.
- Every comment receives a disposition with evidence and resulting anchors.
- Original feedback remains unchanged.
- New plan HTML opens automatically for another human review round.

## Verification Matrix

### Functional

- Open current plan and switch to roadmap.
- Comment on a semantic card, code block, table row, and selected text.
- Edit/cancel drafts and locate comments from the sidebar.
- Publish multiple comments as one batch.
- Copy the explicit planner command.
- Resolve the batch and reopen the regenerated plan.

### Drift And Recovery

- Reject submission from a stale browser tab.
- Mark ambiguous re-anchors stale.
- Recover a missing Markdown projection from private JSON.
- Reuse a healthy server and replace stale session metadata.
- Preserve drafts after browser and server restart.

### Security

- Reject non-loopback Host and cross-origin mutations.
- Reject missing/invalid capability and CSRF headers.
- Reject traversal, symlink escape, arbitrary artifact paths, oversized bodies, raw HTML, and malformed anchors.
- Confirm no token or comment body appears in logs.
- Confirm browser feedback cannot invoke shell, Git, OpenCode, or workflow transitions.

### Compatibility

- Linux default-browser launch and URL fallback.
- macOS and Windows launcher command construction.
- Headless/SSH operation with `--no-open`.
- Desktop, tablet, and mobile layout.
- Keyboard-only annotation and screen-reader labels.

## Acceptance Criteria

- Plan automatically starts a local review session and attempts to open the default browser.
- Browser-launch failure does not fail Plan and always returns a usable URL.
- All Phasecraft-generated HTML with valid source-binding metadata can be reviewed through one generic shell.
- Generated HTML stays deterministic and contains no comment/session state.
- Element and text-selection comments persist outside browser storage.
- Published batches are immutable, exact-hash-bound, private in full detail, and completely projected to reviewable Markdown.
- The browser never starts an AI agent automatically.
- The published UI copies an explicit feedback-bound Plan command.
- Planner resolutions preserve original comments and verify technical claims independently.
- Stale or ambiguous anchors are visible and never silently moved.
- Review server is loopback-only, capability-protected, path-contained, and dependency-free.
- All syntax, unit, workflow, renderer, installer, and security tests pass.

## Open Implementation Questions

- Whether the reviewable Markdown batch may include reviewer-provided names in v1 or remain anonymous/local-human by default.
- Whether feedback on an archived plan may request revision directly or must first be re-anchored to the current plan.
- Whether the default two-hour idle timeout should be configurable in `.phasecraft/config.json` in v1.
- Whether `roadmap.html` or `plan.html` should be the initial page when Plan changes only roadmap ownership.

## Implementation Notes

- v1 remains anonymous/local-human; no reviewer identity is stored.
- Feedback on archived plans is accepted as exact-bound context, but Plan applies changes only to the current authoritative plan and records the old/result hashes in the resolution.
- The two-hour idle timeout remains a runtime default rather than project configuration.
- Plan opens the active plan by default; the artifact switcher exposes roadmap and valid archived plans.
- Authenticated review mode blocks all scripts in the byte-exact artifact iframe. This keeps remote Mermaid code outside the trusted loopback origin, so Mermaid remains readable source rather than rendered SVG during review.
