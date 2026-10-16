#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desiredHostFiles, getHostConfig, SUPPORTED_HOSTS } from "./hosts.mjs";

const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANIFEST_SCHEMA_VERSION = 1;

function installerError(message, code, details = {}) {
  const value = new Error(message);
  value.code = code;
  Object.assign(value, details);
  return value;
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function desiredInstallFiles(sourceRoot = REPOSITORY_ROOT, host = "opencode") {
  return desiredHostFiles(sourceRoot, host);
}

async function readManifest(targetRoot, host) {
  const { manifest: manifestRelativePath, root: hostRoot } = getHostConfig(host);
  const filePath = path.join(targetRoot, ...manifestRelativePath.split("/"));
  if (!(await exists(filePath))) return null;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(filePath, "utf8"));
  } catch (cause) {
    throw installerError(`Invalid Phasecraft install manifest: ${filePath}`, "MANIFEST_INVALID", { cause });
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(manifest.files)) {
    throw installerError("Unsupported Phasecraft install manifest", "MANIFEST_INVALID");
  }
  const targets = new Set();
  for (const entry of manifest.files) {
    const safeTarget = entry
      && typeof entry.target === "string"
      && entry.target !== ""
      && !entry.target.includes("\\")
      && !entry.target.includes("\0")
      && !path.posix.isAbsolute(entry.target)
      && path.posix.normalize(entry.target) === entry.target
      && entry.target.startsWith(`${hostRoot}/`);
    const safeRecord = safeTarget
      && typeof entry.source === "string"
      && /^[a-f0-9]{64}$/u.test(entry.sourceHash)
      && /^[a-f0-9]{64}$/u.test(entry.installedHash)
      && ["copy", "link"].includes(entry.mode);
    if (!safeRecord || targets.has(entry.target)) {
      throw installerError("Install manifest contains an unsafe or duplicate managed file", "MANIFEST_INVALID");
    }
    targets.add(entry.target);
  }
  return manifest;
}

async function targetState(targetRoot, entry) {
  const absolute = path.join(targetRoot, ...entry.target.split("/"));
  const information = await lstat(absolute).catch(() => null);
  if (!information) return { exists: false, absolute };
  if (information.isSymbolicLink()) {
    const link = await readlink(absolute);
    return { exists: true, absolute, kind: "link", link, resolvedLink: path.resolve(path.dirname(absolute), link) };
  }
  if (!information.isFile()) return { exists: true, absolute, kind: "other" };
  const content = await readFile(absolute);
  return { exists: true, absolute, kind: "file", hash: hash(content) };
}

function unchangedFromManifest(state, entry) {
  if (!state.exists) return false;
  if (entry.mode === "link") {
    return state.kind === "link" && state.resolvedLink === path.resolve(entry.linkTarget);
  }
  return state.kind === "file" && state.hash === entry.installedHash;
}

async function atomicWrite(content, target, executable) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: executable ? 0o755 : 0o644 });
    await rename(temporary, target);
    await chmod(target, executable ? 0o755 : 0o644);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    await rename(temporary, filePath);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
}

async function packageVersion(sourceRoot) {
  const packageJson = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  return packageJson.version;
}

export async function installPhasecraft(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? REPOSITORY_ROOT);
  const targetRoot = path.resolve(options.targetRoot ?? process.cwd());
  const mode = options.mode ?? "copy";
  const host = options.host ?? "opencode";
  const hostConfig = getHostConfig(host);
  if (!['copy', 'link'].includes(mode)) throw installerError(`Unknown install mode: ${mode}`, "INSTALL_MODE_INVALID");
  const desired = await desiredInstallFiles(sourceRoot, host);
  const previous = await readManifest(targetRoot, host);
  if (previous?.host && previous.host !== host) {
    throw installerError(`Install manifest belongs to ${previous.host}, not ${host}`, "MANIFEST_INVALID");
  }
  const previousByTarget = new Map((previous?.files ?? []).map((entry) => [entry.target, entry]));
  const desiredTargets = new Set(desired.map((entry) => entry.target));
  const removals = [];

  for (const oldEntry of previous?.files ?? []) {
    if (desiredTargets.has(oldEntry.target)) continue;
    const state = await targetState(targetRoot, oldEntry);
    if (state.exists && !unchangedFromManifest(state, oldEntry)) {
      throw installerError(`Managed file was modified and cannot be replaced: ${oldEntry.target}`, "TARGET_MODIFIED");
    }
    if (state.exists) removals.push(state.absolute);
  }

  for (const entry of desired) {
    const state = await targetState(targetRoot, entry);
    const oldEntry = previousByTarget.get(entry.target);
    if (!state.exists) continue;
    if (!oldEntry) {
      throw installerError(`Unmanaged target already exists: ${entry.target}`, "TARGET_CONFLICT", { target: entry.target });
    }
    if (!unchangedFromManifest(state, oldEntry)) {
      throw installerError(`Managed target was modified: ${entry.target}`, "TARGET_MODIFIED", { target: entry.target });
    }
  }

  for (const absolute of removals) await rm(absolute, { force: true });
  const installed = [];
  for (const entry of desired) {
    const source = entry.generated ? null : path.join(sourceRoot, ...entry.source.split("/"));
    const target = path.join(targetRoot, ...entry.target.split("/"));
    const oldEntry = previousByTarget.get(entry.target);
    if (oldEntry && await exists(target)) await rm(target, { force: true });
    await mkdir(path.dirname(target), { recursive: true });
    if (mode === "link" && !entry.generated) {
      await symlink(source, target, "file");
      installed.push({
        source: entry.source,
        target: entry.target,
        sourceHash: entry.sourceHash,
        executable: entry.executable,
        generated: false,
        mode: "link",
        installedHash: entry.sourceHash,
        linkTarget: source,
      });
    } else {
      const content = entry.generated ? entry.content : await readFile(source);
      await atomicWrite(content, target, entry.executable);
      installed.push({
        source: entry.source,
        target: entry.target,
        sourceHash: entry.sourceHash,
        executable: entry.executable,
        generated: entry.generated,
        mode: "copy",
        installedHash: entry.sourceHash,
        linkTarget: null,
      });
    }
  }

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version: await packageVersion(sourceRoot),
    host,
    mode,
    sourceRoot,
    installedAt: new Date().toISOString(),
    files: installed,
  };
  await atomicJson(path.join(targetRoot, ...hostConfig.manifest.split("/")), manifest);
  return { action: "install", host, targetRoot, mode, version: manifest.version, files: installed.length, restartRequired: true };
}

export async function checkPhasecraft(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? REPOSITORY_ROOT);
  const targetRoot = path.resolve(options.targetRoot ?? process.cwd());
  const host = options.host ?? "opencode";
  getHostConfig(host);
  const manifest = await readManifest(targetRoot, host);
  if (!manifest) throw installerError(`Phasecraft is not installed for ${host}`, "NOT_INSTALLED");
  const desired = await desiredInstallFiles(sourceRoot, host);
  const desiredByTarget = new Map(desired.map((entry) => [entry.target, entry]));
  const statuses = [];
  for (const entry of manifest.files) {
    const state = await targetState(targetRoot, entry);
    const source = desiredByTarget.get(entry.target);
    let status = "ok";
    if (!state.exists) status = "missing";
    else if (!unchangedFromManifest(state, entry)) status = "modified";
    else if (!source || source.sourceHash !== entry.sourceHash) status = "update-available";
    statuses.push({ target: entry.target, status });
  }
  for (const entry of desired) {
    if (!manifest.files.some((installed) => installed.target === entry.target)) {
      statuses.push({ target: entry.target, status: "not-installed" });
    }
  }
  return { action: "check", host, healthy: statuses.every(({ status }) => status === "ok"), statuses };
}

async function cleanManagedParents(targetRoot, targets, host) {
  const boundary = path.join(targetRoot, getHostConfig(host).root);
  const directories = [...new Set(targets.map((target) => path.dirname(path.join(targetRoot, ...target.split("/")))))]
    .sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    let current = directory;
    while (current.startsWith(`${boundary}${path.sep}`)) {
      try {
        await rmdir(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
}

export async function uninstallPhasecraft(options = {}) {
  const targetRoot = path.resolve(options.targetRoot ?? process.cwd());
  const host = options.host ?? "opencode";
  const { manifest: manifestRelativePath } = getHostConfig(host);
  const manifest = await readManifest(targetRoot, host);
  if (!manifest) return { action: "uninstall", host, removed: 0, preserved: [], restartRequired: false };
  const removedTargets = [];
  const preserved = [];
  for (const entry of manifest.files) {
    const state = await targetState(targetRoot, entry);
    if (!state.exists) continue;
    if (!unchangedFromManifest(state, entry)) {
      preserved.push(entry);
      continue;
    }
    await rm(state.absolute, { force: true });
    removedTargets.push(entry.target);
  }
  const manifestPath = path.join(targetRoot, ...manifestRelativePath.split("/"));
  if (preserved.length > 0) {
    await atomicJson(manifestPath, { ...manifest, files: preserved, uninstallIncomplete: true });
  } else {
    await rm(manifestPath, { force: true });
  }
  await cleanManagedParents(targetRoot, [...removedTargets, ...(preserved.length === 0 ? [manifestRelativePath] : [])], host);
  return {
    action: "uninstall",
    host,
    removed: removedTargets.length,
    preserved: preserved.map((entry) => entry.target),
    restartRequired: removedTargets.length > 0,
  };
}

function parseCli(argv) {
  const values = [...argv];
  let action = "install";
  if (values[0] && !values[0].startsWith("--")) action = values.shift();
  if (!["install", "check", "uninstall", "help"].includes(action)) {
    throw installerError(`Unknown installer action: ${action}`, "OPTION_INVALID");
  }
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw installerError(`Unexpected argument: ${value}`, "OPTION_INVALID");
    const name = value.slice(2);
    if (!["host", "target", "link", "check", "uninstall", "help"].includes(name)) {
      throw installerError(`Unknown option: --${name}`, "OPTION_INVALID");
    }
    if (["link", "check", "uninstall", "help"].includes(name)) flags[name] = true;
    else {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw installerError(`--${name} requires a value`, "OPTION_REQUIRED");
      flags[name] = next;
      index += 1;
    }
  }
  if (flags.check) action = "check";
  if (flags.uninstall) action = "uninstall";
  if (flags.help) action = "help";
  return { action, flags };
}

export function installerHelp() {
  return `Phasecraft\n\nUsage:\n  phasecraft install --host <host> [--target PATH] [--link]\n  phasecraft check --host <host> [--target PATH]\n  phasecraft uninstall --host <host> [--target PATH]\n  phasecraft runtime <command> [options]\n\nHosts:\n  ${SUPPORTED_HOSTS.join(", ")}, all\n\nExamples:\n  npx @ahmadhm/phasecraft install --host opencode\n  npx @ahmadhm/phasecraft install --host all --target /path/to/project\n`;
}

export async function runInstaller(argv) {
  const { action, flags } = parseCli(argv);
  if (action === "help") return { action: "help", help: installerHelp() };
  const requestedHost = flags.host ?? "opencode";
  const hosts = requestedHost === "all" ? SUPPORTED_HOSTS : [requestedHost];
  const results = [];
  for (const host of hosts) {
    const options = { host, targetRoot: flags.target, mode: flags.link ? "link" : "copy" };
    const result = action === "uninstall"
      ? await uninstallPhasecraft(options)
      : action === "check"
        ? await checkPhasecraft(options)
        : await installPhasecraft(options);
    results.push(result);
  }
  if (results.length === 1) return results[0];
  return {
    action,
    host: "all",
    healthy: action === "check" ? results.every((result) => result.healthy) : undefined,
    restartRequired: results.some((result) => result.restartRequired),
    results,
  };
}

export function restartMessage(result) {
  if (!result?.restartRequired) return null;
  if (result.host === "all") return "Restart or reload each installed coding agent to load Phasecraft changes.";
  return getHostConfig(result.host).restart;
}

async function main(argv) {
  const { action } = parseCli(argv);
  if (action === "help") {
    process.stdout.write(installerHelp());
    return;
  }
  const result = await runInstaller(argv);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (action === "check" && !result.healthy) process.exitCode = 1;
  const message = restartMessage(result);
  if (message) process.stdout.write(`${message}\n`);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${JSON.stringify({ error: cause.message, code: cause.code ?? "INSTALL_FAILED" }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
