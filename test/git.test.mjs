import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureBaseline,
  createPatchSnapshot,
  createShipPreview,
  dirtyFileOverlaps,
  executeShip,
  getStatus,
  mergeCommitGroups,
  runGit,
} from "../runtime/git.mjs";

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "Phasecraft Test"]);
  await runGit(root, ["config", "user.email", "phasecraft@example.test"]);
  await writeFile(path.join(root, "alpha.txt"), "alpha\n");
  await writeFile(path.join(root, "beta.txt"), "beta\n");
  await runGit(root, ["add", "alpha.txt", "beta.txt"]);
  await runGit(root, ["commit", "-qm", "initial"]);
  return root;
}

test("blocks baseline-dirty planned files until adoption", async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, "alpha.txt"), "user change\n");
  const baseline = await captureBaseline(root);
  assert.deepEqual(dirtyFileOverlaps(baseline, ["alpha.txt", "beta.txt"]), ["alpha.txt"]);
  assert.deepEqual(dirtyFileOverlaps(baseline, ["alpha.txt"], ["alpha.txt"]), []);
});

test("merges commit groups transitively when files overlap", () => {
  const merged = mergeCommitGroups([
    { id: "C-001", message: "first", files: ["a.txt", "shared.txt"] },
    { id: "C-002", message: "second", files: ["shared.txt", "b.txt"] },
    { id: "C-003", message: "third", files: ["c.txt"] },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].sourceIds, ["C-001", "C-002"]);
  assert.deepEqual(merged[0].files, ["a.txt", "b.txt", "shared.txt"]);
});

test("orders commit groups by dependencies and rejects cycles", () => {
  const ordered = mergeCommitGroups([
    { id: "C-002", message: "second", files: ["b.txt"], dependsOn: ["C-001"] },
    { id: "C-001", message: "first", files: ["a.txt"] },
  ]);
  assert.deepEqual(ordered.map(({ id }) => id), ["C-001", "C-002"]);
  assert.throws(() => mergeCommitGroups([
    { id: "C-001", message: "first", files: ["a.txt"], dependsOn: ["C-002"] },
    { id: "C-002", message: "second", files: ["b.txt"], dependsOn: ["C-001"] },
  ]), { code: "COMMIT_DEPENDENCY_CYCLE" });
});

test("writes bounded patches and refuses sensitive paths", async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, "alpha.txt"), "changed\n");
  const patchPath = path.join(root, ".phasecraft", ".local", "patches", "T-001.patch");
  const snapshot = await createPatchSnapshot(root, patchPath, {
    files: ["alpha.txt"],
    sensitivePatterns: [".env", "*.pem"],
    maxBytes: 1024 * 1024,
  });
  assert.equal(snapshot.files[0], "alpha.txt");
  assert.match(await readFile(patchPath, "utf8"), /changed/u);

  await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
  await assert.rejects(
    createPatchSnapshot(root, `${patchPath}.sensitive`, {
      files: [".env"],
      sensitivePatterns: [".env", "*.pem"],
    }),
    { code: "SNAPSHOT_SENSITIVE" },
  );
});

test("invalidates Ship approval on drift", async (t) => {
  const root = await repository(t);
  const baseline = await captureBaseline(root);
  await writeFile(path.join(root, "alpha.txt"), "planned\n");
  const preview = await createShipPreview(
    root,
    [{ id: "C-001", message: "fix: alpha", files: ["alpha.txt"] }],
    { baseline },
  );
  await writeFile(path.join(root, "alpha.txt"), "drifted\n");
  await assert.rejects(executeShip(root, preview, preview.approvalFingerprint), { code: "SHIP_DRIFT" });
});

test("creates exact grouped commits and never pushes", async (t) => {
  const root = await repository(t);
  const baseline = await captureBaseline(root);
  await writeFile(path.join(root, "alpha.txt"), "alpha changed\n");
  await writeFile(path.join(root, "beta.txt"), "beta changed\n");
  const preview = await createShipPreview(root, [
    { id: "C-001", message: "fix: alpha", files: ["alpha.txt"] },
    { id: "C-002", message: "test: beta", files: ["beta.txt"], dependsOn: ["C-001"] },
  ], { baseline, checks: [{ name: "unit", status: "passed" }] });
  assert.match(preview.groups[0].diff, /alpha changed/u);
  assert.match(preview.groups[0].diffHash, /^[a-f0-9]{64}$/u);
  const result = await executeShip(root, preview, preview.approvalFingerprint);
  assert.equal(result.commits.length, 2);
  assert.equal(result.pushed, false);
  assert.deepEqual(await getStatus(root), []);
  const count = await runGit(root, ["rev-list", "--count", "HEAD"]);
  assert.equal(count.stdout.toString("utf8").trim(), "3");
});

test("requires a clean index and both paths of a rename before preview", async (t) => {
  const stagedRoot = await repository(t);
  const stagedBaseline = await captureBaseline(stagedRoot);
  await writeFile(path.join(stagedRoot, "alpha.txt"), "staged\n");
  await runGit(stagedRoot, ["add", "alpha.txt"]);
  await assert.rejects(
    createShipPreview(stagedRoot, [{ id: "C-001", message: "fix: staged", files: ["alpha.txt"] }], {
      baseline: stagedBaseline,
    }),
    { code: "SHIP_INDEX_DIRTY" },
  );

  const renamedRoot = await repository(t);
  const renamedBaseline = await captureBaseline(renamedRoot);
  await runGit(renamedRoot, ["mv", "alpha.txt", "renamed.txt"]);
  await assert.rejects(
    createShipPreview(renamedRoot, [{ id: "C-001", message: "refactor: rename", files: ["renamed.txt"] }], {
      baseline: renamedBaseline,
    }),
    { code: "SHIP_RENAME_INCOMPLETE" },
  );
  await runGit(renamedRoot, ["reset", "-q"]);
  const preview = await createShipPreview(
    renamedRoot,
    [{ id: "C-001", message: "refactor: rename", files: ["alpha.txt", "renamed.txt"] }],
    { baseline: renamedBaseline },
  );
  assert.match(preview.groups[0].diff, /deleted file mode|similarity index/u);
});
