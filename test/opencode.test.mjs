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
    assert.match(source, /handoff-list --all/u);
    assert.match(source, /handoff-write --agent phasecraft-/u);
    assert.match(source, /never allocate `H-NNN\.md` manually/iu);
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
    assert.match(source, /handoff-list --all/u);
    assert.match(source, /handoff-write --agent phasecraft-/u);
    assert.match(source, /never allocate or overwrite `H-NNN\.md` manually/iu);
  }
});

test("Phasecraft skill has discoverable OpenCode frontmatter", async () => {
  const source = await readFile(path.join(root, "opencode", "skills", "phasecraft", "SKILL.md"), "utf8");
  const metadata = frontmatter(source);
  assert.equal(metadata.name, "phasecraft");
  assert.match(metadata.description, /Phasecraft/u);
});

test("planning prompts require implementation-readable HTML source material", async () => {
  const plan = await readFile(path.join(root, "opencode", "commands", "phasecraft-plan.md"), "utf8");
  const verify = await readFile(path.join(root, "opencode", "commands", "phasecraft-verify-plan.md"), "utf8");
  const skill = await readFile(path.join(root, "opencode", "skills", "phasecraft", "SKILL.md"), "utf8");
  for (const pattern of [
    /#### Before code/u,
    /#### Proposed code/u,
    /#### Expected result/u,
    /## Application Flows/u,
    /#### Diagram/u,
    /#### Change points/u,
    /Mermaid node \| Phase \| File \| Symbol \| Surgical change/u,
    /subgraph BEFORE/u,
    /subgraph AFTER/u,
    /all regular discounts/iu,
    /persistence.*external/iu,
    /one full-width row/iu,
    /syntax-highlight/iu,
  ]) {
    assert.match(plan, pattern);
  }
  assert.match(verify, /rendered Mermaid BEFORE\/AFTER/u);
  assert.match(verify, /surgical change-point tables/iu);
  assert.match(verify, /concrete expected-result panels/iu);
  assert.match(verify, /row per manual check/u);
  assert.match(skill, /Every `F-\*` declares/u);
  assert.match(skill, /pinned Mermaid browser renderer/u);
  assert.match(skill, /deterministic token spans/u);
  assert.match(skill, /handoff-write --work <id>/u);
  assert.match(skill, /Never allocate a sequence/iu);
});
