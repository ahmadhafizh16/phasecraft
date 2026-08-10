import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archivePlanVersion, sha256 } from "../runtime/artifacts.mjs";
import { renderArtifact, renderArtifactFile } from "../runtime/render.mjs";
import { evidenceRegistry, validPlan } from "../test-data/artifacts.mjs";

test("renders deterministic standalone HTML bound to the Markdown hash", () => {
  const first = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  const second = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  assert.equal(first, second);
  assert.match(first, /<!doctype html>/u);
  assert.match(first, new RegExp(sha256(validPlan), "u"));
  assert.doesNotMatch(first, /<script\b/iu);
  assert.doesNotMatch(first, /https?:\/\//iu);
});

test("escapes hostile source text", () => {
  const hostile = validPlan.replace(
    "Make timeout handling bounded and observable. D-001",
    "Make <script>alert('x')</script> timeout handling bounded. D-001",
  );
  const html = renderArtifact("plan", hostile, { evidenceRegistry }).html;
  assert.doesNotMatch(html, /<script>/iu);
  assert.match(html, /&lt;script&gt;/u);
});

test("writes rendered HTML to a requested file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "PLAN.md");
  const outputPath = path.join(root, "plan.html");
  const evidencePath = path.join(root, "EVIDENCE.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(sourcePath, validPlan);
  await writeFile(evidencePath, JSON.stringify(evidenceRegistry));
  const result = await renderArtifactFile("plan", sourcePath, outputPath, { evidenceFile: evidencePath });
  assert.equal(result.sourceHash, sha256(validPlan));
  assert.match(await readFile(outputPath, "utf8"), /Phasecraft plan/u);
});

test("archives an immutable plan version with bound HTML", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "PLAN.md");
  const outputPath = path.join(root, "plan.html");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(sourcePath, validPlan);
  await renderArtifactFile("plan", sourcePath, outputPath);
  const archived = await archivePlanVersion(root, 1, "Material file scope changed");
  assert.equal(archived.planHash, sha256(validPlan));
  assert.equal(await readFile(path.join(root, "versions", "v1", "PLAN.md"), "utf8"), validPlan);
  const metadata = JSON.parse(await readFile(path.join(root, "versions", "v1", "SUPERSEDED.json"), "utf8"));
  assert.equal(metadata.reason, "Material file scope changed");
});
