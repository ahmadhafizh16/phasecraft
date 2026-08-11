import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORK_STATES } from "./state.mjs";

export const HANDOFF_AGENT_STAGES = Object.freeze({
  "phasecraft-manager": ["init", "new-work", "status"],
  "phasecraft-researcher": ["discuss"],
  "phasecraft-planner": ["plan"],
  "phasecraft-plan-auditor": ["verify-plan"],
  "phasecraft-executor": ["execute"],
  "phasecraft-verifier": ["verify"],
  "phasecraft-shipper": ["ship"],
});

export const HANDOFF_AGENTS = Object.freeze(Object.keys(HANDOFF_AGENT_STAGES));

const OUTCOMES = new Set(["completed", "blocked", "failed", "no-change"]);
const LIST_FIELDS = Object.freeze([
  ["authoritativeInputsRead", "Authoritative Inputs Read"],
  ["evidenceAndDecisionsUsed", "Evidence And Decisions Used"],
  ["artifactsChanged", "Artifacts Changed"],
  ["validationPerformed", "Validation Performed"],
  ["openQuestionsOrBlockers", "Open Questions Or Blockers"],
]);

function handoffError(message, code, details = {}) {
  const value = new Error(message);
  value.code = code;
  Object.assign(value, details);
  return value;
}

function requireLine(value, field) {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\u0000]/u.test(value)) {
    throw handoffError(`${field} must be a non-empty single line`, "HANDOFF_DATA_INVALID", { field });
  }
  return value.trim();
}

function requireList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw handoffError(`${field} must be a non-empty array`, "HANDOFF_DATA_INVALID", { field });
  }
  return value.map((item) => requireLine(item, field));
}

export function validateHandoffData(agent, data) {
  if (!HANDOFF_AGENTS.includes(agent)) {
    throw handoffError(`Unknown Phasecraft handoff agent: ${agent}`, "HANDOFF_AGENT_INVALID", { agent });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw handoffError("Handoff data must be a JSON object", "HANDOFF_DATA_INVALID");
  }
  const stage = requireLine(data.stage, "stage");
  if (!HANDOFF_AGENT_STAGES[agent].includes(stage)) {
    throw handoffError(`${agent} cannot record stage ${stage}`, "HANDOFF_STAGE_INVALID", { agent, stage });
  }
  const stateStatus = requireLine(data.stateStatus, "stateStatus");
  if (!WORK_STATES.includes(stateStatus)) {
    throw handoffError(`Unknown handoff state status: ${stateStatus}`, "HANDOFF_STATE_INVALID", { stateStatus });
  }
  if (!Number.isInteger(data.stateRevision) || data.stateRevision < 0) {
    throw handoffError("stateRevision must be a non-negative integer", "HANDOFF_DATA_INVALID", { field: "stateRevision" });
  }
  const outcome = requireLine(data.outcome, "outcome");
  if (!OUTCOMES.has(outcome)) {
    throw handoffError(`Unknown handoff outcome: ${outcome}`, "HANDOFF_OUTCOME_INVALID", { outcome });
  }
  const normalized = {
    stage,
    stateStatus,
    stateRevision: data.stateRevision,
    outcome,
    objectiveHandled: requireLine(data.objectiveHandled, "objectiveHandled"),
    exactNextAction: requireLine(data.exactNextAction, "exactNextAction"),
  };
  for (const [field] of LIST_FIELDS) normalized[field] = requireList(data[field], field);
  return normalized;
}

function renderList(values) {
  return values.map((value) => `- ${value}`).join("\n");
}

function renderHandoff(agent, sequence, supersedes, data) {
  const id = `H-${String(sequence).padStart(3, "0")}`;
  const detailSections = LIST_FIELDS.map(([field, title]) => `## ${title}\n${renderList(data[field])}`).join("\n\n");
  return `# Handoff ${id}: ${agent}

## Invocation
- Stage: ${data.stage}
- State read: ${data.stateStatus} revision ${data.stateRevision}
- Outcome: ${data.outcome}
- Supersedes: ${supersedes}

## Objective Handled
- ${data.objectiveHandled}

${detailSections}

## Exact Next Action
- ${data.exactNextAction}
`;
}

async function handoffFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((cause) => {
    if (cause?.code === "ENOENT") return [];
    throw cause;
  });
  return entries
    .flatMap((entry) => {
      const match = entry.isFile() ? entry.name.match(/^H-(\d{3,})\.md$/u) : null;
      return match ? [{ name: entry.name, sequence: Number.parseInt(match[1], 10) }] : [];
    })
    .sort((left, right) => left.sequence - right.sequence);
}

export async function writeHandoff(artifactRoot, agent, input) {
  const data = validateHandoffData(agent, input);
  const root = path.resolve(artifactRoot);
  const directory = path.join(root, "handoffs", agent);
  await mkdir(directory, { recursive: true });
  const files = await handoffFiles(directory);
  const prior = files.at(-1) ?? null;
  const sequence = (prior?.sequence ?? 0) + 1;
  const filename = `H-${String(sequence).padStart(3, "0")}.md`;
  const relativePath = path.posix.join("handoffs", agent, filename);
  const supersedes = prior ? path.posix.join("handoffs", agent, prior.name) : "none";
  const source = renderHandoff(agent, sequence, supersedes, data);
  const filePath = path.join(directory, filename);
  await writeFile(filePath, source, { encoding: "utf8", flag: "wx", mode: 0o444 });
  await chmod(filePath, 0o444);
  return {
    agent,
    sequence,
    path: relativePath,
    supersedes,
    outcome: data.outcome,
    sourceHash: createHash("sha256").update(source).digest("hex"),
  };
}

function parseSummary(source, relativePath, sequence) {
  const field = (name) => source.match(new RegExp(`^- ${name}: (.+)$`, "mu"))?.[1] ?? null;
  return {
    sequence,
    path: relativePath,
    stage: field("Stage"),
    stateRead: field("State read"),
    outcome: field("Outcome"),
    supersedes: field("Supersedes"),
    sourceHash: createHash("sha256").update(source).digest("hex"),
  };
}

export async function listHandoffs(artifactRoot, options = {}) {
  const root = path.resolve(artifactRoot);
  const agents = [];
  let total = 0;
  for (const agent of HANDOFF_AGENTS) {
    const directory = path.join(root, "handoffs", agent);
    const files = await handoffFiles(directory);
    const summaries = await Promise.all(files.map(async (file) => {
      const relativePath = path.posix.join("handoffs", agent, file.name);
      return parseSummary(await readFile(path.join(directory, file.name), "utf8"), relativePath, file.sequence);
    }));
    total += summaries.length;
    agents.push({
      agent,
      count: summaries.length,
      latest: summaries.at(-1) ?? null,
      ...(options.includeAll ? { handoffs: summaries } : {}),
    });
  }
  return {
    total,
    agents,
    missingAgents: agents.filter(({ count }) => count === 0).map(({ agent }) => agent),
  };
}
