import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteDraft,
  detectLikelySecrets,
  listDrafts,
  listFeedback,
  publishFeedback,
  recoverFeedbackProjection,
  recoverFeedbackResolutionProjection,
  renderFeedbackMarkdown,
  reviewDataPaths,
  saveDraft,
  sha256,
  showFeedback,
  validateAnchor,
  validateArtifact,
  validateArtifactBinding,
  validateComment,
  validateFeedbackBatch,
  validateFeedbackResolution,
  validateFeedbackId,
  writeFeedbackResolution,
} from "../runtime/feedback.mjs";

const NOW = "2026-08-12T10:11:12.000Z";
const LATER = "2026-08-12T11:12:13.000Z";
const RESULT_SOURCE = sha256("result source\n");
const RESULT_HTML = sha256("<html>result</html>\n");

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-feedback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "artifacts", "WORK-1");
  const localWorkRoot = path.join(root, "local", "WORK-1-key");
  const sourcePath = "plan/phases/P-01-example/PLAN.md";
  const htmlPath = "plan/phases/P-01-example/plan.html";
  const source = options.source ?? "# Plan\n\nMake retries explicit and bounded.\n";
  const html = options.html ?? "<!doctype html><html><body>Make retries explicit and bounded.</body></html>\n";
  await mkdir(path.dirname(path.join(artifactRoot, sourcePath)), { recursive: true });
  await writeFile(path.join(artifactRoot, sourcePath), source);
  await writeFile(path.join(artifactRoot, htmlPath), html);
  await mkdir(localWorkRoot, { recursive: true });
  const state = { id: "WORK-1", artifactRoot, localWorkRoot };
  const artifact = {
    kind: "plan",
    path: htmlPath,
    sourcePath,
    sourceHash: sha256(source),
    htmlHash: sha256(html),
    phase: "P-01",
  };
  return { root, artifactRoot, localWorkRoot, state, artifact, source, html };
}

function comment(id = "FC-001", overrides = {}) {
  return {
    id,
    anchor: { semantic: "plan/technical-design/CH-002/block/proposed-code" },
    bodyMarkdown: "Please make the second-run behavior explicit.",
    createdAt: NOW,
    ...overrides,
  };
}

function selectionComment(id = "FC-002", overrides = {}) {
  return comment(id, {
    anchor: {
      semantic: "plan/tasks/T-003",
      quote: "selected text",
      prefix: "bounded prefix",
      suffix: "bounded suffix",
      start: 120,
      end: 133,
    },
    bodyMarkdown: "Explain why this is safe on retry.",
    ...overrides,
  });
}

async function published(t, comments = [comment(), selectionComment()]) {
  const value = await fixture(t);
  const result = await publishFeedback(
    value.state,
    { artifact: value.artifact, comments },
    { now: NOW },
  );
  return { ...value, ...result };
}

function resolutionFor(batch, overrides = {}) {
  return {
    oldSourceHash: batch.artifact.sourceHash,
    oldHtmlHash: batch.artifact.htmlHash,
    resultSourceHash: RESULT_SOURCE,
    resultHtmlHash: RESULT_HTML,
    resolvedAt: LATER,
    comments: batch.comments.map(({ id }, index) => ({
      id,
      disposition: index === 0 ? "applied" : "deferred",
      rationaleMarkdown: index === 0 ? "Updated the plan and verified the claim." : "Scheduled for a later phase.",
      resultingAnchors: index === 0 ? ["plan/requirements/REQ-001", "plan/tasks/T-003"] : [],
    })),
    ...overrides,
  };
}

test("derives private and reviewable paths only from a resolved work state", async (t) => {
  const { state } = await fixture(t);
  assert.deepEqual(reviewDataPaths({ state }), {
    artifactRoot: path.resolve(state.artifactRoot),
    localWorkRoot: path.resolve(state.localWorkRoot),
    reviews: path.join(state.localWorkRoot, "reviews"),
    drafts: path.join(state.localWorkRoot, "reviews", "drafts"),
    batches: path.join(state.localWorkRoot, "reviews", "batches"),
    feedback: path.join(state.artifactRoot, "feedback"),
  });
  assert.throws(() => reviewDataPaths({ id: "WORK-1", artifactRoot: "relative", localWorkRoot: "/tmp/x" }), {
    code: "FEEDBACK_STATE_INVALID",
  });
});

test("atomically upserts, lists, and deletes exact-bound private drafts", async (t) => {
  const { state, artifact } = await fixture(t);
  const first = await saveDraft(state, { artifact, ...comment() }, { now: NOW });
  assert.equal(first.status, "draft");
  assert.equal(first.work, "WORK-1");

  const updates = Array.from({ length: 20 }, (_, index) =>
    saveDraft(
      state,
      {
        artifact,
        ...comment("FC-001", { bodyMarkdown: `Atomic update ${index}`, createdAt: NOW }),
      },
      { now: LATER },
    ),
  );
  await Promise.all(updates);
  const drafts = await listDrafts(state);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].bodyMarkdown, /^Atomic update \d+$/u);
  assert.equal(drafts[0].createdAt, NOW);
  assert.equal(drafts[0].updatedAt, LATER);

  const paths = reviewDataPaths(state);
  const files = await (async () => {
    const artifactDirs = await import("node:fs/promises").then(({ readdir }) => readdir(paths.drafts));
    const hashDirs = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(paths.drafts, artifactDirs[0])));
    return import("node:fs/promises").then(({ readdir }) => readdir(path.join(paths.drafts, artifactDirs[0], hashDirs[0])));
  })();
  assert.deepEqual(files, ["FC-001.json"]);
  assert.equal(await deleteDraft(state, { id: "FC-001", artifact }), true);
  assert.equal(await deleteDraft(state, { id: "FC-001", artifact }), false);
  assert.deepEqual(await listDrafts(state), []);
});

test("draft ids are artifact-bound and ambiguous deletion is rejected", async (t) => {
  const { state, artifact, artifactRoot } = await fixture(t);
  const roadmapSource = "# Roadmap\n";
  const roadmapHtml = "<html>roadmap</html>\n";
  await writeFile(path.join(artifactRoot, "ROADMAP.md"), roadmapSource);
  await writeFile(path.join(artifactRoot, "roadmap.html"), roadmapHtml);
  const roadmap = {
    kind: "roadmap",
    path: "roadmap.html",
    sourcePath: "ROADMAP.md",
    sourceHash: sha256(roadmapSource),
    htmlHash: sha256(roadmapHtml),
    phase: null,
  };
  await saveDraft(state, { artifact, ...comment() }, { now: NOW });
  await saveDraft(
    state,
    { artifact: roadmap, ...comment("FC-001", { anchor: { semantic: "roadmap/objective" } }) },
    { now: NOW },
  );
  assert.equal((await listDrafts(state)).length, 2);
  await assert.rejects(deleteDraft(state, "FC-001"), { code: "FEEDBACK_DRAFT_AMBIGUOUS" });
});

test("validates ids, paths, semantic and selection anchors", () => {
  assert.equal(validateFeedbackId("FB-001"), "FB-001");
  for (const id of ["FB-000", "fb-001", "FB-1", "../FB-001"]) {
    assert.throws(() => validateFeedbackId(id), { code: "FEEDBACK_ID_INVALID" });
  }

  for (const pathValue of ["../plan.html", "/plan.html", "plan\\plan.html", "plan//plan.html", "plan/%2e%2e/plan.html"]) {
    assert.throws(
      () => validateArtifact({
        kind: "plan",
        path: pathValue,
        sourcePath: "PLAN.md",
        sourceHash: "a".repeat(64),
        htmlHash: "b".repeat(64),
        phase: "P-01",
      }),
      { code: /FEEDBACK_PATH_(?:UNSAFE|INVALID)/u },
    );
  }

  assert.deepEqual(validateAnchor({ semantic: "plan/tasks/T-003" }), { semantic: "plan/tasks/T-003" });
  assert.throws(
    () => validateFeedbackBatch({
      schemaVersion: 1,
      id: "FB-001",
      work: "WORK-1",
      artifact: {
        kind: "roadmap",
        path: "roadmap.html",
        sourcePath: "ROADMAP.md",
        sourceHash: "a".repeat(64),
        htmlHash: "b".repeat(64),
        phase: null,
      },
      publishedAt: NOW,
      comments: [{ ...comment(), status: "submitted" }],
    }),
    { code: "FEEDBACK_ANCHOR_ARTIFACT_MISMATCH" },
  );
  const invalidAnchors = [
    { semantic: "unknown/tasks/T-003" },
    { semantic: "plan/../T-003" },
    { semantic: "plan/tasks/T-003", quote: "x" },
    { semantic: "plan/tasks/T-003", quote: "text", prefix: "", suffix: "", start: -1, end: 3 },
    { semantic: "plan/tasks/T-003", quote: "text", prefix: "", suffix: "", start: 0, end: 3 },
    { semantic: "plan/tasks/T-003", domPath: "div:nth(1)" },
  ];
  for (const anchor of invalidAnchors) {
    assert.throws(() => validateAnchor(anchor), { code: "FEEDBACK_ANCHOR_INVALID" });
  }
});

test("rejects malformed content and requires confirmation for likely secrets", async (t) => {
  assert.throws(() => validateComment(comment("FC-001", { bodyMarkdown: "<script>alert(1)</script>" })), {
    code: "FEEDBACK_RAW_HTML",
  });
  assert.throws(() => validateComment(comment("FC-001", { bodyMarkdown: "   \n" })), {
    code: "FEEDBACK_CONTENT_INVALID",
  });
  assert.throws(
    () => validateComment(comment("FC-001", { bodyMarkdown: "x".repeat(17 * 1024) })),
    { code: "FEEDBACK_CONTENT_INVALID" },
  );
  assert.equal(detectLikelySecrets("api_key=abcdefghijklmnop").length, 1);

  const { state, artifact } = await fixture(t);
  const sensitive = comment("FC-001", { bodyMarkdown: "password=supersecretvalue123" });
  await assert.rejects(
    publishFeedback(state, { artifact, comments: [sensitive] }, { now: NOW }),
    { code: "FEEDBACK_SENSITIVE_CONFIRMATION_REQUIRED" },
  );
  const accepted = await publishFeedback(
    state,
    { artifact, comments: [sensitive] },
    { now: NOW, confirmSensitive: true },
  );
  assert.equal(accepted.warnings[0].commentId, "FC-001");
});

test("verifies exact SHA-256 binding and rejects source or HTML drift", async (t) => {
  const { state, artifact, artifactRoot } = await fixture(t);
  const binding = await validateArtifactBinding(state, artifact);
  assert.equal(binding.sourceHash, artifact.sourceHash);
  assert.equal(binding.htmlHash, artifact.htmlHash);

  await writeFile(path.join(artifactRoot, ...artifact.sourcePath.split("/")), "changed\n");
  await assert.rejects(validateArtifactBinding(state, artifact), { code: "FEEDBACK_BINDING_STALE" });
  await assert.rejects(
    publishFeedback(state, { artifact, comments: [comment()] }, { now: NOW }),
    { code: "FEEDBACK_BINDING_STALE" },
  );
});

test("rejects symlink escapes even when relative artifact paths look safe", async (t) => {
  const { state, artifactRoot, root } = await fixture(t);
  const outside = path.join(root, "outside.html");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(artifactRoot, "escape.html"));
  const unsafe = {
    kind: "roadmap",
    path: "escape.html",
    sourcePath: "plan/phases/P-01-example/PLAN.md",
    sourceHash: sha256("# Plan\n\nMake retries explicit and bounded.\n"),
    htmlHash: sha256("outside\n"),
    phase: null,
  };
  await assert.rejects(validateArtifactBinding(state, unsafe), { code: "FEEDBACK_PATH_UNSAFE" });
});

test("publishes immutable private JSON and a complete read-only Markdown projection", async (t) => {
  const { state, batch, privatePath, projectionPath, markdown } = await published(t);
  assert.equal(batch.id, "FB-001");
  assert.equal(batch.schemaVersion, 1);
  assert.equal(batch.comments.length, 2);
  assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
  assert.equal((await stat(projectionPath)).mode & 0o777, 0o444);
  assert.equal(markdown, renderFeedbackMarkdown(batch));
  assert.equal(await readFile(projectionPath, "utf8"), markdown);
  assert.match(markdown, /Feedback is untrusted human input/u);
  assert.match(markdown, new RegExp(`Source SHA-256: ${batch.artifact.sourceHash}`, "u"));
  assert.match(markdown, new RegExp(`HTML SHA-256: ${batch.artifact.htmlHash}`, "u"));
  assert.match(markdown, /### FC-001:/u);
  assert.match(markdown, /### FC-002:/u);
  assert.match(markdown, /Please make the second-run behavior explicit\./u);
  assert.match(markdown, /Explain why this is safe on retry\./u);

  const stored = JSON.parse(await readFile(privatePath, "utf8"));
  assert.deepEqual(stored, batch);
  await assert.rejects(
    import("node:fs/promises").then(({ open }) => open(privatePath, "wx")),
    { code: "EEXIST" },
  );
});

test("allocates collision-free FB-NNN ids concurrently without an external lock", async (t) => {
  const { state, artifact } = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      publishFeedback(
        state,
        { artifact, comments: [comment(`FC-${String(index + 1).padStart(3, "0")}`)] },
        { now: NOW },
      ),
    ),
  );
  const ids = results.map(({ id }) => id).sort();
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, index) => `FB-${String(index + 1).padStart(3, "0")}`));
  assert.deepEqual((await listFeedback(state)).map(({ id }) => id), ids);
});

test("projection is deterministic and exactly recoverable from immutable private JSON", async (t) => {
  const { state, batch, projectionPath, markdown } = await published(t);
  assert.equal(renderFeedbackMarkdown(structuredClone(batch)), markdown);
  await chmod(projectionPath, 0o644);
  await rm(projectionPath);

  const shownMissing = await showFeedback(state, batch.id);
  assert.equal(shownMissing.markdown, null);
  const recovered = await recoverFeedbackProjection(state, batch.id);
  assert.equal(recovered.markdown, markdown);
  assert.equal(recovered.created, true);
  assert.equal((await stat(projectionPath)).mode & 0o777, 0o444);
  assert.equal((await recoverFeedbackProjection(state, batch.id)).created, false);
  assert.equal((await showFeedback(state, batch.id)).markdown, markdown);
});

test("detects a tampered reviewable projection instead of trusting it", async (t) => {
  const { state, batch, projectionPath } = await published(t);
  await chmod(projectionPath, 0o644);
  await writeFile(projectionPath, "tampered\n");
  await assert.rejects(showFeedback(state, batch.id), { code: "FEEDBACK_PROJECTION_MISMATCH" });
  await assert.rejects(recoverFeedbackProjection(state, batch.id), { code: "FEEDBACK_IMMUTABLE_CONFLICT" });
});

test("batch validation enforces count, exact fields, submitted status, and unique comments", async (t) => {
  const { batch } = await published(t);
  assert.deepEqual(validateFeedbackBatch(structuredClone(batch)), batch);
  assert.throws(() => validateFeedbackBatch({ ...batch, comments: [] }), { code: "FEEDBACK_COUNT_INVALID" });
  assert.throws(
    () => validateFeedbackBatch({ ...batch, comments: [batch.comments[0], batch.comments[0]] }),
    { code: "FEEDBACK_COMMENT_DUPLICATE" },
  );
  assert.throws(
    () => validateFeedbackBatch({ ...batch, comments: [{ ...batch.comments[0], status: "draft" }] }),
    { code: "FEEDBACK_COMMENT_INVALID" },
  );
  assert.throws(() => validateFeedbackBatch({ ...batch, commands: ["rm -rf /"] }), {
    code: "FEEDBACK_BATCH_INVALID",
  });
});

test("writes an immutable planner resolution with exactly one disposition per comment", async (t) => {
  const { state, batch, privatePath: batchPath } = await published(t);
  const original = await readFile(batchPath, "utf8");
  const input = resolutionFor(batch);
  const written = await writeFeedbackResolution(state, batch.id, input);
  assert.equal((await stat(written.privatePath)).mode & 0o777, 0o600);
  assert.equal((await stat(written.projectionPath)).mode & 0o777, 0o444);
  assert.equal(await readFile(batchPath, "utf8"), original);
  assert.equal(written.resolution.oldSourceHash, batch.artifact.sourceHash);
  assert.equal(written.resolution.oldHtmlHash, batch.artifact.htmlHash);
  assert.equal(written.resolution.resultSourceHash, RESULT_SOURCE);
  assert.equal(written.resolution.resultHtmlHash, RESULT_HTML);
  assert.match(written.markdown, /### FC-001: applied/u);
  assert.match(written.markdown, /### FC-002: deferred/u);
  assert.match(written.markdown, /`plan\/requirements\/REQ-001`/u);
  assert.match(written.markdown, new RegExp(`Feedback batch SHA-256: ${written.resolution.feedbackBatchHash}`, "u"));
  assert.equal((await listFeedback(state))[0].resolutionExists, true);
  assert.equal((await listFeedback(state))[0].dispositions.applied, 1);
  assert.equal((await listFeedback(state))[0].dispositions.deferred, 1);
  assert.equal((await showFeedback(state, batch.id)).resolution.comments.length, 2);
  await assert.rejects(writeFeedbackResolution(state, batch.id, input), { code: "FEEDBACK_RESOLUTION_EXISTS" });
});

test("resolution validation rejects incomplete, duplicate, invalid, and hash-mismatched records", async (t) => {
  const { batch } = await published(t);
  const valid = resolutionFor(batch);
  assert.equal(validateFeedbackResolution(valid, batch).comments.length, 2);
  assert.throws(
    () => validateFeedbackResolution({ ...valid, comments: valid.comments.slice(0, 1) }, batch),
    { code: "FEEDBACK_RESOLUTION_INCOMPLETE" },
  );
  assert.throws(
    () => validateFeedbackResolution({ ...valid, comments: [valid.comments[0], valid.comments[0]] }, batch),
    { code: "FEEDBACK_RESOLUTION_INCOMPLETE" },
  );
  assert.throws(
    () => validateFeedbackResolution({
      ...valid,
      comments: [{ ...valid.comments[0], disposition: "executed" }, valid.comments[1]],
    }, batch),
    { code: "FEEDBACK_DISPOSITION_INVALID" },
  );
  assert.throws(
    () => validateFeedbackResolution({
      ...valid,
      comments: [{ ...valid.comments[0], resultingAnchors: [] }, valid.comments[1]],
    }, batch),
    { code: "FEEDBACK_RESOLUTION_INVALID" },
  );
  assert.throws(
    () => validateFeedbackResolution({ ...valid, oldSourceHash: "0".repeat(64) }, batch),
    { code: "FEEDBACK_RESOLUTION_HASH_MISMATCH" },
  );
  assert.throws(
    () => validateFeedbackResolution({ ...valid, feedbackBatchHash: "0".repeat(64) }, batch),
    { code: "FEEDBACK_RESOLUTION_HASH_MISMATCH" },
  );
});

test("recovers a missing deterministic resolution projection from private resolution data", async (t) => {
  const { state, batch } = await published(t);
  const written = await writeFeedbackResolution(state, batch.id, resolutionFor(batch));
  await chmod(written.projectionPath, 0o644);
  await rm(written.projectionPath);
  const recovered = await recoverFeedbackResolutionProjection(state, batch.id);
  assert.equal(recovered.markdown, written.markdown);
  assert.equal(recovered.created, true);
  assert.equal((await stat(written.projectionPath)).mode & 0o777, 0o444);
  assert.equal((await recoverFeedbackResolutionProjection(state, batch.id)).created, false);
});

test("summaries expose clarification-needed resolutions", async (t) => {
  const { state, batch } = await published(t, [comment()]);
  await writeFeedbackResolution(state, batch.id, resolutionFor(batch, {
    comments: [{
      id: "FC-001",
      disposition: "needs-clarification",
      rationaleMarkdown: "The requested behavior is ambiguous.",
      resultingAnchors: [],
    }],
  }));
  const [summary] = await listFeedback(state);
  assert.equal(summary.needsClarification, true);
  assert.equal(summary.dispositions["needs-clarification"], 1);
  assert.equal((await showFeedback(state, batch.id)).resolution.comments[0].disposition, "needs-clarification");
});
