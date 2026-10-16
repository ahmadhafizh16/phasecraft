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
  assert.equal(manifest.name, "@ahmadhm/phasecraft");
  assert.equal(manifest.version, "0.5.0");
  assert.equal(manifest.license, "MIT");
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.bin.phasecraft, "./bin/phasecraft.mjs");
  assert.equal(manifest.publishConfig.access, "public");
  for (const required of ["bin/", "runtime/", "opencode/", "pi/", "LICENSE", "README.md", "ROADMAP.md"]) {
    assert.ok(manifest.files.includes(required), `npm files must include ${required}`);
  }
});

test("the actual npm tarball installs, checks, and uninstalls every host offline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phasecraft-packed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, npm_config_cache: path.join(directory, "cache"), npm_config_offline: "true" };
  const packed = await execute("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root, env });
  const [metadata] = JSON.parse(packed.stdout);
  for (const required of ["runtime/workflow.mjs", "runtime/hosts.mjs", "runtime/review.mjs", "pi/phasecraft.ts"]) {
    assert.ok(metadata.files.some((file) => file.path === required), `${required} must be published`);
  }
  await execute("npm", ["install", "--prefix", directory, "--no-audit", "--no-fund", path.join(directory, metadata.filename)], { env });
  const binary = path.join(directory, "node_modules", "@ahmadhm", "phasecraft", "bin", "phasecraft.mjs");
  const target = path.join(directory, "application");
  const installed = await execute(process.execPath, [binary, "install", "--host", "all", "--target", target]);
  assert.equal(JSON.parse(installed.stdout.slice(0, installed.stdout.lastIndexOf("}\n") + 1)).results.length, 4);
  const checked = await execute(process.execPath, [binary, "check", "--host", "all", "--target", target]);
  assert.equal(JSON.parse(checked.stdout).healthy, true);
  for (const host of ["opencode", "claude", "codex", "pi"]) {
    const runtime = path.join(target, `.${host}`, "phasecraft", "runtime", "phasecraft.mjs");
    const help = JSON.parse((await execute(process.execPath, [runtime, "help"])).stdout);
    for (const command of ["approve-plan", "task-checkpoint", "resume", "doctor"]) assert.ok(help.commands[command]);
  }
  await execute(process.execPath, [binary, "uninstall", "--host", "all", "--target", target]);
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
