# Phasecraft Host Compatibility

Phasecraft keeps one deterministic Node.js runtime and one canonical set of workflow prompts. The installer projects those prompts into each supported coding agent without duplicating their source in the repository.

## Installation

```bash
npx @ahmadhm/phasecraft@latest install --host opencode --target /path/to/project
npx @ahmadhm/phasecraft@latest install --host claude --target /path/to/project
npx @ahmadhm/phasecraft@latest install --host codex --target /path/to/project
npx @ahmadhm/phasecraft@latest install --host pi --target /path/to/project
```

Use `--host all` to install every adapter. Installation is project-local. Each host has its own manifest and can be checked or removed independently:

```bash
npx @ahmadhm/phasecraft@latest check --host codex --target /path/to/project
npx @ahmadhm/phasecraft@latest uninstall --host codex --target /path/to/project
```

## Host Matrix

| Host | Invocation | Installed workflow surface | Runtime |
| --- | --- | --- | --- |
| OpenCode | `/phasecraft-init` | `.opencode/commands`, `.opencode/agents`, `.opencode/skills` | `.opencode/phasecraft/runtime` |
| Claude Code | `/phasecraft-init` | `.claude/commands`, `.claude/agents`, `.claude/skills` | `.claude/phasecraft/runtime` |
| Codex | `$phasecraft-init` | `.codex/skills`, `.codex/agents/*.toml` | `.codex/phasecraft/runtime` |
| Pi | `/phasecraft-init` | `.pi/prompts`, `.pi/skills`, `.pi/extensions/phasecraft.ts` | `.pi/phasecraft/runtime` |

The complete stage set is `phasecraft-init`, `phasecraft-new-work`, `phasecraft-discuss`, `phasecraft-plan`, `phasecraft-verify-plan`, `phasecraft-execute`, `phasecraft-verify`, `phasecraft-ship`, and `phasecraft-status`.

All four adapters use the v0.5 runtime approval, task-checkpoint, verification, readiness, and Ship-journal contracts. Plan generates interactive HTML review on every host. The review session records its agent host and returns the corresponding planner invocation when feedback is published; agents read the durable response through `feedback-show`. `doctor`, `resume`, and `feedback-list --pending` expose pending response IDs and host-correct commands. See [the v0.5 guide](V0.5.md).

## Safety Parity

The deterministic runtime applies the same state, evidence, artifact, review, Git preview, drift, and local-commit controls on every host. Host-level tool permissions differ:

| Host | Enforcement notes |
| --- | --- |
| OpenCode | Native path- and command-level permissions provide the reference behavior. |
| Claude Code | Agent tool lists and mandatory role policies are installed. Claude Code cannot express every OpenCode path-specific Bash/edit rule. |
| Codex | Skills inline their role and may dispatch to installed named agents. Workspace sandboxing and role policies apply, but path-specific parity is not exact. |
| Pi | A project extension tracks the active Phasecraft role, blocks direct history-changing Git commands, restricts non-executor writes to `.phasecraft`, gates network tools, and confines Shipper shell use to the runtime. |

Claude Code and Codex users should keep host approval prompts enabled. Do not grant unattended broad shell or filesystem access to Phasecraft roles.

## Agent Isolation

OpenCode uses the existing stage agents and Claude Code can fork commands into named agents. Codex uses named agents when available and otherwise follows an inline role. Pi currently runs Phasecraft roles in the active session; its Verify Plan and Verify roles are independent instructions but not isolated subagent contexts.

## Development Links

`--link` symlinks static runtime and adapter source files. Generated Claude, Codex, and Pi prompt projections remain ordinary hashed files because they are derived from multiple canonical inputs. Re-run installation after editing canonical prompts.
