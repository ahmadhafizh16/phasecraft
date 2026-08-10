---
description: Execute every task in one approved Phasecraft phase without committing.
agent: phasecraft-executor
---

Load the `phasecraft` skill and perform only Execute for `$ARGUMENTS`. Run the `execute` preflight and verify the approved plan hash before changing source. Transition to `executing`, then execute the entire approved phase task by task in dependency order.

Before touching a baseline-dirty file, stop. The user must either restore it to HEAD and record that with `baseline-clean` before execution, or explicitly adopt it into the work item. Stay inside approved files and scope. Record commands, changed files, observations, and verification evidence in local execution logs. After every completed task, create a cumulative mode-0600 patch snapshot for approved non-sensitive files. A material architecture, dependency, API, schema, scope, or file-list deviation must stop execution, archive the plan, and return to `plan_draft`; do not improvise. Minor evidence-backed implementation details are logged.

Do not commit, push, create a PR, reset, checkout, or rewrite unrelated changes. Run the planned checks and transition to `execution_complete` only when all tasks finish. Stop before independent verification.
