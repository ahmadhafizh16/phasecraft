import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package metadata exposes the public multi-host CLI", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "@ahmadhafizh16/phasecraft");
  assert.equal(manifest.version, "0.4.0");
  assert.equal(manifest.license, "MIT");
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.bin.phasecraft, "./bin/phasecraft.mjs");
  assert.equal(manifest.publishConfig.access, "public");
  for (const required of ["bin/", "runtime/", "opencode/", "pi/", "LICENSE", "README.md", "ROADMAP.md"]) {
    assert.ok(manifest.files.includes(required), `npm files must include ${required}`);
  }
});

test("npm-style symlinked bin entry points execute their main functions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phasecraft-bin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const phasecraft = path.join(directory, "phasecraft");
  const installer = path.join(directory, "phasecraft-install");
  await symlink(path.join(root, "bin", "phasecraft.mjs"), phasecraft);
  await symlink(path.join(root, "bin", "install.mjs"), installer);

  const cli = await execute(process.execPath, [phasecraft, "--help"]);
  assert.match(cli.stdout, /phasecraft install --host <host>/u);
  const installHelp = await execute(process.execPath, [installer, "help"]);
  assert.match(installHelp.stdout, /opencode, claude, codex, pi/u);
});
