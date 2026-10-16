import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeJsonAtomic } from "./state.mjs";

function gitError(message, code, details = {}) {
  const value = new Error(message);
  value.code = code;
  Object.assign(value, details);
  return value;
}

export async function runGit(projectRoot, args, options = {}) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw gitError("Git arguments must be an array of strings", "GIT_ARGS_INVALID");
  }
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
    let outputBytes = 0;
    let failure = null;
    const child = spawn("git", args, {
      cwd: path.resolve(projectRoot),
      shell: false,
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      failure = gitError(`git ${args[0]} exceeded ${timeoutMs}ms`, "GIT_TIMEOUT", { args, timeoutMs });
      child.kill("SIGTERM");
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes && !failure) {
        failure = gitError(`git ${args[0]} exceeded the output limit`, "GIT_OUTPUT_TOO_LARGE", {
          args,
          maxOutputBytes,
        });
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (cause) => reject(gitError(`Unable to run Git: ${cause.message}`, "GIT_EXEC_FAILED", { cause })));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      const result = {
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (exitCode !== 0 && !options.allowFailure) {
        reject(gitError(`git ${args[0]} failed: ${result.stderr.toString("utf8").trim()}`, "GIT_COMMAND_FAILED", {
          args,
          exitCode,
          stderr: result.stderr.toString("utf8"),
        }));
      } else {
        resolve(result);
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

export async function findGitRoot(start = process.cwd()) {
  const result = await runGit(start, ["rev-parse", "--show-toplevel"]);
  return path.resolve(result.stdout.toString("utf8").trim());
}

export async function getHead(projectRoot) {
  const result = await runGit(projectRoot, ["rev-parse", "HEAD"], { allowFailure: true });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString("utf8").trim();
}

export async function getBranch(projectRoot) {
  const result = await runGit(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : null;
}

function normalizeRepositoryPath(filePath) {
  if (typeof filePath !== "string" || filePath === "" || filePath.includes("\0")) {
    throw gitError("Repository path is invalid", "PATH_INVALID");
  }
  const normalized = filePath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw gitError(`Repository path escapes the root: ${filePath}`, "PATH_UNSAFE");
  }
  return path.posix.normalize(normalized);
}

export async function getStatus(projectRoot) {
  const result = await runGit(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const chunks = result.stdout.toString("utf8").split("\0");
  const records = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    const indexStatus = chunk[0];
    const worktreeStatus = chunk[1];
    const filePath = normalizeRepositoryPath(chunk.slice(3));
    const record = {
      path: filePath,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== " " && indexStatus !== "?",
      untracked: indexStatus === "?" && worktreeStatus === "?",
      deleted: indexStatus === "D" || worktreeStatus === "D",
      originalPath: null,
    };
    if ([indexStatus, worktreeStatus].some((status) => status === "R" || status === "C")) {
      record.originalPath = normalizeRepositoryPath(chunks[index + 1]);
      index += 1;
    }
    records.push(record);
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

export async function contentHash(projectRoot, filePath) {
  const absolute = path.join(projectRoot, ...normalizeRepositoryPath(filePath).split("/"));
  const information = await lstat(absolute).catch(() => null);
  if (!information) return null;
  if (information.isSymbolicLink()) {
    return createHash("sha256").update(`symlink\0${await readlink(absolute)}`).digest("hex");
  }
  if (!information.isFile()) return null;
  const content = await readFile(absolute);
  return createHash("sha256").update(content).digest("hex");
}

export async function captureBaseline(projectRoot) {
  const root = await findGitRoot(projectRoot);
  const [head, branch, status] = await Promise.all([getHead(root), getBranch(root), getStatus(root)]);
  const files = [];
  for (const record of status.filter((entry) => entry.path !== ".phasecraft" && !entry.path.startsWith(".phasecraft/"))) {
    files.push({ ...record, hash: await contentHash(root, record.path) });
  }
  return {
    schemaVersion: 1,
    root,
    head,
    branch,
    capturedAt: new Date().toISOString(),
    files,
    dirtyFiles: files.map((file) => file.path),
    stagedFiles: files.filter((file) => file.staged).map((file) => file.path),
  };
}

export async function configureArtifactExcludes(projectRoot, artifactMode) {
  if (!["local", "reviewable"].includes(artifactMode)) {
    throw gitError(`Unknown artifact mode: ${artifactMode}`, "ARTIFACT_MODE_INVALID");
  }
  const result = await runGit(projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
  const reported = result.stdout.toString("utf8").trim();
  const excludePath = path.isAbsolute(reported) ? reported : path.resolve(projectRoot, reported);
  const existing = await readFile(excludePath, "utf8").catch((cause) => {
    if (cause.code === "ENOENT") return "";
    throw cause;
  });
  const begin = "# BEGIN PHASECRAFT MANAGED";
  const end = "# END PHASECRAFT MANAGED";
  const expression = new RegExp(`(?:^|\\n)${begin}\\n[\\s\\S]*?\\n${end}(?:\\n|$)`, "u");
  const cleaned = existing.replace(expression, "\n").replace(/\n{3,}/gu, "\n\n").trimEnd();
  const rule = artifactMode === "local" ? "/.phasecraft/" : "/.phasecraft/.local/";
  const content = `${cleaned ? `${cleaned}\n\n` : ""}${begin}\n${rule}\n${end}\n`;
  await mkdir(path.dirname(excludePath), { recursive: true });
  const temporary = `${excludePath}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
    await rename(temporary, excludePath);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
  return { artifactMode, excludePath, rule };
}

export function dirtyFileOverlaps(baseline, plannedFiles, adoptedFiles = []) {
  const dirty = new Set((baseline?.files ?? []).flatMap((file) => [file.path, file.originalPath].filter(Boolean)));
  const adopted = new Set(adoptedFiles.map(normalizeRepositoryPath));
  const overlaps = [...new Set(plannedFiles.map(normalizeRepositoryPath))].filter(
    (filePath) => dirty.has(filePath) && !adopted.has(filePath),
  );
  return overlaps.sort();
}

function unionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (value) => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  return { parent, find, union };
}

export function mergeCommitGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw gitError("At least one commit group is required", "COMMIT_GROUPS_EMPTY");
  }
  const normalized = groups.map((group, index) => {
    if (!group?.id || !group?.message || !Array.isArray(group.files) || group.files.length === 0) {
      throw gitError(`Commit group ${index + 1} is invalid`, "COMMIT_GROUP_INVALID");
    }
    return {
      id: String(group.id),
      message: String(group.message),
      files: [...new Set(group.files.map(normalizeRepositoryPath))].sort(),
      dependsOn: [...new Set(group.dependsOn ?? [])],
      originalIndex: index,
    };
  });
  if (new Set(normalized.map((group) => group.id)).size !== normalized.length) {
    throw gitError("Commit group ids must be unique", "COMMIT_GROUP_DUPLICATE");
  }
  const sets = normalized.map((group) => new Set(group.files));
  const union = unionFind(normalized.length);
  for (let left = 0; left < sets.length; left += 1) {
    for (let right = left + 1; right < sets.length; right += 1) {
      if ([...sets[left]].some((filePath) => sets[right].has(filePath))) union.union(left, right);
    }
  }
  const components = new Map();
  for (let index = 0; index < normalized.length; index += 1) {
    const root = union.find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(normalized[index]);
  }
  const merged = [...components.values()]
    .sort((left, right) => left[0].originalIndex - right[0].originalIndex)
    .map((members) => {
      const sourceIds = members.map((member) => member.id);
      return {
        id: sourceIds.join("+"),
        sourceIds,
        message: members.map((member) => member.message).join("; "),
        files: [...new Set(members.flatMap((member) => member.files))].sort(),
        rawDependencies: [...new Set(members.flatMap((member) => member.dependsOn).filter((id) => !sourceIds.includes(id)))],
        originalIndex: Math.min(...members.map((member) => member.originalIndex)),
      };
    });
  const sourceToMerged = new Map(merged.flatMap((group) => group.sourceIds.map((id) => [id, group.id])));
  for (const group of merged) {
    const unknown = group.rawDependencies.filter((id) => !sourceToMerged.has(id));
    if (unknown.length > 0) {
      throw gitError(`Commit group ${group.id} has unknown dependencies: ${unknown.join(", ")}`, "COMMIT_DEPENDENCY_UNKNOWN");
    }
    group.dependsOn = [...new Set(group.rawDependencies.map((id) => sourceToMerged.get(id)).filter((id) => id !== group.id))];
  }
  const ordered = [];
  const remaining = new Map(merged.map((group) => [group.id, group]));
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((group) => group.dependsOn.every((id) => ordered.some((entry) => entry.id === id)))
      .sort((left, right) => left.originalIndex - right.originalIndex);
    if (ready.length === 0) {
      throw gitError("Commit group dependencies contain a cycle", "COMMIT_DEPENDENCY_CYCLE");
    }
    for (const group of ready) {
      remaining.delete(group.id);
      const { rawDependencies, originalIndex, ...publicGroup } = group;
      ordered.push(publicGroup);
    }
  }
  return ordered;
}

function globExpression(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "iu");
}

function matchesSensitivePath(filePath, patterns) {
  const base = path.posix.basename(filePath);
  return patterns.some((pattern) => {
    const expression = globExpression(pattern.replaceAll("\\", "/"));
    return expression.test(filePath) || expression.test(base);
  });
}

async function changedPathSet(projectRoot) {
  return new Set((await getStatus(projectRoot)).flatMap((record) => [record.path, record.originalPath].filter(Boolean)));
}

function assertCompleteRenames(status, files, code) {
  const selected = new Set(files);
  for (const record of status) {
    if (!record.originalPath) continue;
    if (selected.has(record.path) !== selected.has(record.originalPath)) {
      throw gitError(`Renamed paths must be approved together: ${record.originalPath}, ${record.path}`, code, {
        paths: [record.originalPath, record.path],
      });
    }
  }
}

export async function patchForFiles(projectRoot, files, status = null) {
  status ??= await getStatus(projectRoot);
  assertCompleteRenames(status, files, "PATCH_RENAME_INCOMPLETE");
  const untrackedSet = new Set(status.filter((record) => record.untracked).map((record) => record.path));
  const tracked = files.filter((filePath) => !untrackedSet.has(filePath));
  const untracked = files.filter((filePath) => untrackedSet.has(filePath));
  const chunks = [];
  if (tracked.length > 0) {
    const result = await runGit(projectRoot, ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-renames", "--", ...tracked]);
    chunks.push(result.stdout);
  }
  for (const filePath of untracked) {
    const result = await runGit(projectRoot, ["diff", "--binary", "--no-index", "--", "/dev/null", filePath], {
      allowFailure: true,
    });
    if (![0, 1].includes(result.exitCode)) {
      throw gitError(`Cannot diff untracked file ${filePath}`, "PATCH_DIFF_FAILED");
    }
    chunks.push(result.stdout);
  }
  return Buffer.concat(chunks);
}

export async function createPatchSnapshot(projectRoot, outputPath, options) {
  const approvedFiles = [...new Set((options?.files ?? []).map(normalizeRepositoryPath))].sort();
  if (approvedFiles.length === 0) throw gitError("Snapshot requires approved files", "SNAPSHOT_FILES_EMPTY");
  if (approvedFiles.some((filePath) => filePath === ".phasecraft" || filePath.startsWith(".phasecraft/"))) {
    throw gitError("Phasecraft artifacts cannot enter recovery patches", "SNAPSHOT_PHASECRAFT_BLOCKED");
  }
  const sensitive = approvedFiles.filter((filePath) => matchesSensitivePath(filePath, options.sensitivePatterns ?? []));
  if (sensitive.length > 0 && !options.allowSensitive) {
    throw gitError(`Sensitive paths require explicit snapshot approval: ${sensitive.join(", ")}`, "SNAPSHOT_SENSITIVE", {
      files: sensitive,
    });
  }
  const changed = await changedPathSet(projectRoot);
  const unchanged = approvedFiles.filter((filePath) => !changed.has(filePath));
  if (unchanged.length > 0) {
    throw gitError(`Snapshot files are not changed: ${unchanged.join(", ")}`, "SNAPSHOT_FILE_UNCHANGED");
  }
  const patch = await patchForFiles(projectRoot, approvedFiles);
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  if (patch.byteLength > maxBytes) {
    throw gitError(`Patch is ${patch.byteLength} bytes; limit is ${maxBytes}`, "SNAPSHOT_TOO_LARGE");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, patch, { flag: "wx", mode: 0o600 });
    await rename(temporary, outputPath);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
  return { outputPath, bytes: patch.byteLength, hash: createHash("sha256").update(patch).digest("hex"), files: approvedFiles };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export async function worktreeFingerprint(projectRoot) {
  const status = (await getStatus(projectRoot)).filter((record) => !record.path.startsWith(".phasecraft/"));
  const files = [];
  for (const record of status) {
    files.push({
      path: record.path,
      indexStatus: record.indexStatus,
      worktreeStatus: record.worktreeStatus,
      originalPath: record.originalPath,
      hash: await contentHash(projectRoot, record.path),
    });
  }
  const payload = { head: await getHead(projectRoot), files };
  return { ...payload, hash: createHash("sha256").update(stableStringify(payload)).digest("hex") };
}

export async function createShipPreview(projectRoot, groups, options = {}) {
  const root = await findGitRoot(projectRoot);
  const mergedGroups = mergeCommitGroups(groups);
  const plannedFiles = [...new Set(mergedGroups.flatMap((group) => group.files))].sort();
  const status = await getStatus(root);
  assertCompleteRenames(status, plannedFiles, "SHIP_RENAME_INCOMPLETE");
  const staged = await cachedFiles(root);
  if (staged.length > 0) {
    throw gitError(`Staged files must be unstaged before Ship preview: ${staged.join(", ")}`, "SHIP_INDEX_DIRTY");
  }
  const overlaps = dirtyFileOverlaps(options.baseline, plannedFiles, options.adoptedFiles ?? []);
  if (overlaps.length > 0) {
    throw gitError(`Baseline-dirty files must be cleaned or adopted: ${overlaps.join(", ")}`, "BASELINE_ADOPTION_REQUIRED", {
      files: overlaps,
    });
  }
  const fingerprint = await worktreeFingerprint(root);
  const changed = new Set(fingerprint.files.flatMap((file) => [file.path, file.originalPath].filter(Boolean)));
  const unchanged = plannedFiles.filter((filePath) => !changed.has(filePath));
  if (unchanged.length > 0) throw gitError(`Planned files are unchanged: ${unchanged.join(", ")}`, "SHIP_FILE_UNCHANGED");
  const fileHashes = Object.fromEntries(
    await Promise.all(plannedFiles.map(async (filePath) => [filePath, await contentHash(root, filePath)])),
  );
  const previewGroups = [];
  for (const group of mergedGroups) {
    const diff = await patchForFiles(root, group.files, status);
    previewGroups.push({
      ...group,
      diff: diff.toString("utf8"),
      diffHash: createHash("sha256").update(diff).digest("hex"),
    });
  }
  const payload = {
    schemaVersion: 1,
    head: fingerprint.head,
    branch: await getBranch(root),
    worktreeHash: fingerprint.hash,
    groups: previewGroups,
    fileHashes,
    excludedChangedFiles: [...new Set(fingerprint.files.flatMap((file) => [file.path, file.originalPath].filter(Boolean)))]
      .filter((filePath) => !plannedFiles.includes(filePath))
      .sort(),
    checks: options.checks ?? [],
    pendingManualChecks: options.pendingManualChecks ?? [],
    contractFingerprint: options.contractFingerprint ?? null,
  };
  const approvalFingerprint = createHash("sha256").update(stableStringify(payload)).digest("hex");
  return { ...payload, approvalFingerprint };
}

async function cachedFiles(projectRoot) {
  const result = await runGit(projectRoot, ["diff", "--cached", "--name-only", "--no-renames", "-z"]);
  return result.stdout.toString("utf8").split("\0").filter(Boolean).map(normalizeRepositoryPath).sort();
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function verifyJournalCommit(root, entry) {
  if (!/^[a-f0-9]{40,64}$/u.test(entry.commit ?? "") || !/^[a-f0-9]{40,64}$/u.test(entry.headBefore ?? "")) {
    throw gitError("Ship journal contains an invalid commit identity", "SHIP_JOURNAL_INVALID");
  }
  const details = await runGit(root, ["show", "-s", "--format=%P%x00%B", entry.commit]);
  const [parent, message] = details.stdout.toString("utf8").split("\0");
  const names = await runGit(root, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", entry.commit]);
  const committedFiles = names.stdout.toString("utf8").split("\0").filter(Boolean).sort();
  const diff = await runGit(root, ["diff", entry.headBefore, entry.commit, "--binary", "--no-ext-diff", "--no-renames", "--", ...entry.files]);
  if (parent.trim() !== entry.headBefore || message.trimEnd() !== entry.message.trimEnd()
    || !equalArrays(committedFiles, [...entry.files].sort())
    || createHash("sha256").update(diff.stdout).digest("hex") !== entry.diffHash) {
    throw gitError("A recorded Ship commit does not match its approved group", "SHIP_JOURNAL_DRIFT", { commits: [entry] });
  }
}

export async function inspectShipJournal(projectRoot, journalPath) {
  const source = await readFile(journalPath, "utf8").catch((cause) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (source === null) return null;
  let journal;
  try { journal = JSON.parse(source); } catch { throw gitError("Ship journal is invalid JSON", "SHIP_JOURNAL_INVALID"); }
  if (journal.schemaVersion !== 1 || !Array.isArray(journal.commits) || !Array.isArray(journal.originalPreview?.groups)) {
    throw gitError("Ship journal is malformed", "SHIP_JOURNAL_INVALID");
  }
  const head = await getHead(projectRoot);
  if (await getBranch(projectRoot) !== journal.originalPreview.branch) throw gitError("Branch changed after Ship started", "SHIP_DRIFT");
  let expectedHead = journal.originalPreview.head;
  const groups = new Map(journal.originalPreview.groups.map((group) => [group.id, group]));
  const seen = new Set();
  for (const commit of journal.commits) {
    const group = groups.get(commit.group);
    if (!group || seen.has(commit.group) || commit.headBefore !== expectedHead
      || commit.message !== group.message || commit.diffHash !== group.diffHash
      || !equalArrays(commit.files, group.files)) throw gitError("Ship journal does not match its approved sequence", "SHIP_JOURNAL_INVALID");
    await verifyJournalCommit(projectRoot, commit);
    seen.add(commit.group);
    expectedHead = commit.commit;
  }
  if (journal.pending && head !== expectedHead) {
    const group = groups.get(journal.pending.group);
    if (!group || seen.has(group.id) || journal.pending.headBefore !== expectedHead) throw gitError("Pending Ship group is invalid", "SHIP_JOURNAL_INVALID");
    const recovered = { group: group.id, commit: head, headBefore: expectedHead, message: group.message, files: group.files, diffHash: group.diffHash };
    await verifyJournalCommit(projectRoot, recovered);
    journal.commits.push(recovered);
    expectedHead = head;
    journal.pending = null;
    journal.recoveredPendingCommit = true;
  }
  if (head !== expectedHead) throw gitError("HEAD changed outside the recorded Ship sequence", "SHIP_DRIFT");
  journal.status = journal.commits.length === groups.size ? "completed" : journal.status === "completed" ? "interrupted" : journal.status;
  return journal;
}

export async function executeShip(projectRoot, preview, approvalFingerprint, options = {}) {
  if (!preview || approvalFingerprint !== preview.approvalFingerprint) {
    throw gitError("Ship approval fingerprint does not match the preview", "SHIP_APPROVAL_INVALID");
  }
  const expectedFingerprint = createHash("sha256")
    .update(stableStringify({
      schemaVersion: preview.schemaVersion,
      head: preview.head,
      branch: preview.branch,
      worktreeHash: preview.worktreeHash,
      groups: preview.groups,
      fileHashes: preview.fileHashes,
      excludedChangedFiles: preview.excludedChangedFiles,
      checks: preview.checks,
      pendingManualChecks: preview.pendingManualChecks,
      contractFingerprint: preview.contractFingerprint ?? null,
    }))
    .digest("hex");
  if (expectedFingerprint !== approvalFingerprint) {
    throw gitError("Ship preview content changed after approval", "SHIP_PREVIEW_TAMPERED");
  }
  if (preview.pendingManualChecks.length > 0 && options.pendingAcknowledgement !== approvalFingerprint) {
    throw gitError("Pending manual checks require a separate exact-preview acknowledgement", "SHIP_PENDING_ACK_REQUIRED");
  }
  let journal = options.journalPath ? await inspectShipJournal(projectRoot, options.journalPath) : null;
  if (journal && journal.contractFingerprint !== preview.contractFingerprint) {
    throw gitError("Ship contract changed after a partial attempt", "SHIP_CONTRACT_STALE");
  }
  if (journal?.status === "completed" && journal.previewFingerprint === approvalFingerprint) {
    if (options.journalPath) await writeJsonAtomic(options.journalPath, journal);
    return { shipped: true, commits: journal.commits, pushed: false, recovered: true };
  }
  const currentHead = await getHead(projectRoot);
  const currentWorktree = await worktreeFingerprint(projectRoot);
  if (currentHead !== preview.head || currentWorktree.hash !== preview.worktreeHash || await getBranch(projectRoot) !== preview.branch) {
    throw gitError("HEAD or worktree changed after Ship preview", "SHIP_DRIFT");
  }
  const initialCached = await cachedFiles(projectRoot);
  const allPlanned = new Set(preview.groups.flatMap((group) => group.files));
  const unrelatedCached = initialCached.filter((filePath) => !allPlanned.has(filePath));
  if (unrelatedCached.length > 0) {
    throw gitError(`Unrelated staged files block Ship: ${unrelatedCached.join(", ")}`, "SHIP_INDEX_DIRTY");
  }

  journal ??= { schemaVersion: 1, contractFingerprint: preview.contractFingerprint, originalPreview: preview, commits: [] };
  journal.previewFingerprint = approvalFingerprint;
  journal.status = "running";
  journal.pending = null;
  const persist = async () => {
    if (options.journalPath) await writeJsonAtomic(options.journalPath, journal);
  };
  await persist();
  const commits = journal.commits;
  try {
    for (let index = 0; index < preview.groups.length; index += 1) {
      const group = preview.groups[index];
      for (const futureGroup of preview.groups.slice(index)) {
        for (const filePath of futureGroup.files) {
          if ((await contentHash(projectRoot, filePath)) !== preview.fileHashes[filePath]) {
            throw gitError(`File changed during Ship: ${filePath}`, "SHIP_DRIFT");
          }
        }
      }
      await runGit(projectRoot, ["add", "-A", "--", ...group.files]);
      const staged = await cachedFiles(projectRoot);
      const expected = [...group.files].sort();
      if (!equalArrays(staged, expected)) {
        throw gitError(`Staged files do not match group ${group.id}`, "SHIP_STAGE_MISMATCH", { staged, expected });
      }
      const diff = await runGit(projectRoot, ["diff", "--cached", "--quiet"], { allowFailure: true });
      if (diff.exitCode === 0) throw gitError(`Commit group ${group.id} has no staged changes`, "SHIP_GROUP_EMPTY");
      if (diff.exitCode !== 1) throw gitError(`Cannot inspect staged changes for ${group.id}`, "SHIP_DIFF_FAILED");
      const stagedDiff = await runGit(projectRoot, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-renames", "--", ...group.files]);
      if (createHash("sha256").update(stagedDiff.stdout).digest("hex") !== group.diffHash) {
        throw gitError("Staged diff differs from the approved preview", "SHIP_DRIFT");
      }
      const headBefore = await getHead(projectRoot);
      journal.pending = { group: group.id, headBefore };
      await persist();
      await runGit(projectRoot, ["commit", "-m", group.message]);
      const commit = await getHead(projectRoot);
      const entry = { group: group.id, commit, headBefore, message: group.message, files: group.files, diffHash: group.diffHash };
      commits.push(entry);
      journal.pending = null;
      await persist();
      await verifyJournalCommit(projectRoot, entry);
      const remainingCached = await cachedFiles(projectRoot);
      if (remainingCached.length > 0) {
        throw gitError("Commit hooks left staged changes; Ship stopped after a partial commit", "SHIP_HOOK_DRIFT", { commits });
      }
      const status = await getStatus(projectRoot);
      const committedStillDirty = status.map((record) => record.path).filter((filePath) => group.files.includes(filePath));
      if (committedStillDirty.length > 0) {
        throw gitError("Commit hooks changed committed files; Ship stopped after a partial commit", "SHIP_HOOK_DRIFT", {
          commits,
          files: committedStillDirty,
        });
      }
    }
  } catch (cause) {
    journal.status = "failed";
    journal.error = { code: cause.code ?? "SHIP_FAILED", message: cause.message };
    await persist();
    cause.details = { ...cause.details, commits, journalPath: options.journalPath ?? null };
    throw cause;
  }
  journal.status = "completed";
  delete journal.error;
  await persist();
  return { shipped: true, commits, pushed: false };
}
