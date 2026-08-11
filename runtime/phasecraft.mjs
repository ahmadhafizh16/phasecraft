#!/usr/bin/env node

import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertStage,
  discoverProjectRoot,
  initProject,
  initWork,
  loadConfig,
  loadRegistry,
  readJson,
  resolveWork,
  transitionWork,
  updateWorkState,
  withWorkLock,
  writeJsonAtomic,
} from "./state.mjs";
import {
  captureBaseline,
  configureArtifactExcludes,
  createPatchSnapshot,
  createShipPreview,
  executeShip,
  findGitRoot,
  getStatus,
} from "./git.mjs";

function parseArguments(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const separator = value.indexOf("=");
    if (separator !== -1) {
      flags[value.slice(2, separator)] = value.slice(separator + 1);
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function required(flags, name) {
  if (typeof flags[name] !== "string" || flags[name] === "") {
    const error = new Error(`Missing required option --${name}`);
    error.code = "OPTION_REQUIRED";
    throw error;
  }
  return flags[name];
}

function parseJsonOption(flags, name, fallback = undefined) {
  if (flags[name] === undefined) return fallback;
  try {
    return JSON.parse(flags[name]);
  } catch (cause) {
    const error = new Error(`--${name} must contain valid JSON`);
    error.code = "OPTION_JSON_INVALID";
    error.cause = cause;
    throw error;
  }
}

async function projectRoot(flags, { allowUninitialized = false } = {}) {
  if (flags.root) return path.resolve(flags.root);
  if (allowUninitialized) return path.resolve(flags.cwd || process.cwd());
  return discoverProjectRoot(flags.cwd || process.cwd());
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  return {
    name: "phasecraft",
    usage: "phasecraft <command> [options]",
    commands: {
      root: "Locate the Phasecraft project root",
      "init-project": "Initialize project configuration",
      "init-work": "Create a work item from the configured path template",
      resolve: "Resolve a work item deterministically",
      preflight: "Check whether a workflow stage may run",
      transition: "Atomically transition a work item",
      status: "Show one work item or the project registry",
      validate: "Validate a Phasecraft Markdown or evidence artifact",
      render: "Render PLAN.md or ROADMAP.md to deterministic HTML",
      baseline: "Capture the work item's initial Git baseline",
      "baseline-clean": "Confirm cleaned baseline-dirty files before execution",
      adopt: "Adopt baseline-dirty files into the work item",
      snapshot: "Write a cumulative task recovery patch",
      "archive-plan": "Archive an immutable approved plan version",
      "ship-preview": "Create an exact fingerprinted Ship preview",
      ship: "Execute an exactly approved Ship preview",
      "knowledge-candidates": "List known project authority candidates and source hashes",
      "knowledge-set": "Persist the user's confirmed project authorities",
      "knowledge-check": "Detect authority source drift",
      "research-approve": "Record one work-scoped external research approval",
      "phase-start": "Select the next roadmap phase for just-in-time planning",
      "verification-result": "Record verification outcome and pending manual checks",
      "handoff-list": "List durable agent handoffs for a work item",
      "handoff-write": "Atomically write the next immutable agent handoff",
    },
  };
}

async function run(argv) {
  const [command = "help", ...rest] = argv;
  const { positional, flags } = parseArguments(rest);

  if (command === "help" || command === "--help" || command === "-h") {
    return help();
  }

  if (command === "root") {
    const root = await projectRoot(flags);
    return { root };
  }

  if (command === "init-project") {
    const root = await projectRoot(flags, { allowUninitialized: true });
    const gitRoot = await findGitRoot(root);
    if (gitRoot !== root) {
      const error = new Error(`Phasecraft root must equal the Git root: ${gitRoot}`);
      error.code = "PROJECT_ROOT_MISMATCH";
      throw error;
    }
    const result = await initProject(root, {
      workPathTemplate: required(flags, "template"),
      artifactMode: required(flags, "artifact-mode"),
    });
    const excludes = await configureArtifactExcludes(root, result.config.artifactMode);
    return { root, config: result.config, excludes };
  }

  if (command === "init-work") {
    const root = await projectRoot(flags);
    const baseline = await captureBaseline(root);
    const values = parseJsonOption(flags, "values", {});
    if (!values || Array.isArray(values) || typeof values !== "object") {
      const error = new Error("--values must be a JSON object");
      error.code = "OPTION_JSON_INVALID";
      throw error;
    }
    const result = await initWork(root, {
      id: required(flags, "id"),
      title: required(flags, "title"),
      values,
      branch: typeof flags.branch === "string" ? flags.branch : baseline.branch,
    });
    await writeJsonAtomic(path.join(result.state.localWorkRoot, "BASELINE.json"), baseline);
    return {
      ...result,
      baseline: { head: baseline.head, branch: baseline.branch, dirtyFiles: baseline.dirtyFiles },
    };
  }

  if (command === "resolve") {
    const root = await projectRoot(flags);
    return resolveWork(root, {
      id: typeof flags.work === "string" ? flags.work : positional[0],
      branch: typeof flags.branch === "string" ? flags.branch : null,
    });
  }

  if (command === "preflight") {
    const root = await projectRoot(flags);
    const resolved = await resolveWork(root, {
      id: typeof flags.work === "string" ? flags.work : null,
      branch: typeof flags.branch === "string" ? flags.branch : null,
    });
    return {
      work: resolved.record,
      preflight: assertStage(resolved.state, required(flags, "stage")),
      paths: {
        artifactRoot: resolved.state.artifactRoot,
        localWorkRoot: resolved.state.localWorkRoot,
      },
    };
  }

  if (command === "transition") {
    const root = await projectRoot(flags);
    const resolved = await resolveWork(root, {
      id: typeof flags.work === "string" ? flags.work : null,
      branch: typeof flags.branch === "string" ? flags.branch : null,
    });
    const expectedRevision = flags["expected-revision"] === undefined
      ? undefined
      : Number.parseInt(flags["expected-revision"], 10);
    if (expectedRevision !== undefined && !Number.isInteger(expectedRevision)) {
      const error = new Error("--expected-revision must be an integer");
      error.code = "OPTION_INVALID";
      throw error;
    }
    const state = await transitionWork(root, resolved.record, required(flags, "to"), {
      expectedRevision,
      reason: typeof flags.reason === "string" ? flags.reason : null,
    });
    return { work: resolved.record.id, state };
  }

  if (command === "status") {
    const root = await projectRoot(flags);
    if (flags.all) return { root, registry: await loadRegistry(root) };
    return resolveWork(root, {
      id: typeof flags.work === "string" ? flags.work : positional[0],
      branch: typeof flags.branch === "string" ? flags.branch : null,
    });
  }

  if (command === "handoff-list" || command === "handoff-write") {
    const root = await projectRoot(flags);
    const resolved = await resolveWork(root, {
      id: typeof flags.work === "string" ? flags.work : positional[0],
      branch: typeof flags.branch === "string" ? flags.branch : null,
    });
    const { listHandoffs, writeHandoff } = await import("./handoffs.mjs");
    if (command === "handoff-list") {
      return {
        work: resolved.record.id,
        artifactRoot: resolved.state.artifactRoot,
        ...await listHandoffs(resolved.state.artifactRoot, { includeAll: flags.all === true }),
      };
    }
    const data = await jsonFromFlagOrFile(flags, "data", null);
    const handoff = await withWorkLock(root, resolved.record.key, () => writeHandoff(
      resolved.state.artifactRoot,
      required(flags, "agent"),
      data,
    ));
    return { work: resolved.record.id, artifactRoot: resolved.state.artifactRoot, handoff };
  }

  if (["baseline", "baseline-clean", "adopt", "snapshot", "ship-preview", "ship"].includes(command)) {
    return runGitWorkflowCommand(command, flags);
  }

  if (command === "archive-plan") {
    const { archivePlanVersion } = await import("./artifacts.mjs");
    const root = await projectRoot(flags);
    const resolved = await resolveWork(root, {
      id: typeof flags.work === "string" ? flags.work : null,
      branch: typeof flags.branch === "string" ? flags.branch : null,
    });
    const phaseDirectory = path.resolve(required(flags, "phase-dir"));
    const allowedRoot = path.resolve(resolved.state.artifactRoot, "plan", "phases");
    const relative = path.relative(allowedRoot, phaseDirectory);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      const error = new Error("Plan archives must target one phase directory under the resolved work item");
      error.code = "PLAN_PATH_UNSAFE";
      throw error;
    }
    const version = Number.parseInt(required(flags, "version"), 10);
    return archivePlanVersion(phaseDirectory, version, required(flags, "reason"));
  }

  if (["knowledge-candidates", "knowledge-set", "knowledge-check"].includes(command)) {
    const root = await projectRoot(flags);
    const { discoverAuthorityCandidates, setAuthoritySources, checkAuthorityDrift } = await import("./knowledge.mjs");
    if (command === "knowledge-candidates") return { candidates: await discoverAuthorityCandidates(root) };
    if (command === "knowledge-check") return checkAuthorityDrift(root);
    const sources = await jsonFromFlagOrFile(flags, "sources", null);
    return setAuthoritySources(root, sources);
  }

  if (command === "research-approve") {
    const root = await projectRoot(flags);
    const resolved = await resolveWork(root, {
      id: typeof flags.work === "string" ? flags.work : null,
      branch: typeof flags.branch === "string" ? flags.branch : null,
    });
    assertStage(resolved.state, "discuss");
    const question = required(flags, "question");
    const sources = await jsonFromFlagOrFile(flags, "sources", []);
    if (!Array.isArray(sources) || sources.length === 0 || sources.some((source) => typeof source !== "string")) {
      const error = new Error("Research approval requires a JSON array of intended source classes");
      error.code = "OPTION_JSON_INVALID";
      throw error;
    }
    const approval = {
      requestId: `research-${(await import("node:crypto")).createHash("sha256").update(`${question}\0${sources.join("\0")}`).digest("hex").slice(0, 12)}`,
      question,
      sources,
      approvedAt: new Date().toISOString(),
      status: "approved",
    };
    const state = await updateWorkState(root, resolved.record, (current) => {
      current.externalResearchApprovals.push(approval);
      return current;
    });
    return { approval, revision: state.revision };
  }

  if (command === "phase-start") {
    const root = await projectRoot(flags);
    let resolved = await resolveWork(root, {
      id: typeof flags.work === "string" ? flags.work : null,
      branch: typeof flags.branch === "string" ? flags.branch : null,
    });
    const phase = required(flags, "phase");
    if (!/^P-\d{2}$/u.test(phase)) {
      const error = new Error("--phase must use the P-01 form");
      error.code = "OPTION_INVALID";
      throw error;
    }
    if (["verified", "verified_pending"].includes(resolved.state.status)) {
      const previous = { id: resolved.state.activePhase, outcome: resolved.state.status };
      const state = await transitionWork(root, resolved.record, "roadmap_ready", {
        expectedRevision: resolved.state.revision,
        reason: `prepare ${phase}`,
        phaseAdvance: true,
        update: (current) => {
          if (previous.id && !current.completedPhases.some((entry) => entry.id === previous.id)) {
            current.completedPhases.push({ ...previous, completedAt: new Date().toISOString() });
          }
          current.activePhase = phase;
          current.planVersion = 0;
          return current;
        },
      });
      return {
        work: resolved.record.id,
        activePhase: state.activePhase,
        completedPhases: state.completedPhases,
        pendingManualChecks: state.pendingManualChecks,
        revision: state.revision,
      };
    }
    if (!["discussed", "roadmap_ready"].includes(resolved.state.status)) {
      const error = new Error(`Cannot start a phase from ${resolved.state.status}`);
      error.code = "STAGE_BLOCKED";
      throw error;
    }
    const state = await updateWorkState(root, resolved.record, (current) => {
      current.activePhase = phase;
      current.planVersion = 0;
      return current;
    }, { expectedRevision: resolved.state.revision });
    return {
      work: resolved.record.id,
      activePhase: state.activePhase,
      completedPhases: state.completedPhases,
      pendingManualChecks: state.pendingManualChecks,
      revision: state.revision,
    };
  }

  if (command === "verification-result") {
    const root = await projectRoot(flags);
    const resolved = await resolveWork(root, {
      id: typeof flags.work === "string" ? flags.work : null,
      branch: typeof flags.branch === "string" ? flags.branch : null,
    });
    if (resolved.state.status !== "verifying") {
      const error = new Error(`Verification result cannot be recorded from ${resolved.state.status}`);
      error.code = "STAGE_BLOCKED";
      throw error;
    }
    const requestedOutcome = required(flags, "outcome");
    if (!["verified", "verified_pending", "verification_failed"].includes(requestedOutcome)) {
      const error = new Error("--outcome must be verified, verified_pending, or verification_failed");
      error.code = "OPTION_INVALID";
      throw error;
    }
    const pending = await jsonFromFlagOrFile(flags, "pending", []);
    if (!Array.isArray(pending) || pending.some(
      (check) => !check || typeof check.id !== "string" || typeof check.description !== "string",
    )) {
      const error = new Error("--pending must be a JSON array of { id, description } checks");
      error.code = "OPTION_JSON_INVALID";
      throw error;
    }
    if (requestedOutcome === "verified_pending" && pending.length === 0 && resolved.state.pendingManualChecks.length === 0) {
      const error = new Error("verified_pending requires at least one pending manual check");
      error.code = "PENDING_CHECK_REQUIRED";
      throw error;
    }
    const allPending = [...resolved.state.pendingManualChecks];
    for (const check of pending) {
      if (!allPending.some((existing) => existing.id === check.id)) {
        allPending.push({ ...check, phase: resolved.state.activePhase, recordedAt: new Date().toISOString() });
      }
    }
    const outcome = requestedOutcome === "verified" && allPending.length > 0 ? "verified_pending" : requestedOutcome;
    const state = await transitionWork(root, resolved.record, outcome, {
      expectedRevision: resolved.state.revision,
      reason: "independent verification completed",
      update: (current) => {
        current.pendingManualChecks = allPending;
        return current;
      },
    });
    return {
      work: resolved.record.id,
      outcome: state.status,
      pendingManualChecks: state.pendingManualChecks,
      revision: state.revision,
    };
  }

  if (command === "validate" || command === "render") {
    return runArtifactCommand(command, flags, positional);
  }

  const error = new Error(`Unknown command: ${command}`);
  error.code = "COMMAND_UNKNOWN";
  throw error;
}

async function runArtifactCommand(command, flags, positional) {
  const source = path.resolve(required(flags, "source"));
  const kind = required(flags, "kind");
  if (command === "validate") {
    const { validateArtifactFile } = await import("./artifacts.mjs");
    return validateArtifactFile(kind, source, {
      evidenceFile: typeof flags.evidence === "string" ? path.resolve(flags.evidence) : undefined,
    });
  }
  const { renderArtifactFile } = await import("./render.mjs");
  const target = path.resolve(required(flags, "output"));
  return renderArtifactFile(kind, source, target, {
    evidenceFile: typeof flags.evidence === "string" ? path.resolve(flags.evidence) : undefined,
  });
}

async function jsonFromFlagOrFile(flags, name, fallback) {
  if (typeof flags[`${name}-file`] === "string") {
    return JSON.parse(await readFile(path.resolve(flags[`${name}-file`]), "utf8"));
  }
  return parseJsonOption(flags, name, fallback);
}

async function runGitWorkflowCommand(command, flags) {
  const root = await projectRoot(flags);
  const resolved = await resolveWork(root, {
    id: typeof flags.work === "string" ? flags.work : null,
    branch: typeof flags.branch === "string" ? flags.branch : null,
  });
  const baselinePath = path.join(resolved.state.localWorkRoot, "BASELINE.json");

  if (command === "baseline") {
    assertStage(resolved.state, "init");
    const baseline = await captureBaseline(root);
    await writeJsonAtomic(baselinePath, baseline);
    return baseline;
  }

  if (command === "baseline-clean") {
    if (["executing", "execution_complete", "verifying", "verified", "verified_pending", "verification_failed", "shipped"].includes(resolved.state.status)) {
      const error = new Error(`Baseline files cannot be cleaned from state ${resolved.state.status}`);
      error.code = "STAGE_BLOCKED";
      throw error;
    }
    const files = await jsonFromFlagOrFile(flags, "files", []);
    if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) {
      const error = new Error("--files must be a non-empty JSON array of repository paths");
      error.code = "OPTION_JSON_INVALID";
      throw error;
    }
    const baseline = await readJson(baselinePath);
    const baselinePaths = new Set(baseline.files.map((file) => file.path));
    const unknown = files.filter((file) => !baselinePaths.has(file));
    if (unknown.length > 0) {
      const error = new Error(`Files were not dirty at baseline: ${unknown.join(", ")}`);
      error.code = "BASELINE_FILE_INVALID";
      throw error;
    }
    const currentlyDirty = new Set((await getStatus(root)).map((entry) => entry.path));
    const stillDirty = files.filter((file) => currentlyDirty.has(file));
    if (stillDirty.length > 0) {
      const error = new Error(`Files must match HEAD before baseline cleaning: ${stillDirty.join(", ")}`);
      error.code = "BASELINE_FILE_STILL_DIRTY";
      throw error;
    }
    baseline.files = baseline.files.filter((file) => !files.includes(file.path));
    baseline.dirtyFiles = baseline.files.map((file) => file.path);
    baseline.stagedFiles = baseline.files.filter((file) => file.staged).map((file) => file.path);
    await writeJsonAtomic(baselinePath, baseline);
    const state = await updateWorkState(root, resolved.record, (current) => {
      current.cleanedBaselineFiles = [...new Set([...current.cleanedBaselineFiles, ...files])].sort();
      return current;
    }, {
      expectedRevision: flags["expected-revision"] === undefined
        ? undefined
        : Number.parseInt(flags["expected-revision"], 10),
    });
    return { work: resolved.record.id, cleanedBaselineFiles: state.cleanedBaselineFiles, revision: state.revision };
  }

  if (command === "adopt") {
    const files = await jsonFromFlagOrFile(flags, "files", []);
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
      const error = new Error("--files must be a JSON array of repository paths");
      error.code = "OPTION_JSON_INVALID";
      throw error;
    }
    const baseline = await readJson(baselinePath);
    const baselineFiles = new Set(baseline.files.flatMap((file) => [file.path, file.originalPath].filter(Boolean)));
    const invalid = files.filter((file) => !baselineFiles.has(file));
    if (invalid.length > 0) {
      const error = new Error(`Only baseline-dirty files may be adopted: ${invalid.join(", ")}`);
      error.code = "ADOPTION_FILE_INVALID";
      throw error;
    }
    const state = await updateWorkState(root, resolved.record, (current) => {
      current.adoptedBaselineFiles = [...new Set([...current.adoptedBaselineFiles, ...files])].sort();
      return current;
    }, {
      expectedRevision: flags["expected-revision"] === undefined
        ? undefined
        : Number.parseInt(flags["expected-revision"], 10),
    });
    return { work: resolved.record.id, adoptedBaselineFiles: state.adoptedBaselineFiles, revision: state.revision };
  }

  if (command === "snapshot") {
    assertStage(resolved.state, "execute");
    const task = required(flags, "task");
    if (!/^T-\d{3}$/u.test(task)) {
      const error = new Error("--task must use the T-001 form");
      error.code = "OPTION_INVALID";
      throw error;
    }
    const files = await jsonFromFlagOrFile(flags, "files", []);
    const config = await loadConfig(root);
    return createPatchSnapshot(
      root,
      path.join(resolved.state.localWorkRoot, "execution", "phases", resolved.state.activePhase, "patches", `${task}.patch`),
      {
        files,
        sensitivePatterns: config.sensitivePaths,
        maxBytes: config.snapshotMaxBytes,
        allowSensitive: flags["allow-sensitive"] === true,
      },
    );
  }

  if (command === "ship-preview") {
    assertStage(resolved.state, "ship");
    const groupsInput = await jsonFromFlagOrFile(flags, "groups", null);
    const groups = Array.isArray(groupsInput) ? groupsInput : groupsInput?.groups;
    if (!Array.isArray(groups)) {
      const error = new Error("--groups or --groups-file must provide an array or { groups: [] }");
      error.code = "OPTION_JSON_INVALID";
      throw error;
    }
    const preview = await createShipPreview(root, groups, {
      baseline: await readJson(baselinePath),
      adoptedFiles: resolved.state.adoptedBaselineFiles,
      checks: await jsonFromFlagOrFile(flags, "checks", []),
      pendingManualChecks: await jsonFromFlagOrFile(flags, "pending", resolved.state.pendingManualChecks),
    });
    const previewPath = path.join(resolved.state.localWorkRoot, "ship", "preview.json");
    await writeJsonAtomic(previewPath, preview);
    return { ...preview, previewPath };
  }

  assertStage(resolved.state, "ship");
  const previewPath = path.join(resolved.state.localWorkRoot, "ship", "preview.json");
  const preview = await readJson(previewPath);
  const result = await executeShip(root, preview, required(flags, "approval"), {
    pendingAcknowledgement: typeof flags["ack-pending"] === "string" ? flags["ack-pending"] : null,
  });
  await writeJsonAtomic(path.join(resolved.state.localWorkRoot, "ship", "result.json"), result);
  return result;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  run(process.argv.slice(2)).then(output).catch((cause) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: cause.message,
      code: cause.code ?? "UNEXPECTED_ERROR",
      details: cause.details ?? null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments, run };
