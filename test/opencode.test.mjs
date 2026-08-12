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
    /current executable `P-NN`/iu,
    /Future context/u,
  ]) {
    assert.match(plan, pattern);
  }
  assert.match(verify, /validator-accepted Mermaid BEFORE\/AFTER/u);
  assert.match(verify, /surgical change-point tables/iu);
  assert.match(verify, /concrete expected-result panels/iu);
  assert.match(verify, /phase-specific.*<title>/iu);
  assert.match(verify, /row per manual check/u);
  assert.match(plan, /Do not use Playwright, browser automation/iu);
  assert.match(verify, /Do not use Playwright, browser automation/iu);
  assert.match(verify, /visual layout review belongs to the human/iu);
  assert.match(skill, /Every `F-\*` declares/u);
  assert.match(skill, /pinned Mermaid browser renderer/u);
  assert.match(skill, /They do not use Playwright, browser automation/iu);
  assert.match(skill, /deterministic token spans/u);
  assert.match(skill, /authorizes only that phase/iu);
  assert.match(skill, /handoff-write --work <id>/u);
  assert.match(skill, /Never allocate a sequence/iu);
});

test("plan verification returns semantic findings to human disposition", async () => {
  const verify = await readFile(path.join(root, "opencode", "commands", "phasecraft-verify-plan.md"), "utf8");
  const auditor = await readFile(path.join(root, "opencode", "agents", "phasecraft-plan-auditor.md"), "utf8");
  const plan = await readFile(path.join(root, "opencode", "commands", "phasecraft-plan.md"), "utf8");
  const execute = await readFile(path.join(root, "opencode", "commands", "phasecraft-execute.md"), "utf8");
  const skill = await readFile(path.join(root, "opencode", "skills", "phasecraft", "SKILL.md"), "utf8");

  assert.match(verify, /non-waivable integrity gate/iu);
  assert.match(verify, /Never silently decide that a semantic finding blocks execution/iu);
  for (const choice of ["Fix now", "Defer", "Accept risk for speed", "Non-blocking"]) {
    assert.match(verify, new RegExp(choice, "iu"));
  }
  assert.match(verify, /question tool/iu);
  assert.match(verify, /plan\/DEFERRED-FINDINGS\.md/u);
  assert.match(verify, /APPROVED WITH DISPOSITIONS/u);
  assert.match(verify, /exact PLAN SHA-256/u);
  assert.match(verify, /repeat\/differential/iu);
  assert.match(verify, /carry-forward confirmation/iu);
  assert.match(verify, /Guardrails: none/iu);
  assert.match(verify, /stop when integrity and the delta are dispositioned/iu);
  assert.match(auditor, /Future-phase detail is deferred by default/iu);
  assert.match(auditor, /do not plan again from zero/iu);
  assert.match(auditor, /do not.*infer acceptance/iu);
  assert.match(plan, /read every open entry/iu);
  assert.match(plan, /Refresh only stale sources/iu);
  assert.match(execute, /accepted-risk guardrail/iu);
  assert.match(skill, /The phase may become `plan_verified`/iu);
});
