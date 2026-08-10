---
description: Build the ticket roadmap and the next just-in-time Phasecraft plan.
agent: phasecraft-planner
---

Load the `phasecraft` skill and perform only the Plan stage for `$ARGUMENTS`. Run the `plan` preflight. Read confirmed decisions, evidence, current repository content, and source hashes; stop on stale authority or execution-critical unknowns.

Run `knowledge-check` and stop on stale authorities. Create or update `plan/ROADMAP.md` for all phases. From `verified` or `verified_pending`, select the next executable roadmap phase with `phase-start`; from `verification_failed` or `plan_draft`, revise the active phase instead. Write detailed restricted-schema `PLAN.md` only under the active `plan/phases/P-NN-<slug>/`. Every technical change must name file, symbol, evidence-backed before state, clearly labeled PROPOSED after state, and reason. Every task must include requirements, evidence, dependencies, files, change, at least two verification observations separated by semicolons, and a commit group. Include risk impact, mitigation, possible solution, negative checks, boundary checks, and human-only checks.

Validate Markdown, render deterministic HTML, and transition through `roadmap_ready` to `plan_draft`. If revising an approved plan, archive the prior Markdown and HTML under `versions/vN/` with hashes and a supersession reason first. Stop before plan verification.
