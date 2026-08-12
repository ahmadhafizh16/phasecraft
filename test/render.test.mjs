import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archivePlanVersion, sha256 } from "../runtime/artifacts.mjs";
import { validateAnchor } from "../runtime/feedback.mjs";
import { parseReviewManifest, renderArtifact, renderArtifactFile } from "../runtime/render.mjs";
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

const richInlinePlan = validPlan
  .replace(
    "- REQ-001: Reject timeout values outside the supported range.",
    "- REQ-001: Reject `timeout` values outside the supported range. D-001 P-001",
  )
  .replace(
    "- Reason: Prevent invalid lifecycle behavior while preserving D-001.",
    "- Reason: P-01 and P-02 need one safe contract while preserving D-001.",
  );

const futureContextPlan = validPlan.replace("- Phase: P-01", "- Phase: P-02");
const namedPhasePlan = validPlan.replace("# Phase 01: Session timeout", "# MRS-4983 P-01 — Campaign foundation");
const pathScopedPlan = validPlan
  .replace("# Phase 01: Session timeout", "# Session timeout plan")
  .replaceAll("P-01", "P-07");

test("renders deterministic standalone HTML bound to the Markdown hash", () => {
  const first = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  const second = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  assert.equal(first, second);
  assert.match(first, /<!doctype html>/u);
  assert.match(first, new RegExp(sha256(validPlan), "u"));
  assert.match(first, /data-phasecraft-renderer="mermaid"/u);
  assert.match(first, /mermaid@11\.4\.1/u);
});

test("adds unique deterministic review anchors and an ordered manifest", () => {
  for (const [kind, source] of [["roadmap", validRoadmap], ["plan", validPlan]]) {
    const first = renderArtifact(kind, source, { evidenceRegistry }).html;
    const second = renderArtifact(kind, source, { evidenceRegistry }).html;
    const anchors = [...first.matchAll(/data-phasecraft-anchor="([^"]+)"/gu)].map((match) => match[1]);
    const labels = [...first.matchAll(/data-phasecraft-anchor-label="([^"]*)"/gu)].map((match) => match[1]);
    const manifest = parseReviewManifest(first);

    assert.equal(first, second);
    assert.equal(new Set(anchors).size, anchors.length);
    assert.equal(labels.length, anchors.length);
    assert.deepEqual(manifest.entries.map((entry) => entry.semantic), anchors);
    assert.deepEqual(manifest, parseReviewManifest(second));
    assert.ok(manifest.entries.every((entry) => (
      typeof entry.label === "string"
      && entry.label.length > 0
      && typeof entry.plainText === "string"
    )));
  }
});

test("every rendered semantic anchor is accepted by feedback validation", () => {
  for (const [kind, source] of [["plan", validPlan], ["roadmap", validRoadmap]]) {
    const manifest = parseReviewManifest(renderArtifact(kind, source, { evidenceRegistry }).html);
    for (const entry of manifest.entries) {
      assert.deepEqual(validateAnchor({ semantic: entry.semantic }), { semantic: entry.semantic });
    }
  }
});

test("names practical roadmap and plan review units", () => {
  const roadmapManifest = parseReviewManifest(renderArtifact("roadmap", validRoadmap, { evidenceRegistry }).html);
  const planManifest = parseReviewManifest(renderArtifact("plan", validPlan, { evidenceRegistry }).html);
  const databaseManifest = parseReviewManifest(renderArtifact("plan", databasePlan, { evidenceRegistry }).html);
  const manualManifest = parseReviewManifest(renderArtifact("plan", manualPlan, { evidenceRegistry }).html);
  const semantics = (manifest) => new Set(manifest.entries.map((entry) => entry.semantic));

  const roadmapSemantics = semantics(roadmapManifest);
  for (const expected of [
    "roadmap/objective",
    "roadmap/requirements/REQ-001",
    "roadmap/phases/P-01",
    "roadmap/risks/R-001",
    "roadmap/unknowns",
    "roadmap/references/E-001",
  ]) assert.ok(roadmapSemantics.has(expected), `missing ${expected}`);

  const planSemantics = semantics(planManifest);
  for (const expected of [
    "plan/goal",
    "plan/inputs",
    "plan/requirements/REQ-001",
    "plan/technical-design/CH-001",
    "plan/technical-design/CH-001/field/before",
    "plan/technical-design/CH-001/field/proposed-after",
    "plan/technical-design/CH-001/block/before-code",
    "plan/technical-design/CH-001/block/proposed-code",
    "plan/technical-design/CH-001/block/expected-result",
    "plan/application-flows/F-001",
    "plan/application-flows/F-001/diagram",
    "plan/application-flows/F-001/change-point/A2",
    "plan/tasks/T-001",
    "plan/risks/R-001",
    "plan/commit-groups/C-001",
    "plan/manual-checks",
    "plan/references/E-001",
  ]) assert.ok(planSemantics.has(expected), `missing ${expected}`);
  assert.ok([...planSemantics].some((semantic) => /^plan\/files\/file-[a-f0-9]{16}$/u.test(semantic)));

  const databaseSemantics = semantics(databaseManifest);
  assert.ok(databaseSemantics.has("plan/technical-design/CH-001/field/database-changes"));
  assert.ok(databaseSemantics.has("plan/technical-design/CH-001/block/database-migration"));
  assert.ok(databaseSemantics.has("plan/technical-design/CH-001/block/rollback-plan"));
  assert.ok(semantics(manualManifest).has("plan/manual-checks/M-001"));
});

test("projects deterministic plain text for server-side selection validation", () => {
  const manifest = parseReviewManifest(renderArtifact("plan", validPlan, { evidenceRegistry }).html);
  const bySemantic = new Map(manifest.entries.map((entry) => [entry.semantic, entry]));

  assert.equal(
    bySemantic.get("plan/requirements/REQ-001").plainText,
    "REQ-001\nReject timeout values outside the supported range.",
  );
  assert.match(
    bySemantic.get("plan/technical-design/CH-001/block/proposed-code").plainText,
    /^Proposed code\nexport function createSession\(timeout\)/u,
  );
  assert.match(
    bySemantic.get("plan/application-flows/F-001/change-point/A2").plainText,
    /File\nsrc\/session\.mjs\nSymbol\ncreateSession\nSurgical change\nInsert the bounds assertion/u,
  );
  assert.doesNotMatch(bySemantic.get("plan/requirements/REQ-001").plainText, /<[^>]+>/u);
});

test("escapes hostile source text and safely embeds it in the review manifest", () => {
  const hostileText = "Make </script><script>alert('x')</script> & timeout handling bounded. D-001";
  const hostile = validPlan.replace(
    "Make timeout handling bounded and observable. D-001",
    hostileText,
  ).replace("assertTimeoutInRange(timeout);", "<script>alert('code')</script>");
  const html = renderArtifact("plan", hostile, { evidenceRegistry }).html;
  const manifest = parseReviewManifest(html);
  const goal = manifest.entries.find((entry) => entry.semantic === "plan/goal");
  const manifestSource = html.match(/<script type="application\/json" id="phasecraft-review-manifest">([\s\S]*?)<\/script>/u)?.[1];

  assert.doesNotMatch(html, /<script>/iu);
  assert.match(html, /&lt;script&gt;/u);
  assert.equal(goal.plainText, hostileText);
  assert.doesNotMatch(manifestSource, /<\/script|<script|&/iu);
  assert.match(manifestSource, /\\u003c\/script\\u003e/u);
  assert.equal(parseReviewManifest(renderArtifact("plan", hostile, { evidenceRegistry }).html).entries.length, manifest.entries.length);
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

test("makes whole-work and executable-phase scope explicit", () => {
  const roadmap = renderArtifact("roadmap", validRoadmap, { evidenceRegistry }).html;
  const plan = renderArtifact("plan", validPlan, { evidenceRegistry }).html;
  const future = renderArtifact("plan", futureContextPlan, { evidenceRegistry }).html;
  const named = renderArtifact("plan", namedPhasePlan, { evidenceRegistry }).html;

  assert.match(roadmap, /<meta name="phasecraft-artifact-scope" content="all-phases">/u);
  assert.match(roadmap, /<title>All Phases · Session reliability roadmap · Phasecraft Roadmap<\/title>/u);
  assert.match(roadmap, /Whole-work strategic roadmap/u);
  assert.match(roadmap, /Execution requires a separately planned and independently verified phase/u);

  assert.match(plan, /<meta name="phasecraft-artifact-scope" content="single-phase">/u);
  assert.match(plan, /<meta name="phasecraft-executable-phase" content="P-01">/u);
  assert.match(plan, /<title>P-01 · Session timeout · Phasecraft Plan<\/title>/u);
  assert.match(plan, /data-executable-phase="P-01"/u);
  assert.match(plan, /Current executable phase/u);
  assert.match(plan, /This document authorizes <span class="identity identity-phase">P-01<\/span> only/u);
  assert.match(plan, /data-phase-scope="current"/u);
  assert.match(plan, /Current phase/u);

  assert.match(future, /data-phase-scope="future"/u);
  assert.match(future, /flow-phase-future/u);
  assert.match(future, /Future context/u);
  assert.match(future, /are future context only and are not authorized by this plan/u);
  assert.match(named, /<title>P-01 · MRS-4983 — Campaign foundation · Phasecraft Plan<\/title>/u);
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

test("keeps rich requirement and reason copy in one grid child", () => {
  const html = renderArtifact("plan", richInlinePlan, { evidenceRegistry }).html;
  assert.match(html, /<p class="brief-requirement"[^>]*><span><span class="identity identity-req">REQ-001<\/span><\/span><span class="brief-requirement-copy">Reject <code>timeout<\/code> values/u);
  assert.match(html, /<p class="reason"><strong>Why<\/strong><span class="reason-copy"><span class="identity identity-phase">P-01<\/span> and <span class="identity identity-phase">P-02<\/span>/u);
  assert.match(html, /\.brief-requirement-copy \{ min-width: 0; \}/u);
  assert.match(html, /\.reason-copy \{ min-width: 0; \}/u);
});

test("visualizes code deltas and database contract changes", () => {
  const html = renderArtifact("plan", databasePlan, { evidenceRegistry }).html;
  const visibleText = html.replace(/<[^>]+>/gu, "");
  assert.match(html, /Before code/u);
  assert.match(html, /Proposed code/u);
  assert.match(html, /<span class="syntax-function">assertTimeoutInRange<\/span>\(timeout\)/u);
  assert.match(html, /Database impact/u);
  assert.match(html, /Add a constrained session_timeout column/u);
  assert.match(html, /Migration detail/u);
  assert.match(html, /session_timeout/u);
  assert.match(html, /Rollback plan/u);
  assert.match(html, /API impact/u);
  assert.match(html, /Flow impact/u);
  assert.match(visibleText, /F-001 inserts bounded validation/u);
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

test("infers executable phase from the phase directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-phase-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const phaseDirectory = path.join(root, "plan", "phases", "P-07-session-timeout");
  const sourcePath = path.join(phaseDirectory, "PLAN.md");
  const outputPath = path.join(phaseDirectory, "plan.html");
  const { writeFile } = await import("node:fs/promises");
  await mkdir(phaseDirectory, { recursive: true });
  await writeFile(sourcePath, pathScopedPlan);
  await renderArtifactFile("plan", sourcePath, outputPath);
  const html = await readFile(outputPath, "utf8");
  assert.match(html, /<meta name="phasecraft-executable-phase" content="P-07">/u);
  assert.match(html, /<title>P-07 · Session timeout plan · Phasecraft Plan<\/title>/u);
  assert.match(html, /data-executable-phase="P-07"/u);
});

test("archives an immutable plan version with bound HTML", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phasecraft-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "PLAN.md");
  const outputPath = path.join(root, "plan.html");
  const verificationPath = path.join(root, "PLAN-VERIFICATION.md");
  const verification = `# Bound audit\n\n**Plan SHA-256:** ${sha256(validPlan)}\n`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(sourcePath, validPlan);
  await renderArtifactFile("plan", sourcePath, outputPath);
  await writeFile(verificationPath, verification);
  const archived = await archivePlanVersion(root, 1, "Material file scope changed");
  assert.equal(archived.planHash, sha256(validPlan));
  assert.equal(archived.verificationHash, sha256(verification));
  assert.equal(await readFile(path.join(root, "versions", "v1", "PLAN.md"), "utf8"), validPlan);
  assert.equal(await readFile(path.join(root, "versions", "v1", "PLAN-VERIFICATION.md"), "utf8"), verification);
  const metadata = JSON.parse(await readFile(path.join(root, "versions", "v1", "SUPERSEDED.json"), "utf8"));
  assert.equal(metadata.reason, "Material file scope changed");
  assert.equal(metadata.verificationHash, archived.verificationHash);
});
