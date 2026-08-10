---
description: Preview and create exact approved Phasecraft commit groups without pushing.
agent: phasecraft-shipper
---

Load the `phasecraft` skill and perform only Ship for `$ARGUMENTS`. Run the `ship` preflight. Require a clean Git index, merge commit groups that share files, order dependencies, then generate a final preview containing exact binary-capable diffs, whole-file groups, messages, checks, pending manual checks, HEAD, worktree fingerprint, and approval fingerprint.

Show the complete preview and request one explicit approval for that exact fingerprint. If verification is `verified_pending`, separately list every pending check and require a second acknowledgement bound to the same fingerprint. Execute Ship only through the Phasecraft runtime. Any HEAD, worktree, group, message, or check drift invalidates approval and requires a new preview.

Write `SHIP.md`, transition to `shipped`, and report created commit hashes. Never push, create a PR, stage unrelated files, bypass hooks, amend, reset, or force any Git operation.
