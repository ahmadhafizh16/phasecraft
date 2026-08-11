import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../runtime/phasecraft.mjs";
import { runGit } from "../runtime/git.mjs";

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
  for (const to of ["plan_draft", "plan_verified", "executing"]) {
    await run(["transition", "--root", root, "--work", "TASK-9", "--to", to]);
  }
  const snapshot = await run([
    "snapshot", "--root", root, "--work", "TASK-9", "--task", "T-001", "--files", '["feature.txt"]',
  ]);
  assert.ok(snapshot.bytes > 0);
  for (const to of ["execution_complete", "verifying"]) {
    await run(["transition", "--root", root, "--work", "TASK-9", "--to", to]);
  }
  await run(["verification-result", "--root", root, "--work", "TASK-9", "--outcome", "verified"]);
  const preview = await run([
    "ship-preview",
    "--root",
    root,
    "--work",
    "TASK-9",
    "--groups",
    '[{"id":"C-001","message":"feat: adopt implementation","files":["feature.txt"]}]',
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
  for (const to of ["plan_draft", "plan_verified", "executing", "execution_complete", "verifying"]) {
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
