import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archivePlanVersion, sha256 } from "../runtime/artifacts.mjs";
import { renderArtifact, renderArtifactFile } from "../runtime/render.mjs";
import { evidenceRegistry, validPlan, validRoadmap } from "../test-data/artifacts.mjs";

const dependencyPlan = validPlan
  .replace("\n## Risk Controls", `
### T-002: Record timeout observations
- Requirements: REQ-001
- Evidence: E-001, D-001, P-001
- Depends on: T-001
- Files: src/session-metrics.mjs, test/session-metrics.test.mjs
- Change: Record accepted and rejected timeout values.
- Verification: Observe accepted timeout metrics; observe rejected timeout metrics
- Commit group: C-002

## Risk Controls`)
  .replace("\n## Manual Checks", `
### C-002: Timeout observations
- Files: src/session-metrics.mjs, test/session-metrics.test.mjs
- Message: test: record timeout observations
- Depends on: C-001

## Manual Checks`);

const dependencyRoadmap = validRoadmap.replace("\n## Risks", `
### P-02: Timeout observations
- Goal: Add operational evidence after validation.
- Requirements: REQ-001
- Depends on: P-01
- Exit evidence: Accepted and rejected timeout metrics are observable.
- Status: later

## Risks`);

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

test("renders roadmap and plan as distinct information products", () => {
  const roadmap = renderArtifact("roadmap", validRoadmap, { evidenceRegistry }).html;
  const plan = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  assert.match(roadmap, /data-view="roadmap-atlas"/u);
  assert.match(roadmap, /strategic atlas/u);
  assert.match(roadmap, /Phase ledger/u);
  assert.doesNotMatch(roadmap, /data-view="execution-cockpit"/u);
  assert.match(plan, /data-view="execution-cockpit"/u);
  assert.match(plan, /execution cockpit/u);
  assert.match(plan, /Change blueprint/u);
  assert.match(plan, /Requirement coverage/u);
  assert.match(plan, /File impact map/u);
  assert.doesNotMatch(plan, /data-view="roadmap-atlas"/u);
  assert.notEqual(roadmap, plan);
});

test("adds dependency diagrams only when relationships need visualization", () => {
  const singleRoadmap = renderArtifact("roadmap", validRoadmap, { evidenceRegistry }).html;
  const singlePlan = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  assert.doesNotMatch(singleRoadmap, /data-diagram=/u);
  assert.doesNotMatch(singlePlan, /data-diagram=/u);

  const roadmap = renderArtifact("roadmap", dependencyRoadmap, { evidenceRegistry }).html;
  const plan = renderArtifact("plan", dependencyPlan, { evidenceRegistry }).html;
  assert.match(roadmap, /data-diagram="roadmap-dependencies"/u);
  assert.match(roadmap, /P-01/u);
  assert.match(roadmap, /P-02/u);
  assert.match(plan, /data-diagram="plan-dependencies"/u);
  assert.match(plan, /T-001/u);
  assert.match(plan, /T-002/u);
  assert.match(plan, /<svg class="dependency-graph"/u);
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
