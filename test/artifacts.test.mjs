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
});

test("rejects missing fields and missing evidence references", () => {
  const invalid = validPlan
    .replace("- Files: src/session.mjs, test/session.test.mjs\n- Change:", "- Change:")
    .replace("E-001, D-001, P-001", "E-404, D-001, P-001");
  const result = validatePlan(invalid, { evidenceRegistry });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some(({ code }) => code === "FIELD_MISSING"), true);
  assert.equal(result.errors.some(({ code }) => code === "REFERENCE_MISSING"), true);
});

test("enforces requirement coverage and two observable checks", () => {
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
  assert.equal(undersampled.valid, false);
  assert.equal(undersampled.errors.some(({ code }) => code === "NYQUIST_INSUFFICIENT"), true);
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
