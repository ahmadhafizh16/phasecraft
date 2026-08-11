---
description: Initialize Phasecraft project configuration and create the first work item.
agent: phasecraft-manager
---

Load the `phasecraft` skill and perform only the Init stage. Treat `$ARGUMENTS` as optional work context, never as a confirmed identifier or path.

Discover the Git root and inspect known authority candidates such as `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, and documentation indexes. If Phasecraft is not configured, ask the user to choose `local` or `reviewable` artifacts and configure a feature/task path template. For the first work item, collect every template value, show the exact resulting path under `.phasecraft/work/`, and require confirmation before running `init-work`. If Phasecraft is already configured, stop and direct the user to `/phasecraft-new-work` instead of rerunning project initialization.

Run `knowledge-candidates`, ask which project sources are authoritative, then persist the confirmed ordered selection with `knowledge-set`. Record their paths, SHA-256 hashes, authority decisions, and evidence in `.phasecraft/general_knowledge/`. Capture the first work item's Git baseline. Do not infer Jira or any other tracker convention. Finish in `initialized`, report the exact next command, and state that later work items use `/phasecraft-new-work`.

After the first work resolves, run `handoff-list --all` and read any existing context. Before returning, invoke `handoff-write --agent phasecraft-manager`, including when initialization is blocked or no change is made; never allocate `H-NNN.md` manually.
