import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../runtime/phasecraft.mjs";
import { runGit } from "../runtime/git.mjs";
import { sha256 } from "../runtime/artifacts.mjs";
import { validPlan } from "../test-data/artifacts.mjs";
import { passingChecks, writePlan } from "../test-data/workflow.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "Phasecraft Test"]);
  await runGit(root, ["config", "user.email", "phasecraft@example.test"]);
  for (const file of ["feature.txt", "second.txt", "unrelated.txt"]) await writeFile(path.join(root, file), "before\n");
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-qm", "initial"]);
  if (options.dirty) await writeFile(path.join(root, options.dirty), "existing user work\n");
  const cli = (command, ...args) => run([command, "--root", root, "--work", "WORK-1", ...args]);
  await run(["init-project", "--root", root, "--template", "tasks/{id}-{slug}", "--artifact-mode", "reviewable"]);
  await cli("init-work", "--id", "WORK-1", "--title", "Approval binding");
  for (const to of ["researching", "discussed", "roadmap_ready"]) await cli("transition", "--to", to);
  await cli("phase-start", "--phase", "P-01");
  await cli("transition", "--to", "plan_draft");
  const state = (await cli("status")).state;
  const plan = await writePlan(state, options);
  const start = async () => { await cli("approve-plan"); await cli("transition", "--to", "executing"); };
  const checkpoint = (task = "T-001", checks = passingChecks) => cli("task-checkpoint", "--task", task, "--checks", JSON.stringify(checks));
  const verify = async (pending = []) => {
    await cli("transition", "--to", "execution_complete");
    await cli("transition", "--to", "verifying");
    return cli("verification-result", "--outcome", pending.length ? "verified_pending" : "verified",
      "--checks", JSON.stringify(passingChecks), "--pending", JSON.stringify(pending));
  };
  return { root, state, cli, plan, start, checkpoint, verify };
}

test("runtime approval gates cannot be skipped with raw state transitions", async (t) => {
  const { cli, start, root, checkpoint } = await fixture(t);
  await assert.rejects(cli("transition", "--to", "plan_verified"), { code: "PLAN_APPROVAL_REQUIRED" });
  await start();
  await assert.rejects(cli("transition", "--to", "execution_complete"), { code: "TASK_CHECKPOINTS_REQUIRED" });
  await writeFile(path.join(root, "feature.txt"), "implemented\n");
  await checkpoint();
  await cli("transition", "--to", "execution_complete");
  await cli("transition", "--to", "verifying");
  await assert.rejects(cli("transition", "--to", "verified"), { code: "CHECKS_INVALID" });
  await cli("verification-result", "--outcome", "verified", "--checks", JSON.stringify(passingChecks));
  await assert.rejects(cli("transition", "--to", "shipped"), { code: "SHIP_INCOMPLETE" });
});

test("approval rejects changes to the exact plan, HTML, audit, and evidence", async (t) => {
  for (const artifact of ["PLAN.md", "plan.html", "PLAN-VERIFICATION.md", "EVIDENCE.json"]) {
    await t.test(artifact, async (t) => {
      const { cli, state, plan } = await fixture(t);
      const approved = await cli("approve-plan");
      const file = artifact === "EVIDENCE.json" ? path.join(state.artifactRoot, "research", artifact) : path.join(plan.directory, artifact);
      await writeFile(file, `${await readFile(file, "utf8")}\n`);
      await assert.rejects(cli("preflight", "--stage", "execute"), (cause) => /(?:STALE|INVALID)$/u.test(cause.code));
      assert.equal((await cli("status")).state.revision, approved.state.revision);
    });
  }
});

test("human risk acceptance is valid, but pending or incomplete dispositions block approval", async (t) => {
  const { cli, plan } = await fixture(t);
  const hash = sha256(plan.source);
  const audit = `# Plan Verification
**Outcome:** APPROVED WITH DISPOSITIONS
**Plan SHA-256:** ${hash}

## Integrity Gate
- Status: passed

## Findings
### PV-001: Deliberate tradeoff
- Consequence: A rare request may fail.

## Human Q&A
### Q-001: Accept the tradeoff
- Findings: PV-001
- Answer: accept-risk
- Human rationale: Ship the bounded first version.
- Guardrails: none
- Plan SHA-256: ${hash}

## Execution Gate
- Status: approved
`;
  const file = path.join(plan.directory, "PLAN-VERIFICATION.md");
  await writeFile(file, audit.replace("Answer: accept-risk", "Answer: pending"));
  await assert.rejects(cli("approve-plan"), { code: "PLAN_DISPOSITION_BLOCKED" });
  await writeFile(file, audit.replace("Findings: PV-001", "Findings: PV-999"));
  await assert.rejects(cli("approve-plan"), { code: "PLAN_DISPOSITION_BLOCKED" });
  await writeFile(file, audit);
  const approved = await cli("approve-plan");
  assert.equal(approved.approval.dispositions[0].guardrails, "none");
  assert.equal(approved.approval.outcome, "APPROVED WITH DISPOSITIONS");
});

test("an absent or malformed evidence registry cannot be treated as optional during approval", async (t) => {
  const { cli, state } = await fixture(t);
  for (const value of [null, { schemaVersion: 1, entries: {} }]) {
    await writeFile(path.join(state.artifactRoot, "research", "EVIDENCE.json"), JSON.stringify(value));
    await assert.rejects(cli("approve-plan"), { code: "EVIDENCE_INVALID" });
  }
});

test("execution preflight enforces baseline adoption", async (t) => {
  const { cli } = await fixture(t, { dirty: "feature.txt" });
  await cli("approve-plan");
  await assert.rejects(cli("preflight", "--stage", "execute"), { code: "BASELINE_ADOPTION_REQUIRED" });
  await cli("adopt", "--files", '["feature.txt"]');
  await cli("transition", "--to", "executing");
});

function dependentPlan() {
  return validPlan.replaceAll("src/session.mjs", "feature.txt").replaceAll(", test/session.test.mjs", "")
    .replace("## Risk Controls", `### T-002: Dependent change
- Requirements: REQ-001
- Evidence: E-001
- Depends on: T-001
- Files: second.txt
- Change: Complete dependent behavior.
- Verification: Observe dependent behavior; reject invalid input
- Commit group: C-002

## Risk Controls`)
    .replace("## Manual Checks", `### C-002: Dependent commit
- Files: second.txt
- Message: fix: dependent change
- Depends on: C-001

## Manual Checks`);
}

test("durable task checkpoints respect dependencies and invalidate dependent completions on retry", async (t) => {
  const { cli, root, start, checkpoint } = await fixture(t, { source: dependentPlan() });
  await start();
  await assert.rejects(checkpoint("T-002"), { code: "TASK_DEPENDENCY_INCOMPLETE" });
  await writeFile(path.join(root, "feature.txt"), "first\n");
  await assert.rejects(checkpoint("T-001", [{ name: "unit", passed: false }]), { code: "CHECKS_FAILED" });
  const first = await checkpoint();
  assert.equal((await stat(first.checkpoint.snapshot.outputPath)).mode & 0o777, 0o600);
  await writeFile(path.join(root, "second.txt"), "second\n");
  await checkpoint("T-002");
  const report = await cli("resume", "--host", "codex");
  assert.deepEqual(report.execution.completedTasks, ["T-001", "T-002"]);
  assert.match(report.nextAction.command, /^\$phasecraft-execute/u);
  await writeFile(path.join(root, "feature.txt"), "revised first\n");
  assert.ok((await cli("doctor")).warnings.some((warning) => warning.code === "EXECUTION_UNCHECKPOINTED"));
  await checkpoint();
  await assert.rejects(cli("transition", "--to", "execution_complete"), { code: "TASK_CHECKPOINTS_REQUIRED" });
  await checkpoint("T-002");
  await cli("transition", "--to", "execution_complete");
});

test("checkpoints preserve unrelated baseline work and reject new out-of-scope edits", async (t) => {
  const { cli, root, start, checkpoint } = await fixture(t, { dirty: "unrelated.txt" });
  await start();
  await writeFile(path.join(root, "feature.txt"), "implemented\n");
  await checkpoint();
  await writeFile(path.join(root, "unrelated.txt"), "changed outside scope\n");
  await assert.rejects(checkpoint(), { code: "EXECUTION_SCOPE_DRIFT" });
  assert.equal(await readFile(path.join(root, "unrelated.txt"), "utf8"), "changed outside scope\n");
  assert.equal((await cli("resume")).ready, false);
});

test("Ship uses only approved groups, recorded checks, and exact pending-check acknowledgement", async (t) => {
  const { cli, root, start, checkpoint, verify } = await fixture(t);
  await start();
  await writeFile(path.join(root, "feature.txt"), "implemented\n");
  await checkpoint();
  await verify([{ id: "M-001", description: "Review the physical device." }]);
  await assert.rejects(cli("ship-preview", "--groups", '[{"id":"C-999","message":"other","files":["unrelated.txt"]}]'), { code: "SHIP_SCOPE_INVALID" });
  await assert.rejects(cli("ship-preview", "--checks", "[]"), { code: "SHIP_VERIFICATION_MISMATCH" });
  await assert.rejects(cli("ship-preview", "--pending", "[]"), { code: "SHIP_VERIFICATION_MISMATCH" });
  const preview = await cli("ship-preview");
  await assert.rejects(cli("ship", "--approval", preview.approvalFingerprint), { code: "SHIP_PENDING_ACK_REQUIRED" });
  const result = await cli("ship", "--approval", preview.approvalFingerprint, "--ack-pending", preview.approvalFingerprint);
  assert.equal(result.commits.length, 1);
  assert.equal(result.pushed, false);
  assert.equal((await cli("resume")).ship.status, "completed");
  await cli("transition", "--to", "shipped");
});

test("implementation changes after independent verification invalidate Ship", async (t) => {
  const { cli, root, start, checkpoint, verify } = await fixture(t);
  await start();
  await writeFile(path.join(root, "feature.txt"), "implemented\n");
  await checkpoint();
  await verify();
  await writeFile(path.join(root, "feature.txt"), "unverified change\n");
  await assert.rejects(cli("ship-preview"), { code: "EXECUTION_CHECKPOINT_STALE" });
  assert.equal((await cli("doctor")).ready, false);
});

test("Ship resumes remaining approved groups after a hook failure without repeating commits", async (t) => {
  const { cli, root, state, start, checkpoint, verify } = await fixture(t, { source: dependentPlan() });
  await start();
  await writeFile(path.join(root, "feature.txt"), "first\n");
  await checkpoint();
  await writeFile(path.join(root, "second.txt"), "second\n");
  await checkpoint("T-002");
  await verify();
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  await writeFile(hook, '#!/bin/sh\ncase "$(git diff --cached --name-only)" in *second.txt*) exit 1;; esac\n', { mode: 0o755 });
  const preview = await cli("ship-preview");
  await assert.rejects(cli("ship", "--approval", preview.approvalFingerprint), (cause) => {
    assert.equal(cause.details.commits.length, 1);
    return cause.code === "GIT_COMMAND_FAILED";
  });
  const journalPath = path.join(state.localWorkRoot, "ship", "journal.json");
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).commits.length, 1);
  assert.equal((await cli("resume")).ship.commits.length, 1);
  await rm(hook);
  await runGit(root, ["reset", "-q"]);
  const next = await cli("ship-preview");
  assert.equal(next.groups.length, 1);
  assert.deepEqual(next.groups[0].files, ["second.txt"]);
  assert.equal(next.previousCommits.length, 1);
  const shipped = await cli("ship", "--approval", next.approvalFingerprint);
  assert.equal(shipped.commits.length, 2);
  assert.notEqual(shipped.commits[0].commit, shipped.commits[1].commit);
  await cli("transition", "--to", "shipped");
});

test("doctor is read-only and all hosts can publish generated HTML feedback that agents read", async (t) => {
  const { cli, state } = await fixture(t);
  const revision = (await cli("status")).state.revision;
  for (const [index, host] of ["opencode", "claude", "codex", "pi"].entries()) {
    const review = await cli("review-start", "--host", host, "--no-open");
    t.after(() => { try { process.kill(review.pid, "SIGTERM"); } catch {} });
    const url = new URL(review.url);
    const requestHeaders = { origin: url.origin, "content-type": "application/json" };
    const exchange = await fetch(`${url.origin}/auth/exchange`, { method: "POST", headers: { ...requestHeaders, "x-phasecraft-bootstrap": "1" }, body: JSON.stringify({ token: url.hash.slice(1) }) });
    const cookie = exchange.headers.get("set-cookie").split(";", 1)[0];
    const csrf = (await exchange.json()).csrf;
    const headers = { ...requestHeaders, cookie, "x-phasecraft-csrf": csrf };
    const session = await (await fetch(`${url.origin}/api/session`, { headers: { cookie } })).json();
    assert.equal(session.agentHost, host);
    const artifact = session.artifacts.find((item) => item.key === session.activeKey);
    const html = await (await fetch(`${url.origin}/artifact/${artifact.key}`, { headers: { cookie } })).text();
    assert.match(html, /data-phasecraft-anchor="plan\/goal"/u);
    const commentId = `FC-00${index + 1}`;
    const saved = await fetch(`${url.origin}/api/drafts/${commentId}`, { method: "PUT", headers, body: JSON.stringify({
      id: commentId, artifactKey: artifact.key, sourceHash: artifact.sourceHash, htmlHash: artifact.htmlHash,
      anchor: { semantic: "plan/goal" }, bodyMarkdown: `Feedback from ${host}.`,
    }) });
    assert.equal(saved.status, 200, await saved.text());
    const published = await fetch(`${url.origin}/api/publish`, { method: "POST", headers, body: JSON.stringify({
      artifactKey: artifact.key, sourceHash: artifact.sourceHash, htmlHash: artifact.htmlHash, commentIds: [commentId],
    }) });
    assert.equal(published.status, 201);
    const response = await published.json();
    assert.equal(response.command, `${host === "codex" ? "$" : "/"}phasecraft-plan --work WORK-1 --feedback ${response.id}`);
    const agentResponse = await cli("feedback-show", "--host", host, "--feedback", response.id);
    assert.equal(agentResponse.batch.comments[0].bodyMarkdown, `Feedback from ${host}.`);
    assert.equal(agentResponse.batch.artifact.sourceHash, artifact.sourceHash);
    const report = await cli("doctor", "--host", host);
    assert.equal(report.feedback.at(-1).command, response.command);
    assert.equal(report.revision, revision);
    await cli("review-stop");
  }
  assert.equal(JSON.parse(await readFile(path.join(state.localWorkRoot, "state.json"), "utf8")).revision, revision);
});

test("resume reconciles a commit made immediately before the process lost its journal update", async (t) => {
  const { cli, root, state, start, checkpoint, verify } = await fixture(t);
  await start();
  await writeFile(path.join(root, "feature.txt"), "implemented\n");
  await checkpoint();
  await verify();
  const preview = await cli("ship-preview");
  const shipped = await cli("ship", "--approval", preview.approvalFingerprint);
  const journalPath = path.join(state.localWorkRoot, "ship", "journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const last = journal.commits.pop();
  journal.pending = { group: last.group, headBefore: last.headBefore };
  journal.status = "running";
  await writeFile(journalPath, JSON.stringify(journal));
  const report = await cli("resume");
  assert.equal(report.ship.recoveredPendingCommit, true);
  assert.equal(report.ship.commits[0].commit, shipped.commits[0].commit);
  const resumed = await cli("ship", "--approval", preview.approvalFingerprint);
  assert.equal(resumed.commits.length, 1);
  assert.equal(resumed.recovered, true);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).commits.length, 1);
  await cli("transition", "--to", "shipped");
});

test("final Ship retains approvals and pending check identities across multiple phases", async (t) => {
  const { cli, root, plan, start, checkpoint, verify } = await fixture(t);
  await start();
  await writeFile(path.join(root, "feature.txt"), "phase one\n");
  await checkpoint();
  await verify([{ id: "M-001", description: "First phase manual observation." }]);
  await cli("phase-start", "--phase", "P-02");
  await cli("transition", "--to", "plan_draft");
  await writePlan((await cli("status")).state, { file: "second.txt" });
  await start();
  await writeFile(path.join(root, "second.txt"), "phase two\n");
  await checkpoint();
  await verify([{ id: "M-001", description: "Second phase manual observation." }]);
  const status = await cli("status");
  assert.deepEqual(status.state.pendingManualChecks.map((check) => check.phase), ["P-01", "P-02"]);
  await writeFile(path.join(plan.directory, "PLAN.md"), `${plan.source}\nchanged historical approval\n`);
  await assert.rejects(cli("ship-preview"), { code: "PLAN_HTML_STALE" });
  await writeFile(path.join(plan.directory, "PLAN.md"), plan.source);
  const preview = await cli("ship-preview");
  assert.deepEqual(preview.groups.map((group) => group.id), ["P-01:C-001", "P-02:C-001"]);
  assert.equal(preview.pendingManualChecks.length, 2);
  const result = await cli("ship", "--approval", preview.approvalFingerprint, "--ack-pending", preview.approvalFingerprint);
  assert.equal(result.commits.length, 2);
  await cli("transition", "--to", "shipped");
});

test("a between-phase edit cannot replace a previous phase's independently verified file", async (t) => {
  const { cli, root, start, checkpoint, verify } = await fixture(t);
  await start();
  await writeFile(path.join(root, "feature.txt"), "verified phase one\n");
  await checkpoint();
  await verify();
  await cli("phase-start", "--phase", "P-02");
  await writeFile(path.join(root, "feature.txt"), "unverified between-phase edit\n");
  await cli("transition", "--to", "plan_draft");
  await writePlan((await cli("status")).state, { file: "second.txt" });
  await start();
  await writeFile(path.join(root, "second.txt"), "verified phase two\n");
  await checkpoint();
  await verify();
  await assert.rejects(cli("ship-preview"), { code: "VERIFICATION_STALE" });
});
