import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { phasecraftPaths, readJson, writeJsonAtomic } from "./state.mjs";

const KNOWN_AUTHORITY_PATHS = Object.freeze([
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "CLAUDE.md",
  "docs/README.md",
  "docs/index.md",
  "docs/INDEX.md",
]);

function knowledgeError(message, code, details = {}) {
  const value = new Error(message);
  value.code = code;
  Object.assign(value, details);
  return value;
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function writeTextAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    await rename(temporary, filePath);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
}

async function safeProjectFile(projectRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath === "" || path.isAbsolute(relativePath)) {
    throw knowledgeError(`Authority path must be relative: ${relativePath}`, "AUTHORITY_PATH_INVALID");
  }
  const root = await realpath(projectRoot);
  const candidate = path.resolve(root, relativePath);
  const resolved = await realpath(candidate).catch((cause) => {
    if (cause.code === "ENOENT") throw knowledgeError(`Authority source does not exist: ${relativePath}`, "AUTHORITY_NOT_FOUND");
    throw cause;
  });
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw knowledgeError(`Authority source escapes the project: ${relativePath}`, "AUTHORITY_PATH_UNSAFE");
  }
  const information = await stat(resolved);
  if (!information.isFile()) throw knowledgeError(`Authority source is not a file: ${relativePath}`, "AUTHORITY_NOT_FILE");
  return { absolute: resolved, relative: path.relative(root, resolved).split(path.sep).join("/") };
}

export async function discoverAuthorityCandidates(projectRoot) {
  const candidates = [];
  for (const relativePath of KNOWN_AUTHORITY_PATHS) {
    try {
      const source = await safeProjectFile(projectRoot, relativePath);
      const content = await readFile(source.absolute);
      candidates.push({ path: source.relative, hash: hash(content), bytes: content.byteLength });
    } catch (cause) {
      if (cause.code !== "AUTHORITY_NOT_FOUND") throw cause;
    }
  }
  return candidates;
}

export async function setAuthoritySources(projectRoot, selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw knowledgeError("At least one confirmed authority source is required", "AUTHORITY_EMPTY");
  }
  const seen = new Set();
  const sources = [];
  for (const [index, selection] of selections.entries()) {
    const source = await safeProjectFile(projectRoot, selection?.path);
    if (seen.has(source.relative)) throw knowledgeError(`Duplicate authority source: ${source.relative}`, "AUTHORITY_DUPLICATE");
    seen.add(source.relative);
    const content = await readFile(source.absolute);
    sources.push({
      path: source.relative,
      authority: selection.authority ?? "confirmed",
      reason: selection.reason ?? null,
      order: index + 1,
      hash: hash(content),
      bytes: content.byteLength,
    });
  }
  const paths = phasecraftPaths(projectRoot);
  const registry = {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    confirmedAt: new Date().toISOString(),
    sources,
  };
  await writeJsonAtomic(path.join(paths.generalKnowledge, "SOURCES.json"), registry);
  const projectMarkdown = `# Project Knowledge Authority\n\n## Confirmed Sources\n\n${sources
    .map((source) => `- ${source.order}. \`${source.path}\` (${source.authority}) SHA-256 \`${source.hash}\`${source.reason ? `: ${source.reason}` : ""}`)
    .join("\n")}\n\n## Rule\n\nA changed source hash is stale evidence and must be reviewed before planning or execution.\n`;
  await writeTextAtomic(path.join(paths.generalKnowledge, "PROJECT.md"), projectMarkdown);
  return registry;
}

export async function checkAuthorityDrift(projectRoot) {
  const filePath = path.join(phasecraftPaths(projectRoot).generalKnowledge, "SOURCES.json");
  const registry = await readJson(filePath);
  const sources = [];
  for (const source of registry.sources ?? []) {
    try {
      const file = await safeProjectFile(projectRoot, source.path);
      const currentHash = hash(await readFile(file.absolute));
      sources.push({
        ...source,
        currentHash,
        status: currentHash === source.hash ? "current" : "stale",
      });
    } catch (cause) {
      if (cause.code !== "AUTHORITY_NOT_FOUND") throw cause;
      sources.push({ ...source, currentHash: null, status: "missing" });
    }
  }
  return {
    valid: sources.length > 0 && sources.every((source) => source.status === "current"),
    sources,
    stale: sources.filter((source) => source.status !== "current").map((source) => source.path),
  };
}
