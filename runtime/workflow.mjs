import { lstat, readFile, readdir, realpath, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseRestrictedMarkdown, sha256, validateEvidenceRegistry, validatePlan } from "./artifacts.mjs";
import {
  contentHash, createPatchSnapshot, dirtyFileOverlaps, getHead, getStatus,
  inspectShipJournal, mergeCommitGroups, patchForFiles, stableStringify, worktreeFingerprint,
} from "./git.mjs";
import { loadConfig, readJson, updateWorkState, writeJsonAtomic } from "./state.mjs";
import { stageInvocation, workflowHost } from "./hosts.mjs";

function fail(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function fingerprint(value) {
  return sha256(stableStringify(value));
}

async function artifactFile(root, relative) {
  const absolute = path.resolve(root, relative);
  const rootReal = await realpath(root);
  const actual = await realpath(absolute).catch(() => null);
  const info = await lstat(absolute).catch(() => null);
  if (!actual || !actual.startsWith(`${rootReal}${path.sep}`) || !info?.isFile() || info.isSymbolicLink()) {
    throw fail(`Missing or unsafe workflow artifact: ${relative}`, "APPROVAL_ARTIFACT_INVALID", { path: relative });
  }
  return readFile(absolute, "utf8");
}

function files(value) {
  return value.split(",").map((file) => file.trim()).filter(Boolean).map((file) => {
    if (file.includes("\\") || /[\u0000-\u001f*?]/u.test(file) || file.startsWith(":")
      || path.posix.isAbsolute(file) || path.posix.normalize(file) !== file || file === "."
      || file === ".." || file.startsWith("../") || /^(?:\.git|\.phasecraft)(?:\/|$)/u.test(file)) {
      throw fail(`Plan file must be an exact repository-relative path: ${file}`, "PLAN_SCOPE_INVALID");
    }
    return file;
  });
}

function references(value = "none") {
  return value.toLowerCase() === "none" ? [] : value.split(",").map((item) => item.trim());
}

function field(entry, name) {
  return entry.fields.get(name.toLowerCase())?.value ?? "";
}

function validateAudit(source, planHash) {
  const hashes = [...source.matchAll(/^\*\*Plan SHA-256:\*\* ([a-f0-9]{64})\s*$/gmu)];
  const outcomes = [...source.matchAll(/^\*\*Outcome:\*\* (.+)\s*$/gmu)];
  if (hashes.length !== 1 || hashes[0][1] !== planHash || outcomes.length !== 1) {
    throw fail("Plan verification must bind exactly one current plan hash and outcome", "PLAN_VERIFICATION_STALE");
  }
  const document = parseRestrictedMarkdown(source);
  const sections = ["Integrity Gate", "Findings", "Human Q&A", "Execution Gate"];
  if (!document.title || document.extraTitles.length || document.sections.size !== sections.length
    || sections.some((name) => !document.sections.has(name) || document.sections.get(name).duplicate)) {
    throw fail("Plan verification requires unambiguous Integrity Gate, Findings, Human Q&A, and Execution Gate sections", "PLAN_AUDIT_INVALID");
  }
  const sectionStatus = (name) => document.sections.get(name).content
    .filter(({ text }) => /^- Status: /u.test(text)).map(({ text }) => text.slice(10).trim());
  if (stableStringify(sectionStatus("Integrity Gate")) !== '["passed"]'
    || stableStringify(sectionStatus("Execution Gate")) !== '["approved"]') {
    throw fail("The audit's integrity and execution gates must pass", "PLAN_AUDIT_BLOCKED");
  }
  const findings = document.sections.get("Findings").entries;
  const findingIds = findings.map((entry) => entry.heading.match(/^(PV-\d{3,}): .+/u)?.[1]);
  const questions = document.sections.get("Human Q&A").entries;
  if (findingIds.some((id) => !id) || new Set(findingIds).size !== findingIds.length
    || outcomes[0][1].trim() !== (findings.length ? "APPROVED WITH DISPOSITIONS" : "APPROVED")) {
    throw fail("Audit findings and approval outcome are inconsistent", "PLAN_AUDIT_INVALID");
  }
  const covered = new Set();
  const questionIds = new Set();
  const dispositions = questions.map((entry) => {
    const id = entry.heading.match(/^(Q-\d{3,}): .+/u)?.[1];
    const answer = field(entry, "Answer");
    const rationale = field(entry, "Human rationale");
    if (!id || questionIds.has(id) || entry.duplicateFields?.length
      || !["defer", "accept-risk", "non-blocking"].includes(answer)
      || !rationale || rationale.toLowerCase() === "pending" || field(entry, "Plan SHA-256") !== planHash) {
      throw fail("Every audit question needs an explicit resolved disposition bound to the current plan", "PLAN_DISPOSITION_BLOCKED");
    }
    questionIds.add(id);
    const ownedFindings = references(field(entry, "Findings"));
    if (!ownedFindings.length || ownedFindings.some((finding) => !findingIds.includes(finding) || covered.has(finding))) {
      throw fail("Each audit finding must have exactly one human disposition", "PLAN_DISPOSITION_BLOCKED");
    }
    ownedFindings.forEach((finding) => covered.add(finding));
    if (answer === "defer" && (!field(entry, "Owner/trigger") || field(entry, "Owner/trigger") === "none")) {
      throw fail("Deferred findings require an owner phase or trigger", "PLAN_DISPOSITION_BLOCKED");
    }
    return { id, findings: ownedFindings, answer, rationale, guardrails: field(entry, "Guardrails") || "none" };
  });
  if (covered.size !== findings.length) throw fail("Audit findings remain undispositioned", "PLAN_DISPOSITION_BLOCKED");
  return { outcome: outcomes[0][1].trim(), dispositions };
}

export async function buildPlanApproval(state) {
  if (!/^P-\d{2}$/u.test(state.activePhase ?? "")) throw fail("Select the active phase first", "ACTIVE_PHASE_REQUIRED");
  const directory = path.join(state.artifactRoot, "plan", "phases");
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${state.activePhase}-`));
  if (candidates.length !== 1) throw fail("The active phase must have exactly one plan directory", "ACTIVE_PLAN_AMBIGUOUS");
  const planDirectory = path.posix.join("plan", "phases", candidates[0].name);
  const [plan, html, audit, evidence] = await Promise.all([
    artifactFile(state.artifactRoot, `${planDirectory}/PLAN.md`),
    artifactFile(state.artifactRoot, `${planDirectory}/plan.html`),
    artifactFile(state.artifactRoot, `${planDirectory}/PLAN-VERIFICATION.md`),
    artifactFile(state.artifactRoot, "research/EVIDENCE.json"),
  ]);
  let evidenceRegistry;
  try { evidenceRegistry = JSON.parse(evidence); }
  catch { throw fail("Evidence registry is not valid JSON", "EVIDENCE_INVALID"); }
  const evidenceValidation = validateEvidenceRegistry(evidenceRegistry);
  if (!evidenceValidation.valid) throw fail("Evidence registry failed structural validation", "EVIDENCE_INVALID", { errors: evidenceValidation.errors });
  const validation = validatePlan(plan, { evidenceRegistry });
  if (!validation.valid) throw fail("Plan failed structural validation", "PLAN_INVALID", { errors: validation.errors });
  const bindings = [...html.matchAll(/<meta name="phasecraft-source-sha256" content="([a-f0-9]{64})">/gu)];
  if (bindings.length !== 1 || bindings[0][1] !== validation.sourceHash) {
    throw fail("Generated HTML does not bind the active plan", "PLAN_HTML_STALE");
  }
  const auditResult = validateAudit(audit, validation.sourceHash);
  const groups = validation.document.sections.get("Commit Groups").entries.map((entry) => ({
    id: entry.heading.split(":")[0], message: field(entry, "Message"), files: files(field(entry, "Files")),
    dependsOn: references(field(entry, "Depends on")),
  }));
  mergeCommitGroups(groups);
  const tasks = validation.document.sections.get("Tasks").entries.map((entry) => ({
    id: entry.heading.split(":")[0], files: files(field(entry, "Files")),
    dependsOn: references(field(entry, "Depends on")), group: field(entry, "Commit group"),
  }));
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw fail("Task identities must be unique", "PLAN_SCOPE_INVALID");
  const visited = new Set();
  while (visited.size < tasks.length) {
    const ready = tasks.filter((task) => !visited.has(task.id) && task.dependsOn.every((id) => visited.has(id)));
    if (!ready.length) throw fail("Task dependencies contain a cycle", "TASK_DEPENDENCY_CYCLE");
    ready.forEach((task) => visited.add(task.id));
  }
  for (const task of tasks) {
    const group = groups.find((entry) => entry.id === task.group);
    if (!task.files.length || task.files.some((file) => !group?.files.includes(file))) {
      throw fail(`Task ${task.id} has files outside its commit group`, "PLAN_SCOPE_INVALID");
    }
  }
  const payload = {
    schemaVersion: 1, phase: state.activePhase, planVersion: state.planVersion, planDirectory,
    planHash: validation.sourceHash, htmlHash: sha256(html), auditHash: sha256(audit), evidenceHash: sha256(evidence),
    ...auditResult, tasks, groups, files: [...new Set(groups.flatMap((group) => group.files))].sort(),
  };
  return { ...payload, fingerprint: fingerprint(payload) };
}

export async function assertPlanApproval(state) {
  const receipt = state.planApprovals?.[state.activePhase];
  if (!receipt) throw fail("Record a plan approval with approve-plan before execution", "PLAN_APPROVAL_REQUIRED");
  const current = await buildPlanApproval(state);
  if (receipt.fingerprint !== current.fingerprint || stableStringify(receipt) !== stableStringify(current)) {
    throw fail("Approved plan, audit, evidence, HTML, or scope changed; revise and audit again", "PLAN_APPROVAL_STALE");
  }
  return receipt;
}

export async function executionFingerprint(root, approval) {
  const status = await getStatus(root);
  const changed = new Set(status.flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean)));
  const patch = await patchForFiles(root, approval.files.filter((file) => changed.has(file)), status);
  return fingerprint({ head: await getHead(root), diffHash: sha256(patch) });
}

async function fileState(root, file) {
  const information = await lstat(path.join(root, ...file.split("/"))).catch((cause) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  return { hash: await contentHash(root, file), executable: information ? Boolean(information.mode & 0o111) : null };
}

async function assertScope(root, state, approval) {
  const execution = state.executionRecords?.[state.activePhase];
  if (!execution || execution.approvalFingerprint !== approval.fingerprint) {
    throw fail("This phase has no execution checkpoint session", "EXECUTION_SESSION_REQUIRED");
  }
  const current = await worktreeFingerprint(root);
  if (current.head !== execution.start.head) throw fail("HEAD changed during execution", "EXECUTION_HEAD_DRIFT");
  const outside = (entries) => entries.filter((entry) => !approval.files.includes(entry.path));
  if (stableStringify(outside(current.files)) !== stableStringify(outside(execution.start.files))) {
    throw fail("Files outside the approved phase changed during execution", "EXECUTION_SCOPE_DRIFT");
  }
  return execution;
}

export async function assertExecutionComplete(root, state) {
  const approval = await assertPlanApproval(state);
  const execution = await assertScope(root, state, approval);
  const missing = approval.tasks.filter((task) => !execution.completedTasks[task.id]).map((task) => task.id);
  if (missing.length) throw fail("Record successful task checkpoints before completing execution", "TASK_CHECKPOINTS_REQUIRED", { tasks: missing });
  const latest = execution.checkpoints.at(-1);
  if (latest?.executionFingerprint !== await executionFingerprint(root, approval)) {
    throw fail("Implementation changed after its last task checkpoint", "EXECUTION_CHECKPOINT_STALE");
  }
  return approval;
}

export function validateChecks(checks, { passing = true } = {}) {
  if (!Array.isArray(checks) || !checks.length || checks.some((check) => !check
    || typeof check.name !== "string" || !check.name.trim() || typeof check.passed !== "boolean")
    || new Set(checks.map((check) => check.name)).size !== checks.length) {
    throw fail("Checks must be a non-empty array of unique { name, passed, ... } observations", "CHECKS_INVALID");
  }
  if (passing && checks.some((check) => !check.passed)) throw fail("Required automatic checks did not pass", "CHECKS_FAILED");
  return checks;
}

export async function checkpointTask(root, record, taskId, data) {
  return updateWorkState(root, record, async (state) => {
    if (state.status !== "executing") throw fail("Task checkpoints require executing state", "STAGE_BLOCKED");
    const approval = await assertPlanApproval(state);
    const execution = await assertScope(root, state, approval);
    const task = approval.tasks.find((entry) => entry.id === taskId);
    if (!task) throw fail("Task is outside the approved phase", "TASK_NOT_APPROVED");
    if (task.dependsOn.some((id) => !execution.completedTasks[id])) throw fail("Complete task dependencies first", "TASK_DEPENDENCY_INCOMPLETE");
    const checks = validateChecks(data.checks);
    const config = await loadConfig(root);
    const changed = new Set((await getStatus(root)).flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean)));
    const snapshotFiles = approval.files.filter((file) => changed.has(file));
    const sequence = execution.checkpoints.length + 1;
    const snapshot = snapshotFiles.length ? await createPatchSnapshot(root,
      path.join(state.localWorkRoot, "execution", "phases", state.activePhase, "patches", `${taskId}-${sequence}.patch`), {
        files: snapshotFiles, sensitivePatterns: config.sensitivePaths, maxBytes: config.snapshotMaxBytes,
        allowSensitive: data.allowSensitive === true,
      }) : null;
    const invalidated = new Set([taskId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const candidate of approval.tasks) {
        if (!invalidated.has(candidate.id) && candidate.dependsOn.some((id) => invalidated.has(id))) {
          invalidated.add(candidate.id);
          changed = true;
        }
      }
    }
    const checkpoint = {
      task: taskId, sequence, completedAt: new Date().toISOString(), checks, snapshot,
      executionFingerprint: await executionFingerprint(root, approval), invalidatedTasks: [...invalidated].filter((id) => id !== taskId),
    };
    invalidated.forEach((id) => delete execution.completedTasks[id]);
    execution.completedTasks[taskId] = sequence;
    execution.checkpoints.push(checkpoint);
    return state;
  });
}

export async function transitionGate(root, state, to, options) {
  state.planApprovals ??= {};
  state.executionRecords ??= {};
  state.verificationRecords ??= {};
  if (to === "plan_verified") {
    if (!options.approvePlan) throw fail("Use approve-plan to record a runtime-bound audit receipt", "PLAN_APPROVAL_REQUIRED");
    const receipt = await buildPlanApproval(state);
    const directory = path.join(state.localWorkRoot, "approvals", state.activePhase);
    await mkdir(directory, { recursive: true });
    const receiptPath = path.join(directory, `${receipt.fingerprint}.json`);
    const content = `${JSON.stringify(receipt, null, 2)}\n`;
    await writeFile(receiptPath, content, { flag: "wx", mode: 0o400 }).catch(async (cause) => {
      if (cause.code !== "EEXIST" || await readFile(receiptPath, "utf8") !== content) throw cause;
    });
    state.planApprovals[state.activePhase] = receipt;
  }
  if (to === "executing") {
    const approval = await assertPlanApproval(state);
    const baseline = await readJson(path.join(state.localWorkRoot, "BASELINE.json"));
    const overlaps = dirtyFileOverlaps(baseline, approval.files, state.adoptedBaselineFiles);
    if (overlaps.length) throw fail("Clean or explicitly adopt baseline-dirty planned files", "BASELINE_ADOPTION_REQUIRED", { files: overlaps });
    if (state.executionRecords[state.activePhase]?.approvalFingerprint !== approval.fingerprint) {
      state.executionRecords[state.activePhase] = {
        approvalFingerprint: approval.fingerprint, start: await worktreeFingerprint(root),
        startedAt: new Date().toISOString(), completedTasks: {}, checkpoints: [],
      };
    } else await assertScope(root, state, approval);
    delete state.verificationRecords[state.activePhase];
  }
  if (to === "execution_complete" || to === "verifying") await assertExecutionComplete(root, state);
  if (["verified", "verified_pending"].includes(to) || (to === "verification_failed" && options.verificationChecks)) {
    const approval = to === "verification_failed" ? await assertPlanApproval(state) : await assertExecutionComplete(root, state);
    const checks = validateChecks(options.verificationChecks, { passing: to !== "verification_failed" });
    state.verificationRecords[state.activePhase] = {
      approvalFingerprint: approval.fingerprint, executionFingerprint: await executionFingerprint(root, approval),
      checks, outcome: to, recordedAt: new Date().toISOString(),
      fileStates: Object.fromEntries(await Promise.all(approval.files.map(async (file) => [file, await fileState(root, file)]))),
    };
  }
  if (to === "shipped") {
    const { journal } = await approvedShipGroups(root, state);
    if (!journal || journal.status !== "completed" || journal.contractFingerprint !== shipContract(state)) {
      throw fail("Ship must finish and persist its commit journal before the work is marked shipped", "SHIP_INCOMPLETE");
    }
    if (journal.recoveredPendingCommit) await writeJsonAtomic(path.join(state.localWorkRoot, "ship", "journal.json"), journal);
  }
  if (to === "plan_draft") {
    delete state.planApprovals[state.activePhase];
    delete state.verificationRecords[state.activePhase];
  }
  return state;
}

export function shipContract(state) {
  return fingerprint({ approvals: state.planApprovals ?? {}, verification: state.verificationRecords ?? {}, pending: state.pendingManualChecks });
}

export async function approvedShipGroups(root, state) {
  const approval = await assertPlanApproval(state);
  const verification = state.verificationRecords?.[state.activePhase];
  if (!verification || verification.approvalFingerprint !== approval.fingerprint) throw fail("Independent verification is missing or stale", "VERIFICATION_REQUIRED");
  const journal = await inspectShipJournal(root, path.join(state.localWorkRoot, "ship", "journal.json"));
  if (journal?.commits.length) {
    if (journal.contractFingerprint !== shipContract(state)) throw fail("Approval or verification changed after partial Ship", "SHIP_CONTRACT_STALE");
    const dirty = new Set((await getStatus(root)).flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean)));
    for (const group of journal.originalPreview.groups) {
      for (const file of group.files) {
        if (await contentHash(root, file) !== journal.originalPreview.fileHashes[file]) throw fail(`Verified file changed after partial Ship: ${file}`, "SHIP_DRIFT");
      }
      if (journal.commits.some((commit) => commit.group === group.id) && group.files.some((file) => dirty.has(file))) {
        throw fail("A committed Ship group is dirty again", "SHIP_DRIFT");
      }
      if (!journal.commits.some((commit) => commit.group === group.id)
        && sha256(await patchForFiles(root, group.files)) !== group.diffHash) throw fail("Remaining diff changed after partial Ship", "SHIP_DRIFT");
    }
  } else {
    await assertExecutionComplete(root, state);
    if (verification.executionFingerprint !== await executionFingerprint(root, approval)) throw fail("Implementation changed after independent verification", "VERIFICATION_STALE");
  }
  const phases = [...new Set([...state.completedPhases.map((phase) => phase.id), state.activePhase])];
  // Later phases may intentionally revise earlier files. The final version of every
  // file must still match the independent verifier for its latest owning phase.
  const expectedFiles = new Map();
  for (const phase of phases) {
    const verification = state.verificationRecords?.[phase];
    if (!verification || !["verified", "verified_pending"].includes(verification.outcome) || !verification.fileStates) {
      throw fail(`Phase ${phase} lacks bound independent file observations`, "VERIFICATION_REQUIRED");
    }
    for (const file of state.planApprovals?.[phase]?.files ?? []) expectedFiles.set(file, verification.fileStates[file]);
  }
  for (const [file, expected] of expectedFiles) {
    if (stableStringify(await fileState(root, file)) !== stableStringify(expected)) {
      throw fail(`File changed since its last owning phase was independently verified: ${file}`, "VERIFICATION_STALE");
    }
  }
  const groups = (await Promise.all(phases.map(async (phase) => {
    const receipt = state.planApprovals?.[phase];
    if (!receipt || state.verificationRecords?.[phase]?.approvalFingerprint !== receipt.fingerprint) throw fail(`Phase ${phase} lacks approval or verification`, "VERIFICATION_REQUIRED");
    if (phase !== state.activePhase) {
      const current = await buildPlanApproval({ ...state, activePhase: phase, planVersion: receipt.planVersion });
      const shape = ({ fingerprint, evidenceHash, ...bound }) => bound;
      if (stableStringify(shape(current)) !== stableStringify(shape(receipt))) {
        throw fail(`Completed phase ${phase} artifacts changed`, "PLAN_APPROVAL_STALE");
      }
    }
    return receipt.groups.map((group) => ({ ...group, id: `${phase}:${group.id}`, dependsOn: group.dependsOn.map((id) => `${phase}:${id}`) }));
  }))).flat();
  const completed = new Set(journal?.commits.map((commit) => commit.group) ?? []);
  const changed = new Set((await getStatus(root)).flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean)));
  const merged = mergeCommitGroups(groups).filter((group) => !completed.has(group.id))
    .map((group) => ({ ...group, files: group.files.filter((file) => changed.has(file)) })).filter((group) => group.files.length);
  const remainingIds = new Set(merged.map((group) => group.id));
  return { groups: merged.map((group) => ({ ...group, dependsOn: group.dependsOn.filter((id) => remainingIds.has(id)) })), journal, contractFingerprint: shipContract(state) };
}

export async function preflightWorkflow(root, state, stage) {
  if (stage === "execute") {
    const approval = await assertPlanApproval(state);
    const baseline = await readJson(path.join(state.localWorkRoot, "BASELINE.json"));
    const overlaps = dirtyFileOverlaps(baseline, approval.files, state.adoptedBaselineFiles);
    if (overlaps.length) throw fail("Clean or adopt baseline-dirty planned files", "BASELINE_ADOPTION_REQUIRED", { files: overlaps });
    if (state.status === "executing") await assertScope(root, state, approval);
  }
  if (stage === "verify") await assertExecutionComplete(root, state);
  if (stage === "ship") {
    await approvedShipGroups(root, state);
    if ((await getStatus(root)).some((entry) => entry.staged)) throw fail("Unstage changes without discarding content before Ship preview", "SHIP_INDEX_DIRTY");
  }
}

export async function readinessReport(root, state, { host } = {}) {
  host = workflowHost(host);
  const blockers = [];
  const warnings = [];
  const stages = {
    initialized: "discuss", researching: "discuss", discussed: "plan", roadmap_ready: "plan",
    plan_draft: "verify-plan", plan_verified: "execute", executing: "execute", execution_complete: "verify",
    verifying: "verify", verified: "ship", verified_pending: "ship", verification_failed: "execute",
  };
  let stage = stages[state.status] ?? null;
  let approval = null;
  if (state.activePhase && !["plan_draft", "roadmap_ready", "discussed", "shipped"].includes(state.status)) {
    try { approval = await assertPlanApproval(state); }
    catch (cause) { blockers.push({ code: cause.code, message: cause.message }); }
  }
  const execution = state.executionRecords?.[state.activePhase];
  if (execution && approval && !["verified", "verified_pending", "shipped"].includes(state.status)) {
    try { await assertScope(root, state, approval); }
    catch (cause) { blockers.push({ code: cause.code, message: cause.message }); }
    if (state.status === "executing" && execution.checkpoints.length
      && execution.checkpoints.at(-1).executionFingerprint !== await executionFingerprint(root, approval)) {
      warnings.push({ code: "EXECUTION_UNCHECKPOINTED", message: "Implementation changed after the last checkpoint; recheck the affected task before completing execution" });
    }
  }
  if (stage === "verify-plan") {
    try { await artifactFile(state.artifactRoot, `plan/phases/${(await readdir(path.join(state.artifactRoot, "plan", "phases"))).find((name) => name.startsWith(`${state.activePhase}-`))}/PLAN.md`); }
    catch { stage = "plan"; }
  }
  let authority = null;
  try {
    const { checkAuthorityDrift } = await import("./knowledge.mjs");
    authority = await checkAuthorityDrift(root);
    if (!authority.valid) warnings.push({ code: "AUTHORITY_DRIFT", message: "Project authority sources are stale or missing" });
  } catch { warnings.push({ code: "AUTHORITY_UNCONFIRMED", message: "Project authorities have not been confirmed" }); }
  let feedback = [];
  try {
    const { listFeedback } = await import("./feedback.mjs");
    feedback = (await listFeedback(state)).filter((batch) => !batch.resolved || batch.needsClarification)
      .map((batch) => ({ ...batch, command: stageInvocation(host, "plan", state.id, batch.id) }));
  } catch (cause) { blockers.push({ code: cause.code, message: cause.message }); }
  let review = null;
  try { const { reviewStatus } = await import("./review.mjs"); review = await reviewStatus(state); }
  catch (cause) { warnings.push({ code: cause.code, message: cause.message }); }
  let journal = null;
  try {
    journal = await inspectShipJournal(root, path.join(state.localWorkRoot, "ship", "journal.json"));
    if (["execute", "verify", "ship"].includes(stage)) await preflightWorkflow(root, state, stage);
  } catch (cause) { blockers.push({ code: cause.code, message: cause.message }); }
  const completedTasks = Object.keys(execution?.completedTasks ?? {});
  let recovery = null;
  if (blockers.some((blocker) => /^(?:PLAN_|APPROVAL_|ACTIVE_PLAN)/u.test(blocker.code ?? ""))) {
    recovery = "Archive the audited plan, transition to plan_draft, revise and audit it with approve-plan. Existing v0.4 work does not require reinitialization.";
  } else if (blockers.length) recovery = "Resolve the reported drift or blocker, then rerun resume. Preserve existing changes and recorded commits.";
  return {
    schemaVersion: 1, work: state.id, host, status: state.status, revision: state.revision, activePhase: state.activePhase,
    ready: blockers.length === 0, blockers, warnings, authority, review, feedback,
    approval: approval ? { fingerprint: approval.fingerprint, planHash: approval.planHash, files: approval.files } : null,
    execution: execution ? { completedTasks, remainingTasks: (approval?.tasks ?? []).filter((task) => !completedTasks.includes(task.id)).map((task) => task.id), lastCheckpoint: execution.checkpoints.at(-1) ?? null } : null,
    ship: journal ? { status: journal.status, commits: journal.commits, pendingGroup: journal.pending ?? null, recoveredPendingCommit: journal.recoveredPendingCommit ?? false } : null,
    pendingManualChecks: state.pendingManualChecks,
    nextAction: stage ? { stage, command: stageInvocation(host, stage, state.id), blocked: blockers.length > 0 } : null,
    recovery,
  };
}
