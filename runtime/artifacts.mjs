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

const PLAN_ALLOWED_SECTIONS = [...PLAN_SECTIONS, "Application Flows"];

const ROADMAP_SECTIONS = ["Objective", "Requirements", "Phases", "Risks", "Unknowns"];

const ENTRY_SCHEMAS = Object.freeze({
  "Technical Design": {
    heading: /^CH-\d{3}:\s+.+$/u,
    fields: ["File", "Symbol", "Before", "Proposed after", "Reason"],
    optionalFields: ["Change type", "Database changes", "API changes", "Flow impact"],
  },
  "Application Flows": {
    heading: /^F-\d{3}:\s+.+$/u,
    fields: ["Surface", "Entry point", "Phase", "Before", "After", "Evidence"],
    optionalEntries: true,
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
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    const line = index + 1;
    if (/^```[^`]*$/u.test(text)) {
      if (entry) entry.content.push({ text, line });
      else if (section) section.content.push({ text, line });
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (entry) entry.content.push({ text, line });
      else if (section) section.content.push({ text, line });
      continue;
    }
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

export function parseEntryDetailBlocks(entry) {
  const allowed = new Map([
    ["before code", "Before code"],
    ["proposed code", "Proposed code"],
    ["database migration", "Database migration"],
    ["rollback plan", "Rollback plan"],
    ["diagram", "Diagram"],
    ["expected result", "Expected result"],
    ["change points", "Change points"],
  ]);
  const blocks = new Map();
  let current = null;
  let inFence = false;
  for (const { text, line } of entry.content ?? []) {
    if (inFence) {
      if (/^```\s*$/u.test(text)) {
        inFence = false;
      } else {
        current.lines.push(text);
      }
      continue;
    }
    const heading = text.match(/^####\s+(.+)$/u);
    if (heading) {
      const normalized = heading[1].trim().toLowerCase();
      const title = allowed.get(normalized);
      current = title ? { title, line, language: "", lines: [] } : null;
      if (current) blocks.set(title.toLowerCase(), current);
      inFence = false;
      continue;
    }
    if (!current) continue;
    const fence = text.match(/^```([^`]*)$/u);
    if (fence) {
      current.language = fence[1].trim();
      inFence = true;
      continue;
    }
  }
  for (const block of blocks.values()) block.text = block.lines.join("\n").trim();
  return blocks;
}

export function parseChangePoints(block) {
  const points = [];
  const errors = [];
  for (const [index, source] of (block?.text?.split("\n") ?? []).entries()) {
    const text = source.trim();
    if (!text || text.startsWith("//")) continue;
    const columns = text.split("|").map((value) => value.trim());
    const line = (block?.line ?? 1) + index + 2;
    if (columns.length !== 5 || columns.some((value) => !value)) {
      errors.push(issue("Change point must use 'Node | Phase | File | Symbol | Surgical change'", line, "CHANGE_POINT_INVALID"));
      continue;
    }
    const [node, phase, file, symbol, change] = columns;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(node)) errors.push(issue(`Invalid Mermaid node id '${node}'`, line, "CHANGE_POINT_NODE_INVALID"));
    if (!/^P-\d{2}$/u.test(phase)) errors.push(issue(`Invalid change-point phase '${phase}'`, line, "CHANGE_POINT_PHASE_INVALID"));
    points.push({ node, phase, file, symbol, change, line });
  }
  if (points.length === 0) errors.push(issue("At least one surgical change point is required", block?.line, "CHANGE_POINTS_EMPTY"));
  return { valid: errors.length === 0, points, errors };
}

function nonEmptySection(section) {
  if (section.entries.length > 0) return true;
  return section.content.some(({ text }) => text.trim() !== "");
}

function validateBase(document, requiredSections, errors, allowedSections = requiredSections) {
  if (!document.title) errors.push(issue("Document must start with one level-one title", 1, "TITLE_MISSING"));
  for (const title of document.extraTitles) {
    errors.push(issue(`Unexpected additional level-one title: ${title.text}`, title.line, "TITLE_DUPLICATE"));
  }
  for (const section of document.sections.values()) {
    if (!allowedSections.includes(section.name)) {
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
    const allowed = new Set([...schema.fields, ...(schema.optionalFields ?? [])].map((field) => field.toLowerCase()));
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
      warnings.push(issue(`${entry.heading} Before should cite repository evidence E-*`, entry.line, "BEFORE_EVIDENCE_MISSING"));
    }
    const proposed = entry.fields.get("proposed after")?.value ?? "";
    if (!/\bPROPOSED\b/u.test(proposed) && !/\bP-\d{3,}\b/u.test(proposed)) {
      errors.push(issue(`${entry.heading} Proposed after must be labeled PROPOSED or cite P-*`, entry.line));
    }
    for (const [field, code] of [
      ["change type", "TECHNICAL_TYPE_MISSING"],
      ["database changes", "DATABASE_IMPACT_MISSING"],
      ["api changes", "API_IMPACT_MISSING"],
      ["flow impact", "FLOW_IMPACT_MISSING"],
    ]) {
      if (!entry.fields.get(field)?.value) {
        warnings.push(issue(`${entry.heading} should declare '${field}' for technical visualization`, entry.line, code));
      }
    }
    const blocks = parseEntryDetailBlocks(entry);
    for (const name of ["before code", "proposed code"]) {
      if (!blocks.get(name)?.text) {
        warnings.push(issue(`${entry.heading} should include a '${name}' detail block`, entry.line, "TECHNICAL_CODE_MISSING"));
      }
    }
    const databaseChanges = entry.fields.get("database changes")?.value ?? "";
    if (databaseChanges && databaseChanges.toLowerCase() !== "none") {
      if (!blocks.get("database migration")?.text) {
        warnings.push(issue(`${entry.heading} declares database changes without a Database migration block`, entry.line, "DATABASE_DETAIL_MISSING"));
      }
      if (!blocks.get("rollback plan")?.text) {
        warnings.push(issue(`${entry.heading} declares database changes without a Rollback plan block`, entry.line, "ROLLBACK_DETAIL_MISSING"));
      }
    }
    if (!blocks.get("expected result")?.text) {
      warnings.push(issue(`${entry.heading} should include an Expected result block`, entry.line, "EXPECTED_RESULT_MISSING"));
    }
  }

  const applicationFlows = document.sections.get("Application Flows");
  const flowEntries = applicationFlows?.entries ?? [];
  const flowIds = new Set(flowEntries.map((entry) => entry.heading.split(":")[0]));
  const impactedChanges = (technical?.entries ?? []).filter((entry) => {
    const impact = entry.fields.get("flow impact")?.value ?? "";
    return impact && impact.toLowerCase() !== "none";
  });
  if (impactedChanges.length > 0 && flowEntries.length === 0) {
    warnings.push(issue("Runtime flow impact is declared but Application Flows is missing or empty", technical?.line, "APPLICATION_FLOW_MISSING"));
  }
  for (const change of impactedChanges) {
    const impact = change.fields.get("flow impact")?.value ?? "";
    if (!/\bF-\d{3}\b/u.test(impact)) {
      warnings.push(issue(`${change.heading} Flow impact should reference an Application Flow F-*`, change.line, "APPLICATION_FLOW_REFERENCE_MISSING"));
    }
    for (const match of impact.matchAll(/\b(F-\d{3})\b/gu)) {
      if (flowIds.size > 0 && !flowIds.has(match[1])) errors.push(issue(`${change.heading} references unknown application flow ${match[1]}`, change.line, "APPLICATION_FLOW_UNKNOWN"));
    }
  }
  for (const entry of flowEntries) {
    const blocks = parseEntryDetailBlocks(entry);
    const diagram = blocks.get("diagram");
    if (!diagram?.text) {
      errors.push(issue(`${entry.heading} requires a Diagram block`, entry.line, "APPLICATION_FLOW_DIAGRAM_MISSING"));
      continue;
    }
    if (diagram.language.toLowerCase() !== "mermaid") {
      errors.push(issue(`${entry.heading} Diagram block must use the 'mermaid' language`, diagram.line, "APPLICATION_FLOW_LANGUAGE_INVALID"));
    }
    if (!/^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/mu.test(diagram.text)) {
      errors.push(issue(`${entry.heading} Diagram must start with a Mermaid flowchart direction`, diagram.line, "APPLICATION_FLOW_DIAGRAM_INVALID"));
    }
    if (/%%\{|<\/?(?:script|iframe|object)\b/iu.test(diagram.text)) {
      errors.push(issue(`${entry.heading} Diagram contains an unsafe Mermaid directive or element`, diagram.line, "APPLICATION_FLOW_DIAGRAM_UNSAFE"));
    }
    if (!/subgraph\s+BEFORE\b/iu.test(diagram.text) || !/subgraph\s+AFTER\b/iu.test(diagram.text)) {
      warnings.push(issue(`${entry.heading} should separate BEFORE and AFTER subgraphs`, diagram.line, "APPLICATION_FLOW_LANES_MISSING"));
    }
    const changePoints = blocks.get("change points");
    if (!changePoints?.text) {
      warnings.push(issue(`${entry.heading} should map Mermaid nodes to surgical change points`, entry.line, "CHANGE_POINTS_MISSING"));
      continue;
    }
    if (changePoints.language.toLowerCase() !== "changes") {
      errors.push(issue(`${entry.heading} Change points block must use the 'changes' language`, changePoints.line, "CHANGE_POINTS_LANGUAGE_INVALID"));
      continue;
    }
    const parsedPoints = parseChangePoints(changePoints);
    errors.push(...parsedPoints.errors);
    for (const point of parsedPoints.points) {
      if (!new RegExp(`\\b${point.node.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(diagram.text)) {
        errors.push(issue(`${entry.heading} change point references unknown Mermaid node ${point.node}`, point.line, "CHANGE_POINT_NODE_UNKNOWN"));
      }
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
      warnings.push(issue(`${entry.heading} depends on unresolved UNKNOWN evidence`, entry.line, "TASK_UNKNOWN_BLOCKS"));
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
      warnings.push(issue(`${requirement} should have at least two observable verification checks`, requirements?.line, "NYQUIST_INSUFFICIENT"));
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

function validateReferences(references, registry, errors, missingReferences = errors) {
  if (!registry) return;
  const result = validateEvidenceRegistry(registry);
  errors.push(...result.errors);
  if (!result.valid) return;
  for (const reference of references) {
    if (!result.ids.has(reference.id)) {
      missingReferences.push(issue(`Unknown evidence reference ${reference.id} in ${reference.context}`, reference.line, "REFERENCE_MISSING"));
    }
  }
}

export function validatePlan(source, options = {}) {
  const document = parseRestrictedMarkdown(source);
  const errors = [];
  const warnings = [];
  validateBase(document, PLAN_SECTIONS, errors, PLAN_ALLOWED_SECTIONS);
  for (const name of ["Technical Design", "Application Flows", "Tasks", "Risk Controls", "Commit Groups", "Manual Checks"]) {
    if (name === "Application Flows" && !document.sections.has(name)) continue;
    validateEntries(document.sections.get(name), ENTRY_SCHEMAS[name], errors);
  }
  if (errors.length === 0) validatePlanSemantics(document, errors, warnings);
  const references = collectReferences(document);
  validateReferences(references, options.evidenceRegistry, errors, warnings);
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
  const sourceVerification = path.join(phaseDirectory, "PLAN-VERIFICATION.md");
  const [plan, html, verification] = await Promise.all([
    readFile(sourcePlan),
    readFile(sourceHtml),
    readFile(sourceVerification).catch((cause) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    }),
  ]);
  const planHash = sha256(plan);
  if (!html.toString("utf8").includes(`name="phasecraft-source-sha256" content="${planHash}"`)) {
    const error = new Error("plan.html is not bound to the current PLAN.md hash");
    error.code = "PLAN_HTML_STALE";
    throw error;
  }
  if (verification && !verification.toString("utf8").includes(`**Plan SHA-256:** ${planHash}`)) {
    const error = new Error("PLAN-VERIFICATION.md is not bound to the current PLAN.md hash");
    error.code = "PLAN_VERIFICATION_STALE";
    throw error;
  }
  const target = path.join(phaseDirectory, "versions", `v${version}`);
  await mkdir(target, { recursive: false }).catch((cause) => {
    if (cause.code === "ENOENT") return mkdir(path.dirname(target), { recursive: true }).then(() => mkdir(target));
    throw cause;
  });
  const targetPlan = path.join(target, "PLAN.md");
  const targetHtml = path.join(target, "plan.html");
  const targetVerification = path.join(target, "PLAN-VERIFICATION.md");
  await Promise.all([
    copyFile(sourcePlan, targetPlan),
    copyFile(sourceHtml, targetHtml),
    verification ? copyFile(sourceVerification, targetVerification) : Promise.resolve(),
  ]);
  await writeFile(path.join(target, "SUPERSEDED.json"), `${JSON.stringify({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    version,
    planHash,
    htmlHash: sha256(html),
    verificationHash: verification ? sha256(verification) : null,
    reason: reason.trim(),
    archivedAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  await Promise.all([
    chmod(targetPlan, 0o444),
    chmod(targetHtml, 0o444),
    verification ? chmod(targetVerification, 0o444) : Promise.resolve(),
  ]);
  return {
    version,
    directory: target,
    planHash,
    htmlHash: sha256(html),
    verificationHash: verification ? sha256(verification) : null,
  };
}
