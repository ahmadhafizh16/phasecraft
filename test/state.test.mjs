import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertStage,
  expandWorkPath,
  initProject,
  initWork,
  loadRegistry,
  resolveWork,
  resolveWorkRecord,
  transitionWork,
} from "../runtime/state.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root, {
    workPathTemplate: "features/{feature}/tasks/{id}-{slug}",
    artifactMode: "local",
  });
  return root;
}

test("expands only safe template segments", () => {
  assert.equal(
    expandWorkPath("features/{feature}/tasks/{id}", { feature: "auth", id: "TASK-12" }),
    "features/auth/tasks/TASK-12",
  );
  assert.throws(
    () => expandWorkPath("features/{feature}", { feature: "../../outside" }),
    { code: "TEMPLATE_VALUE_UNSAFE" },
  );
  assert.throws(
    () => expandWorkPath("../{feature}", { feature: "auth" }),
    { code: "WORK_PATH_UNSAFE" },
  );
});

test("initializes and resolves a work item", async (t) => {
  const root = await fixture(t);
  const created = await initWork(root, {
    id: "TASK-12",
    title: "Add session timeout",
    values: { feature: "auth" },
    branch: "feature/session-timeout",
  });
  assert.equal(created.state.status, "initialized");
  assert.equal(created.record.artifactPath, "features/auth/tasks/TASK-12-add-session-timeout");

  const byBranch = await resolveWork(root, { branch: "feature/session-timeout" });
  assert.equal(byBranch.record.id, "TASK-12");
  assertStage(byBranch.state, "discuss");
  assert.throws(() => assertStage(byBranch.state, "execute"), { code: "STAGE_BLOCKED" });
});

test("transitions atomically with revision checks", async (t) => {
  const root = await fixture(t);
  const { record } = await initWork(root, {
    id: "WORK-1",
    title: "First work",
    values: { feature: "core" },
  });
  const researching = await transitionWork(root, record, "researching", { expectedRevision: 0 });
  assert.equal(researching.revision, 1);
  assert.equal(researching.status, "researching");
  await assert.rejects(
    transitionWork(root, record, "discussed", { expectedRevision: 0 }),
    { code: "REVISION_CONFLICT" },
  );
  const discussed = await transitionWork(root, record, "discussed", { expectedRevision: 1 });
  assert.equal(discussed.revision, 2);
  await assert.rejects(transitionWork(root, record, "executing"), { code: "TRANSITION_ILLEGAL" });
});

test("requires explicit resolution when multiple work items are open", async (t) => {
  const root = await fixture(t);
  await initWork(root, { id: "A-1", title: "Alpha", values: { feature: "alpha" } });
  await initWork(root, { id: "B-1", title: "Beta", values: { feature: "beta" } });
  const registry = await loadRegistry(root);
  assert.throws(() => resolveWorkRecord(registry), { code: "WORK_AMBIGUOUS" });
  assert.equal(resolveWorkRecord(registry, { id: "B-1" }).title, "Beta");
});
