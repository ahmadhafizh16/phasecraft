import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const ARTIFACT_SCHEMA_VERSION = 1;
export const EVIDENCE_ID_PATTERN = /\b([EDPUR]-\d{3,})\b/gu;

const PLAN_SECTIONS = [
  "Goal",
  "Inputs",
  "Requirements",
  "Technical Design",
  "Tasks",
  "Risk Controls",
  "Commit Groups",
  "Manual Checks",
];

const ROADMAP_SECTIONS = ["Objective", "Requirements", "Phases", "Risks", "Unknowns"];

const ENTRY_SCHEMAS = Object.freeze({
  "Technical Design": {
    heading: /^CH-\d{3}:\s+.+$/u,
    fields: ["File", "Symbol", "Before", "Proposed after", "Reason"],
  },
  Tasks: {
    heading: /^T-\d{3}:\s+.+$/u,
    fields: ["Requirements", "Evidence", "Depends on", "Files", "Change", "Verification", "Commit group"],
  },
  "Risk Controls": {
    heading: /^R-\d{3}:\s+.+$/u,
    fields: ["Impact", "Mitigation", "Possible solution", "Evidence"],
  },
  "Commit Groups": {
    heading: /^C-\d{3}:\s+.+$/u,
    fields: ["Files", "Message", "Depends on"],
  },
  "Manual Checks": {
    heading: /^M-\d{3}:\s+.+$/u,
    fields: ["Requirement", "Instructions", "Expected", "Status"],
    optionalEntries: true,
  },
  Phases: {
    heading: /^P-\d{2}:\s+.+$/u,
    fields: ["Goal", "Requirements", "Depends on", "Exit evidence", "Status"],
  },
  Risks: {
    heading: /^R-\d{3}:\s+.+$/u,
    fields: ["Impact", "Mitigation", "Possible solution", "Evidence"],
    optionalEntries: true,
  },
});

function issue(message, line = null, code = "SCHEMA_INVALID") {
  return { code, message, line };
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceLines(source) {
  return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

export function parseRestrictedMarkdown(source) {
  const lines = sourceLines(source);
  const document = { title: null, extraTitles: [], sections: new Map(), lines };
  let section = null;
  let entry = null;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    const line = index + 1;
    const h1 = text.match(/^#\s+(.+)$/u);
    if (h1) {
      if (!document.title) document.title = { text: h1[1].trim(), line };
      else document.extraTitles.push({ text: h1[1].trim(), line });
      continue;
    }
    const h2 = text.match(/^##\s+(.+)$/u);
    if (h2) {
      const name = h2[1].trim();
      section = { name, line, content: [], entries: [] };
      if (document.sections.has(name)) section.duplicate = true;
      document.sections.set(name, section);
      entry = null;
      continue;
    }
    const h3 = text.match(/^###\s+(.+)$/u);
    if (h3 && section) {
      entry = { heading: h3[1].trim(), line, fields: new Map(), content: [] };
      section.entries.push(entry);
      continue;
    }
    const field = text.match(/^-\s+([A-Za-z][A-Za-z ]+):\s*(.*)$/u);
    if (field && entry) {
      const name = field[1].trim().toLowerCase();
      if (!entry.duplicateFields) entry.duplicateFields = [];
      if (entry.fields.has(name)) entry.duplicateFields.push({ name, line });
      entry.fields.set(name, { value: field[2].trim(), line });
      continue;
    }
    if (entry) entry.content.push({ text, line });
    else if (section) section.content.push({ text, line });
  }
  return document;
}

function nonEmptySection(section) {
  if (section.entries.length > 0) return true;
  return section.content.some(({ text }) => text.trim() !== "");
}

function validateBase(document, requiredSections, errors) {
  if (!document.title) errors.push(issue("Document must start with one level-one title", 1, "TITLE_MISSING"));
  for (const title of document.extraTitles) {
    errors.push(issue(`Unexpected additional level-one title: ${title.text}`, title.line, "TITLE_DUPLICATE"));
  }
  for (const section of document.sections.values()) {
    if (!requiredSections.includes(section.name)) {
      errors.push(issue(`Unknown level-two section: ${section.name}`, section.line, "SECTION_UNKNOWN"));
    }
  }
  for (const name of requiredSections) {
    const section = document.sections.get(name);
    if (!section) {
      errors.push(issue(`Missing required section: ${name}`, null, "SECTION_MISSING"));
      continue;
    }
    if (section.duplicate) errors.push(issue(`Duplicate section: ${name}`, section.line, "SECTION_DUPLICATE"));
    if (!nonEmptySection(section)) errors.push(issue(`Section is empty: ${name}`, section.line, "SECTION_EMPTY"));
  }
}

function validateEntries(section, schema, errors) {
  if (!section) return;
  if (!schema.optionalEntries && section.entries.length === 0) {
    errors.push(issue(`${section.name} requires at least one level-three entry`, section.line, "ENTRY_MISSING"));
  }
  for (const entry of section.entries) {
    if (!schema.heading.test(entry.heading)) {
      errors.push(issue(`Invalid ${section.name} heading: ${entry.heading}`, entry.line, "ENTRY_HEADING_INVALID"));
    }
    for (const field of schema.fields) {
      const found = entry.fields.get(field.toLowerCase());
      if (!found || found.value === "") {
        errors.push(issue(`${entry.heading} is missing field '${field}'`, entry.line, "FIELD_MISSING"));
      }
    }
    const allowed = new Set(schema.fields.map((field) => field.toLowerCase()));
    for (const [name, field] of entry.fields) {
      if (!allowed.has(name)) errors.push(issue(`${entry.heading} has unknown field '${name}'`, field.line, "FIELD_UNKNOWN"));
    }
    for (const duplicate of entry.duplicateFields ?? []) {
      errors.push(issue(`${entry.heading} repeats field '${duplicate.name}'`, duplicate.line, "FIELD_DUPLICATE"));
    }
  }
}

function collectReferences(document) {
  const references = [];
  for (const section of document.sections.values()) {
    for (const entry of section.entries) {
      for (const field of entry.fields.values()) {
        for (const match of field.value.matchAll(EVIDENCE_ID_PATTERN)) {
          references.push({ id: match[1], line: field.line, context: entry.heading });
        }
      }
      for (const content of entry.content) {
        for (const match of content.text.matchAll(EVIDENCE_ID_PATTERN)) {
          references.push({ id: match[1], line: content.line, context: entry.heading });
        }
      }
    }
    for (const content of section.content) {
      for (const match of content.text.matchAll(EVIDENCE_ID_PATTERN)) {
        references.push({ id: match[1], line: content.line, context: section.name });
      }
    }
  }
  return references;
}

function validatePlanSemantics(document, errors, warnings) {
  const requirements = document.sections.get("Requirements");
  const requirementIds = new Set();
  for (const { text, line } of requirements?.content ?? []) {
    const match = text.match(/^-\s+(REQ-\d{3}):\s+.+$/u);
    if (text.trim() && !match) {
      errors.push(issue("Requirements must use '- REQ-001: description'", line, "REQUIREMENT_INVALID"));
    } else if (match) {
      if (requirementIds.has(match[1])) errors.push(issue(`Duplicate requirement ${match[1]}`, line));
      requirementIds.add(match[1]);
    }
  }
  if (requirementIds.size === 0) errors.push(issue("At least one requirement is required", requirements?.line));
  const requirementChecks = new Map([...requirementIds].map((id) => [id, []]));

  const technical = document.sections.get("Technical Design");
  for (const entry of technical?.entries ?? []) {
    const before = entry.fields.get("before")?.value ?? "";
    if (!/\bE-\d{3,}\b/u.test(before)) {
      errors.push(issue(`${entry.heading} Before must cite repository evidence E-*`, entry.line, "BEFORE_EVIDENCE_MISSING"));
    }
    const proposed = entry.fields.get("proposed after")?.value ?? "";
    if (!/\bPROPOSED\b/u.test(proposed) && !/\bP-\d{3,}\b/u.test(proposed)) {
      errors.push(issue(`${entry.heading} Proposed after must be labeled PROPOSED or cite P-*`, entry.line));
    }
  }

  const taskIds = new Set((document.sections.get("Tasks")?.entries ?? []).map((entry) => entry.heading.split(":")[0]));
  const commitIds = new Set(
    (document.sections.get("Commit Groups")?.entries ?? []).map((entry) => entry.heading.split(":")[0]),
  );
  for (const entry of document.sections.get("Tasks")?.entries ?? []) {
    const dependencies = entry.fields.get("depends on")?.value ?? "";
    if (dependencies.toLowerCase() !== "none") {
      for (const dependency of dependencies.split(",").map((value) => value.trim())) {
        if (!taskIds.has(dependency)) errors.push(issue(`${entry.heading} has unknown dependency ${dependency}`, entry.line));
      }
    }
    const group = entry.fields.get("commit group")?.value;
    if (group && !commitIds.has(group)) errors.push(issue(`${entry.heading} has unknown commit group ${group}`, entry.line));
    const evidence = entry.fields.get("evidence")?.value ?? "";
    if (/\bU-\d{3,}\b/u.test(evidence)) {
      errors.push(issue(`${entry.heading} depends on unresolved UNKNOWN evidence`, entry.line, "TASK_UNKNOWN_BLOCKS"));
    }
    const verification = entry.fields.get("verification")?.value ?? "";
    const checks = verification.split(";").map((value) => value.trim()).filter(Boolean);
    const taskRequirements = (entry.fields.get("requirements")?.value ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const requirement of taskRequirements) {
      if (!requirementIds.has(requirement)) {
        errors.push(issue(`${entry.heading} references unknown requirement ${requirement}`, entry.line));
      } else {
        requirementChecks.get(requirement).push(...checks);
      }
    }
  }
  for (const [requirement, checks] of requirementChecks) {
    if (checks.length < 2) {
      errors.push(issue(`${requirement} requires at least two observable verification checks`, requirements?.line, "NYQUIST_INSUFFICIENT"));
    }
  }
  for (const entry of document.sections.get("Commit Groups")?.entries ?? []) {
    const dependencies = entry.fields.get("depends on")?.value ?? "";
    if (dependencies.toLowerCase() === "none") continue;
    for (const dependency of dependencies.split(",").map((value) => value.trim())) {
      if (!commitIds.has(dependency)) {
        errors.push(issue(`${entry.heading} has unknown commit dependency ${dependency}`, entry.line));
      }
    }
  }
}

function validateRoadmapSemantics(document, errors) {
  const requirements = document.sections.get("Requirements");
  const requirementIds = new Set(
    (requirements?.content ?? [])
      .map(({ text }) => text.match(/^-\s+(REQ-\d{3}):\s+.+$/u)?.[1])
      .filter(Boolean),
  );
  if (requirementIds.size === 0) {
    errors.push(issue("Roadmap requires at least one '- REQ-001: description' entry", requirements?.line));
  }
  const phases = document.sections.get("Phases")?.entries ?? [];
  const ids = new Set(phases.map((entry) => entry.heading.split(":")[0]));
  for (const entry of phases) {
    for (const requirement of (entry.fields.get("requirements")?.value ?? "").split(",").map((value) => value.trim())) {
      if (requirement && !requirementIds.has(requirement)) {
        errors.push(issue(`${entry.heading} references unknown requirement ${requirement}`, entry.line));
      }
    }
    const dependencies = entry.fields.get("depends on")?.value ?? "";
    if (dependencies.toLowerCase() !== "none") {
      for (const dependency of dependencies.split(",").map((value) => value.trim())) {
        if (!ids.has(dependency)) errors.push(issue(`${entry.heading} has unknown phase dependency ${dependency}`, entry.line));
      }
    }
  }
}

export function validateEvidenceRegistry(registry) {
  const errors = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return { valid: false, errors: [issue("Evidence registry must be an object")] };
  }
  if (registry.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    errors.push(issue(`Evidence schemaVersion must be ${ARTIFACT_SCHEMA_VERSION}`));
  }
  if (!Array.isArray(registry.entries)) errors.push(issue("Evidence registry requires an entries array"));
  const ids = new Set();
  const expectedPrefixes = { evidence: "E", decision: "D", proposal: "P", unknown: "U", risk: "R" };
  for (const [index, entry] of (registry.entries ?? []).entries()) {
    const at = `entries[${index}]`;
    if (!/^[EDPUR]-\d{3,}$/u.test(entry?.id ?? "")) errors.push(issue(`${at}.id is invalid`));
    if (ids.has(entry?.id)) errors.push(issue(`Duplicate evidence id ${entry.id}`));
    ids.add(entry?.id);
    if (!Object.hasOwn(expectedPrefixes, entry?.type)) errors.push(issue(`${at}.type is invalid`));
    else if (!entry.id?.startsWith(`${expectedPrefixes[entry.type]}-`)) {
      errors.push(issue(`${entry.id} prefix does not match type ${entry.type}`));
    }
    if (typeof entry?.claim !== "string" || entry.claim.trim() === "") errors.push(issue(`${at}.claim is required`));
    if (!entry?.source || typeof entry.source.kind !== "string" || typeof entry.source.locator !== "string") {
      errors.push(issue(`${at}.source requires kind and locator`));
    }
    if (entry?.type === "evidence" && !/^[a-f0-9]{64}$/u.test(entry?.source?.hash ?? "")) {
      errors.push(issue(`${at}.source.hash must be SHA-256 for E-* evidence`));
    }
    if (typeof entry?.status !== "string") errors.push(issue(`${at}.status is required`));
  }
  return { valid: errors.length === 0, errors, ids };
}

function validateReferences(references, registry, errors) {
  if (!registry) return;
  const result = validateEvidenceRegistry(registry);
  errors.push(...result.errors);
  if (!result.valid) return;
  for (const reference of references) {
    if (!result.ids.has(reference.id)) {
      errors.push(issue(`Unknown evidence reference ${reference.id} in ${reference.context}`, reference.line, "REFERENCE_MISSING"));
    }
  }
}

export function validatePlan(source, options = {}) {
  const document = parseRestrictedMarkdown(source);
  const errors = [];
  const warnings = [];
  validateBase(document, PLAN_SECTIONS, errors);
  for (const name of ["Technical Design", "Tasks", "Risk Controls", "Commit Groups", "Manual Checks"]) {
    validateEntries(document.sections.get(name), ENTRY_SCHEMAS[name], errors);
  }
  if (errors.length === 0) validatePlanSemantics(document, errors, warnings);
  const references = collectReferences(document);
  validateReferences(references, options.evidenceRegistry, errors);
  return {
    valid: errors.length === 0,
    kind: "plan",
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    sourceHash: sha256(source),
    errors,
    warnings,
    references,
    document,
  };
}

export function validateRoadmap(source, options = {}) {
  const document = parseRestrictedMarkdown(source);
  const errors = [];
  const warnings = [];
  validateBase(document, ROADMAP_SECTIONS, errors);
  validateEntries(document.sections.get("Phases"), ENTRY_SCHEMAS.Phases, errors);
  validateEntries(document.sections.get("Risks"), ENTRY_SCHEMAS.Risks, errors);
  if (errors.length === 0) validateRoadmapSemantics(document, errors);
  const references = collectReferences(document);
  validateReferences(references, options.evidenceRegistry, errors);
  return {
    valid: errors.length === 0,
    kind: "roadmap",
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    sourceHash: sha256(source),
    errors,
    warnings,
    references,
    document,
  };
}

export async function validateArtifactFile(kind, sourcePath, options = {}) {
  const source = await readFile(sourcePath, "utf8");
  let evidenceRegistry;
  if (options.evidenceFile) evidenceRegistry = JSON.parse(await readFile(options.evidenceFile, "utf8"));
  if (kind === "plan") return validatePlan(source, { evidenceRegistry });
  if (kind === "roadmap") return validateRoadmap(source, { evidenceRegistry });
  if (kind === "evidence") {
    const registry = JSON.parse(source);
    const result = validateEvidenceRegistry(registry);
    return { ...result, kind, schemaVersion: ARTIFACT_SCHEMA_VERSION, sourceHash: sha256(source) };
  }
  const error = new Error(`Unknown artifact kind: ${kind}`);
  error.code = "ARTIFACT_KIND_UNKNOWN";
  throw error;
}

export async function archivePlanVersion(phaseDirectory, version, reason) {
  if (!Number.isInteger(version) || version < 1) {
    const error = new Error("Plan archive version must be a positive integer");
    error.code = "PLAN_VERSION_INVALID";
    throw error;
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    const error = new Error("Plan supersession reason is required");
    error.code = "PLAN_REASON_REQUIRED";
    throw error;
  }
  const sourcePlan = path.join(phaseDirectory, "PLAN.md");
  const sourceHtml = path.join(phaseDirectory, "plan.html");
  const [plan, html] = await Promise.all([readFile(sourcePlan), readFile(sourceHtml)]);
  const planHash = sha256(plan);
  if (!html.toString("utf8").includes(`name="phasecraft-source-sha256" content="${planHash}"`)) {
    const error = new Error("plan.html is not bound to the current PLAN.md hash");
    error.code = "PLAN_HTML_STALE";
    throw error;
  }
  const target = path.join(phaseDirectory, "versions", `v${version}`);
  await mkdir(target, { recursive: false }).catch((cause) => {
    if (cause.code === "ENOENT") return mkdir(path.dirname(target), { recursive: true }).then(() => mkdir(target));
    throw cause;
  });
  const targetPlan = path.join(target, "PLAN.md");
  const targetHtml = path.join(target, "plan.html");
  await Promise.all([copyFile(sourcePlan, targetPlan), copyFile(sourceHtml, targetHtml)]);
  await writeFile(path.join(target, "SUPERSEDED.json"), `${JSON.stringify({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    version,
    planHash,
    htmlHash: sha256(html),
    reason: reason.trim(),
    archivedAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  await Promise.all([chmod(targetPlan, 0o444), chmod(targetHtml, 0o444)]);
  return { version, directory: target, planHash, htmlHash: sha256(html) };
}
