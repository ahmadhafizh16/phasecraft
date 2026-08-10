export const evidenceRegistry = {
  schemaVersion: 1,
  entries: [
    {
      id: "E-001",
      type: "evidence",
      claim: "Current implementation is in src/session.mjs.",
      source: { kind: "repository", locator: "src/session.mjs", hash: "a".repeat(64) },
      status: "verified",
    },
    {
      id: "D-001",
      type: "decision",
      claim: "Timeouts remain configurable.",
      source: { kind: "user", locator: "discussion" },
      status: "confirmed",
    },
    {
      id: "P-001",
      type: "proposal",
      claim: "Add bounded timeout validation.",
      source: { kind: "planning", locator: "CH-001" },
      status: "proposed",
    },
    {
      id: "R-001",
      type: "risk",
      claim: "A timeout regression could terminate active sessions.",
      source: { kind: "analysis", locator: "risk review" },
      status: "accepted",
    },
  ],
};

export const validPlan = `# Phase 01: Session timeout

## Goal
Make timeout handling bounded and observable. D-001

## Inputs
- E-001: Current implementation
- D-001: Confirmed behavior

## Requirements
- REQ-001: Reject timeout values outside the supported range.

## Technical Design
### CH-001: Validate timeout configuration
- File: src/session.mjs
- Symbol: createSession
- Before: E-001 accepts any numeric timeout.
- Proposed after: PROPOSED P-001 validates the configured bounds.
- Reason: Prevent invalid lifecycle behavior while preserving D-001.

## Tasks
### T-001: Add bounded validation
- Requirements: REQ-001
- Evidence: E-001, D-001, P-001
- Depends on: none
- Files: src/session.mjs, test/session.test.mjs
- Change: Implement CH-001 and focused tests.
- Verification: Reject a value below the minimum; accept both supported boundaries
- Commit group: C-001

## Risk Controls
### R-001: Active session regression
- Impact: Existing sessions could terminate unexpectedly.
- Mitigation: Preserve defaults and test both supported boundaries.
- Possible solution: P-001 adds validation only at configuration input.
- Evidence: E-001, R-001

## Commit Groups
### C-001: Session timeout validation
- Files: src/session.mjs, test/session.test.mjs
- Message: fix: validate session timeout
- Depends on: none

## Manual Checks
None.
`;

export const validRoadmap = `# Session reliability roadmap

## Objective
Improve session reliability without changing defaults. D-001

## Requirements
- REQ-001: Reject timeout values outside the supported range.

## Phases
### P-01: Timeout validation
- Goal: Implement REQ-001.
- Requirements: REQ-001
- Depends on: none
- Exit evidence: Automated boundary and rejection checks.
- Status: next

## Risks
### R-001: Active session regression
- Impact: Existing sessions could terminate unexpectedly.
- Mitigation: Preserve defaults and test boundaries.
- Possible solution: P-001 validates configuration input.
- Evidence: E-001, R-001

## Unknowns
None.
`;
