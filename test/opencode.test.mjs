import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function frontmatter(source) {
  assert.match(source, /^---\n/u);
  const end = source.indexOf("\n---\n", 4);
  assert.notEqual(end, -1);
  const values = {};
  for (const line of source.slice(4, end).split("\n")) {
    const match = line.match(/^([a-z_]+):\s*(.+)$/u);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

test("OpenCode package contains nine commands with valid agent references", async () => {
  const commandDirectory = path.join(root, "opencode", "commands");
  const agentDirectory = path.join(root, "opencode", "agents");
  const commands = (await readdir(commandDirectory)).filter((file) => file.endsWith(".md")).sort();
  const agents = new Set((await readdir(agentDirectory)).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)));
  assert.deepEqual(commands, [
    "phasecraft-discuss.md",
    "phasecraft-execute.md",
    "phasecraft-init.md",
    "phasecraft-new-work.md",
    "phasecraft-plan.md",
    "phasecraft-ship.md",
    "phasecraft-status.md",
    "phasecraft-verify-plan.md",
    "phasecraft-verify.md",
  ]);
  for (const file of commands) {
    const source = await readFile(path.join(commandDirectory, file), "utf8");
    const metadata = frontmatter(source);
    assert.ok(metadata.description, `${file} needs a description`);
    assert.ok(agents.has(metadata.agent), `${file} references missing agent ${metadata.agent}`);
    assert.match(source, /\$ARGUMENTS/u);
    assert.doesNotMatch(source, /^model:/mu);
  }
});

test("OpenCode package contains seven model-agnostic stage agents", async () => {
  const directory = path.join(root, "opencode", "agents");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md"));
  assert.equal(files.length, 7);
  for (const file of files) {
    const source = await readFile(path.join(directory, file), "utf8");
    const metadata = frontmatter(source);
    assert.equal(metadata.mode, "all");
    assert.ok(metadata.description);
    assert.doesNotMatch(source, /^model:/mu);
    assert.match(source, /^\s+question:\s+allow$/mu);
  }
});

test("Phasecraft skill has discoverable OpenCode frontmatter", async () => {
  const source = await readFile(path.join(root, "opencode", "skills", "phasecraft", "SKILL.md"), "utf8");
  const metadata = frontmatter(source);
  assert.equal(metadata.name, "phasecraft");
  assert.match(metadata.description, /Phasecraft/u);
});
