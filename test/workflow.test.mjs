import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../runtime/phasecraft.mjs";
import { runGit } from "../runtime/git.mjs";
import { passingChecks, writePlan } from "../test-data/workflow.mjs";

test("CLI drives an explicit initialized to plan draft workflow", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "Phasecraft Test"]);
  await runGit(root, ["config", "user.email", "phasecraft@example.test"]);
  await runGit(root, ["commit", "--allow-empty", "-qm", "initial"]);

  await run(["init-project", "--root", root, "--template", "work/{id}-{slug}", "--artifact-mode", "reviewable"]);
  const created = await run([
    "init-work",
    "--root",
    root,
    "--id",
    "FEATURE-3",
    "--title",
    "Safer shipping",
    "--values",
    "{}",
    "--branch",
    "feature/safer-shipping",
  ]);
  assert.equal(created.state.status, "initialized");

  for (const [to, revision] of [["researching", 0], ["discussed", 1], ["roadmap_ready", 2]]) {
    const result = await run([
      "transition",
      "--root",
      root,
      "--work",
      "FEATURE-3",
      "--to",
      to,
      "--expected-revision",
      String(revision),
    ]);
    assert.equal(result.state.status, to);
  }
  const phase = await run(["phase-start", "--root", root, "--work", "FEATURE-3", "--phase", "P-01"]);
  assert.equal(phase.activePhase, "P-01");
  await run([
    "transition", "--root", root, "--work", "FEATURE-3", "--to", "plan_draft", "--expected-revision", "4",
  ]);
  const preflight = await run(["preflight", "--root", root, "--work", "FEATURE-3", "--stage", "verify-plan"]);
  assert.equal(preflight.preflight.allowed, true);
  assert.equal(preflight.preflight.revision, 5);

  const handoffData = {
    stage: "plan",
    stateStatus: "plan_draft",
    stateRevision: 5,
    outcome: "completed",
    objectiveHandled: "Prepared P-01 for independent audit.",
    authoritativeInputsRead: ["CONTEXT.md", "research/EVIDENCE.json"],
    evidenceAndDecisionsUsed: ["E-001", "D-001"],
    artifactsChanged: ["plan/phases/P-01-safer-shipping/PLAN.md"],
    validationPerformed: ["Restricted plan validation passed."],
    openQuestionsOrBlockers: ["none"],
    exactNextAction: "Run /phasecraft-verify-plan --work FEATURE-3.",
  };
  const written = await run([
    "handoff-write", "--root", root, "--work", "FEATURE-3", "--agent", "phasecraft-planner", "--data", JSON.stringify(handoffData),
  ]);
  assert.equal(written.handoff.path, "handoffs/phasecraft-planner/H-001.md");
  const handoffs = await run(["handoff-list", "--root", root, "--work", "FEATURE-3", "--all"]);
  assert.equal(handoffs.total, 1);
  assert.equal(handoffs.agents.find(({ agent }) => agent === "phasecraft-planner").latest.outcome, "completed");
});

test("CLI captures, adopts, snapshots, previews, and ships exact files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-ship-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "Phasecraft Test"]);
  await runGit(root, ["config", "user.email", "phasecraft@example.test"]);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(root, "feature.txt"), "before\n");
  await runGit(root, ["add", "feature.txt"]);
  await runGit(root, ["commit", "-qm", "initial"]);

  await run(["init-project", "--root", root, "--template", "tasks/{id}-{slug}", "--artifact-mode", "reviewable"]);
  await writeFile(path.join(root, "feature.txt"), "adopted and implemented\n");
  const created = await run([
    "init-work", "--root", root, "--id", "TASK-9", "--title", "Adopt implementation", "--values", "{}",
  ]);
  assert.deepEqual(created.baseline.dirtyFiles, ["feature.txt"]);
  const adopted = await run(["adopt", "--root", root, "--work", "TASK-9", "--files", '["feature.txt"]']);
  assert.deepEqual(adopted.adoptedBaselineFiles, ["feature.txt"]);

  for (const to of ["researching", "discussed", "roadmap_ready"]) {
    await run(["transition", "--root", root, "--work", "TASK-9", "--to", to]);
  }
  await run(["phase-start", "--root", root, "--work", "TASK-9", "--phase", "P-01"]);
  await run(["transition", "--root", root, "--work", "TASK-9", "--to", "plan_draft"]);
  const draft = await run(["status", "--root", root, "--work", "TASK-9"]);
  await writePlan(draft.state);
  await run(["approve-plan", "--root", root, "--work", "TASK-9"]);
  for (const to of ["executing"]) {
    await run(["transition", "--root", root, "--work", "TASK-9", "--to", to]);
  }
  const snapshot = await run([
    "snapshot", "--root", root, "--work", "TASK-9", "--task", "T-001", "--files", '["feature.txt"]',
  ]);
  assert.ok(snapshot.bytes > 0);
  await run(["task-checkpoint", "--root", root, "--work", "TASK-9", "--task", "T-001", "--checks", JSON.stringify(passingChecks)]);
  for (const to of ["execution_complete", "verifying"]) {
    await run(["transition", "--root", root, "--work", "TASK-9", "--to", to]);
  }
  await run(["verification-result", "--root", root, "--work", "TASK-9", "--outcome", "verified", "--checks", JSON.stringify(passingChecks)]);
  const preview = await run([
    "ship-preview",
    "--root",
    root,
    "--work",
    "TASK-9",
  ]);
  const shipped = await run([
    "ship", "--root", root, "--work", "TASK-9", "--approval", preview.approvalFingerprint,
  ]);
  assert.equal(shipped.commits.length, 1);
  assert.equal(shipped.pushed, false);
  const finalState = await run(["transition", "--root", root, "--work", "TASK-9", "--to", "shipped"]);
  assert.equal(finalState.state.status, "shipped");
  assert.deepEqual(finalState.state.completedPhases.map(({ id }) => id), ["P-01"]);
});

test("verified phases return to just-in-time planning with pending checks preserved", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-multiphase-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "Phasecraft Test"]);
  await runGit(root, ["config", "user.email", "phasecraft@example.test"]);
  await runGit(root, ["commit", "--allow-empty", "-qm", "initial"]);
  await run(["init-project", "--root", root, "--template", "tasks/{id}-{slug}", "--artifact-mode", "local"]);
  await run(["init-work", "--root", root, "--id", "MULTI-1", "--title", "Two phases", "--values", "{}"]);
  for (const to of ["researching", "discussed", "roadmap_ready"]) {
    await run(["transition", "--root", root, "--work", "MULTI-1", "--to", to]);
  }
  await run(["phase-start", "--root", root, "--work", "MULTI-1", "--phase", "P-01"]);
  await run(["transition", "--root", root, "--work", "MULTI-1", "--to", "plan_draft"]);
  await writePlan((await run(["status", "--root", root, "--work", "MULTI-1"])).state);
  await run(["approve-plan", "--root", root, "--work", "MULTI-1"]);
  await run(["transition", "--root", root, "--work", "MULTI-1", "--to", "executing"]);
  await writeFile(path.join(root, "feature.txt"), "implemented\n");
  await run(["task-checkpoint", "--root", root, "--work", "MULTI-1", "--task", "T-001", "--checks", JSON.stringify(passingChecks)]);
  for (const to of ["execution_complete", "verifying"]) {
    await run(["transition", "--root", root, "--work", "MULTI-1", "--to", to]);
  }
  const verification = await run([
    "verification-result",
    "--root",
    root,
    "--work",
    "MULTI-1",
    "--outcome",
    "verified_pending",
    "--checks",
    JSON.stringify(passingChecks),
    "--pending",
    '[{"id":"M-001","description":"Confirm the mobile interaction."}]',
  ]);
  assert.equal(verification.outcome, "verified_pending");
  const next = await run(["phase-start", "--root", root, "--work", "MULTI-1", "--phase", "P-02"]);
  assert.equal(next.activePhase, "P-02");
  assert.deepEqual(next.completedPhases.map(({ id }) => id), ["P-01"]);
  assert.deepEqual(next.pendingManualChecks.map(({ id }) => id), ["M-001"]);
  const status = await run(["status", "--root", root, "--work", "MULTI-1"]);
  assert.equal(status.state.status, "roadmap_ready");
  assert.equal(status.state.planVersion, 0);
});

test("baseline-clean requires a dirty file to be restored before planning edits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-baseline-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "Phasecraft Test"]);
  await runGit(root, ["config", "user.email", "phasecraft@example.test"]);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(root, "shared.txt"), "clean\n");
  await runGit(root, ["add", "shared.txt"]);
  await runGit(root, ["commit", "-qm", "initial"]);
  await run(["init-project", "--root", root, "--template", "tasks/{id}-{slug}", "--artifact-mode", "local"]);
  await writeFile(path.join(root, "shared.txt"), "user edit\n");
  await run(["init-work", "--root", root, "--id", "CLEAN-1", "--title", "Clean baseline", "--values", "{}"]);
  await assert.rejects(
    run(["baseline-clean", "--root", root, "--work", "CLEAN-1", "--files", '["shared.txt"]']),
    { code: "BASELINE_FILE_STILL_DIRTY" },
  );
  await writeFile(path.join(root, "shared.txt"), "clean\n");
  const cleaned = await run([
    "baseline-clean", "--root", root, "--work", "CLEAN-1", "--files", '["shared.txt"]',
  ]);
  assert.deepEqual(cleaned.cleanedBaselineFiles, ["shared.txt"]);
});

test("CLI starts local review and lists, shows, and resolves feedback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-review-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "Phasecraft Test"]);
  await runGit(root, ["config", "user.email", "phasecraft@example.test"]);
  await runGit(root, ["commit", "--allow-empty", "-qm", "initial"]);
  await run(["init-project", "--root", root, "--template", "tasks/{id}-{slug}", "--artifact-mode", "reviewable"]);
  const created = await run(["init-work", "--root", root, "--id", "REVIEW-1", "--title", "Review plan", "--values", "{}"]);
  const phase = path.join(created.state.artifactRoot, "plan", "phases", "P-01-review");
  await mkdir(phase, { recursive: true });
  const source = "# Review plan\n";
  const { sha256, publishFeedback } = await import("../runtime/feedback.mjs");
  const html = `<!doctype html><html><head><meta name="phasecraft-source-sha256" content="${sha256(source)}"></head><body><p data-phasecraft-anchor="plan/goal">Review goal</p><script type="application/json" id="phasecraft-review-manifest">{"schemaVersion":1,"entries":[{"semantic":"plan/goal","label":"Goal","plainText":"Review goal"}]}</script></body></html>\n`;
  await writeFile(path.join(phase, "PLAN.md"), source);
  await writeFile(path.join(phase, "plan.html"), html);
  const started = await run(["review-start", "--root", root, "--work", "REVIEW-1", "--artifact", "plan", "--no-open"]);
  assert.equal(started.opened, false);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/#/u);
  assert.equal((await run(["review-status", "--root", root, "--work", "REVIEW-1"])).running, true);
  t.after(() => run(["review-stop", "--root", root, "--work", "REVIEW-1"]).catch(() => {}));

  const artifact = {
    kind: "plan",
    path: "plan/phases/P-01-review/plan.html",
    sourcePath: "plan/phases/P-01-review/PLAN.md",
    sourceHash: sha256(source),
    htmlHash: sha256(html),
    phase: "P-01",
  };
  await publishFeedback(created.state, {
    artifact,
    comments: [{ id: "FC-001", anchor: { semantic: "plan/goal" }, bodyMarkdown: "Clarify the goal.", createdAt: "2026-08-12T10:11:12.000Z" }],
  }, { now: "2026-08-12T10:11:12.000Z" });
  const listed = await run(["feedback-list", "--root", root, "--work", "REVIEW-1"]);
  assert.deepEqual(listed.feedback.map(({ id }) => id), ["FB-001"]);
  const shown = await run(["feedback-show", "--root", root, "--work", "REVIEW-1", "--feedback", "FB-001"]);
  assert.equal(shown.batch.comments[0].bodyMarkdown, "Clarify the goal.");
  const resultSourceHash = sha256(source);
  const resolutionFile = path.join(root, "resolution.json");
  await writeFile(resolutionFile, JSON.stringify({
    resultSourceHash,
    resultHtmlHash: sha256(html),
    comments: [{ id: "FC-001", disposition: "applied", rationaleMarkdown: "Clarified the goal.", resultingAnchors: ["plan/goal"] }],
  }));
  const resolved = await run(["feedback-resolve", "--root", root, "--work", "REVIEW-1", "--feedback", "FB-001", "--data-file", resolutionFile]);
  assert.equal(resolved.resolution.resultSourceHash, resultSourceHash);
  assert.match(await readFile(path.join(created.state.artifactRoot, "feedback", "FB-001-RESOLUTION.md"), "utf8"), /FC-001: applied/u);
});

test("CLI rejects feedback resolutions not bound to generated result artifacts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-feedback-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "Phasecraft Test"]);
  await runGit(root, ["config", "user.email", "phasecraft@example.test"]);
  await runGit(root, ["commit", "--allow-empty", "-qm", "initial"]);
  await run(["init-project", "--root", root, "--template", "tasks/{id}-{slug}", "--artifact-mode", "reviewable"]);
  const created = await run(["init-work", "--root", root, "--id", "BIND-1", "--title", "Bind feedback", "--values", "{}"]);
  const phase = path.join(created.state.artifactRoot, "plan", "phases", "P-01-bind");
  await mkdir(phase, { recursive: true });
  const { sha256, publishFeedback } = await import("../runtime/feedback.mjs");
  const source = "# Bound plan\n";
  const html = `<!doctype html><html><head><meta name="phasecraft-source-sha256" content="${sha256(source)}"></head><body><p data-phasecraft-anchor="plan/goal">Goal</p><script type="application/json" id="phasecraft-review-manifest">{"schemaVersion":1,"entries":[{"semantic":"plan/goal","label":"Goal","plainText":"Goal"}]}</script></body></html>\n`;
  await writeFile(path.join(phase, "PLAN.md"), source);
  await writeFile(path.join(phase, "plan.html"), html);
  await publishFeedback(created.state, {
    artifact: { kind: "plan", path: "plan/phases/P-01-bind/plan.html", sourcePath: "plan/phases/P-01-bind/PLAN.md", sourceHash: sha256(source), htmlHash: sha256(html), phase: "P-01" },
    comments: [{ id: "FC-001", anchor: { semantic: "plan/goal" }, bodyMarkdown: "Clarify.", createdAt: "2026-08-12T10:11:12.000Z" }],
  }, { now: "2026-08-12T10:11:12.000Z" });
  const unknownResult = path.join(root, "unknown-result.json");
  await writeFile(unknownResult, JSON.stringify({
    resultSourceHash: "a".repeat(64),
    resultHtmlHash: "b".repeat(64),
    comments: [{ id: "FC-001", disposition: "applied", rationaleMarkdown: "Changed.", resultingAnchors: ["plan/goal"] }],
  }));
  await assert.rejects(
    run(["feedback-resolve", "--root", root, "--work", "BIND-1", "--feedback", "FB-001", "--data-file", unknownResult]),
    { code: "FEEDBACK_RESULT_BINDING_UNKNOWN" },
  );
  const unknownAnchor = path.join(root, "unknown-anchor.json");
  await writeFile(unknownAnchor, JSON.stringify({
    resultSourceHash: sha256(source),
    resultHtmlHash: sha256(html),
    comments: [{ id: "FC-001", disposition: "applied", rationaleMarkdown: "Changed.", resultingAnchors: ["plan/tasks/T-999"] }],
  }));
  await assert.rejects(
    run(["feedback-resolve", "--root", root, "--work", "BIND-1", "--feedback", "FB-001", "--data-file", unknownAnchor]),
    { code: "FEEDBACK_RESULT_ANCHOR_UNKNOWN" },
  );
});
