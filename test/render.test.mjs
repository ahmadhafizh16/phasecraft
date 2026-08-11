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

const databasePlan = validPlan
  .replace("- Change type: code", "- Change type: database")
  .replace("- Database changes: none", "- Database changes: Add a constrained session_timeout column.")
  .replace("- API changes: none", "- API changes: Expose the normalized timeout in the session response.")
  .replace(
    "\n## Application Flows",
    "\n#### Database migration\n```sql\nALTER TABLE sessions ADD COLUMN session_timeout INTEGER NOT NULL;\n```\n\n#### Rollback plan\n```sql\nALTER TABLE sessions DROP COLUMN session_timeout;\n```\n\n## Application Flows",
  );

const manualPlan = validPlan.replace("## Manual Checks\nNone.", `## Manual Checks
### M-001: Verify invalid timeout rejection
- Requirement: REQ-001
- Instructions: Submit a timeout below the supported minimum and record the response.
- Expected: The request is rejected before a session is created.
- Status: pending

### M-002: Verify supported boundary
- Requirement: REQ-001
- Instructions: Submit the exact lower supported boundary and inspect the created session.
- Expected: The session is created with the supplied boundary value.
- Status: pending`);

const noApplicationFlowPlan = validPlan
  .replace("- Flow impact: F-001 inserts bounded validation before session construction and rejects invalid input before state is created.", "- Flow impact: none")
  .replace(/\n## Application Flows[\s\S]*?(?=\n## Tasks)/u, "");

test("renders deterministic standalone HTML bound to the Markdown hash", () => {
  const first = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  const second = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  assert.equal(first, second);
  assert.match(first, /<!doctype html>/u);
  assert.match(first, new RegExp(sha256(validPlan), "u"));
  assert.match(first, /data-phasecraft-renderer="mermaid"/u);
  assert.match(first, /mermaid@11\.4\.1/u);
});

test("escapes hostile source text", () => {
  const hostile = validPlan.replace(
    "Make timeout handling bounded and observable. D-001",
    "Make <script>alert('x')</script> timeout handling bounded. D-001",
  ).replace("assertTimeoutInRange(timeout);", "<script>alert('code')</script>");
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

test("resolves evidence identities to claims and provenance", () => {
  const html = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  const roadmap = renderArtifact("roadmap", validRoadmap, { evidenceRegistry }).html;
  assert.match(html, /href="#reference-D-001"/u);
  assert.match(html, /id="reference-D-001"/u);
  assert.match(html, /Timeouts remain configurable\./u);
  assert.match(html, /user \/ discussion/u);
  assert.match(html, /confirmed/u);
  assert.match(html, /data-reference-index="plan"/u);
  assert.doesNotMatch(html, /href="#reference-REQ-001"/u);
  assert.doesNotMatch(html, /href="#reference-P-01"/u);
  assert.match(html, /class="identity identity-phase">P-01<\/span>/u);
  assert.match(roadmap, /data-reference-index="roadmap"/u);
  assert.match(roadmap, /id="reference-E-001"/u);
});

test("visualizes code deltas and database contract changes", () => {
  const html = renderArtifact("plan", databasePlan, { evidenceRegistry }).html;
  assert.match(html, /Before code/u);
  assert.match(html, /Proposed code/u);
  assert.match(html, /<span class="syntax-function">assertTimeoutInRange<\/span>\(timeout\)/u);
  assert.match(html, /Database impact/u);
  assert.match(html, /Add a constrained session_timeout column/u);
  assert.match(html, /Migration detail/u);
  assert.match(html, /session_timeout/u);
  assert.match(html, /Rollback plan/u);
  assert.match(html, /API impact/u);
  assert.match(html, /Expected result/u);
  assert.match(html, /<span class="syntax-keyword">ALTER<\/span>/u);
  assert.match(html, /<span class="syntax-keyword">DROP<\/span>/u);
});

test("highlights code and renders Mermaid application flows from Markdown", () => {
  const html = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  assert.match(html, /<span class="syntax-keyword">export<\/span>/u);
  assert.match(html, /<span class="syntax-function">createSession<\/span>/u);
  assert.match(html, /data-application-flow="F-001"/u);
  assert.match(html, /<pre class="mermaid">flowchart LR/u);
  assert.match(html, /BEFORE · direct construction/u);
  assert.match(html, /AFTER · bounded construction/u);
  assert.match(html, /Surgical application changes/u);
  assert.match(html, /src\/session\.mjs/u);
  assert.match(html, /Insert the bounds assertion/u);
  assert.match(html, /<span class="syntax-property">&quot;timeout&quot;<\/span>/u);
  assert.match(html, /mermaid\.initialize/u);
  assert.doesNotMatch(html, /class="affected-flow"/u);
});

test("loads Mermaid only when authoritative application flows exist", () => {
  const html = renderArtifact("plan", noApplicationFlowPlan, { evidenceRegistry }).html;
  assert.doesNotMatch(html, /data-phasecraft-renderer="mermaid"/u);
  assert.match(html, /No application flow diagram was recorded/u);
});

test("renders manual verification as one full-width row per item", () => {
  const html = renderArtifact("plan", manualPlan, { evidenceRegistry }).html;
  assert.match(html, /class="manual-grid" data-layout="rows"/u);
  assert.equal((html.match(/class="manual-card"/gu) ?? []).length, 2);
  assert.match(html, /\.manual-grid \{ display: grid; grid-template-columns: 1fr;/u);
  assert.match(html, /Expected observation/u);
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
