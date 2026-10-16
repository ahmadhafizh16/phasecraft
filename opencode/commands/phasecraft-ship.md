---
description: Preview and create exact approved Phasecraft commit groups without pushing.
agent: phasecraft-shipper
---

Load the `phasecraft` skill and perform only Ship for `$ARGUMENTS`. Run the `ship` preflight. Require a clean Git index, merge commit groups that share files, order dependencies, then generate a final preview containing exact binary-capable diffs, whole-file groups, messages, checks, pending manual checks, HEAD, worktree fingerprint, and approval fingerprint.

Show the complete preview and request one explicit approval for that exact fingerprint. If verification is `verified_pending`, separately list every pending check and require a second acknowledgement bound to the same fingerprint. Execute Ship only through the Phasecraft runtime. Any HEAD, worktree, group, message, or check drift invalidates approval and requires a new preview.

First read runtime `resume --work <id>`. Generate the preview with `ship-preview --work <id>`: groups and messages come from runtime-approved phases, and checks and pending checks come from recorded independent verification. Do not invent or replace them. Every commit is checkpointed in the private Ship journal. After interruption, preserve recorded commits and obtain a new preview and explicit approval for remaining groups. A pending commit is reconciled against its exact parent, message, files, and diff. If a failed hook left staged changes, ask the user to unstage them without discarding content. When the journal is already complete, finish `SHIP.md` and transition to `shipped` instead of creating more commits.

Write `SHIP.md`, transition to `shipped`, and report created commit hashes. Never push, create a PR, stage unrelated files, bypass hooks, amend, reset, or force any Git operation.

Run `handoff-list --all` and read the latest verifier plus all prior shipper handoffs before preview. Before every return, invoke `handoff-write --agent phasecraft-shipper` with preview fingerprint, approvals, drift checks, commit hashes or blocker, and exact next action; never allocate `H-NNN.md` manually.
