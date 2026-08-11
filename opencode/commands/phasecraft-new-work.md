---
description: Create a new Phasecraft work item in an already initialized project.
agent: phasecraft-manager
---

Load the `phasecraft` skill and perform only New Work creation. Treat `$ARGUMENTS` as optional hints for the work id, title, and short objective; never treat them as confirmed values.

Require an existing `.phasecraft/config.json`. If the project is not initialized, stop and direct the user to `/phasecraft-init`. Run `knowledge-check`; if confirmed project authorities are stale or missing, stop and explain that project knowledge must be refreshed, but do not rerun project initialization.

Read the configured work-path template and ask only for the new work id, title, any remaining template placeholders, and optional branch association. Derive suggestions from `$ARGUMENTS` and the current branch without imposing Jira or another tracker convention. Show the exact final path under `.phasecraft/work/` and require confirmation.

After confirmation, run runtime `init-work` with the confirmed id, title, template values, and branch. This command captures a fresh Git baseline automatically. Do not change artifact mode, path template, authorities, existing work items, or application source. Finish in `initialized`, report the created work id/path, and suggest `/phasecraft-discuss --work <id> <initial context>`.

After the new work resolves, run `handoff-list --all` and invoke `handoff-write --agent phasecraft-manager` before returning. If creation stops after an existing work item resolves, record the blocked/no-change outcome there. Never allocate `H-NNN.md` manually.
