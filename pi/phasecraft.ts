import path from "node:path";

const ROLE_MARKER = /<phasecraft-role name="(phasecraft-[a-z-]+)">/u;
const ROLES = new Set([
  "phasecraft-manager",
  "phasecraft-researcher",
  "phasecraft-planner",
  "phasecraft-plan-auditor",
  "phasecraft-executor",
  "phasecraft-verifier",
  "phasecraft-shipper",
]);
const DANGEROUS_GIT_SUBCOMMANDS = new Set(["commit", "push", "reset", "checkout", "switch", "clean"]);
const NETWORK_TOOL = /^(?:web(?:_search|_fetch)?|websearch|webfetch|fetch|http(?:_fetch)?|browser|exa_search)$/iu;

function writePath(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof input[key] === "string" && input[key] !== "") return input[key];
  }
  return null;
}

function isInsideWorkflowRoot(cwd, filePath) {
  const root = path.resolve(cwd, ".phasecraft");
  const candidate = path.resolve(cwd, filePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isPhasecraftRuntime(command) {
  return !/[;&|`<>\n]|\$\(/u.test(command)
    && /^\s*node\s+(?:["'])?\.pi\/phasecraft\/runtime\/phasecraft\.mjs(?:["'])?(?:\s|$)/u.test(command);
}

function hasDangerousGit(command) {
  for (const segment of command.split(/[;&|\n]+/u)) {
    const tokens = segment.trim().split(/\s+/u).map((token) => token.replace(/^["']|["']$/gu, ""));
    const gitIndex = tokens.findIndex((token) => path.basename(token) === "git");
    if (gitIndex !== -1 && tokens.slice(gitIndex + 1).some((token) => DANGEROUS_GIT_SUBCOMMANDS.has(token))) {
      return true;
    }
  }
  return false;
}

export default function phasecraftPiExtension(pi) {
  let activeRole = null;

  pi.on("before_agent_start", async (event) => {
    const match = typeof event?.prompt === "string" ? event.prompt.match(ROLE_MARKER) : null;
    activeRole = match && ROLES.has(match[1]) ? match[1] : null;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!activeRole) return undefined;
    const toolName = String(event?.toolName ?? "");
    const input = event?.input && typeof event.input === "object" ? event.input : {};

    if (toolName === "bash") {
      const command = typeof input.command === "string" ? input.command : "";
      if (hasDangerousGit(command)) {
        return { block: true, reason: "Phasecraft forbids direct history-changing Git commands." };
      }
      if (activeRole === "phasecraft-shipper" && !isPhasecraftRuntime(command)) {
        return { block: true, reason: "The Phasecraft shipper may invoke only the bundled deterministic runtime." };
      }
      if (ctx?.ui?.confirm) {
        const allowed = await ctx.ui.confirm("Phasecraft shell command", command || "Allow this shell command?");
        if (!allowed) return { block: true, reason: "Shell command declined by the user." };
      }
    }

    if (["write", "edit", "apply_patch"].includes(toolName) && activeRole !== "phasecraft-executor") {
      const filePath = writePath(input);
      if (!filePath || !isInsideWorkflowRoot(ctx?.cwd ?? process.cwd(), filePath)) {
        return { block: true, reason: "This Phasecraft role may write only under .phasecraft/." };
      }
    }

    if (NETWORK_TOOL.test(toolName)) {
      if (activeRole !== "phasecraft-researcher") {
        return { block: true, reason: "Network tools are disabled for this Phasecraft role." };
      }
      if (ctx?.ui?.confirm) {
        const allowed = await ctx.ui.confirm(
          "Phasecraft external research",
          "Confirm that this exact research question was approved before continuing.",
        );
        if (!allowed) return { block: true, reason: "External research was not approved." };
      }
    }
    return undefined;
  });
}
