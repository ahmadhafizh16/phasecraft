import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { desiredHostFiles, SUPPORTED_HOSTS } from "../bin/hosts.mjs";
import { checkPhasecraft, installPhasecraft, uninstallPhasecraft } from "../bin/install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function generatedText(entry) {
  return entry.generated ? entry.content.toString("utf8") : "";
}

async function temporaryRoot(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phasecraft-hosts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("projects the canonical workflow into all supported hosts", async () => {
  assert.deepEqual(SUPPORTED_HOSTS, ["opencode", "claude", "codex", "pi"]);

  const opencode = await desiredHostFiles(root, "opencode");
  assert.equal(opencode.filter(({ target }) => target.startsWith(".opencode/commands/")).length, 9);
  assert.equal(opencode.filter(({ target }) => target.startsWith(".opencode/agents/")).length, 7);

  const claude = await desiredHostFiles(root, "claude");
  assert.equal(claude.filter(({ target }) => target.startsWith(".claude/commands/")).length, 9);
  assert.equal(claude.filter(({ target }) => target.startsWith(".claude/agents/")).length, 7);
  assert.ok(claude.some(({ target }) => target === ".claude/skills/phasecraft/SKILL.md"));
  assert.ok(claude.filter(({ generated }) => generated).every((entry) => !generatedText(entry).includes(".opencode/")));

  const codex = await desiredHostFiles(root, "codex");
  assert.equal(codex.filter(({ target }) => /^\.codex\/skills\/phasecraft-[^/]+\/SKILL\.md$/u.test(target)).length, 9);
  assert.equal(codex.filter(({ target }) => target.startsWith(".codex/agents/")).length, 7);
  for (const entry of codex.filter(({ generated }) => generated)) {
    const source = generatedText(entry);
    assert.doesNotMatch(source, /\.opencode\//u);
    assert.doesNotMatch(source, /\$ARGUMENTS/u);
    assert.doesNotMatch(source, /`\/phasecraft-[a-z-]+/u);
  }

  const pi = await desiredHostFiles(root, "pi");
  assert.equal(pi.filter(({ target }) => target.startsWith(".pi/prompts/")).length, 9);
  assert.ok(pi.some(({ target }) => target === ".pi/extensions/phasecraft.ts"));
  assert.ok(pi.some(({ target }) => target === ".pi/skills/phasecraft/SKILL.md"));
  for (const entry of pi.filter(({ target }) => target.startsWith(".pi/prompts/"))) {
    assert.match(generatedText(entry), /<phasecraft-role name="phasecraft-[a-z-]+">/u);
  }
});

test("installs, checks, and uninstalls hosts independently", async (t) => {
  const target = await temporaryRoot(t);
  for (const host of SUPPORTED_HOSTS) {
    const result = await installPhasecraft({ sourceRoot: root, targetRoot: target, host });
    assert.equal(result.host, host);
    assert.ok(result.files > 10);
    assert.equal((await checkPhasecraft({ sourceRoot: root, targetRoot: target, host })).healthy, true);
  }

  await uninstallPhasecraft({ targetRoot: target, host: "claude" });
  await assert.rejects(checkPhasecraft({ sourceRoot: root, targetRoot: target, host: "claude" }), {
    code: "NOT_INSTALLED",
  });
  for (const host of ["opencode", "codex", "pi"]) {
    assert.equal((await checkPhasecraft({ sourceRoot: root, targetRoot: target, host })).healthy, true);
  }
});

test("link mode links static runtime files and hashes generated projections", async (t) => {
  const target = await temporaryRoot(t);
  await installPhasecraft({ sourceRoot: root, targetRoot: target, host: "codex", mode: "link" });
  const manifest = JSON.parse(await readFile(path.join(target, ".codex", "phasecraft", "install-manifest.json"), "utf8"));
  const runtime = manifest.files.find(({ target: file }) => file.endsWith("/runtime/phasecraft.mjs"));
  const skill = manifest.files.find(({ target: file }) => file.endsWith("/skills/phasecraft-init/SKILL.md"));
  assert.equal(runtime.mode, "link");
  assert.equal(skill.mode, "copy");
  assert.equal(skill.generated, true);
});

test("Pi extension applies the active Phasecraft role guards", async (t) => {
  const target = await temporaryRoot(t);
  const source = await readFile(path.join(root, "pi", "phasecraft.ts"), "utf8");
  const modulePath = path.join(target, "phasecraft-extension.mjs");
  await writeFile(modulePath, source);
  const extension = (await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`)).default;
  const handlers = new Map();
  extension({ on: (event, handler) => handlers.set(event, handler) });
  assert.deepEqual([...handlers.keys()].sort(), ["before_agent_start", "tool_call"]);

  await handlers.get("before_agent_start")({ prompt: '<phasecraft-role name="phasecraft-manager">' });
  const context = { cwd: target, ui: { confirm: async () => true } };
  assert.equal((await handlers.get("tool_call")({ toolName: "write", input: { path: ".phasecraft/state.json" } }, context)), undefined);
  assert.equal((await handlers.get("tool_call")({ toolName: "write", input: { path: "src/app.js" } }, context)).block, true);
  assert.equal((await handlers.get("tool_call")({ toolName: "bash", input: { command: "git commit -m no" } }, context)).block, true);
  assert.equal((await handlers.get("tool_call")({ toolName: "bash", input: { command: "git -C . commit -m no" } }, context)).block, true);
  assert.equal((await handlers.get("tool_call")({ toolName: "web_search", input: {} }, context)).block, true);

  await handlers.get("before_agent_start")({ prompt: '<phasecraft-role name="phasecraft-executor">' });
  assert.equal((await handlers.get("tool_call")({ toolName: "write", input: { path: "src/app.js" } }, context)), undefined);

  await handlers.get("before_agent_start")({ prompt: '<phasecraft-role name="phasecraft-shipper">' });
  assert.equal((await handlers.get("tool_call")({
    toolName: "bash",
    input: { command: "node .pi/phasecraft/runtime/phasecraft.mjs status --work X; touch escaped" },
  }, context)).block, true);
});

test("rejects tampered manifests before resolving managed targets", async (t) => {
  const target = await temporaryRoot(t);
  await installPhasecraft({ sourceRoot: root, targetRoot: target, host: "pi" });
  const manifestPath = path.join(target, ".pi", "phasecraft", "install-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.push({
    source: "tampered",
    target: ".pi/../outside.txt",
    sourceHash: "a".repeat(64),
    installedHash: "a".repeat(64),
    mode: "copy",
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(uninstallPhasecraft({ targetRoot: target, host: "pi" }), { code: "MANIFEST_INVALID" });
});
