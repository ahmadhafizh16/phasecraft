---
description: Build the ticket roadmap and the next just-in-time Phasecraft plan.
agent: phasecraft-planner
---

Load the `phasecraft` skill and perform only the Plan stage for `$ARGUMENTS`. Run the `plan` preflight. Read confirmed decisions, evidence, current repository content, and source hashes; stop on stale authority or execution-critical unknowns.

Run `knowledge-check` and stop on stale authorities. Create or update `plan/ROADMAP.md` for all phases. From `verified` or `verified_pending`, select the next executable roadmap phase with `phase-start`; from `verification_failed` or `plan_draft`, revise the active phase instead. Write detailed restricted-schema `PLAN.md` only under the active `plan/phases/P-NN-<slug>/`. Every technical change must name file, symbol, evidence-backed before state, clearly labeled PROPOSED after state, and reason. Every task must include requirements, evidence, dependencies, files, change, at least two verification observations separated by semicolons, and a commit group. Include risk impact, mitigation, possible solution, negative checks, boundary checks, and human-only checks.

Validate Markdown, then render each artifact with its own runtime view; never hand-author or copy HTML between artifacts. `roadmap.html` must read as a strategic map: emphasize phase sequence, declared dependencies, statuses, requirement ownership, exit evidence, risks, and unresolved unknowns. `plan.html` must read as an execution cockpit: emphasize verified-before versus proposed-after deltas, requirement-to-task/check coverage, dependency-aware task order, affected files, risk controls, manual checks, and commit groups. Keep structured Markdown fields concise and specific enough to label these views. The renderer adds a native dependency diagram only when multiple phases/tasks or declared dependencies make a diagram useful; do not add decorative diagrams with no relationship to the evidence.

Inspect both generated views for readable labels and complete mappings, then transition through `roadmap_ready` to `plan_draft`. If revising an approved plan, archive the prior Markdown and HTML under `versions/vN/` with hashes and a supersession reason first. Stop before plan verification.
