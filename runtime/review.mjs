import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWork } from "./state.mjs";
import { reviewClientJs, reviewCss, reviewShellHtml, SHELL_CSP } from "./review-ui.mjs";
import { stageInvocation, workflowHost } from "./hosts.mjs";

// Feedback integration adapter. These are the only functions that know the expected
// feedback.mjs surface; callers can inject equivalent methods while that module evolves.
let feedbackModulePromise;
async function feedbackModule() {
  feedbackModulePromise ??= import("./feedback.mjs").catch((cause) => {
    if (cause?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw cause;
  });
  return feedbackModulePromise;
}

function feedbackArtifact(artifact) {
  return {
    kind: artifact.kind,
    path: artifact.path,
    sourcePath: artifact.sourcePath,
    sourceHash: artifact.sourceHash,
    htmlHash: artifact.htmlHash,
    phase: artifact.phase,
  };
}

function browserDraft(draft, artifacts) {
  const artifactPath = draft.artifactPath ?? draft.artifact?.path;
  const sourceHash = draft.sourceHash ?? draft.artifact?.sourceHash;
  const htmlHash = draft.htmlHash ?? draft.artifact?.htmlHash;
  const artifact = artifacts.find((candidate) =>
    (draft.artifactKey ? candidate.key === draft.artifactKey : candidate.path === artifactPath) &&
    candidate.path === artifactPath && candidate.sourceHash === sourceHash && candidate.htmlHash === htmlHash,
  );
  return {
    ...draft,
    artifactKey: artifact?.key ?? draft.artifactKey ?? null,
    artifactPath,
    sourceHash,
    htmlHash,
    status: draft.status === "draft" && !artifact ? "stale" : draft.status,
  };
}

export function createFeedbackAdapter(overrides = {}) {
  return {
    async listDrafts(context) {
      if (overrides.listDrafts) return overrides.listDrafts(context);
      const module = await feedbackModule();
      const drafts = module?.listReviewDrafts
        ? await module.listReviewDrafts(context.state)
        : module?.listDrafts
          ? await module.listDrafts(context.state)
          : await fallbackListDrafts(context);
      const comments = new Map(drafts.map((draft) => {
        const browser = browserDraft(draft, context.artifacts);
        return [`draft\0${browser.artifactPath}\0${browser.sourceHash}\0${browser.htmlHash}\0${browser.id}`, browser];
      }));
      if (module?.listFeedback && module?.showFeedback) {
        for (const summary of await module.listFeedback(context.state)) {
          const shown = await module.showFeedback(context.state, summary.id);
          const resolutionByComment = new Map((shown.resolution?.comments ?? []).map((entry) => [entry.id, entry]));
          for (const comment of shown.batch.comments) {
            const resolution = resolutionByComment.get(comment.id);
            const browser = browserDraft({
              ...comment,
              artifact: shown.batch.artifact,
              status: resolution ? "addressed" : "submitted",
              disposition: resolution?.disposition ?? null,
              feedbackId: shown.batch.id,
            }, context.artifacts);
            comments.set(`submitted\0${shown.batch.id}\0${browser.id}`, browser);
            for (const [key, candidate] of comments) {
              if (candidate.status === "draft"
                && candidate.id === browser.id
                && candidate.artifactPath === browser.artifactPath
                && candidate.sourceHash === browser.sourceHash
                && candidate.htmlHash === browser.htmlHash) comments.delete(key);
            }
          }
        }
      }
      return [...comments.values()];
    },
    async saveDraft(context, draft) {
      if (overrides.saveDraft) return overrides.saveDraft(context, draft);
      const module = await feedbackModule();
      const input = {
        artifact: feedbackArtifact(context.artifact),
        id: draft.id,
        anchor: draft.anchor,
        bodyMarkdown: draft.bodyMarkdown,
        createdAt: draft.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const saved = module?.saveReviewDraft
        ? await module.saveReviewDraft(context.state, input)
        : module?.saveDraft
          ? await module.saveDraft(context.state, input, { verifyBinding: true })
          : await fallbackSaveDraft(context, draft);
      return browserDraft(saved, context.artifacts);
    },
    async deleteDraft(context, draft) {
      if (overrides.deleteDraft) return overrides.deleteDraft(context, draft);
      const module = await feedbackModule();
      if (module?.deleteDraft) {
        return module.deleteDraft(context.state, { id: draft.id, artifact: feedbackArtifact(context.artifact) });
      }
      if (module?.deleteReviewDraft) {
        return module.deleteReviewDraft(context.state, { id: draft.id, artifact: feedbackArtifact(context.artifact) });
      }
      return fallbackDeleteDraft(context, draft);
    },
    async publish(context, input) {
      if (overrides.publish) return overrides.publish(context, input);
      const module = await feedbackModule();
      const publishInput = {
        artifact: feedbackArtifact(context.artifact),
        comments: input.comments.map(({ id, anchor, bodyMarkdown, createdAt }) => ({ id, anchor, bodyMarkdown, createdAt })),
      };
      if (module?.publishReviewFeedback) {
        return module.publishReviewFeedback(context.state, publishInput, { confirmSensitive: input.confirmedSensitive === true });
      }
      if (module?.publishFeedback) {
        return module.publishFeedback(context.state, publishInput, { confirmSensitive: input.confirmedSensitive === true });
      }
      return fallbackPublish(context, input);
    },
  };
}

const HOST = "127.0.0.1";
const BODY_LIMIT = 256 * 1024;
const MAX_COMMENTS = 200;
const MAX_MARKDOWN = 16 * 1024;
const MAX_FIELDS = 80;
const MAX_ANCHOR_DEPTH = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const COOKIE_NAME = "phasecraft_review";
const LOCAL_SERVERS = new Map();
const ARTIFACT_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; font-src data: 'self'";

function reviewError(message, code, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function safeRegularFile(root, filePath) {
  const rootReal = await realpath(root);
  const absolute = path.resolve(filePath);
  if (!contained(path.resolve(root), absolute)) throw reviewError("Artifact path escapes its work root", "REVIEW_PATH_UNSAFE", 403);
  const information = await lstat(absolute).catch(() => null);
  if (!information?.isFile() || information.isSymbolicLink()) throw reviewError("Artifact is not a regular file", "REVIEW_PATH_UNSAFE", 403);
  if (information.size > 64 * 1024 * 1024) throw reviewError("Artifact is too large to review", "REVIEW_ARTIFACT_TOO_LARGE", 413);
  const actual = await realpath(absolute);
  if (!contained(rootReal, actual)) throw reviewError("Artifact symlink escapes its work root", "REVIEW_PATH_UNSAFE", 403);
  return actual;
}

function sourceBinding(html) {
  const match = html.match(/<meta\s+name=["']phasecraft-source-sha256["']\s+content=["']([a-f0-9]{64})["']\s*\/?\s*>/iu)
    ?? html.match(/<meta\s+content=["']([a-f0-9]{64})["']\s+name=["']phasecraft-source-sha256["']\s*\/?\s*>/iu);
  return match?.[1]?.toLowerCase() ?? null;
}

function reviewManifest(html) {
  const source = html.match(/<script\b(?=[^>]*\bid=["']phasecraft-review-manifest["'])[^>]*>([\s\S]*?)<\/script>/iu)?.[1];
  if (!source) return null;
  try {
    const manifest = JSON.parse(source);
    return manifest?.schemaVersion === 1 && Array.isArray(manifest.entries) ? manifest : null;
  } catch {
    return null;
  }
}

function artifactAnchors(html) {
  const manifest = reviewManifest(html);
  if (manifest) return new Set(manifest.entries.map((entry) => entry.semantic));
  return new Set([...html.matchAll(/\bdata-phasecraft-anchor=["']([^"']+)["']/gu)].map((match) => match[1]));
}

function decodeHtmlText(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value
    .replace(/<script\b[\s\S]*?<\/script\s*>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/giu, (_match, entity) => {
      if (entity[0] !== "#") return named[entity.toLowerCase()] ?? " ";
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    })
    .replace(/\s+/gu, " ")
    .trim();
}

function anchorText(html, semantic) {
  const manifestEntry = reviewManifest(html)?.entries.find((entry) => entry.semantic === semantic);
  if (manifestEntry && typeof manifestEntry.plainText === "string") return manifestEntry.plainText.replace(/\s+/gu, " ").trim();
  const doubleMarker = `data-phasecraft-anchor="${semantic}"`;
  const singleMarker = `data-phasecraft-anchor='${semantic}'`;
  const markerIndex = html.indexOf(doubleMarker) === -1 ? html.indexOf(singleMarker) : html.indexOf(doubleMarker);
  if (markerIndex === -1) return null;
  const openingStart = html.lastIndexOf("<", markerIndex);
  const openingEnd = html.indexOf(">", markerIndex);
  const opening = html.slice(openingStart, openingEnd + 1);
  const tag = opening.match(/^<([A-Za-z][A-Za-z0-9:-]*)\b/u)?.[1];
  if (!tag) return null;
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, "giu");
  tags.lastIndex = openingStart;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (match[0][1] === "/") depth -= 1;
    else if (!/\/\s*>$/u.test(match[0])) depth += 1;
    if (depth === 0) return decodeHtmlText(html.slice(openingEnd + 1, match.index));
  }
  return null;
}

async function artifactCandidate(root, htmlPath, sourcePath, kind) {
  const [safeHtml, safeSource] = await Promise.all([safeRegularFile(root, htmlPath), safeRegularFile(root, sourcePath)]);
  const [html, source] = await Promise.all([readFile(safeHtml), readFile(safeSource)]);
  const expectedSourceHash = sha256(source);
  if (sourceBinding(html.toString("utf8")) !== expectedSourceHash) {
    throw reviewError(`${path.basename(htmlPath)} is not bound to its current Markdown source`, "REVIEW_ARTIFACT_STALE", 409);
  }
  const relativeHtml = path.relative(root, safeHtml).split(path.sep).join("/");
  const relativeSource = path.relative(root, safeSource).split(path.sep).join("/");
  const phase = kind === "plan" ? relativeHtml.match(/(?:^|\/)(P-\d{2})(?:[-/]|$)/u)?.[1] ?? null : null;
  const version = kind === "plan" ? relativeHtml.match(/\/versions\/(v\d+)\/plan\.html$/u)?.[1] ?? null : null;
  const key = `${kind}-${sha256(relativeHtml).slice(0, 16)}`;
  return Object.freeze({
    key,
    kind,
    label: kind === "roadmap" ? "Roadmap · All phases" : `${phase ? `${phase} · ` : ""}Plan${version ? ` · archived ${version}` : ""}`,
    path: relativeHtml,
    sourcePath: relativeSource,
    absolutePath: safeHtml,
    absoluteSourcePath: safeSource,
    sourceHash: expectedSourceHash,
    htmlHash: sha256(html),
    phase,
    version,
    bytes: html.byteLength,
    snapshot: html,
  });
}

function selectReviewArtifact(artifacts, state, options = {}) {
  if (options.artifactKey) return artifacts.find((item) => item.key === options.artifactKey);
  if (options.artifact && !["plan", "roadmap"].includes(options.artifact)) {
    return artifacts.find((item) => item.path === options.artifact || item.key === options.artifact);
  }
  if (options.artifact === "roadmap") return artifacts.find((item) => item.kind === "roadmap");
  return artifacts.find((item) => item.kind === "plan" && item.phase === state.activePhase && !item.version)
    ?? artifacts.find((item) => item.kind === "plan" && !item.version)
    ?? artifacts[0];
}

async function phaseDirectories(phasesRoot) {
  const entries = await readdir(phasesRoot, { withFileTypes: true }).catch((cause) => {
    if (cause?.code === "ENOENT") return [];
    throw cause;
  });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^P-\d{2}(?:-|$)/u.test(entry.name))
    .map((entry) => path.join(phasesRoot, entry.name))
    .sort();
}

export async function discoverReviewArtifacts(state) {
  if (!state?.artifactRoot) throw reviewError("Resolved work state with artifactRoot is required", "REVIEW_STATE_REQUIRED");
  const root = path.resolve(state.artifactRoot);
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw reviewError("Artifact root is not a safe directory", "REVIEW_ROOT_UNSAFE");
  const candidates = [[path.join(root, "plan", "roadmap.html"), path.join(root, "plan", "ROADMAP.md"), "roadmap"]];
  for (const directory of await phaseDirectories(path.join(root, "plan", "phases"))) {
    candidates.push([path.join(directory, "plan.html"), path.join(directory, "PLAN.md"), "plan"]);
    const versionsRoot = path.join(directory, "versions");
    const versions = await readdir(versionsRoot, { withFileTypes: true }).catch((cause) => cause?.code === "ENOENT" ? [] : Promise.reject(cause));
    for (const version of versions.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^v\d+$/u.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))) {
      const archived = path.join(versionsRoot, version.name);
      candidates.push([path.join(archived, "plan.html"), path.join(archived, "PLAN.md"), "plan"]);
    }
  }
  const artifacts = [];
  for (const candidate of candidates) {
    const exists = await lstat(candidate[0]).catch(() => null);
    if (!exists) continue;
    artifacts.push(await artifactCandidate(root, ...candidate));
  }
  if (artifacts.length === 0) throw reviewError("No valid generated roadmap or plan HTML was found", "REVIEW_ARTIFACTS_EMPTY", 404);
  return artifacts;
}

async function verifyArtifactCurrent(artifact) {
  const [html, source] = await Promise.all([readFile(artifact.absolutePath), readFile(artifact.absoluteSourcePath)]);
  const sourceHash = sha256(source);
  const htmlHash = sha256(html);
  if (sourceHash !== artifact.sourceHash || htmlHash !== artifact.htmlHash || sourceBinding(html.toString("utf8")) !== sourceHash) {
    throw reviewError("Artifact or authoritative source changed after this review session started", "REVIEW_ARTIFACT_STALE", 409);
  }
  return html;
}

function reviewsRoot(state) {
  if (!state?.localWorkRoot) throw reviewError("Resolved work state with localWorkRoot is required", "REVIEW_STATE_REQUIRED");
  return path.join(path.resolve(state.localWorkRoot), "reviews");
}

function sessionPath(state) {
  return path.join(reviewsRoot(state), "sessions", "current.json");
}

async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
}

async function readSession(stateOrRoot) {
  const filePath = typeof stateOrRoot === "string"
    ? path.join(path.resolve(stateOrRoot), "reviews", "sessions", "current.json")
    : sessionPath(stateOrRoot);
  return JSON.parse(await readFile(filePath, "utf8"));
}

function publicArtifact(artifact) {
  const { absolutePath, absoluteSourcePath, snapshot, ...safe } = artifact;
  return safe;
}

function securityHeaders(response, csp = SHELL_CSP) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", csp);
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function send(response, status, body, contentType = "application/json; charset=utf-8", csp = SHELL_CSP, frameOptions = "DENY") {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : `${JSON.stringify(body)}\n`);
  response.statusCode = status;
  securityHeaders(response, csp);
  response.setHeader("x-frame-options", frameOptions);
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", payload.byteLength);
  response.end(payload);
}

function cookies(request) {
  const result = new Map();
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

async function jsonBody(request, limit = BODY_LIMIT) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw reviewError("Request body is too large", "REVIEW_BODY_TOO_LARGE", 413);
  }
  let tooLarge = false;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > limit) tooLarge = true;
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw reviewError("Request body is too large", "REVIEW_BODY_TOO_LARGE", 413);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (cause) {
    throw reviewError("Request body must be valid JSON", "REVIEW_JSON_INVALID", 400, { cause });
  }
}

function countFields(value, depth = 0) {
  if (depth > MAX_ANCHOR_DEPTH) throw reviewError("Request nesting is too deep", "REVIEW_DEPTH_LIMIT", 422);
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((total, child) => total + countFields(child, depth + 1), 0);
  let count = 0;
  for (const child of Object.values(value)) {
    count += 1 + countFields(child, depth + 1);
    if (count > MAX_FIELDS) throw reviewError("Request has too many fields", "REVIEW_FIELD_LIMIT", 422);
  }
  return count;
}

function validRelativeIdentity(value, max = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);
}

function validateCommentAnchor(comment, artifact) {
  const semantic = comment.anchor?.semantic;
  if (
    !validRelativeIdentity(semantic, 512) ||
    semantic.split("/").length > MAX_ANCHOR_DEPTH ||
    semantic.split("/").some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))
  ) {
    throw reviewError("Semantic anchor is invalid", "REVIEW_ANCHOR_INVALID", 422);
  }
  const html = artifact.snapshot.toString("utf8");
  if (!artifactAnchors(html).has(semantic)) throw reviewError("Semantic anchor is not present in this artifact", "REVIEW_ANCHOR_STALE", 409);
  const selection = comment.anchor.quote !== undefined;
  if (!selection) return;
  if (!validRelativeIdentity(comment.anchor.quote, 2048) || !Number.isSafeInteger(comment.anchor.start) || !Number.isSafeInteger(comment.anchor.end) || comment.anchor.start < 0 || comment.anchor.end <= comment.anchor.start || comment.anchor.end - comment.anchor.start !== comment.anchor.quote.length) {
    throw reviewError("Text selection anchor is invalid", "REVIEW_ANCHOR_INVALID", 422);
  }
  for (const field of ["prefix", "suffix"]) {
    if (typeof comment.anchor[field] !== "string" || comment.anchor[field].length > 256) throw reviewError("Selection context is invalid", "REVIEW_ANCHOR_INVALID", 422);
  }
  const text = anchorText(html, semantic);
  const matches = [];
  for (let index = text?.indexOf(comment.anchor.quote) ?? -1; index !== -1; index = text.indexOf(comment.anchor.quote, index + 1)) matches.push(index);
  const contextual = matches.filter((index) =>
    text.slice(Math.max(0, index - comment.anchor.prefix.length), index).endsWith(comment.anchor.prefix) &&
    text.slice(index + comment.anchor.quote.length, index + comment.anchor.quote.length + comment.anchor.suffix.length).startsWith(comment.anchor.suffix),
  );
  if (contextual.length !== 1) throw reviewError("Text selection no longer resolves uniquely in its semantic anchor", "REVIEW_ANCHOR_STALE", 409);
}

function validateDraftBinding(input, artifact, routeId) {
  countFields(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw reviewError("Draft must be an object", "REVIEW_DRAFT_INVALID", 422);
  if (input.id !== routeId || !/^FC-[A-Za-z0-9-]{3,80}$/u.test(routeId)) throw reviewError("Draft id is invalid", "REVIEW_DRAFT_INVALID", 422);
  if (input.artifactKey !== artifact.key || input.sourceHash !== artifact.sourceHash || input.htmlHash !== artifact.htmlHash) throw reviewError("Draft artifact binding is stale", "REVIEW_ARTIFACT_STALE", 409);
}

function validateDraft(input, artifact, routeId) {
  validateDraftBinding(input, artifact, routeId);
  validateCommentAnchor(input, artifact);
  if (typeof input.bodyMarkdown !== "string" || Buffer.byteLength(input.bodyMarkdown) > MAX_MARKDOWN || input.bodyMarkdown.trim() === "") throw reviewError("Comment Markdown is empty or too large", "REVIEW_MARKDOWN_INVALID", 422);
  if (/<\/?[A-Za-z][^>]*>/u.test(input.bodyMarkdown)) throw reviewError("Raw HTML is not supported in comments", "REVIEW_MARKDOWN_HTML", 422);
  return { ...input, artifactPath: artifact.path, sourcePath: artifact.sourcePath, status: "draft" };
}

function sameOrigin(request, expectedOrigin) {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin === expectedOrigin;
}

function mutationRequest(request, origin, csrf, { bootstrap = false } = {}) {
  if (!sameOrigin(request, origin)) throw reviewError("Mutation Origin is not this review server", "REVIEW_ORIGIN_INVALID", 403);
  if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw reviewError("Mutations require application/json", "REVIEW_CONTENT_TYPE", 415);
  if (bootstrap) {
    if (request.headers["x-phasecraft-bootstrap"] !== "1") throw reviewError("Bootstrap header is required", "REVIEW_BOOTSTRAP_HEADER", 403);
  } else if (!secureEqual(request.headers["x-phasecraft-csrf"], csrf)) {
    throw reviewError("CSRF token is missing or invalid", "REVIEW_CSRF_INVALID", 403);
  }
}

function fallbackDraftPath(context, draft) {
  return path.join(reviewsRoot(context.state), "drafts", draft.artifactKey, draft.sourceHash, `${draft.id}.json`);
}

async function fallbackListDrafts(context) {
  const draftsRoot = path.join(reviewsRoot(context.state), "drafts");
  const output = [];
  async function walk(directory, depth = 0) {
    if (depth > 4) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause) => cause?.code === "ENOENT" ? [] : Promise.reject(cause));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const draft = JSON.parse(await readFile(target, "utf8")).draft;
        if (draft) output.push(draft);
      }
    }
  }
  await walk(draftsRoot);
  return output;
}

async function fallbackSaveDraft(context, draft) {
  await writePrivateJson(fallbackDraftPath(context, draft), { schemaVersion: 1, draft });
  return draft;
}

async function fallbackDeleteDraft(context, draft) {
  const filePath = fallbackDraftPath(context, draft);
  try {
    await rm(filePath);
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
  await rm(path.dirname(filePath), { recursive: false }).catch(() => {});
  await rm(path.dirname(path.dirname(filePath)), { recursive: false }).catch(() => {});
  return true;
}

function markdownFence(value) {
  return String(value).replaceAll("```", "` ` `");
}

async function fallbackPublish(context, input) {
  const batches = path.join(reviewsRoot(context.state), "batches");
  const feedbackRoot = path.join(path.resolve(context.state.artifactRoot), "feedback");
  await Promise.all([mkdir(batches, { recursive: true, mode: 0o700 }), mkdir(feedbackRoot, { recursive: true })]);
  const existing = await readdir(batches).catch(() => []);
  const sequence = Math.max(0, ...existing.map((name) => Number(name.match(/^FB-(\d{3})\.json$/u)?.[1] ?? 0))) + 1;
  const id = `FB-${String(sequence).padStart(3, "0")}`;
  const publishedAt = new Date().toISOString();
  const comments = input.comments.map((comment, index) => ({ ...comment, id: `FC-${String(index + 1).padStart(3, "0")}`, status: "submitted" }));
  const batch = { schemaVersion: 1, id, work: context.work, artifact: publicArtifact(context.artifact), publishedAt, comments };
  const jsonPath = path.join(batches, `${id}.json`);
  const handle = await open(jsonPath, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(batch, null, 2)}\n`); } finally { await handle.close(); }
  const lines = [`# Feedback ${id}`, "", `- Work: ${context.work}`, `- Artifact: ${context.artifact.path}`, `- Source: ${context.artifact.sourcePath}`, `- Source SHA-256: ${context.artifact.sourceHash}`, `- HTML SHA-256: ${context.artifact.htmlHash}`, `- Published: ${publishedAt}`, `- Comments: ${comments.length}`, "", "## Comments", ""];
  for (const comment of comments) lines.push(`### ${comment.id}: ${comment.anchor.semantic}`, ...(comment.anchor.quote ? [`- Selected text: \`${comment.anchor.quote.replaceAll("`", "\\`")}\``] : []), "- Status: submitted", "", "#### Comment", "```markdown", markdownFence(comment.bodyMarkdown), "```", "");
  await writeFile(path.join(feedbackRoot, `${id}.md`), `${lines.join("\n")}\n`, { flag: "wx", mode: 0o644 });
  return { id, work: context.work, batch };
}

export function browserLaunchCommand(url, platform = process.platform) {
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url], windowsHide: true };
  return null;
}

export async function openReviewBrowser(url, options = {}) {
  if (options.noOpen || process.env.PHASECRAFT_NO_BROWSER === "1") return { opened: false, reason: "disabled" };
  const launch = browserLaunchCommand(url, options.platform);
  if (!launch) return { opened: false, reason: "unsupported-platform" };
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: launch.windowsHide === true });
    let settled = false;
    child.once("error", (cause) => { if (!settled) { settled = true; resolve({ opened: false, reason: cause.code ?? "launch-failed" }); } });
    child.once("spawn", () => { if (!settled) { settled = true; child.unref(); resolve({ opened: true }); } });
  });
}

function sanitizeSession(session) {
  const { bootstrapToken, cookieToken, csrfToken, controlToken, url, ...safe } = session;
  return { ...safe, url: session.origin ? `${session.origin}/` : undefined };
}

function startSessionResult(session) {
  return { ...sanitizeSession(session), url: session.url };
}

export async function startReviewServer(options) {
  const state = options?.state;
  const agentHost = workflowHost(options.host);
  const artifacts = options?.artifacts ?? await discoverReviewArtifacts(state);
  const active = selectReviewArtifact(artifacts, state, options);
  if (!active) throw reviewError("Requested review artifact is not allowlisted", "REVIEW_ARTIFACT_UNKNOWN", 404);
  const adapter = options.feedbackAdapter ?? createFeedbackAdapter(options.feedback ?? {});
  const bootstrapToken = options.bootstrapToken ?? randomBytes(32).toString("base64url");
  const cookieToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const controlToken = randomBytes(32).toString("base64url");
  const sessionId = randomBytes(16).toString("hex");
  const work = options.work ?? state.id ?? state.key;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const artifactMap = new Map(artifacts.map((item) => [item.key, item]));
  let expectedHost;
  let origin;
  let lastActivity = Date.now();
  let closing = false;
  let idleTimer;
  const context = { state, artifacts, work };

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== expectedHost) throw reviewError("Host does not match this review server", "REVIEW_HOST_INVALID", 403);
      const url = new URL(request.url, origin);
      if (url.origin !== origin) throw reviewError("Request target is invalid", "REVIEW_TARGET_INVALID", 400);
      if (url.pathname !== "/health") lastActivity = Date.now();
      if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true, pid: process.pid, sessionId });
      if (request.method === "POST" && url.pathname === "/auth/exchange") {
        mutationRequest(request, origin, csrfToken, { bootstrap: true });
        const body = await jsonBody(request, 4096);
        if (!secureEqual(body.token, bootstrapToken)) throw reviewError("Capability token is invalid", "REVIEW_CAPABILITY_INVALID", 401);
        response.setHeader("set-cookie", `${COOKIE_NAME}=${cookieToken}; Path=/; HttpOnly; SameSite=Strict`);
        return send(response, 200, { authenticated: true, csrf: csrfToken });
      }
      // The inert shell and its fixed self assets must load before fragment exchange;
      // protected data and the artifact remain unavailable until the cookie exists.
      if (request.method === "GET" && url.pathname === "/") return send(response, 200, reviewShellHtml(), "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/assets/review.css") return send(response, 200, reviewCss(), "text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/assets/review.js") return send(response, 200, reviewClientJs(), "text/javascript; charset=utf-8");
      const authenticated = secureEqual(cookies(request).get(COOKIE_NAME), cookieToken);
      if (!authenticated) throw reviewError("Review session authentication is required", "REVIEW_AUTH_REQUIRED", 401);
      if (request.method === "GET" && url.pathname === "/api/session") {
        const drafts = await adapter.listDrafts(context);
        return send(response, 200, { work, agentHost, csrf: csrfToken, activeKey: active.key, artifacts: artifacts.map(publicArtifact), drafts });
      }
      const artifactMatch = request.method === "GET" && url.pathname.match(/^\/artifact\/([A-Za-z0-9_-]+)$/u);
      if (artifactMatch) {
        const artifact = artifactMap.get(decodeURIComponent(artifactMatch[1]));
        if (!artifact) throw reviewError("Artifact is not allowlisted", "REVIEW_ARTIFACT_UNKNOWN", 404);
        const bytes = await verifyArtifactCurrent(artifact);
        response.setHeader("content-disposition", "inline");
        response.setHeader("x-phasecraft-source-sha256", artifact.sourceHash);
        return send(response, 200, bytes, "text/html; charset=utf-8", ARTIFACT_CSP, "SAMEORIGIN");
      }
      const draftMatch = ["PUT", "DELETE"].includes(request.method) && url.pathname.match(/^\/api\/drafts\/(FC-[A-Za-z0-9-]+)$/u);
      if (draftMatch) {
        mutationRequest(request, origin, csrfToken);
        const body = await jsonBody(request);
        const artifact = artifactMap.get(body.artifactKey);
        if (!artifact) throw reviewError("Artifact is not allowlisted", "REVIEW_ARTIFACT_UNKNOWN", 404);
        await verifyArtifactCurrent(artifact);
        if (request.method === "PUT") {
          const draft = validateDraft(body, artifact, draftMatch[1]);
          const saved = await adapter.saveDraft({ ...context, artifact }, draft);
          return send(response, 200, { draft: saved });
        }
        if (Object.keys(body).some((field) => !["id", "artifactKey", "sourceHash", "htmlHash"].includes(field))) throw reviewError("Draft deletion contains unsupported fields", "REVIEW_DRAFT_INVALID", 422);
        validateDraftBinding(body, artifact, draftMatch[1]);
        const comments = await adapter.listDrafts(context);
        const sameId = comments.filter((comment) => comment.id === draftMatch[1]);
        const draft = sameId.find((comment) =>
          comment.status === "draft" && comment.artifactKey === artifact.key &&
          comment.artifactPath === artifact.path && comment.sourceHash === artifact.sourceHash && comment.htmlHash === artifact.htmlHash,
        );
        if (!draft) {
          if (sameId.some((comment) => comment.status === "stale" || comment.status === "draft")) throw reviewError("Draft artifact binding is stale", "REVIEW_ARTIFACT_STALE", 409);
          throw reviewError("Draft does not exist", "REVIEW_DRAFT_UNKNOWN", 404);
        }
        const deleted = await adapter.deleteDraft({ ...context, artifact }, draft);
        if (!deleted) throw reviewError("Draft does not exist", "REVIEW_DRAFT_UNKNOWN", 404);
        return send(response, 200, { deleted: true, id: draft.id });
      }
      if (request.method === "POST" && url.pathname === "/api/publish") {
        mutationRequest(request, origin, csrfToken);
        const body = await jsonBody(request);
        countFields(body);
        const artifact = artifactMap.get(body.artifactKey);
        if (!artifact) throw reviewError("Artifact is not allowlisted", "REVIEW_ARTIFACT_UNKNOWN", 404);
        if (body.sourceHash !== artifact.sourceHash || body.htmlHash !== artifact.htmlHash) throw reviewError("Publication binding is stale", "REVIEW_ARTIFACT_STALE", 409);
        await verifyArtifactCurrent(artifact);
        const allComments = await adapter.listDrafts(context);
        const ids = Array.isArray(body.commentIds) ? [...new Set(body.commentIds)] : [];
        if (ids.length === 0 || ids.length > MAX_COMMENTS || ids.some((id) => typeof id !== "string")) throw reviewError("Publish requires 1–200 comment ids", "REVIEW_COMMENT_LIMIT", 422);
        const selected = ids.map((requestedId) => {
          const candidates = allComments.filter((comment) => comment.id === requestedId);
          const draft = candidates.find((comment) =>
            comment.status === "draft" && comment.artifactKey === artifact.key &&
            comment.artifactPath === artifact.path && comment.sourceHash === artifact.sourceHash && comment.htmlHash === artifact.htmlHash,
          );
          if (draft) return draft;
          if (candidates.some((comment) => comment.status === "draft" || comment.status === "stale")) {
            throw reviewError("A requested draft is bound to another or stale artifact", "REVIEW_ARTIFACT_STALE", 409);
          }
          throw reviewError("A requested draft does not exist", "REVIEW_DRAFT_UNKNOWN", 422);
        });
        for (const draft of selected) validateCommentAnchor(draft, artifact);
        const sensitive = selected.some((draft) => /(?:password|secret|api[_ -]?key|private[_ -]?key|token)\s*[:=]/iu.test(draft.bodyMarkdown));
        if (sensitive && body.confirmedSensitive !== true) throw reviewError("Possible sensitive content requires explicit confirmation", "REVIEW_SENSITIVE_CONFIRM", 422);
        const publicationContext = { ...context, artifact };
        const result = await adapter.publish(publicationContext, { ...body, comments: selected });
        for (const draft of selected) {
          const deleted = await adapter.deleteDraft(publicationContext, draft);
          if (!deleted) throw reviewError("Published feedback but could not remove its private draft", "REVIEW_DRAFT_DELETE_FAILED", 500);
        }
        const id = result.id ?? result.batch?.id;
        return send(response, 201, { ...result, id, work, agentHost, publishedCommentIds: selected.map((draft) => draft.id), command: stageInvocation(agentHost, "plan", work, id) });
      }
      if (request.method === "POST" && url.pathname === "/api/stop") {
        mutationRequest(request, origin, csrfToken);
        await jsonBody(request, 4096);
        send(response, 202, { stopping: true });
        setImmediate(() => close());
        return;
      }
      throw reviewError("Route not found", "REVIEW_ROUTE_NOT_FOUND", 404);
    } catch (cause) {
      if (response.headersSent || response.destroyed) return;
      const status = cause?.statusCode ?? 500;
      send(response, status, { error: status === 500 ? "Internal review server error" : cause.message, code: cause?.code ?? "REVIEW_INTERNAL" });
    }
  });

  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: HOST, port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== HOST) {
    server.close();
    throw reviewError("Review server did not bind to IPv4 loopback", "REVIEW_BIND_INVALID", 500);
  }
  expectedHost = `${HOST}:${address.port}`;
  origin = `http://${expectedHost}`;
  const url = `${origin}/#${bootstrapToken}`;
  const metadata = {
    schemaVersion: 1, sessionId, pid: process.pid, host: HOST, agentHost, port: address.port, origin,
    url, bootstrapToken, cookieToken, csrfToken, controlToken, work,
    activeKey: active.key, activeArtifact: publicArtifact(active), artifacts: artifacts.map(publicArtifact),
    startedAt: new Date().toISOString(), idleTimeoutMs,
  };
  if (options.writeSession !== false) await writePrivateJson(sessionPath(state), metadata);

  async function close() {
    if (closing) return;
    closing = true;
    LOCAL_SERVERS.delete(sessionId);
    clearInterval(idleTimer);
    await new Promise((resolve) => server.close(resolve));
    if (options.writeSession !== false) {
      const current = await readSession(state).catch(() => null);
      if (current?.sessionId === sessionId) await rm(sessionPath(state), { force: true });
    }
  }
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity >= idleTimeoutMs) close().catch(() => {});
  }, Math.min(60_000, Math.max(100, Math.floor(idleTimeoutMs / 4))));
  idleTimer.unref();
  server.on("close", () => clearInterval(idleTimer));
  LOCAL_SERVERS.set(sessionId, { close, server });
  const signalClose = () => close().finally(() => process.exit(0));
  if (options.handleSignals) {
    process.once("SIGTERM", signalClose);
    process.once("SIGINT", signalClose);
  }
  return { ...sanitizeSession(metadata), url, artifacts: artifacts.map(publicArtifact), activeArtifact: publicArtifact(active), server, close, address: () => server.address() };
}

async function resolveState(input, options) {
  if (input?.artifactRoot && input?.localWorkRoot) return { state: input, work: options.work ?? input.id ?? input.key };
  if (input?.state?.artifactRoot) return { state: input.state, work: options.work ?? input.record?.id ?? input.state.id };
  if (typeof input === "string") {
    const resolved = await resolveWork(path.resolve(input), { id: options.work, branch: options.branch });
    return { state: resolved.state, work: resolved.record.id };
  }
  throw reviewError("Project root or resolved work state is required", "REVIEW_STATE_REQUIRED");
}

async function health(metadata, timeoutMs = 500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${metadata.origin}/health`, { headers: { host: `${metadata.host}:${metadata.port}` }, signal: controller.signal });
    const body = await response.json();
    return response.ok && body.sessionId === metadata.sessionId && body.pid === metadata.pid;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function reviewStatus(input, options = {}) {
  const { state, work } = await resolveState(input, options);
  const metadata = await readSession(state).catch(() => null);
  if (!metadata) return { running: false, work };
  const running = await health(metadata, options.timeoutMs);
  if (!running) return { running: false, stale: true, work, metadata: sanitizeSession(metadata) };
  return { running: true, work, ...sanitizeSession(metadata) };
}

export const statusReview = reviewStatus;

export async function stopReview(input, options = {}) {
  const { state, work } = await resolveState(input, options);
  const metadata = await readSession(state).catch(() => null);
  if (!metadata) return { stopped: false, running: false, work };
  if (!await health(metadata, options.timeoutMs)) {
    await rm(sessionPath(state), { force: true });
    return { stopped: false, running: false, stale: true, work };
  }
  const local = metadata.pid === process.pid ? LOCAL_SERVERS.get(metadata.sessionId) : null;
  if (local) {
    await local.close();
    return { stopped: true, running: false, work };
  }
  try { process.kill(metadata.pid, "SIGTERM"); } catch (cause) {
    if (cause?.code !== "ESRCH") throw cause;
  }
  const deadline = Date.now() + (options.stopTimeoutMs ?? 2_000);
  while (Date.now() < deadline && await health(metadata, 150)) await new Promise((resolve) => setTimeout(resolve, 40));
  const stopped = !await health(metadata, 150);
  if (stopped) await rm(sessionPath(state), { force: true });
  return { stopped, running: !stopped, work };
}

export const reviewStop = stopReview;

async function detachedStart(state, options) {
  const config = Buffer.from(JSON.stringify({ state, host: options.host, work: options.work, artifact: options.artifact, artifactKey: options.artifactKey, idleTimeoutMs: options.idleTimeoutMs })).toString("base64url");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--serve-detached", config], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(reviewError("Detached review server did not start", "REVIEW_START_TIMEOUT", 500)); }, options.startTimeoutMs ?? 5_000);
    child.once("error", (cause) => { clearTimeout(timeout); reject(cause); });
    child.once("message", (message) => {
      clearTimeout(timeout);
      if (!message?.ok) reject(reviewError(message?.error ?? "Detached review server failed", message?.code ?? "REVIEW_START_FAILED", 500));
      else { child.disconnect(); child.unref(); resolve(message.result); }
    });
  });
}

export async function startReview(input, options = {}) {
  options = { ...options, host: workflowHost(options.host) };
  const resolved = await resolveState(input, options);
  const artifacts = await discoverReviewArtifacts(resolved.state);
  const requested = selectReviewArtifact(artifacts, resolved.state, options);
  if (!requested) throw reviewError("Requested review artifact is not allowlisted", "REVIEW_ARTIFACT_UNKNOWN", 404);
  const current = await readSession(resolved.state).catch(() => null);
  if (current && await health(current) && (current.agentHost ?? "opencode") === options.host && current.activeKey === requested.key && current.activeArtifact?.sourceHash === requested.sourceHash && current.activeArtifact?.htmlHash === requested.htmlHash) {
    const opened = await openReviewBrowser(current.url, options);
    return { ...startSessionResult(current), reused: true, opened: opened.opened, openReason: opened.reason };
  }
  if (current && await health(current)) await stopReview(resolved.state, options);
  else if (current) await rm(sessionPath(resolved.state), { force: true });
  const serverResult = options.detached === false
    ? await startReviewServer({ ...options, state: resolved.state, work: resolved.work, artifacts, artifactKey: requested.key })
    : await detachedStart(resolved.state, { ...options, work: resolved.work, artifactKey: requested.key });
  const opened = await openReviewBrowser(serverResult.url, options);
  return { ...serverResult, reused: false, opened: opened.opened, openReason: opened.reason };
}

export const reviewStart = startReview;

async function detachedMain() {
  try {
    const config = JSON.parse(Buffer.from(process.argv[3] ?? "", "base64url").toString("utf8"));
    const result = await startReviewServer({ ...config, handleSignals: true });
    process.send?.({ ok: true, result: { ...result, server: undefined, close: undefined, address: undefined } });
    process.disconnect?.();
  } catch (cause) {
    process.send?.({ ok: false, error: cause.message, code: cause.code });
    process.disconnect?.();
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--serve-detached") detachedMain();
