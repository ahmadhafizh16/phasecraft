import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  browserLaunchCommand,
  createFeedbackAdapter,
  discoverReviewArtifacts,
  reviewStatus,
  startReview,
  startReviewServer,
  stopReview,
} from "../runtime/review.mjs";
import { reviewClientJs, reviewCss, reviewShellHtml, SHELL_CSP } from "../runtime/review-ui.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "artifacts", "WORK-1");
  const localWorkRoot = path.join(root, "local", "WORK-1-key");
  const planDirectory = path.join(artifactRoot, "plan", "phases", "P-01-review");
  const roadmapDirectory = path.join(artifactRoot, "plan");
  const planSource = options.planSource ?? "# Plan\n\n## Goal\nReview this exact source.\n";
  const roadmapSource = "# Roadmap\n\n## Objective\nReview all phases.\n";
  const planHash = hash(planSource);
  const roadmapHash = hash(roadmapSource);
  const planHtml = options.planHtml ?? `<!doctype html><html><head><meta name="phasecraft-source-sha256" content="${planHash}"></head><body><section data-phasecraft-anchor="plan/goal"><h1>Goal</h1><p>Readable Mermaid source remains.</p><pre class="mermaid">flowchart LR</pre></section><script src="https://cdn.example/mermaid.js"></script></body></html>\n`;
  const roadmapHtml = `<!doctype html><html><head><meta name="phasecraft-source-sha256" content="${roadmapHash}"></head><body><section data-phasecraft-anchor="roadmap/objective">Objective</section></body></html>\n`;
  await Promise.all([mkdir(planDirectory, { recursive: true }), mkdir(localWorkRoot, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(planDirectory, "PLAN.md"), planSource),
    writeFile(path.join(planDirectory, "plan.html"), planHtml),
    writeFile(path.join(roadmapDirectory, "ROADMAP.md"), roadmapSource),
    writeFile(path.join(roadmapDirectory, "roadmap.html"), roadmapHtml),
  ]);
  const state = { id: "WORK-1", key: "work-1", artifactRoot, localWorkRoot };
  return { root, artifactRoot, localWorkRoot, planDirectory, planSource, planHtml, state };
}

function rawRequest(origin, route, options = {}) {
  const url = new URL(route, origin);
  const headers = { ...options.headers };
  if (options.body !== undefined && headers["content-length"] === undefined) headers["content-length"] = Buffer.byteLength(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method ?? "GET",
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        json() { return JSON.parse(this.body.toString("utf8")); },
      }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.end(options.body);
    else request.end();
  });
}

async function authenticated(serverResult) {
  const capability = new URL(serverResult.url).hash.slice(1);
  const exchange = await rawRequest(serverResult.origin, "/auth/exchange", {
    method: "POST",
    headers: {
      host: `127.0.0.1:${serverResult.port}`,
      origin: serverResult.origin,
      "content-type": "application/json",
      "x-phasecraft-bootstrap": "1",
    },
    body: JSON.stringify({ token: capability }),
  });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers["set-cookie"][0].split(";", 1)[0];
  return { cookie, csrf: exchange.json().csrf };
}

async function runningFixture(t, options = {}) {
  const value = await fixture(t, options);
  const drafts = [];
  const published = [];
  const feedbackAdapter = createFeedbackAdapter({
    listDrafts: async () => drafts,
    saveDraft: async (_context, draft) => {
      const index = drafts.findIndex((item) => item.id === draft.id);
      if (index < 0) drafts.push(draft);
      else drafts[index] = draft;
      return draft;
    },
    deleteDraft: async (_context, draft) => {
      const index = drafts.findIndex((item) =>
        item.status === "draft" && item.id === draft.id && item.artifactKey === draft.artifactKey &&
        item.sourceHash === draft.sourceHash && item.htmlHash === draft.htmlHash,
      );
      if (index < 0) return false;
      drafts.splice(index, 1);
      return true;
    },
    publish: async (_context, input) => {
      published.push(input);
      return { id: "FB-001" };
    },
  });
  const server = await startReviewServer({
    state: value.state,
    work: "WORK-1",
    feedbackAdapter,
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
  });
  t.after(() => server.close());
  return { ...value, server, drafts, published };
}

function headersFor(server, auth, extra = {}) {
  return {
    host: `127.0.0.1:${server.port}`,
    cookie: auth.cookie,
    ...extra,
  };
}

function draftFor(artifact, id = "FC-001") {
  return {
    id,
    artifactKey: artifact.key,
    artifactPath: artifact.path,
    sourceHash: artifact.sourceHash,
    htmlHash: artifact.htmlHash,
    status: "draft",
    anchor: { semantic: "plan/goal" },
    bodyMarkdown: "Please make the retry boundary explicit.",
    createdAt: "2026-08-12T10:11:12.000Z",
  };
}

test("discovers only current generated roadmap and phase plan artifacts", async (t) => {
  const { state } = await fixture(t);
  const artifacts = await discoverReviewArtifacts(state);
  assert.deepEqual(artifacts.map(({ kind }) => kind), ["roadmap", "plan"]);
  assert.equal(artifacts[0].path, "plan/roadmap.html");
  assert.equal(artifacts[1].path, "plan/phases/P-01-review/plan.html");
  assert.equal(artifacts[1].sourceHash.length, 64);
  assert.equal(artifacts[1].htmlHash.length, 64);
});

test("starts review on the active phase instead of the oldest available plan", async (t) => {
  const value = await fixture(t);
  const secondDirectory = path.join(value.artifactRoot, "plan", "phases", "P-02-current");
  const secondSource = "# Current plan\n";
  const secondHtml = `<!doctype html><html><head><meta name="phasecraft-source-sha256" content="${hash(secondSource)}"></head><body><p data-phasecraft-anchor="plan/goal">Current</p></body></html>\n`;
  await mkdir(secondDirectory, { recursive: true });
  await writeFile(path.join(secondDirectory, "PLAN.md"), secondSource);
  await writeFile(path.join(secondDirectory, "plan.html"), secondHtml);
  const result = await startReviewServer({
    state: { ...value.state, activePhase: "P-02" },
    work: "WORK-1",
    feedbackAdapter: createFeedbackAdapter({ listDrafts: async () => [] }),
    writeSession: false,
  });
  t.after(() => result.close());
  assert.equal(result.activeArtifact.phase, "P-02");
  assert.equal(result.activeArtifact.path, "plan/phases/P-02-current/plan.html");
});

test("rejects stale metadata bindings, symlink artifacts, and oversized artifacts", async (t) => {
  await t.test("source binding drift", async (t) => {
    const { state, planDirectory } = await fixture(t);
    await writeFile(path.join(planDirectory, "PLAN.md"), "changed\n");
    await assert.rejects(discoverReviewArtifacts(state), { code: "REVIEW_ARTIFACT_STALE" });
  });
  await t.test("symlink escape", async (t) => {
    const { state, planDirectory, root } = await fixture(t);
    const outside = path.join(root, "outside.html");
    await writeFile(outside, "outside\n");
    await rm(path.join(planDirectory, "plan.html"));
    await symlink(outside, path.join(planDirectory, "plan.html"));
    await assert.rejects(discoverReviewArtifacts(state), { code: "REVIEW_PATH_UNSAFE" });
  });
  await t.test("artifact size", async (t) => {
    const { state, planDirectory } = await fixture(t);
    await writeFile(path.join(planDirectory, "plan.html"), Buffer.alloc(64 * 1024 * 1024 + 1));
    await assert.rejects(discoverReviewArtifacts(state), { code: "REVIEW_ARTIFACT_TOO_LARGE" });
  });
});

test("binds an OS-assigned port only on IPv4 loopback and writes private session metadata", async (t) => {
  const { server, state } = await runningFixture(t);
  const address = server.server.address();
  assert.equal(address.address, "127.0.0.1");
  assert.ok(address.port > 0);
  assert.equal(server.port, address.port);
  assert.match(server.url, new RegExp(`^http://127\\.0\\.0\\.1:${address.port}/#[A-Za-z0-9_-]{40,}$`, "u"));
  const metadataPath = path.join(state.localWorkRoot, "reviews", "sessions", "current.json");
  assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  assert.equal(metadata.host, "127.0.0.1");
  assert.equal(metadata.port, address.port);
  assert.ok(metadata.bootstrapToken.length >= 43);
});

test("exchanges the fragment capability for a strict HttpOnly cookie", async (t) => {
  const { server } = await runningFixture(t);
  const shell = await rawRequest(server.origin, "/", { headers: { host: `127.0.0.1:${server.port}` } });
  assert.equal(shell.status, 200, "fixed shell can bootstrap without exposing protected data");
  assert.doesNotMatch(shell.body.toString(), /phasecraft_review|bootstrapToken/u);
  const denied = await rawRequest(server.origin, "/api/session", { headers: { host: `127.0.0.1:${server.port}` } });
  assert.equal(denied.status, 401);

  const token = new URL(server.url).hash.slice(1);
  assert.equal(new URL(server.url).search, "");
  const bad = await rawRequest(server.origin, "/auth/exchange", {
    method: "POST",
    headers: { host: `127.0.0.1:${server.port}`, origin: server.origin, "content-type": "application/json", "x-phasecraft-bootstrap": "1" },
    body: JSON.stringify({ token: `${token}x` }),
  });
  assert.equal(bad.status, 401);
  const auth = await authenticated(server);
  assert.match(auth.cookie, /^phasecraft_review=/u);
  const response = await rawRequest(server.origin, "/api/session", { headers: headersFor(server, auth) });
  assert.equal(response.status, 200);
  assert.equal(response.json().work, "WORK-1");

  const exchange = await rawRequest(server.origin, "/auth/exchange", {
    method: "POST",
    headers: { host: `127.0.0.1:${server.port}`, origin: server.origin, "content-type": "application/json", "x-phasecraft-bootstrap": "1" },
    body: JSON.stringify({ token }),
  });
  assert.match(exchange.headers["set-cookie"][0], /HttpOnly/u);
  assert.match(exchange.headers["set-cookie"][0], /SameSite=Strict/u);
  assert.doesNotMatch(exchange.headers["set-cookie"][0], /Secure/u, "HTTP loopback cookies are intentionally not Secure");
});

test("enforces exact Host, Origin, JSON content type, and CSRF without CORS", async (t) => {
  const { server } = await runningFixture(t);
  const auth = await authenticated(server);
  const invalidHost = await rawRequest(server.origin, "/api/session", { headers: { ...headersFor(server, auth), host: "localhost" } });
  assert.equal(invalidHost.status, 403);
  const artifact = server.artifacts.find((item) => item.kind === "plan");
  const body = JSON.stringify(draftFor(artifact));
  const base = { method: "PUT", body };
  const wrongOrigin = await rawRequest(server.origin, "/api/drafts/FC-001", { ...base, headers: headersFor(server, auth, { origin: "http://evil.invalid", "content-type": "application/json", "x-phasecraft-csrf": auth.csrf }) });
  assert.equal(wrongOrigin.status, 403);
  const missingCsrf = await rawRequest(server.origin, "/api/drafts/FC-001", { ...base, headers: headersFor(server, auth, { origin: server.origin, "content-type": "application/json" }) });
  assert.equal(missingCsrf.status, 403);
  const wrongType = await rawRequest(server.origin, "/api/drafts/FC-001", { ...base, headers: headersFor(server, auth, { origin: server.origin, "content-type": "text/plain", "x-phasecraft-csrf": auth.csrf }) });
  assert.equal(wrongType.status, 415);
  const accepted = await rawRequest(server.origin, "/api/drafts/FC-001", { ...base, headers: headersFor(server, auth, { origin: server.origin, "content-type": "application/json", "x-phasecraft-csrf": auth.csrf }) });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers["access-control-allow-origin"], undefined);
});

test("serves only allowlisted byte-exact HTML with all artifact scripts blocked", async (t) => {
  const { server, planHtml } = await runningFixture(t);
  const auth = await authenticated(server);
  const plan = server.artifacts.find((item) => item.kind === "plan");
  const response = await rawRequest(server.origin, `/artifact/${plan.key}`, { headers: headersFor(server, auth) });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, Buffer.from(planHtml));
  assert.match(response.headers["content-security-policy"], /script-src 'none'/u);
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'self'/u);
  assert.equal(response.headers["x-frame-options"], "SAMEORIGIN");
  assert.match(response.body.toString(), /flowchart LR/u, "readable Mermaid source remains");
  const traversal = await rawRequest(server.origin, "/artifact/%2e%2e%2fetc%2fpasswd", { headers: headersFor(server, auth) });
  assert.equal(traversal.status, 404);
  const arbitrary = await rawRequest(server.origin, "/artifact/not-allowlisted", { headers: headersFor(server, auth) });
  assert.equal(arbitrary.status, 404);
});

test("rejects draft and publish requests after source or HTML drift", async (t) => {
  const { server, planDirectory } = await runningFixture(t);
  const auth = await authenticated(server);
  const artifact = server.artifacts.find((item) => item.kind === "plan");
  await writeFile(path.join(planDirectory, "PLAN.md"), "# changed after opening\n");
  const draft = await rawRequest(server.origin, "/api/drafts/FC-001", {
    method: "PUT",
    headers: headersFor(server, auth, { origin: server.origin, "content-type": "application/json", "x-phasecraft-csrf": auth.csrf }),
    body: JSON.stringify(draftFor(artifact)),
  });
  assert.equal(draft.status, 409);
  assert.equal(draft.json().code, "REVIEW_ARTIFACT_STALE");
  const publish = await rawRequest(server.origin, "/api/publish", {
    method: "POST",
    headers: headersFor(server, auth, { origin: server.origin, "content-type": "application/json", "x-phasecraft-csrf": auth.csrf }),
    body: JSON.stringify({ artifactKey: artifact.key, sourceHash: artifact.sourceHash, htmlHash: artifact.htmlHash, commentIds: ["FC-001"] }),
  });
  assert.equal(publish.status, 409);
});

test("enforces transport, Markdown, field, and comment-count limits", async (t) => {
  const { server } = await runningFixture(t);
  const auth = await authenticated(server);
  const mutationHeaders = headersFor(server, auth, { origin: server.origin, "content-type": "application/json", "x-phasecraft-csrf": auth.csrf });
  const oversizedBody = JSON.stringify({ padding: "x".repeat(256 * 1024) });
  const huge = await rawRequest(server.origin, "/api/publish", {
    method: "POST",
    headers: mutationHeaders,
    body: oversizedBody,
  });
  assert.equal(huge.status, 413);
  const artifact = server.artifacts.find((item) => item.kind === "plan");
  const markdown = await rawRequest(server.origin, "/api/drafts/FC-001", {
    method: "PUT", headers: mutationHeaders, body: JSON.stringify({ ...draftFor(artifact), bodyMarkdown: "x".repeat(16 * 1024 + 1) }),
  });
  assert.equal(markdown.status, 422);
  const html = await rawRequest(server.origin, "/api/drafts/FC-001", {
    method: "PUT", headers: mutationHeaders, body: JSON.stringify({ ...draftFor(artifact), bodyMarkdown: "<img src=x onerror=alert(1)>" }),
  });
  assert.equal(html.status, 422);
  const tooMany = await rawRequest(server.origin, "/api/publish", {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ artifactKey: artifact.key, sourceHash: artifact.sourceHash, htmlHash: artifact.htmlHash, commentIds: Array.from({ length: 201 }, (_, index) => `FC-${index}`) }),
  });
  assert.equal(tooMany.status, 422);
});

test("the isolated adapter integrates with the pragmatic feedback module", async (t) => {
  const { state } = await fixture(t);
  const artifacts = await discoverReviewArtifacts(state);
  const artifact = artifacts.find((item) => item.kind === "plan");
  const adapter = createFeedbackAdapter();
  const context = { state, artifacts, artifact, work: state.id };
  const saved = await adapter.saveDraft(context, draftFor(artifact));
  assert.equal(saved.artifactKey, artifact.key);
  assert.equal((await adapter.listDrafts(context)).length, 1);
  const result = await adapter.publish(context, { comments: [saved], confirmedSensitive: false });
  assert.equal(result.id, "FB-001");
  assert.equal((await stat(result.privatePath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.projectionPath)).mode & 0o777, 0o444);
});

test("publishes through the adapter and returns only an explicit planner command", async (t) => {
  const { server, drafts, published } = await runningFixture(t);
  const auth = await authenticated(server);
  const artifact = server.artifacts.find((item) => item.kind === "plan");
  const headers = headersFor(server, auth, { origin: server.origin, "content-type": "application/json", "x-phasecraft-csrf": auth.csrf });
  const saved = await rawRequest(server.origin, "/api/drafts/FC-001", { method: "PUT", headers, body: JSON.stringify(draftFor(artifact)) });
  assert.equal(saved.status, 200);
  const response = await rawRequest(server.origin, "/api/publish", {
    method: "POST", headers, body: JSON.stringify({ artifactKey: artifact.key, sourceHash: artifact.sourceHash, htmlHash: artifact.htmlHash, commentIds: ["FC-001"] }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.json().command, "/phasecraft-plan --work WORK-1 --feedback FB-001");
  assert.deepEqual(response.json().publishedCommentIds, ["FC-001"]);
  assert.equal(published.length, 1);
  assert.equal(published[0].comments.length, 1);
  assert.deepEqual(drafts, [], "published drafts are removed from adapter state");
});

test("real-adapter publication deletes private drafts and historical submitted comments cannot be republished", async (t) => {
  const value = await fixture(t);
  const server = await startReviewServer({ state: value.state, work: "WORK-1", idleTimeoutMs: 60_000 });
  t.after(() => server.close());
  const auth = await authenticated(server);
  const artifact = server.artifacts.find((item) => item.kind === "plan");
  const headers = headersFor(server, auth, { origin: server.origin, "content-type": "application/json", "x-phasecraft-csrf": auth.csrf });
  const draft = draftFor(artifact);
  const feedbackArtifactKey = hash(`${artifact.kind}\0${artifact.path}\0${artifact.sourcePath}`).slice(0, 24);
  const privateDraftPath = path.join(value.localWorkRoot, "reviews", "drafts", feedbackArtifactKey, artifact.sourceHash, `${draft.id}.json`);

  const saved = await rawRequest(server.origin, `/api/drafts/${draft.id}`, { method: "PUT", headers, body: JSON.stringify(draft) });
  assert.equal(saved.status, 200);
  assert.equal((await stat(privateDraftPath)).isFile(), true);

  const published = await rawRequest(server.origin, "/api/publish", {
    method: "POST",
    headers,
    body: JSON.stringify({ artifactKey: artifact.key, sourceHash: artifact.sourceHash, htmlHash: artifact.htmlHash, commentIds: [draft.id] }),
  });
  assert.equal(published.status, 201);
  await assert.rejects(stat(privateDraftPath), { code: "ENOENT" });

  const session = await rawRequest(server.origin, "/api/session", { headers: headersFor(server, auth) });
  const historical = session.json().drafts.filter((comment) => comment.id === draft.id);
  assert.equal(historical.length, 1);
  assert.equal(historical[0].status, "submitted");

  const repeated = await rawRequest(server.origin, "/api/publish", {
    method: "POST",
    headers,
    body: JSON.stringify({ artifactKey: artifact.key, sourceHash: artifact.sourceHash, htmlHash: artifact.htmlHash, commentIds: [draft.id] }),
  });
  assert.equal(repeated.status, 422);
  assert.equal(repeated.json().code, "REVIEW_DRAFT_UNKNOWN");
  assert.equal((await readFile(path.join(value.localWorkRoot, "reviews", "batches", "FB-001.json"), "utf8")).includes(draft.bodyMarkdown), true);
  await assert.rejects(stat(path.join(value.localWorkRoot, "reviews", "batches", "FB-002.json")), { code: "ENOENT" });
});

test("historical submitted feedback hides an orphaned matching draft", async (t) => {
  const value = await fixture(t);
  const artifacts = await discoverReviewArtifacts(value.state);
  const artifact = artifacts.find((item) => item.kind === "plan");
  const adapter = createFeedbackAdapter();
  const context = { state: value.state, artifacts, artifact, work: value.state.id };
  const saved = await adapter.saveDraft(context, draftFor(artifact));
  const result = await adapter.publish(context, { comments: [saved], confirmedSensitive: false });
  await adapter.saveDraft(context, saved);
  const comments = await adapter.listDrafts(context);
  assert.equal(result.id, "FB-001");
  assert.equal(comments.filter((comment) => comment.id === saved.id && comment.status === "draft").length, 0);
  assert.equal(comments.filter((comment) => comment.id === saved.id && comment.status === "submitted").length, 1);
});

test("DELETE draft route requires authentication, CSRF, and exact artifact/hash binding", async (t) => {
  const { server, drafts } = await runningFixture(t);
  const auth = await authenticated(server);
  const artifact = server.artifacts.find((item) => item.kind === "plan");
  const mutationHeaders = headersFor(server, auth, { origin: server.origin, "content-type": "application/json", "x-phasecraft-csrf": auth.csrf });
  const draft = draftFor(artifact);
  assert.equal((await rawRequest(server.origin, `/api/drafts/${draft.id}`, { method: "PUT", headers: mutationHeaders, body: JSON.stringify(draft) })).status, 200);
  const selector = { id: draft.id, artifactKey: artifact.key, sourceHash: artifact.sourceHash, htmlHash: artifact.htmlHash };

  const unauthenticated = await rawRequest(server.origin, `/api/drafts/${draft.id}`, {
    method: "DELETE",
    headers: { host: `127.0.0.1:${server.port}`, origin: server.origin, "content-type": "application/json", "x-phasecraft-csrf": auth.csrf },
    body: JSON.stringify(selector),
  });
  assert.equal(unauthenticated.status, 401);
  const missingCsrf = await rawRequest(server.origin, `/api/drafts/${draft.id}`, {
    method: "DELETE", headers: headersFor(server, auth, { origin: server.origin, "content-type": "application/json" }), body: JSON.stringify(selector),
  });
  assert.equal(missingCsrf.status, 403);
  const wrongHash = await rawRequest(server.origin, `/api/drafts/${draft.id}`, {
    method: "DELETE", headers: mutationHeaders, body: JSON.stringify({ ...selector, sourceHash: "0".repeat(64) }),
  });
  assert.equal(wrongHash.status, 409);
  assert.equal(wrongHash.json().code, "REVIEW_ARTIFACT_STALE");
  const wrongId = await rawRequest(server.origin, `/api/drafts/${draft.id}`, {
    method: "DELETE", headers: mutationHeaders, body: JSON.stringify({ ...selector, id: "FC-002" }),
  });
  assert.equal(wrongId.status, 422);
  assert.equal(drafts.length, 1);

  const deleted = await rawRequest(server.origin, `/api/drafts/${draft.id}`, {
    method: "DELETE", headers: mutationHeaders, body: JSON.stringify(selector),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json(), { deleted: true, id: draft.id });
  assert.deepEqual(drafts, []);
  const missing = await rawRequest(server.origin, `/api/drafts/${draft.id}`, {
    method: "DELETE", headers: mutationHeaders, body: JSON.stringify(selector),
  });
  assert.equal(missing.status, 404);
});

test("supports detached start, status, no-browser mode, stale cleanup, and stop", async (t) => {
  const { state } = await fixture(t);
  const started = await startReview(state, { detached: true, noOpen: true, idleTimeoutMs: 60_000 });
  t.after(() => stopReview(state).catch(() => {}));
  assert.equal(started.opened, false);
  assert.equal(started.openReason, "disabled");
  assert.ok(started.pid !== process.pid);
  const status = await reviewStatus(state);
  assert.equal(status.running, true);
  assert.doesNotMatch(status.url, /#/u, "status does not disclose the capability");
  const stopped = await stopReview(state);
  assert.equal(stopped.stopped, true);
  assert.equal((await reviewStatus(state)).running, false);
});

test("closes an in-process server after its idle timeout", async (t) => {
  const { server } = await runningFixture(t, { idleTimeoutMs: 120 });
  await new Promise((resolve) => server.server.once("close", resolve));
  assert.equal(server.server.listening, false);
});

test("builds argument-safe browser launch commands for supported operating systems", () => {
  const url = "http://127.0.0.1:1234/#opaque-token&not-shell";
  assert.deepEqual(browserLaunchCommand(url, "linux"), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserLaunchCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserLaunchCommand(url, "win32"), { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url], windowsHide: true });
  assert.equal(browserLaunchCommand(url, "aix"), null);
});

test("shell exposes responsive review and accessibility contracts without inline script", () => {
  const html = reviewShellHtml();
  const css = reviewCss();
  const js = reviewClientJs();
  assert.equal(SHELL_CSP.includes("script-src 'self'"), true);
  assert.match(html, /aria-label="Review toolbar"/u);
  assert.match(html, /aria-pressed="false">Comment mode/u);
  assert.match(html, /role="status" aria-live="polite"/u);
  assert.match(html, /<textarea[^>]+maxlength="16384"/u);
  assert.match(html, /data-format="(?:bold|italic|code|fence|list|link)"/u);
  assert.match(html, /Safe Markdown preview/u);
  assert.match(html, /id="draft-delete" hidden>Delete draft/u);
  assert.match(html, /id="publish-open"[^>]+disabled/u);
  assert.match(html, /Publish feedback/u);
  assert.match(html, /Stop review/u);
  assert.match(html, /<iframe[^>]+title=/u);
  assert.doesNotMatch(html, /<script(?! src=)/u);
  assert.match(css, /--sidebar:380px/u);
  assert.match(css, /@media\(min-width:1280px\)/u);
  assert.match(css, /@media\(max-width:1279px\)/u);
  assert.match(css, /@media\(max-width:720px\)/u);
  assert.match(css, /min-height:44px/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(css, /forced-colors/u);
  assert.match(js, /data-phasecraft-anchor/u);
  assert.match(js, /selectionchange/u);
  assert.match(js, /Comment on selection/u);
  assert.match(js, /autosave-status/u);
  assert.match(js, /item\.status==='draft'/u, "only drafts are editable and publishable");
  assert.match(js, /method:'DELETE'/u);
  assert.match(js, /state\.comments=state\.comments\.filter/u, "published and deleted drafts leave browser state");
  assert.match(js, /currentDrafts\(\)\.length===0/u, "publish is disabled without drafts");
  assert.match(js, /Resolve stale drafts before publishing/u);
  assert.match(js, /Copy failed\. The planner command is selected/u);
  assert.match(js, /range\.selectNodeContents\(code\)/u);
  assert.match(js, /\/phasecraft-plan --work /u);
  assert.doesNotMatch(js, /innerHTML=state\.|innerHTML=.*bodyMarkdown/u, "untrusted comment data is not inserted as raw HTML");
});
