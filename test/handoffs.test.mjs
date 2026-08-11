import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listHandoffs, writeHandoff } from "../runtime/handoffs.mjs";

function data(overrides = {}) {
  return {
    stage: "plan",
    stateStatus: "plan_draft",
    stateRevision: 7,
    outcome: "completed",
    objectiveHandled: "Prepared the next phase plan.",
    authoritativeInputsRead: ["CONTEXT.md", "research/EVIDENCE.json", "state revision 7"],
    evidenceAndDecisionsUsed: ["E-001", "D-001", "P-001"],
    artifactsChanged: ["plan/phases/P-01-example/PLAN.md"],
    validationPerformed: ["Plan validation passed with zero warnings."],
    openQuestionsOrBlockers: ["none"],
    exactNextAction: "Run /phasecraft-verify-plan --work WORK-1.",
    ...overrides,
  };
}

test("writes immutable sequential handoffs and lists latest context", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-handoffs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await writeHandoff(root, "phasecraft-planner", data());
  const second = await writeHandoff(root, "phasecraft-planner", data({ outcome: "blocked" }));
  assert.equal(first.path, "handoffs/phasecraft-planner/H-001.md");
  assert.equal(second.path, "handoffs/phasecraft-planner/H-002.md");
  assert.equal(second.supersedes, first.path);

  const source = await readFile(path.join(root, ...second.path.split("/")), "utf8");
  assert.match(source, /^# Handoff H-002: phasecraft-planner$/mu);
  assert.match(source, /- Supersedes: handoffs\/phasecraft-planner\/H-001\.md/u);
  assert.match(source, /## Exact Next Action/u);
  assert.equal((await stat(path.join(root, ...second.path.split("/")))).mode & 0o777, 0o444);

  const listed = await listHandoffs(root, { includeAll: true });
  const planner = listed.agents.find(({ agent }) => agent === "phasecraft-planner");
  assert.equal(listed.total, 2);
  assert.equal(planner.count, 2);
  assert.equal(planner.latest.path, second.path);
  assert.equal(planner.latest.outcome, "blocked");
  assert.equal(planner.handoffs.length, 2);
  assert.ok(listed.missingAgents.includes("phasecraft-executor"));
});

test("rejects invalid agent, stage, outcome, and multiline data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-handoffs-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(writeHandoff(root, "unknown", data()), { code: "HANDOFF_AGENT_INVALID" });
  await assert.rejects(writeHandoff(root, "phasecraft-planner", data({ stage: "execute" })), { code: "HANDOFF_STAGE_INVALID" });
  await assert.rejects(writeHandoff(root, "phasecraft-planner", data({ outcome: "maybe" })), { code: "HANDOFF_OUTCOME_INVALID" });
  await assert.rejects(writeHandoff(root, "phasecraft-planner", data({ exactNextAction: "one\ntwo" })), { code: "HANDOFF_DATA_INVALID" });
});
