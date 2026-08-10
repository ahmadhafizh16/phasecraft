import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkAuthorityDrift,
  discoverAuthorityCandidates,
  setAuthoritySources,
} from "../runtime/knowledge.mjs";
import { initProject, initWork, resolveWork } from "../runtime/state.mjs";
import { run } from "../runtime/phasecraft.mjs";

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-knowledge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "# Project\n\nAuthority.\n");
  await initProject(root, { workPathTemplate: "tasks/{id}-{slug}", artifactMode: "local" });
  return root;
}

test("discovers, confirms, and detects drift in project authorities", async (t) => {
  const root = await project(t);
  const candidates = await discoverAuthorityCandidates(root);
  assert.equal(candidates.some((candidate) => candidate.path === "README.md"), true);
  const registry = await setAuthoritySources(root, [
    { path: "README.md", authority: "primary", reason: "Project contract" },
  ]);
  assert.match(registry.sources[0].hash, /^[a-f0-9]{64}$/u);
  assert.equal((await checkAuthorityDrift(root)).valid, true);
  await writeFile(path.join(root, "README.md"), "# Changed\n");
  const drift = await checkAuthorityDrift(root);
  assert.equal(drift.valid, false);
  assert.deepEqual(drift.stale, ["README.md"]);
});

test("records one explicit external research approval on the work state", async (t) => {
  const root = await project(t);
  await initWork(root, { id: "TASK-1", title: "Research behavior", values: {} });
  const result = await run([
    "research-approve",
    "--root",
    root,
    "--work",
    "TASK-1",
    "--question",
    "What behavior is specified upstream?",
    "--sources",
    '["official documentation"]',
  ]);
  assert.match(result.approval.requestId, /^research-[a-f0-9]{12}$/u);
  const work = await resolveWork(root, { id: "TASK-1" });
  assert.equal(work.state.externalResearchApprovals.length, 1);
  assert.equal(work.state.externalResearchApprovals[0].question, "What behavior is specified upstream?");
});
