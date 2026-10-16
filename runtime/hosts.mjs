import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_HOSTS = Object.freeze(["opencode", "claude", "codex", "pi"]);

export function workflowHost(host, runtimeUrl = import.meta.url) {
  const segments = [...path.resolve(process.argv[1] ?? ".").split(path.sep), ...fileURLToPath(runtimeUrl).split(path.sep)];
  const selected = host ?? SUPPORTED_HOSTS.find((name) => segments.includes(`.${name}`)) ?? "opencode";
  if (!SUPPORTED_HOSTS.includes(selected)) {
    const error = new Error(`Unsupported workflow host: ${selected}`);
    error.code = "HOST_INVALID";
    throw error;
  }
  return selected;
}

function argument(value) {
  const text = String(value);
  return /^[A-Za-z0-9._-]+$/u.test(text) ? text : JSON.stringify(text);
}

export function stageInvocation(host, stage, work, feedback = null) {
  const prefix = workflowHost(host) === "codex" ? "$" : "/";
  return `${prefix}phasecraft-${stage} --work ${argument(work)}${feedback ? ` --feedback ${argument(feedback)}` : ""}`;
}
