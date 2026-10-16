import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SCHEMA_VERSION = 1;

export const WORK_STATES = Object.freeze([
  "initialized",
  "researching",
  "discussed",
  "roadmap_ready",
  "plan_draft",
  "plan_verified",
  "executing",
  "execution_complete",
  "verifying",
  "verified",
  "verified_pending",
  "verification_failed",
  "shipped",
]);

export const TRANSITIONS = Object.freeze({
  initialized: ["researching"],
  researching: ["discussed"],
  discussed: ["roadmap_ready", "researching"],
  roadmap_ready: ["plan_draft", "researching"],
  plan_draft: ["plan_verified", "discussed"],
  plan_verified: ["executing", "plan_draft"],
  executing: ["execution_complete", "plan_draft"],
  execution_complete: ["verifying", "executing", "plan_draft"],
  verifying: ["verified", "verified_pending", "verification_failed", "plan_draft"],
  verified: ["shipped", "roadmap_ready", "plan_draft"],
  verified_pending: ["verified", "shipped", "verification_failed", "roadmap_ready", "plan_draft"],
  verification_failed: ["executing", "plan_draft"],
  shipped: [],
});

const STAGE_STATES = Object.freeze({
  init: ["initialized"],
  discuss: ["initialized", "researching", "discussed"],
  plan: ["discussed", "roadmap_ready", "plan_draft", "verified", "verified_pending", "verification_failed"],
  "verify-plan": ["plan_draft"],
  execute: ["plan_verified", "executing", "verification_failed"],
  verify: ["execution_complete", "verifying"],
  ship: ["verified", "verified_pending"],
  status: WORK_STATES,
});

function error(message, code, details = {}) {
  const value = new Error(message);
  value.code = code;
  Object.assign(value, details);
  return value;
}

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (cause) {
    throw error(`Cannot read JSON file: ${filePath}`, "JSON_READ_FAILED", { cause });
  }

  try {
    return JSON.parse(source);
  } catch (cause) {
    throw error(`Invalid JSON in ${filePath}`, "JSON_INVALID", { cause });
  }
}

export async function writeJsonAtomic(filePath, value, options = {}) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const serialized = `${JSON.stringify(value, null, 2)}\n`;

  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error(`Atomic write failed for ${filePath}`, "ATOMIC_WRITE_FAILED", { cause });
  }
}

export function phasecraftPaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const phasecraftRoot = path.join(root, ".phasecraft");
  const localRoot = path.join(phasecraftRoot, ".local");
  return {
    projectRoot: root,
    phasecraftRoot,
    config: path.join(phasecraftRoot, "config.json"),
    generalKnowledge: path.join(phasecraftRoot, "general_knowledge"),
    artifactWork: path.join(phasecraftRoot, "work"),
    localRoot,
    registry: path.join(localRoot, "registry.json"),
    localWork: path.join(localRoot, "work"),
    locks: path.join(localRoot, "locks"),
  };
}

export async function discoverProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  const startInfo = await stat(current).catch(() => null);
  if (startInfo?.isFile()) current = path.dirname(current);

  while (true) {
    const paths = phasecraftPaths(current);
    if (await pathExists(paths.config)) return current;
    if (await pathExists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw error(`No Phasecraft or Git project found from ${start}`, "PROJECT_NOT_FOUND");
}

function safeSegment(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw error(`Missing value for template placeholder {${name}}`, "TEMPLATE_VALUE_MISSING", { name });
  }
  const segment = value.trim();
  if (
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    /[\u0000-\u001f]/u.test(segment) ||
    !/^[A-Za-z0-9._-]+$/u.test(segment)
  ) {
    throw error(`Unsafe path value for {${name}}: ${value}`, "TEMPLATE_VALUE_UNSAFE", { name, value });
  }
  return segment;
}

export function slugify(value) {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  if (!slug) throw error("Cannot derive a non-empty slug", "SLUG_EMPTY");
  return slug;
}

export function templatePlaceholders(template) {
  if (typeof template !== "string" || template.trim() === "") {
    throw error("Work path template is required", "TEMPLATE_REQUIRED");
  }
  const names = [];
  const seen = new Set();
  for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)\}/gu)) {
    if (!seen.has(match[1])) {
      names.push(match[1]);
      seen.add(match[1]);
    }
  }
  if (names.length === 0) {
    throw error("Work path template must contain at least one placeholder", "TEMPLATE_PLACEHOLDER_REQUIRED");
  }
  return names;
}

export function expandWorkPath(template, values) {
  const names = templatePlaceholders(template);
  let result = template;
  for (const name of names) {
    const value = safeSegment(name, values?.[name]);
    result = result.replaceAll(`{${name}}`, value);
  }
  if (/[{}]/u.test(result)) {
    throw error("Work path template contains malformed placeholders", "TEMPLATE_MALFORMED");
  }
  if (path.posix.isAbsolute(result) || result.includes("\\")) {
    throw error("Work path must be relative and use '/' separators", "WORK_PATH_UNSAFE");
  }
  const normalized = path.posix.normalize(result);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw error(`Work path escapes its root: ${result}`, "WORK_PATH_UNSAFE");
  }
  return normalized;
}

function workKey(id, artifactPath) {
  const digest = createHash("sha256").update(`${id}\0${artifactPath}`).digest("hex").slice(0, 12);
  return `${slugify(id)}-${digest}`;
}

export async function withWorkLock(projectRoot, key, operation) {
  const paths = phasecraftPaths(projectRoot);
  await mkdir(paths.locks, { recursive: true });
  const lockPath = path.join(paths.locks, `${safeSegment("work-key", key)}.lock`);
  const ownerPath = path.join(lockPath, "owner.json");
  const owner = {
    pid: process.pid,
    hostname: process.env.HOSTNAME ?? null,
    createdAt: new Date().toISOString(),
  };

  try {
    await mkdir(lockPath);
  } catch (cause) {
    if (cause?.code !== "EEXIST") throw cause;
    const existing = await readJson(ownerPath).catch(() => ({ createdAt: null, pid: null }));
    throw error(`Work item is locked by PID ${existing.pid ?? "unknown"}`, "WORK_LOCKED", {
      lockPath,
      owner: existing,
    });
  }

  try {
    await writeJsonAtomic(ownerPath, owner, { mode: 0o600 });
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function initProject(projectRoot, options) {
  const paths = phasecraftPaths(projectRoot);
  const artifactMode = options?.artifactMode;
  if (!["local", "reviewable"].includes(artifactMode)) {
    throw error("artifactMode must be 'local' or 'reviewable'", "ARTIFACT_MODE_INVALID");
  }
  templatePlaceholders(options?.workPathTemplate);

  if (await pathExists(paths.config)) {
    throw error(`Phasecraft is already initialized at ${paths.projectRoot}`, "PROJECT_ALREADY_INITIALIZED");
  }

  const now = new Date().toISOString();
  const config = {
    schemaVersion: SCHEMA_VERSION,
    artifactMode,
    workPathTemplate: options.workPathTemplate,
    sensitivePaths: [".env", ".env.*", "*.pem", "*.key", "*credentials*", "*secret*"],
    snapshotMaxBytes: 10 * 1024 * 1024,
    createdAt: now,
    updatedAt: now,
  };
  const registry = { schemaVersion: SCHEMA_VERSION, revision: 0, works: [] };

  await mkdir(paths.generalKnowledge, { recursive: true });
  await mkdir(paths.artifactWork, { recursive: true });
  await mkdir(paths.localWork, { recursive: true });
  await writeJsonAtomic(paths.config, config);
  await writeJsonAtomic(paths.registry, registry);
  return { config, paths };
}

export async function loadConfig(projectRoot) {
  const config = await readJson(phasecraftPaths(projectRoot).config);
  if (config.schemaVersion !== SCHEMA_VERSION) {
    throw error(`Unsupported config schema version: ${config.schemaVersion}`, "SCHEMA_UNSUPPORTED");
  }
  return config;
}

export async function loadRegistry(projectRoot) {
  const registry = await readJson(phasecraftPaths(projectRoot).registry);
  if (registry.schemaVersion !== SCHEMA_VERSION || !Array.isArray(registry.works)) {
    throw error("Invalid Phasecraft registry", "REGISTRY_INVALID");
  }
  return registry;
}

export function stateFileFor(projectRoot, record) {
  return path.join(phasecraftPaths(projectRoot).localWork, record.key, "state.json");
}

export async function loadWorkState(projectRoot, record) {
  const state = await readJson(stateFileFor(projectRoot, record));
  if (state.schemaVersion !== SCHEMA_VERSION || !WORK_STATES.includes(state.status)) {
    throw error(`Invalid state for work item ${record.id}`, "STATE_INVALID");
  }
  return state;
}

export async function initWork(projectRoot, options) {
  const paths = phasecraftPaths(projectRoot);
  const config = await loadConfig(projectRoot);
  if (!options?.id || !options?.title) {
    throw error("Work id and title are required", "WORK_INPUT_REQUIRED");
  }
  const values = { ...(options.values ?? {}), id: options.values?.id ?? options.id };
  if (templatePlaceholders(config.workPathTemplate).includes("slug") && !values.slug) {
    values.slug = slugify(options.title);
  }
  const artifactPath = expandWorkPath(config.workPathTemplate, values);
  const key = workKey(options.id, artifactPath);

  return withWorkLock(projectRoot, "registry", async () => {
    const registry = await loadRegistry(projectRoot);
    if (registry.works.some((work) => work.id === options.id || work.artifactPath === artifactPath)) {
      throw error(`Work item or path already exists: ${options.id}`, "WORK_ALREADY_EXISTS");
    }

    const now = new Date().toISOString();
    const record = {
      id: options.id,
      key,
      title: options.title,
      artifactPath,
      branch: options.branch ?? null,
      status: "initialized",
      createdAt: now,
      updatedAt: now,
    };
    const artifactRoot = path.join(paths.artifactWork, ...artifactPath.split("/"));
    const localWorkRoot = path.join(paths.localWork, key);
    const state = {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      id: options.id,
      key,
      title: options.title,
      artifactPath,
      artifactRoot,
      localWorkRoot,
      branch: options.branch ?? null,
      status: "initialized",
      planVersion: 0,
      activePhase: null,
      completedPhases: [],
      pendingManualChecks: [],
      adoptedBaselineFiles: [],
      cleanedBaselineFiles: [],
      externalResearchApprovals: [],
      planApprovals: {},
      executionRecords: {},
      verificationRecords: {},
      history: [{ from: null, to: "initialized", at: now, reason: "work initialized" }],
      createdAt: now,
      updatedAt: now,
    };

    await Promise.all([
      mkdir(path.join(artifactRoot, "research"), { recursive: true }),
      mkdir(path.join(artifactRoot, "plan", "phases"), { recursive: true }),
      mkdir(path.join(artifactRoot, "verification", "phases"), { recursive: true }),
      mkdir(path.join(artifactRoot, "ship"), { recursive: true }),
      mkdir(path.join(localWorkRoot, "execution", "phases"), { recursive: true }),
    ]);
    await writeJsonAtomic(path.join(localWorkRoot, "state.json"), state);
    registry.works.push(record);
    registry.revision += 1;
    await writeJsonAtomic(paths.registry, registry);
    return { record, state };
  });
}

export function assertTransition(from, to) {
  if (!WORK_STATES.includes(from) || !WORK_STATES.includes(to)) {
    throw error(`Unknown state transition ${from} -> ${to}`, "STATE_UNKNOWN");
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw error(`Illegal state transition ${from} -> ${to}`, "TRANSITION_ILLEGAL", { from, to });
  }
}

export function assertStage(state, stage) {
  const allowed = STAGE_STATES[stage];
  if (!allowed) throw error(`Unknown stage: ${stage}`, "STAGE_UNKNOWN");
  if (!allowed.includes(state.status)) {
    throw error(`Stage ${stage} cannot run from ${state.status}`, "STAGE_BLOCKED", {
      stage,
      status: state.status,
      allowed,
    });
  }
  return { stage, status: state.status, allowed: true, revision: state.revision };
}

export function resolveWorkRecord(registry, options = {}) {
  if (options.id) {
    const exact = registry.works.filter((work) => work.id === options.id || work.key === options.id);
    if (exact.length !== 1) throw error(`Unknown work item: ${options.id}`, "WORK_NOT_FOUND");
    return exact[0];
  }
  if (options.branch) {
    const branch = registry.works.filter((work) => work.branch === options.branch && work.status !== "shipped");
    if (branch.length === 1) return branch[0];
    if (branch.length > 1) throw error(`Multiple work items use branch ${options.branch}`, "WORK_AMBIGUOUS");
  }
  const openWorks = registry.works.filter((work) => work.status !== "shipped");
  if (openWorks.length === 1) return openWorks[0];
  if (openWorks.length === 0) throw error("No open Phasecraft work items", "WORK_NOT_FOUND");
  throw error("Multiple open work items; provide an explicit id", "WORK_AMBIGUOUS", {
    candidates: openWorks.map(({ id, artifactPath, status }) => ({ id, artifactPath, status })),
  });
}

export async function resolveWork(projectRoot, options = {}) {
  const registry = await loadRegistry(projectRoot);
  const record = resolveWorkRecord(registry, options);
  const state = await loadWorkState(projectRoot, record);
  return { record, state };
}

export async function transitionWork(projectRoot, record, to, options = {}) {
  return withWorkLock(projectRoot, record.key, async () => {
    const filePath = stateFileFor(projectRoot, record);
    let state = await readJson(filePath);
    if (options.expectedRevision !== undefined && state.revision !== options.expectedRevision) {
      throw error(
        `State revision changed: expected ${options.expectedRevision}, found ${state.revision}`,
        "REVISION_CONFLICT",
      );
    }
    assertTransition(state.status, to);
    if (["verified", "verified_pending"].includes(state.status) && to === "roadmap_ready" && !options.phaseAdvance) {
      throw error("Verified phases advance only through phase-start", "PHASE_ADVANCE_REQUIRED");
    }
    if (to === "plan_draft" && !state.activePhase) {
      throw error("Select an active roadmap phase before creating its plan", "ACTIVE_PHASE_REQUIRED");
    }
    const { transitionGate } = await import("./workflow.mjs");
    state = await transitionGate(projectRoot, state, to, options);
    const now = new Date().toISOString();
    const from = state.status;
    state.status = to;
    state.updatedAt = now;
    state.history.push({ from, to, at: now, reason: options.reason ?? null });
    if (to === "shipped" && state.activePhase && !state.completedPhases.some((entry) => entry.id === state.activePhase)) {
      state.completedPhases.push({ id: state.activePhase, outcome: from, completedAt: now });
    }
    if (to === "plan_draft") {
      if (state.planVersion === 0) state.planVersion = 1;
      else if (from !== "roadmap_ready" && from !== "discussed") state.planVersion += 1;
    }
    if (typeof options.update === "function") {
      const updated = await options.update(structuredClone(state));
      if (!updated || updated.id !== state.id || updated.key !== state.key || updated.status !== to) {
        throw error("Transition update changed protected state metadata", "STATE_UPDATE_INVALID");
      }
      state = updated;
    }
    state.revision += 1;
    await writeJsonAtomic(filePath, state);

    await withWorkLock(projectRoot, "registry", async () => {
      const registry = await loadRegistry(projectRoot);
      const entry = registry.works.find((work) => work.key === record.key);
      if (!entry) throw error(`Registry entry missing for ${record.id}`, "REGISTRY_ENTRY_MISSING");
      entry.status = to;
      entry.updatedAt = now;
      registry.revision += 1;
      await writeJsonAtomic(phasecraftPaths(projectRoot).registry, registry);
    });
    return state;
  });
}

export async function updateWorkState(projectRoot, record, update, options = {}) {
  if (typeof update !== "function") throw error("State update must be a function", "STATE_UPDATE_INVALID");
  return withWorkLock(projectRoot, record.key, async () => {
    const filePath = stateFileFor(projectRoot, record);
    const state = await readJson(filePath);
    if (options.expectedRevision !== undefined && state.revision !== options.expectedRevision) {
      throw error(
        `State revision changed: expected ${options.expectedRevision}, found ${state.revision}`,
        "REVISION_CONFLICT",
      );
    }
    const changed = await update(structuredClone(state));
    if (!changed || changed.id !== state.id || changed.key !== state.key || changed.status !== state.status) {
      throw error("State metadata and status cannot be changed by a non-transition update", "STATE_UPDATE_INVALID");
    }
    changed.revision = state.revision + 1;
    changed.updatedAt = new Date().toISOString();
    await writeJsonAtomic(filePath, changed);
    return changed;
  });
}
