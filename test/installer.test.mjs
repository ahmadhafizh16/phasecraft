import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkPhasecraft,
  installPhasecraft,
  uninstallPhasecraft,
} from "../bin/install.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function target(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("copies, checks, updates, and cleanly uninstalls managed files", async (t) => {
  const root = await target(t);
  const installed = await installPhasecraft({ sourceRoot, targetRoot: root, mode: "copy" });
  assert.equal(installed.mode, "copy");
  assert.ok(installed.files > 10);
  for (const runtime of ["feedback.mjs", "review.mjs", "review-ui.mjs"]) {
    assert.equal((await lstat(path.join(root, ".opencode", "phasecraft", "runtime", runtime))).isFile(), true);
  }
  assert.equal((await checkPhasecraft({ sourceRoot, targetRoot: root })).healthy, true);

  const updated = await installPhasecraft({ sourceRoot, targetRoot: root, mode: "copy" });
  assert.equal(updated.files, installed.files);
  const unrelated = path.join(root, ".opencode", "commands", "unrelated.md");
  await writeFile(unrelated, "keep\n");
  const removed = await uninstallPhasecraft({ targetRoot: root });
  assert.equal(removed.preserved.length, 0);
  assert.equal(await readFile(unrelated, "utf8"), "keep\n");
});

test("refuses unmanaged conflicts", async (t) => {
  const root = await target(t);
  const conflict = path.join(root, ".opencode", "commands", "phasecraft-init.md");
  await mkdir(path.dirname(conflict), { recursive: true });
  await writeFile(conflict, "unmanaged\n");
  await assert.rejects(
    installPhasecraft({ sourceRoot, targetRoot: root, mode: "copy" }),
    { code: "TARGET_CONFLICT" },
  );
  assert.equal(await readFile(conflict, "utf8"), "unmanaged\n");
});

test("does not overwrite or uninstall locally modified managed files", async (t) => {
  const root = await target(t);
  await installPhasecraft({ sourceRoot, targetRoot: root, mode: "copy" });
  const command = path.join(root, ".opencode", "commands", "phasecraft-status.md");
  await writeFile(command, "local edit\n");
  const check = await checkPhasecraft({ sourceRoot, targetRoot: root });
  assert.equal(check.healthy, false);
  assert.equal(check.statuses.find(({ target: file }) => file.endsWith("phasecraft-status.md")).status, "modified");
  await assert.rejects(
    installPhasecraft({ sourceRoot, targetRoot: root, mode: "copy" }),
    { code: "TARGET_MODIFIED" },
  );
  const uninstalled = await uninstallPhasecraft({ targetRoot: root });
  assert.ok(uninstalled.preserved.some((file) => file.endsWith("phasecraft-status.md")));
  assert.equal(await readFile(command, "utf8"), "local edit\n");
});

test("links individual source files in development mode", async (t) => {
  const root = await target(t);
  await installPhasecraft({ sourceRoot, targetRoot: root, mode: "link" });
  const command = path.join(root, ".opencode", "commands", "phasecraft-init.md");
  assert.equal((await lstat(command)).isSymbolicLink(), true);
  assert.equal((await checkPhasecraft({ sourceRoot, targetRoot: root })).healthy, true);
  const result = await uninstallPhasecraft({ targetRoot: root });
  assert.equal(result.preserved.length, 0);
  await assert.rejects(lstat(command), { code: "ENOENT" });
});
