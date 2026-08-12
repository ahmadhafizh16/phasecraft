import assert from "node:assert/strict";
import test from "node:test";
import {
  validateEvidenceRegistry,
  validatePlan,
  validateRoadmap,
} from "../runtime/artifacts.mjs";
import { evidenceRegistry, validPlan, validRoadmap } from "../test-data/artifacts.mjs";

test("validates evidence ids, prefixes, and provenance", () => {
  const result = validateEvidenceRegistry(evidenceRegistry);
  assert.equal(result.valid, true);
  const invalid = structuredClone(evidenceRegistry);
  invalid.entries[0].id = "D-999";
  assert.equal(validateEvidenceRegistry(invalid).valid, false);
});

test("validates a restricted Phasecraft plan", () => {
  const result = validatePlan(validPlan, { evidenceRegistry });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.references.some(({ id }) => id === "E-001"), true);
  assert.deepEqual(result.warnings, []);
});

test("reports visualization detail gaps without invalidating existing plans", () => {
  const sparse = validPlan
    .replace("- Change type: code\n", "")
    .replace("- Database changes: none\n", "")
    .replace("- API changes: none\n", "")
    .replace("- Flow impact: F-001 inserts bounded validation before session construction and rejects invalid input before state is created.\n", "")
    .replace(/\n#### Before code[\s\S]*?(?=\n## Application Flows)/u, "");
  const result = validatePlan(sparse, { evidenceRegistry });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.warnings.some(({ code }) => code === "TECHNICAL_TYPE_MISSING"), true);
  assert.equal(result.warnings.some(({ code }) => code === "TECHNICAL_CODE_MISSING"), true);
  assert.equal(result.warnings.some(({ code }) => code === "DATABASE_IMPACT_MISSING"), true);
  assert.equal(result.warnings.some(({ code }) => code === "API_IMPACT_MISSING"), true);
  assert.equal(result.warnings.some(({ code }) => code === "FLOW_IMPACT_MISSING"), true);
  assert.equal(result.warnings.some(({ code }) => code === "EXPECTED_RESULT_MISSING"), true);
});

test("reports missing migration and rollback details for database changes", () => {
  const databaseChange = validPlan.replace(
    "- Database changes: none",
    "- Database changes: Add a session_timeout column.",
  );
  const result = validatePlan(databaseChange, { evidenceRegistry });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.warnings.some(({ code }) => code === "DATABASE_DETAIL_MISSING"), true);
  assert.equal(result.warnings.some(({ code }) => code === "ROLLBACK_DETAIL_MISSING"), true);
});

test("rejects malformed application flow diagrams", () => {
  const invalid = validPlan.replace("flowchart LR", "sequenceDiagram");
  const result = validatePlan(invalid, { evidenceRegistry });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some(({ code }) => code === "APPLICATION_FLOW_DIAGRAM_INVALID"), true);
});

test("rejects unsafe Mermaid directives", () => {
  const invalid = validPlan.replace("flowchart LR", "%%{init: { 'securityLevel': 'loose' }}%%\nflowchart LR");
  const result = validatePlan(invalid, { evidenceRegistry });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some(({ code }) => code === "APPLICATION_FLOW_DIAGRAM_UNSAFE"), true);
});

test("rejects surgical change points that do not map to the diagram", () => {
  const invalid = validPlan.replace(
    "A2 | P-01 | src/session.mjs | createSession | Insert the bounds assertion before constructing session state.",
    "UNKNOWN | P-01 | src/session.mjs | createSession | Insert the bounds assertion before constructing session state.",
  );
  const result = validatePlan(invalid, { evidenceRegistry });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some(({ code }) => code === "CHANGE_POINT_NODE_UNKNOWN"), true);
});

test("reports application flows without surgical change-point mappings", () => {
  const missingPoints = validPlan.replace(/\n#### Change points[\s\S]*?(?=\n## Tasks)/u, "");
  const result = validatePlan(missingPoints, { evidenceRegistry });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.warnings.some(({ code }) => code === "CHANGE_POINTS_MISSING"), true);
});

test("keeps plan-like headings and fields inside fenced code", () => {
  const embeddedSyntax = validPlan.replace(
    "  assertTimeoutInRange(timeout);",
    "### not-a-plan-entry\n- Reason: this is code, not a structured field\n  assertTimeoutInRange(timeout);",
  );
  const result = validatePlan(embeddedSyntax, { evidenceRegistry });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const changes = result.document.sections.get("Technical Design").entries;
  assert.equal(changes.length, 1);
  assert.match(changes[0].fields.get("reason").value, /Prevent invalid lifecycle behavior/u);
});

test("reports runtime flow impact without an application flow section", () => {
  const missingFlow = validPlan.replace(/\n## Application Flows[\s\S]*?(?=\n## Tasks)/u, "");
  const result = validatePlan(missingFlow, { evidenceRegistry });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.warnings.some(({ code }) => code === "APPLICATION_FLOW_MISSING"), true);
});

test("rejects missing fields and warns on missing evidence references", () => {
  const invalid = validPlan
    .replace("- Files: src/session.mjs, test/session.test.mjs\n- Change:", "- Change:")
    .replace("E-001, D-001, P-001", "E-404, D-001, P-001");
  const result = validatePlan(invalid, { evidenceRegistry });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some(({ code }) => code === "FIELD_MISSING"), true);
  assert.equal(result.warnings.some(({ code }) => code === "REFERENCE_MISSING"), true);
});

test("enforces requirement references and warns on insufficient observations", () => {
  const unknown = validatePlan(validPlan.replace("- Requirements: REQ-001", "- Requirements: REQ-999"), {
    evidenceRegistry,
  });
  assert.equal(unknown.valid, false);
  assert.match(unknown.errors.map(({ message }) => message).join("\n"), /unknown requirement REQ-999/u);

  const undersampled = validatePlan(
    validPlan.replace(
      "Reject a value below the minimum; accept both supported boundaries",
      "Accept a supported timeout",
    ),
    { evidenceRegistry },
  );
  assert.equal(undersampled.valid, true);
  assert.equal(undersampled.warnings.some(({ code }) => code === "NYQUIST_INSUFFICIENT"), true);
});

test("reports unsupported before states and unresolved task evidence as semantic warnings", () => {
  const registryWithUnknown = {
    ...evidenceRegistry,
    entries: [
      ...evidenceRegistry.entries,
      {
        id: "U-001",
        type: "unknown",
        claim: "The current task behavior is not independently confirmed.",
        source: { kind: "planning", locator: "T-001" },
        status: "open",
      },
    ],
  };
  const unsupported = validatePlan(
    validPlan
      .replace("- Before: E-001", "- Before: Current behavior is not independently confirmed.")
      .replace("- Evidence: E-001, D-001, P-001\n- Depends on: none", "- Evidence: U-001, D-001, P-001\n- Depends on: none"),
    { evidenceRegistry: registryWithUnknown },
  );
  assert.equal(unsupported.valid, true, JSON.stringify(unsupported.errors));
  assert.equal(unsupported.warnings.some(({ code }) => code === "BEFORE_EVIDENCE_MISSING"), true);
  assert.equal(unsupported.warnings.some(({ code }) => code === "TASK_UNKNOWN_BLOCKS"), true);
});

test("rejects unknown sections and duplicate or unknown structured fields", () => {
  const invalid = validPlan
    .replace("## Goal", "## Extra\nUnexpected.\n\n## Goal")
    .replace("- Symbol: createSession", "- Symbol: oldSymbol\n- Symbol: createSession\n- Surprise: no");
  const result = validatePlan(invalid, { evidenceRegistry });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some(({ code }) => code === "SECTION_UNKNOWN"), true);
  assert.equal(result.errors.some(({ code }) => code === "FIELD_DUPLICATE"), true);
  assert.equal(result.errors.some(({ code }) => code === "FIELD_UNKNOWN"), true);
});

test("validates roadmap phase dependencies", () => {
  assert.equal(validateRoadmap(validRoadmap, { evidenceRegistry }).valid, true);
  const invalid = validRoadmap.replace("- Depends on: none", "- Depends on: P-99");
  const result = validateRoadmap(invalid, { evidenceRegistry });
  assert.equal(result.valid, false);
  assert.match(result.errors.map(({ message }) => message).join("\n"), /unknown phase dependency/u);
});
