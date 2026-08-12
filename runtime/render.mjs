import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACT_SCHEMA_VERSION,
  parseChangePoints,
  parseEntryDetailBlocks,
  validatePlan,
  validateRoadmap,
} from "./artifacts.mjs";

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/gu, "<code>$1</code>")
    .replace(/\b(E|D|P|U|R)-(\d{3,})\b/gu, (_, prefix, number) => (
      `<a class="identity identity-${prefix.toLowerCase()}" href="#reference-${prefix}-${number}" title="Open reference ${prefix}-${number}">${prefix}-${number}</a>`
    ))
    .replace(/\bP-(\d{2})\b/gu, (_, number) => `<span class="identity identity-phase">P-${number}</span>`)
    .replace(/\b(REQ|CH|F|T|C|M)-(\d{2,})\b/gu, (_, prefix, number) => (
      `<span class="identity identity-${prefix.toLowerCase()}">${prefix}-${number}</span>`
    ));
}

function renderContent(content) {
  const output = [];
  let listOpen = false;
  for (const { text } of content ?? []) {
    const trimmed = text.trim();
    const list = trimmed.match(/^-\s+(.+)$/u);
    if (list) {
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }
      output.push(`<li>${renderInline(list[1])}</li>`);
      continue;
    }
    if (listOpen) {
      output.push("</ul>");
      listOpen = false;
    }
    if (trimmed) output.push(`<p>${renderInline(trimmed)}</p>`);
  }
  if (listOpen) output.push("</ul>");
  return output.join("\n");
}

function plainInline(value) {
  return String(value ?? "").replace(/`([^`]+)`/gu, "$1");
}

function plainContent(content) {
  return (content ?? [])
    .map(({ text }) => text.trim().replace(/^-\s+/u, ""))
    .filter(Boolean)
    .map(plainInline)
    .join("\n");
}

function joinPlainText(...parts) {
  return parts
    .flat(Infinity)
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function semanticKey(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function entryPlainText(entry, fields = [], blocks = []) {
  return joinPlainText(
    entry.heading,
    fields.map((field) => {
      const value = getField(entry, field);
      return value ? `${field}\n${plainInline(value)}` : "";
    }),
    blocks.map((block) => block?.text ? `${block.title}\n${block.text}` : ""),
  );
}

class ReviewManifestBuilder {
  constructor() {
    this.entries = [];
    this.counts = new Map();
  }

  anchor(semantic, label, plainText) {
    const count = (this.counts.get(semantic) ?? 0) + 1;
    this.counts.set(semantic, count);
    const uniqueSemantic = count === 1 ? semantic : `${semantic}/occurrence-${count}`;
    const entry = {
      semantic: uniqueSemantic,
      label: String(label),
      plainText: String(plainText ?? ""),
    };
    this.entries.push(entry);
    return ` data-phasecraft-anchor="${escapeHtml(uniqueSemantic)}" data-phasecraft-anchor-label="${escapeHtml(entry.label)}"`;
  }

  toJSON(html = "") {
    const entries = html
      ? [...this.entries].sort((left, right) => {
        const leftIndex = html.indexOf(`data-phasecraft-anchor="${escapeHtml(left.semantic)}"`);
        const rightIndex = html.indexOf(`data-phasecraft-anchor="${escapeHtml(right.semantic)}"`);
        return leftIndex - rightIndex;
      })
      : this.entries;
    return { schemaVersion: 1, entries };
  }
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function parseReviewManifest(html) {
  const match = String(html).match(/<script\b(?=[^>]*\bid=["']phasecraft-review-manifest["'])[^>]*>([\s\S]*?)<\/script>/iu);
  if (!match) {
    const error = new Error("Phasecraft review manifest was not found in generated HTML");
    error.code = "REVIEW_MANIFEST_MISSING";
    throw error;
  }
  try {
    return JSON.parse(match[1]);
  } catch (cause) {
    const error = new Error("Phasecraft review manifest contains invalid JSON", { cause });
    error.code = "REVIEW_MANIFEST_INVALID";
    throw error;
  }
}

function getSection(document, name) {
  return document.sections.get(name) ?? { name, content: [], entries: [] };
}

function getField(entry, name) {
  return entry.fields.get(name.toLowerCase())?.value ?? "";
}

function entryId(entry) {
  return entry.heading.split(":")[0].trim();
}

function entryTitle(entry) {
  const separator = entry.heading.indexOf(":");
  return separator === -1 ? entry.heading : entry.heading.slice(separator + 1).trim();
}

function phaseId(value) {
  const source = String(value ?? "");
  const exact = source.match(/\bP-(\d{2})\b/iu);
  if (exact) return `P-${exact[1]}`;
  const labeled = source.match(/\bPhase\s+(\d{1,2})\b/iu);
  return labeled ? `P-${labeled[1].padStart(2, "0")}` : null;
}

function planPhaseContext(document, explicitPhase = null) {
  const current = phaseId(explicitPhase) ?? phaseId(document.title?.text);
  const flowPhases = [...new Set(
    getSection(document, "Application Flows").entries
      .map((entry) => phaseId(getField(entry, "Phase")))
      .filter(Boolean),
  )];
  return {
    current,
    contextPhases: flowPhases.filter((phase) => phase !== current).sort(),
  };
}

function planBrowserTitle(title, phase) {
  if (!phase) return `Phasecraft Plan · ${title}`;
  const descriptor = title
    .replace(/\bP-\d{2}\b/iu, "")
    .replace(/^Phase\s+\d{1,2}\s*[:—–-]?\s*/iu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return `${phase} · ${descriptor || "Phase plan"} · Phasecraft Plan`;
}

function phaseFromPath(filePath) {
  const segment = path.resolve(filePath).split(path.sep).find((value) => /^P-\d{2}(?:-|$)/iu.test(value));
  return phaseId(segment);
}

function splitList(value) {
  if (!value || value.trim().toLowerCase() === "none") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function requirementItems(section) {
  return section.content.flatMap(({ text }) => {
    const match = text.match(/^-\s+(REQ-\d{3}):\s+(.+)$/u);
    return match ? [{ id: match[1], text: match[2] }] : [];
  });
}

function sectionIsNone(section) {
  return section.entries.length === 0 && section.content
    .map(({ text }) => text.trim())
    .filter(Boolean)
    .every((text) => /^none\.?$/iu.test(text));
}

function renderChips(values, className = "chip") {
  if (values.length === 0) return '<span class="muted">none</span>';
  return `<span class="chip-list">${values.map((value) => `<span class="${className}">${renderInline(value)}</span>`).join("")}</span>`;
}

function renderChecks(value) {
  const checks = value.split(";").map((item) => item.trim()).filter(Boolean);
  return `<ul class="check-list">${checks.map((check) => `<li>${renderInline(check)}</li>`).join("")}</ul>`;
}

function syntaxPattern(language) {
  if (["js", "javascript", "jsx", "mjs", "cjs", "ts", "typescript", "tsx"].includes(language)) {
    return /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<string>'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`)|(?<number>\b(?:0[xX][\dA-Fa-f]+|\d+(?:\.\d+)?)\b)|(?<keyword>\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|switch|throw|try|typeof|var|while|yield)\b)|(?<literal>\b(?:false|null|true|undefined)\b)|(?<function>\b[A-Za-z_$][\w$]*(?=\s*\())|(?<property>\b[A-Za-z_$][\w$]*(?=\s*:))/gmu;
  }
  if (language === "json") {
    return /(?<property>"(?:\\[\s\S]|[^"\\])*"(?=\s*:))|(?<string>"(?:\\[\s\S]|[^"\\])*")|(?<number>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<literal>\b(?:false|null|true)\b)/gmu;
  }
  if (["sql", "pgsql", "postgres", "mysql"].includes(language)) {
    return /(?<comment>--[^\n]*|\/\*[\s\S]*?\*\/)|(?<string>'(?:''|[^'])*')|(?<number>\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:add|alter|and|as|begin|by|column|commit|constraint|create|delete|drop|exists|from|group|having|index|insert|into|join|key|limit|not|null|on|or|order|primary|references|returning|rollback|select|set|table|transaction|unique|update|values|where)\b)|(?<literal>\b(?:false|true)\b)/gimu;
  }
  if (["bash", "sh", "shell", "zsh"].includes(language)) {
    return /(?<comment>#[^\n]*)|(?<string>'[^']*'|"(?:\\.|[^"\\])*")|(?<variable>\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)|(?<number>\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:case|do|done|elif|else|esac|export|fi|for|function|if|in|local|readonly|then|while)\b)/gmu;
  }
  return null;
}

function highlightCode(value, language) {
  const normalized = String(language || "text").trim().toLowerCase();
  const pattern = syntaxPattern(normalized);
  if (!pattern) return escapeHtml(value);
  let cursor = 0;
  let output = "";
  for (const match of String(value).matchAll(pattern)) {
    output += escapeHtml(String(value).slice(cursor, match.index));
    const type = Object.entries(match.groups ?? {}).find(([, token]) => token !== undefined)?.[0] ?? "plain";
    output += `<span class="syntax-${type}">${escapeHtml(match[0])}</span>`;
    cursor = match.index + match[0].length;
  }
  return output + escapeHtml(String(value).slice(cursor));
}

function renderTechnicalBlock(block, label, manifest, semantic, anchorLabel = label) {
  const plainText = block?.text ? joinPlainText(label, block.text) : joinPlainText(label, "Not supplied in PLAN.md");
  const anchor = manifest.anchor(semantic, anchorLabel, plainText);
  if (!block?.text) {
    return `<div class="missing-detail"${anchor}><strong>${escapeHtml(label)}</strong><span>Not supplied in PLAN.md</span></div>`;
  }
  const language = block.language || "text";
  return `<div class="code-panel"${anchor}><div class="code-panel-heading"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(language)}</span></div><pre><code class="language-${escapeHtml(language.toLowerCase())}">${highlightCode(block.text, language)}</code></pre></div>`;
}

function renderApplicationFlow(entry, currentPhase, manifest) {
  const blocks = parseEntryDetailBlocks(entry);
  const diagram = blocks.get("diagram");
  const changePoints = parseChangePoints(blocks.get("change points")).points;
  const id = entryId(entry);
  const semantic = `plan/application-flows/${id}`;
  const label = `${id}: ${entryTitle(entry)}`;
  const pointRows = changePoints.map((point) => {
    const pointSemantic = `${semantic}/change-point/${point.node}`;
    const pointLabel = `${label} — Change point ${point.node}`;
    const pointText = joinPlainText(
      `Change point ${point.node}`,
      `Phase\n${point.phase}`,
      `File\n${point.file}`,
      `Symbol\n${point.symbol}`,
      `Surgical change\n${plainInline(point.change)}`,
    );
    return `<tr${manifest.anchor(pointSemantic, pointLabel, pointText)}><th><code>${escapeHtml(point.node)}</code></th><td>${renderInline(point.phase)}</td><td><code>${renderInline(point.file)}</code><small>${renderInline(point.symbol)}</small></td><td>${renderInline(point.change)}</td></tr>`;
  }).join("\n");
  const ownerPhase = phaseId(getField(entry, "Phase"));
  const phaseScope = currentPhase && ownerPhase !== currentPhase ? "future" : "current";
  const phaseLabel = phaseScope === "current" ? "Current phase" : "Future context";
  const flowText = entryPlainText(entry, ["Surface", "Entry point", "Phase", "Before", "After", "Evidence"]);
  const diagramText = joinPlainText("Diagram", diagram?.text ?? "");
  return `<article class="application-flow-card application-flow-${phaseScope}" data-application-flow="${escapeHtml(id)}" data-phase-scope="${phaseScope}"${manifest.anchor(semantic, label, flowText)}>
    <div class="application-flow-header"><div><span>${renderInline(id)}</span><h3>${renderInline(entryTitle(entry))}</h3></div><em class="flow-phase flow-phase-${phaseScope}">${renderInline(getField(entry, "Phase"))}<span>${phaseLabel}</span></em></div>
    <div class="application-flow-meta"><div><small>Surface</small><strong>${renderInline(getField(entry, "Surface"))}</strong></div><div><small>Entry point</small><code>${renderInline(getField(entry, "Entry point"))}</code></div></div>
    <div class="application-flow-delta"><div><small>Before</small><p>${renderInline(getField(entry, "Before"))}</p></div><div><small>After</small><p>${renderInline(getField(entry, "After"))}</p></div></div>
    <div class="mermaid-shell"${manifest.anchor(`${semantic}/diagram`, `${label} — Diagram`, diagramText)}><pre class="mermaid">${escapeHtml(diagram?.text ?? "")}</pre></div>
    <div class="change-point-shell"><div class="change-point-heading"><strong>Surgical application changes</strong><span>${changePoints.length} mapped points</span></div><div class="table-shell"><table class="change-point-table"><thead><tr><th>Flow node</th><th>Phase</th><th>File / symbol</th><th>Surgical change</th></tr></thead><tbody>${pointRows}</tbody></table></div></div>
    <div class="application-flow-evidence"><small>Evidence</small>${renderChips(splitList(getField(entry, "Evidence")))}</div>
  </article>`;
}

function truncate(value, length = 27) {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

function dependencyGraph(entries, options) {
  const dependencies = new Map(entries.map((entry) => [
    entryId(entry),
    splitList(getField(entry, "Depends on")),
  ]));
  const needsDiagram = entries.length > 1 || [...dependencies.values()].some((values) => values.length > 0);
  if (!needsDiagram) return "";

  const ids = new Set(entries.map(entryId));
  const depthCache = new Map();
  function depth(id, visiting = new Set()) {
    if (depthCache.has(id)) return depthCache.get(id);
    if (visiting.has(id)) return 0;
    const nextVisiting = new Set(visiting).add(id);
    const parentDepths = (dependencies.get(id) ?? [])
      .filter((dependency) => ids.has(dependency))
      .map((dependency) => depth(dependency, nextVisiting) + 1);
    const value = parentDepths.length > 0 ? Math.max(...parentDepths) : 0;
    depthCache.set(id, value);
    return value;
  }

  const columns = new Map();
  for (const entry of entries) {
    const column = depth(entryId(entry));
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(entry);
  }

  const nodeWidth = 196;
  const nodeHeight = 76;
  const columnGap = 76;
  const rowGap = 28;
  const padding = 36;
  const maxColumn = Math.max(...columns.keys());
  const maxRows = Math.max(...[...columns.values()].map((column) => column.length));
  const width = padding * 2 + (maxColumn + 1) * nodeWidth + maxColumn * columnGap;
  const height = Math.max(180, padding * 2 + maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap);
  const positions = new Map();

  for (const [column, columnEntries] of columns) {
    const totalHeight = columnEntries.length * nodeHeight + Math.max(0, columnEntries.length - 1) * rowGap;
    const startY = (height - totalHeight) / 2;
    columnEntries.forEach((entry, row) => {
      positions.set(entryId(entry), {
        x: padding + column * (nodeWidth + columnGap),
        y: startY + row * (nodeHeight + rowGap),
      });
    });
  }

  const markerId = `${options.kind}-dependency-arrow`;
  const edges = [];
  for (const entry of entries) {
    const destination = positions.get(entryId(entry));
    for (const dependency of dependencies.get(entryId(entry)) ?? []) {
      const source = positions.get(dependency);
      if (!source) continue;
      const sourceX = source.x + nodeWidth;
      const sourceY = source.y + nodeHeight / 2;
      const destinationX = destination.x;
      const destinationY = destination.y + nodeHeight / 2;
      const bend = Math.max(28, (destinationX - sourceX) / 2);
      edges.push(
        `<path class="graph-edge" d="M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY}, ${destinationX - bend} ${destinationY}, ${destinationX} ${destinationY}" marker-end="url(#${markerId})"/>`,
      );
    }
  }

  const nodes = entries.map((entry) => {
    const id = entryId(entry);
    const position = positions.get(id);
    const subtitle = options.subtitle(entry);
    return `<g class="graph-node" transform="translate(${position.x} ${position.y})">
      <rect width="${nodeWidth}" height="${nodeHeight}" rx="12"/>
      <text class="graph-id" x="16" y="24">${escapeHtml(id)}</text>
      <text class="graph-title" x="16" y="47">${escapeHtml(truncate(entryTitle(entry)))}</text>
      <text class="graph-subtitle" x="16" y="65">${escapeHtml(truncate(subtitle, 31))}</text>
    </g>`;
  }).join("\n");

  return `<div class="diagram-shell" data-diagram="${escapeHtml(options.kind)}-dependencies">
    <div class="diagram-heading"><span>${escapeHtml(options.label)}</span><small>Arrows show declared dependencies</small></div>
    <div class="diagram-scroll">
      <svg class="dependency-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.label)} dependency diagram">
        <title>${escapeHtml(options.label)} dependency diagram</title>
        <defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>
        ${edges.join("\n")}
        ${nodes}
      </svg>
    </div>
  </div>`;
}

function metric(label, value, detail = "") {
  return `<div class="metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>`;
}

function renderReferenceIndex(validation, evidenceRegistry, kind, manifest) {
  const entriesById = new Map((evidenceRegistry?.entries ?? []).map((entry) => [entry.id, entry]));
  const references = [];
  const seen = new Set();
  for (const reference of validation.references) {
    if (seen.has(reference.id)) continue;
    seen.add(reference.id);
    references.push({ id: reference.id, entry: entriesById.get(reference.id) ?? null });
  }
  if (references.length === 0) {
    return '<p class="empty-state resolved">This artifact has no evidence or decision references.</p>';
  }

  const cards = references.map(({ id, entry }) => {
    const type = entry?.type ?? "unresolved";
    const source = entry?.source ?? {};
    const label = `${id}: ${entry?.claim ?? "Unresolved reference"}`;
    const plainText = joinPlainText(
      id,
      entry?.claim ?? "Reference metadata was not supplied to the renderer.",
      `Type\n${type}`,
      `Source\n${entry ? `${source.kind ?? "unknown"} / ${source.locator ?? "unknown"}` : "unavailable"}`,
      `Status\n${entry?.status ?? "unresolved"}`,
    );
    return `<article class="reference-card reference-${escapeHtml(type)}" id="reference-${escapeHtml(id)}"${manifest.anchor(`${kind}/references/${id}`, label, plainText)}>
      <div class="reference-heading"><span>${renderInline(id)}</span><em>${escapeHtml(type)}</em></div>
      <p>${entry ? renderInline(entry.claim) : "Reference metadata was not supplied to the renderer."}</p>
      <dl>
        <dt>Source</dt><dd>${entry ? `${escapeHtml(source.kind ?? "unknown")} / ${escapeHtml(source.locator ?? "unknown")}` : "unavailable"}</dd>
        <dt>Status</dt><dd>${escapeHtml(entry?.status ?? "unresolved")}</dd>
      </dl>
    </article>`;
  }).join("\n");

  return `<div class="reference-intro"><p>Every identity used above resolves here to its claim, provenance, and status. Select any inline identity to jump to its reference.</p><span>${references.length} unique references</span></div><div class="reference-grid" data-reference-index="${escapeHtml(kind)}">${cards}</div>`;
}

function renderRoadmap(validation, evidenceRegistry, manifest) {
  const document = validation.document;
  const objective = getSection(document, "Objective");
  const requirements = requirementItems(getSection(document, "Requirements"));
  const phases = getSection(document, "Phases").entries;
  const risks = getSection(document, "Risks");
  const unknowns = getSection(document, "Unknowns");
  const activeCount = phases.filter((phase) => /next|active|current|in progress/iu.test(getField(phase, "Status"))).length;
  const completedCount = phases.filter((phase) => /complete|done|verified|shipped/iu.test(getField(phase, "Status"))).length;

  const graph = dependencyGraph(phases, {
    kind: "roadmap",
    label: "Phase architecture",
    subtitle: (entry) => getField(entry, "Status"),
  });

  const phaseCards = phases.map((phase, index) => {
    const status = getField(phase, "Status");
    const statusClass = status.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
    const id = entryId(phase);
    const label = `${id}: ${entryTitle(phase)}`;
    const plainText = entryPlainText(phase, ["Goal", "Requirements", "Depends on", "Exit evidence", "Status"]);
    return `<article class="phase-card"${manifest.anchor(`roadmap/phases/${id}`, label, plainText)}>
      <div class="phase-card-top"><span class="phase-number">${String(index + 1).padStart(2, "0")}</span><span class="status status-${escapeHtml(statusClass)}">${renderInline(status)}</span></div>
      <p class="phase-id">${renderInline(entryId(phase))}</p>
      <h3>${renderInline(entryTitle(phase))}</h3>
      <p class="phase-goal">${renderInline(getField(phase, "Goal"))}</p>
      <dl>
        <dt>Requirements</dt><dd>${renderChips(splitList(getField(phase, "Requirements")))}</dd>
        <dt>Depends on</dt><dd>${renderChips(splitList(getField(phase, "Depends on")))}</dd>
        <dt>Exit evidence</dt><dd>${renderInline(getField(phase, "Exit evidence"))}</dd>
      </dl>
    </article>`;
  }).join("\n");

  const requirementCards = requirements.map((requirement) => {
    const owners = phases.filter((phase) => splitList(getField(phase, "Requirements")).includes(requirement.id));
    const label = `${requirement.id}: ${requirement.text}`;
    const plainText = joinPlainText(requirement.id, plainInline(requirement.text), `${owners.length} phase${owners.length === 1 ? "" : "s"}`);
    return `<article class="requirement-card"${manifest.anchor(`roadmap/requirements/${requirement.id}`, label, plainText)}><span>${renderInline(requirement.id)}</span><p>${renderInline(requirement.text)}</p><small>${owners.length} phase${owners.length === 1 ? "" : "s"}</small></article>`;
  }).join("\n");

  const riskCards = risks.entries.map((risk) => {
    const id = entryId(risk);
    const label = `${id}: ${entryTitle(risk)}`;
    return `<article class="roadmap-risk"${manifest.anchor(`roadmap/risks/${id}`, label, entryPlainText(risk, ["Impact", "Mitigation", "Possible solution", "Evidence"]))}>
    <div><span>${renderInline(id)}</span><h3>${renderInline(entryTitle(risk))}</h3></div>
    <p><strong>Impact</strong><span class="roadmap-risk-copy">${renderInline(getField(risk, "Impact"))}</span></p>
    <p><strong>Mitigation</strong><span class="roadmap-risk-copy">${renderInline(getField(risk, "Mitigation"))}</span></p>
    <p><strong>Possible solution</strong><span class="roadmap-risk-copy">${renderInline(getField(risk, "Possible solution"))}</span></p>
  </article>`;
  }).join("\n");

  return `<header class="roadmap-hero">
    <div class="hero-inner">
      <div class="eyebrow">Phasecraft roadmap / strategic atlas</div>
      <h1>${escapeHtml(document.title?.text ?? "Phasecraft roadmap")}</h1>
      <div class="hero-copy"${manifest.anchor("roadmap/objective", "Objective", plainContent(objective.content))}>${renderContent(objective.content)}</div>
      <div class="roadmap-scope-banner" data-artifact-scope="all-phases"><span>All phases</span><div><strong>Whole-work strategic roadmap</strong><p>This artifact defines phase sequence and ownership. Execution requires a separately planned and independently verified phase.</p></div></div>
      <div class="metric-row">
        ${metric("phases", String(phases.length), `${completedCount} completed`)}
        ${metric("requirements", String(requirements.length), "mapped to phases")}
        ${metric("risks", String(risks.entries.length), "with controls")}
        ${metric("active", String(activeCount), "current or next")}
      </div>
    </div>
  </header>
  <main class="roadmap-main" data-view="roadmap-atlas">
    <section class="roadmap-section architecture-section">
      <div class="section-heading"><span>01</span><div><p>Sequence</p><h2>Phase architecture</h2></div></div>
      ${graph || '<p class="single-note">Single phase roadmap. A dependency diagram will appear when multiple phases or dependencies exist.</p>'}
    </section>
    <section class="roadmap-section">
      <div class="section-heading"><span>02</span><div><p>Delivery path</p><h2>Phase ledger</h2></div></div>
      <div class="phase-grid">${phaseCards}</div>
    </section>
    <section class="roadmap-section">
      <div class="section-heading"><span>03</span><div><p>Outcome coverage</p><h2>Requirements map</h2></div></div>
      <div class="requirement-grid">${requirementCards}</div>
    </section>
    <section class="roadmap-section split-section">
      <div>
        <div class="section-heading compact"><span>04</span><div><p>Controls</p><h2>Strategic risks</h2></div></div>
        ${sectionIsNone(risks) ? '<p class="empty-state">No roadmap risks recorded.</p>' : `<div class="risk-stack">${riskCards}</div>`}
      </div>
      <div>
        <div class="section-heading compact"><span>05</span><div><p>Discovery queue</p><h2>Open unknowns</h2></div></div>
        ${sectionIsNone(unknowns) ? `<p class="empty-state resolved"${manifest.anchor("roadmap/unknowns", "Open unknowns", plainContent(unknowns.content))}>No unresolved roadmap unknowns.</p>` : `<div class="unknown-panel"${manifest.anchor("roadmap/unknowns", "Open unknowns", plainContent(unknowns.content))}>${renderContent(unknowns.content)}</div>`}
      </div>
    </section>
    <section class="roadmap-section reference-section">
      <div class="section-heading"><span>06</span><div><p>Traceability</p><h2>Evidence reference atlas</h2></div></div>
      ${renderReferenceIndex(validation, evidenceRegistry, "roadmap", manifest)}
    </section>
  </main>`;
}

function renderPlan(validation, evidenceRegistry, options = {}, manifest) {
  const document = validation.document;
  const phaseContext = planPhaseContext(document, options.phase);
  const goal = getSection(document, "Goal");
  const inputs = getSection(document, "Inputs");
  const requirements = requirementItems(getSection(document, "Requirements"));
  const changes = getSection(document, "Technical Design").entries;
  const applicationFlows = getSection(document, "Application Flows").entries;
  const tasks = getSection(document, "Tasks").entries;
  const risks = getSection(document, "Risk Controls").entries;
  const commits = getSection(document, "Commit Groups").entries;
  const manualChecks = getSection(document, "Manual Checks");
  const files = [...new Set(tasks.flatMap((task) => splitList(getField(task, "Files"))))].sort();

  const taskGraph = dependencyGraph(tasks, {
    kind: "plan",
    label: "Task execution flow",
    subtitle: (entry) => getField(entry, "Commit group"),
  });

  const coverageRows = requirements.map((requirement) => {
    const coveringTasks = tasks.filter((task) => splitList(getField(task, "Requirements")).includes(requirement.id));
    const checks = coveringTasks.flatMap((task) => getField(task, "Verification").split(";").map((check) => check.trim()).filter(Boolean));
    const plainText = joinPlainText(
      requirement.id,
      plainInline(requirement.text),
      `Tasks\n${coveringTasks.map(entryId).join(", ") || "none"}`,
      `Checks\n${checks.join("\n") || "none"}`,
    );
    return `<tr${manifest.anchor(`plan/requirement-coverage/${requirement.id}`, `${requirement.id} requirement coverage`, plainText)}><th><span>${renderInline(requirement.id)}</span><small>${renderInline(requirement.text)}</small></th><td>${renderChips(coveringTasks.map(entryId), "chip task-chip")}</td><td><strong>${checks.length}</strong><span>observations</span></td></tr>`;
  }).join("\n");

  const changeCards = changes.map((change) => {
    const blocks = parseEntryDetailBlocks(change);
    const id = entryId(change);
    const semantic = `plan/technical-design/${id}`;
    const label = `${id}: ${entryTitle(change)}`;
    const databaseChanges = getField(change, "Database changes") || "Not declared";
    const apiChanges = getField(change, "API changes") || "Not declared";
    const flowImpact = getField(change, "Flow impact") || "Not declared";
    const databaseDetail = databaseChanges.toLowerCase() === "none" && !blocks.get("database migration")
      ? ""
      : `<div class="database-detail"><div><strong>Database migration</strong><p>${renderInline(databaseChanges)}</p></div>${renderTechnicalBlock(blocks.get("database migration"), "Migration detail", manifest, `${semantic}/block/database-migration`, `${label} — Database migration`)}${renderTechnicalBlock(blocks.get("rollback plan"), "Rollback plan", manifest, `${semantic}/block/rollback-plan`, `${label} — Rollback plan`)}</div>`;
    const changeText = entryPlainText(change, ["Change type", "File", "Symbol", "Before", "Proposed after", "Reason", "Database changes", "API changes", "Flow impact"]);
    return `<article class="change-card"${manifest.anchor(semantic, label, changeText)}>
      <div class="change-heading"><div><span>${renderInline(id)}</span><h3>${renderInline(entryTitle(change))}</h3><em>${escapeHtml(getField(change, "Change type") || "type not declared")}</em></div><div class="target"><code>${renderInline(getField(change, "File"))}</code><small>${renderInline(getField(change, "Symbol"))}</small></div></div>
      <div class="delta-lane">
        <div class="delta before"${manifest.anchor(`${semantic}/field/before`, `${label} — Verified before`, joinPlainText("Verified before", plainInline(getField(change, "Before"))))}><span>Verified before</span><p>${renderInline(getField(change, "Before"))}</p></div>
        <div class="delta-arrow" aria-hidden="true">&rarr;</div>
        <div class="delta after"${manifest.anchor(`${semantic}/field/proposed-after`, `${label} — Proposed after`, joinPlainText("Proposed after", plainInline(getField(change, "Proposed after"))))}><span>Proposed after</span><p>${renderInline(getField(change, "Proposed after"))}</p></div>
      </div>
      <div class="code-delta">${renderTechnicalBlock(blocks.get("before code"), "Before code", manifest, `${semantic}/block/before-code`, `${label} — Before code`)}${renderTechnicalBlock(blocks.get("proposed code"), "Proposed code", manifest, `${semantic}/block/proposed-code`, `${label} — Proposed code`)}</div>
      <div class="contract-impact"><div${manifest.anchor(`${semantic}/field/database-changes`, `${label} — Database changes`, joinPlainText("Database impact", databaseChanges))}><strong>Database impact</strong><p>${renderInline(databaseChanges)}</p></div><div${manifest.anchor(`${semantic}/field/api-changes`, `${label} — API changes`, joinPlainText("API impact", apiChanges))}><strong>API impact</strong><p>${renderInline(apiChanges)}</p></div><div${manifest.anchor(`${semantic}/field/flow-impact`, `${label} — Flow impact`, joinPlainText("Flow impact", flowImpact))}><strong>Flow impact</strong><p>${renderInline(flowImpact)}</p></div></div>
      <div class="expected-result">${renderTechnicalBlock(blocks.get("expected result"), "Expected result", manifest, `${semantic}/block/expected-result`, `${label} — Expected result`)}</div>
      ${databaseDetail}
      <p class="reason"><strong>Why</strong><span class="reason-copy">${renderInline(getField(change, "Reason"))}</span></p>
    </article>`;
  }).join("\n");

  const applicationFlowCards = applicationFlows.map((entry) => renderApplicationFlow(entry, phaseContext.current, manifest)).join("\n");
  const contextDescription = phaseContext.contextPhases.length > 0
    ? `Application flows labeled ${phaseContext.contextPhases.map(renderInline).join(", ")} are future context only and are not authorized by this plan.`
    : "Every application flow shown here is owned by the current executable phase.";

  const taskCards = tasks.map((task, index) => {
    const id = entryId(task);
    const label = `${id}: ${entryTitle(task)}`;
    return `<article class="task-card"${manifest.anchor(`plan/tasks/${id}`, label, entryPlainText(task, ["Requirements", "Evidence", "Depends on", "Files", "Change", "Verification", "Commit group"]))}>
    <div class="task-index">${String(index + 1).padStart(2, "0")}</div>
    <div class="task-body">
      <div class="task-title"><div><span>${renderInline(id)}</span><h3>${renderInline(entryTitle(task))}</h3></div><span class="commit-badge">${renderInline(getField(task, "Commit group"))}</span></div>
      <p class="task-change">${renderInline(getField(task, "Change"))}</p>
      <div class="task-meta"><div><small>Requirements</small>${renderChips(splitList(getField(task, "Requirements")))}</div><div><small>Depends on</small>${renderChips(splitList(getField(task, "Depends on")))}</div></div>
      <div class="file-strip"><small>Files</small>${renderChips(splitList(getField(task, "Files")), "chip file-chip")}</div>
      <div class="verification-box"><small>Observable verification</small>${renderChecks(getField(task, "Verification"))}</div>
      <div class="evidence-line"><small>Evidence</small>${renderChips(splitList(getField(task, "Evidence")))}</div>
    </div>
  </article>`;
  }).join("\n");

  const fileRows = files.map((file) => {
    const relatedTasks = tasks.filter((task) => splitList(getField(task, "Files")).includes(file));
    const relatedChanges = changes.filter((change) => getField(change, "File") === file);
    const groups = [...new Set(relatedTasks.map((task) => getField(task, "Commit group")))];
    const plainText = joinPlainText(
      file,
      `Changes\n${relatedChanges.map(entryId).join(", ") || "none"}`,
      `Tasks\n${relatedTasks.map(entryId).join(", ") || "none"}`,
      `Commit\n${groups.join(", ") || "none"}`,
    );
    return `<tr${manifest.anchor(`plan/files/file-${semanticKey(file)}`, `File: ${file}`, plainText)}><th><code>${renderInline(file)}</code></th><td>${renderChips(relatedChanges.map(entryId))}</td><td>${renderChips(relatedTasks.map(entryId), "chip task-chip")}</td><td>${renderChips(groups)}</td></tr>`;
  }).join("\n");

  const riskCards = risks.map((risk) => {
    const id = entryId(risk);
    const label = `${id}: ${entryTitle(risk)}`;
    return `<article class="risk-card"${manifest.anchor(`plan/risks/${id}`, label, entryPlainText(risk, ["Impact", "Mitigation", "Possible solution", "Evidence"]))}>
    <div class="risk-title"><span>${renderInline(id)}</span><h3>${renderInline(entryTitle(risk))}</h3></div>
    <dl><dt>Impact</dt><dd>${renderInline(getField(risk, "Impact"))}</dd><dt>Mitigation</dt><dd>${renderInline(getField(risk, "Mitigation"))}</dd><dt>Possible solution</dt><dd>${renderInline(getField(risk, "Possible solution"))}</dd><dt>Evidence</dt><dd>${renderChips(splitList(getField(risk, "Evidence")))}</dd></dl>
  </article>`;
  }).join("\n");

  const commitCards = commits.map((commit, index) => {
    const id = entryId(commit);
    const label = `${id}: ${entryTitle(commit)}`;
    return `<article class="commit-card"${manifest.anchor(`plan/commit-groups/${id}`, label, entryPlainText(commit, ["Files", "Message", "Depends on"]))}>
    <span class="commit-order">${index + 1}</span><div><p>${renderInline(id)}</p><h3><code>${renderInline(getField(commit, "Message"))}</code></h3>${renderChips(splitList(getField(commit, "Files")), "chip file-chip")}<small>Depends on: ${renderInline(getField(commit, "Depends on"))}</small></div>
  </article>`;
  }).join("\n");

  const manualCards = manualChecks.entries.map((check) => {
    const id = entryId(check);
    const label = `${id}: ${entryTitle(check)}`;
    return `<article class="manual-card"${manifest.anchor(`plan/manual-checks/${id}`, label, entryPlainText(check, ["Requirement", "Instructions", "Expected", "Status"]))}>
    <div class="manual-heading"><span>${renderInline(id)}</span><strong>${renderInline(entryTitle(check))}</strong><small class="manual-requirement">Requirement ${renderInline(getField(check, "Requirement"))}</small><em>${renderInline(getField(check, "Status"))}</em></div>
    <div class="manual-copy"><div><small>Instructions</small><p>${renderInline(getField(check, "Instructions"))}</p></div><div><small>Expected observation</small><p>${renderInline(getField(check, "Expected"))}</p></div></div>
  </article>`;
  }).join("\n");

  return `<header class="plan-hero">
    <div class="hero-inner">
      <div class="eyebrow">Phasecraft plan / execution cockpit</div>
      <h1>${escapeHtml(document.title?.text ?? "Phasecraft plan")}</h1>
      <div class="hero-copy"${manifest.anchor("plan/goal", "Goal", plainContent(goal.content))}>${renderContent(goal.content)}</div>
      <div class="phase-scope-banner" data-executable-phase="${escapeHtml(phaseContext.current ?? "unspecified")}"><div class="phase-scope-marker"><small>Current executable phase</small><strong>${phaseContext.current ? renderInline(phaseContext.current) : "Not declared"}</strong></div><div class="phase-scope-copy"><strong>This document authorizes ${phaseContext.current ? renderInline(phaseContext.current) : "one declared phase"} only.</strong><p>${contextDescription}</p></div></div>
      <div class="metric-row">
        ${metric("tasks", String(tasks.length), "ordered for execution")}
        ${metric("changes", String(changes.length), "before / after deltas")}
        ${metric("files", String(files.length), "approved impact surface")}
        ${metric("risks", String(risks.length), "with mitigations")}
      </div>
    </div>
  </header>
  <main class="plan-main" data-view="execution-cockpit">
    <section class="plan-section brief-section">
      <div class="section-heading"><span>00</span><div><p>Grounding</p><h2>Inputs and constraints</h2></div></div>
      <div class="brief-grid"><div${manifest.anchor("plan/inputs", "Inputs", plainContent(inputs.content))}><h3>Evidence inputs</h3>${renderContent(inputs.content)}</div><div><h3>Requirements</h3>${requirements.map((requirement) => `<p class="brief-requirement"${manifest.anchor(`plan/requirements/${requirement.id}`, `${requirement.id}: ${requirement.text}`, joinPlainText(requirement.id, plainInline(requirement.text)))}><span>${renderInline(requirement.id)}</span><span class="brief-requirement-copy">${renderInline(requirement.text)}</span></p>`).join("")}</div></div>
    </section>
    <section class="plan-section">
      <div class="section-heading"><span>01</span><div><p>Behavior delta</p><h2>Change blueprint</h2></div></div>
      <div class="change-stack">${changeCards}</div>
    </section>
    <section class="plan-section application-flow-section">
      <div class="section-heading"><span>02</span><div><p>User-facing behavior</p><h2>Application flow changes</h2></div></div>
      ${applicationFlows.length === 0 ? '<p class="single-note">No application flow diagram was recorded for this phase.</p>' : `<div class="application-flow-stack">${applicationFlowCards}</div>`}
    </section>
    <section class="plan-section">
      <div class="section-heading"><span>03</span><div><p>Coverage gate</p><h2>Requirement coverage</h2></div></div>
      <div class="table-shell"><table class="coverage-table"><thead><tr><th>Requirement</th><th>Tasks</th><th>Checks</th></tr></thead><tbody>${coverageRows}</tbody></table></div>
    </section>
    <section class="plan-section">
      <div class="section-heading"><span>04</span><div><p>Dependency-aware sequence</p><h2>Execution flow</h2></div></div>
      ${taskGraph || '<p class="single-note">Single task plan. A dependency diagram will appear when multiple tasks or dependencies exist.</p>'}
      <div class="task-stack">${taskCards}</div>
    </section>
    <section class="plan-section">
      <div class="section-heading"><span>05</span><div><p>Blast radius</p><h2>File impact map</h2></div></div>
      <div class="table-shell"><table class="file-table"><thead><tr><th>File</th><th>Changes</th><th>Tasks</th><th>Commit</th></tr></thead><tbody>${fileRows}</tbody></table></div>
    </section>
    <section class="plan-section split-section">
      <div><div class="section-heading compact"><span>06</span><div><p>Controls</p><h2>Risk register</h2></div></div><div class="risk-stack">${riskCards}</div></div>
      <div><div class="section-heading compact"><span>07</span><div><p>Delivery shape</p><h2>Commit groups</h2></div></div><div class="commit-stack">${commitCards}</div></div>
    </section>
    <section class="plan-section">
      <div class="section-heading"><span>08</span><div><p>Human evidence</p><h2>Manual checks</h2></div></div>
      ${sectionIsNone(manualChecks) ? `<p class="empty-state resolved"${manifest.anchor("plan/manual-checks", "Manual checks", plainContent(manualChecks.content))}>No manual checks required for this phase.</p>` : `<div class="manual-grid" data-layout="rows">${manualCards}</div>`}
    </section>
    <section class="plan-section reference-section">
      <div class="section-heading"><span>09</span><div><p>Traceability</p><h2>Evidence and decision reference</h2></div></div>
      ${renderReferenceIndex(validation, evidenceRegistry, "plan", manifest)}
    </section>
  </main>`;
}

const SHARED_STYLES = `
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
h1, h2, h3, p { margin-top: 0; }
code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; overflow-wrap: anywhere; }
.hero-inner, main, footer { width: min(1180px, calc(100% - 2rem)); margin-inline: auto; }
header { overflow: hidden; }
.hero-inner { padding-block: clamp(3rem, 8vw, 6.5rem) clamp(2.5rem, 6vw, 4.5rem); }
.eyebrow { margin-bottom: 1.25rem; font: 700 .72rem/1.2 "SFMono-Regular", Consolas, monospace; letter-spacing: .16em; text-transform: uppercase; }
h1 { max-width: 980px; margin-bottom: 1.25rem; font-size: clamp(2.45rem, 7vw, 5.8rem); line-height: .96; letter-spacing: -.055em; }
.hero-copy { max-width: 800px; font-size: clamp(1rem, 2vw, 1.28rem); line-height: 1.65; }
.hero-copy p:last-child { margin-bottom: 0; }
.metric-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-top: clamp(2rem, 5vw, 4rem); border-radius: 16px; overflow: hidden; }
.metric { display: flex; min-height: 116px; flex-direction: column; justify-content: flex-end; padding: 1.15rem; }
.metric strong { font-size: clamp(1.8rem, 4vw, 3rem); line-height: 1; }
.metric span { margin-top: .45rem; font-size: .72rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.metric small { margin-top: .45rem; opacity: .68; }
main { padding-block: 2rem 5rem; }
section { scroll-margin-top: 1rem; }
.section-heading { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
.section-heading > span { display: grid; width: 2.5rem; height: 2.5rem; place-items: center; border-radius: 999px; font: 800 .7rem/1 "SFMono-Regular", Consolas, monospace; }
.section-heading p { margin-bottom: .2rem; font-size: .68rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.section-heading h2 { margin: 0; font-size: clamp(1.55rem, 3vw, 2.4rem); letter-spacing: -.035em; }
.section-heading.compact { margin-bottom: 1rem; }
.chip-list { display: inline-flex; flex-wrap: wrap; gap: .35rem; }
.chip { display: inline-flex; align-items: center; padding: .27rem .5rem; border: 1px solid currentColor; border-radius: 999px; font: 700 .68rem/1.2 "SFMono-Regular", Consolas, monospace; opacity: .82; }
.identity { display: inline-flex; padding: .12em .34em; border-radius: .35em; font: 750 .86em/1.3 "SFMono-Regular", Consolas, monospace; text-decoration: none; white-space: nowrap; }
.identity-e, .identity-d { background: #dbeafe; color: #1e40af; }
.identity-p, .identity-ch { background: #ede9fe; color: #6d28d9; }
.identity-u, .identity-r { background: #ffedd5; color: #9a3412; }
.identity-phase, .identity-req, .identity-t, .identity-c, .identity-m { background: #e2e8f0; color: #334155; }
.muted { opacity: .6; }
.diagram-shell { overflow: hidden; border: 1px solid; border-radius: 18px; }
.diagram-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .9rem 1.1rem; border-bottom: 1px solid; }
.diagram-heading span { font-weight: 800; }
.diagram-heading small { opacity: .62; }
.diagram-scroll { overflow-x: auto; }
.dependency-graph { display: block; width: 100%; min-width: 680px; height: auto; }
.graph-edge { fill: none; stroke-width: 2.2; }
.graph-node rect { stroke-width: 1.4; }
.graph-id { font: 800 12px "SFMono-Regular", Consolas, monospace; }
.graph-title { font: 750 13px Inter, ui-sans-serif, system-ui, sans-serif; }
.graph-subtitle { font: 500 10px Inter, ui-sans-serif, system-ui, sans-serif; opacity: .68; }
.split-section { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(280px, .8fr); gap: 2rem; }
.single-note, .empty-state { padding: 1.2rem; border: 1px dashed; border-radius: 14px; line-height: 1.55; }
.reference-intro { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.reference-intro p { max-width: 760px; margin: 0; line-height: 1.55; }
.reference-intro > span { flex: 0 0 auto; padding: .38rem .58rem; border: 1px solid; border-radius: 999px; font: 750 .68rem/1 "SFMono-Regular", Consolas, monospace; }
.reference-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 290px), 1fr)); gap: .8rem; }
.reference-card { scroll-margin-top: 1rem; padding: 1rem; border: 1px solid; border-radius: 14px; }
.reference-card:target { outline: 3px solid; outline-offset: 3px; }
.reference-heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
.reference-heading em { font-size: .66rem; font-style: normal; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
.reference-card > p { min-height: 3.2rem; margin: .8rem 0; line-height: 1.5; }
.reference-card dl { display: grid; grid-template-columns: 55px 1fr; gap: .4rem .6rem; margin: 0; font-size: .72rem; }
.reference-card dt { font-weight: 800; text-transform: uppercase; }
.reference-card dd { margin: 0; overflow-wrap: anywhere; }
footer { padding-block: 1.25rem 2.5rem; font: 500 .72rem/1.5 "SFMono-Regular", Consolas, monospace; overflow-wrap: anywhere; opacity: .68; }
@media (max-width: 800px) {
  .metric-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .split-section { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .hero-inner, main, footer { width: min(100% - 1.25rem, 1180px); }
  .metric-row { grid-template-columns: 1fr 1fr; }
  .metric { min-height: 96px; padding: .85rem; }
  .diagram-heading { align-items: flex-start; flex-direction: column; }
  .reference-intro { align-items: flex-start; flex-direction: column; }
  .roadmap-scope-banner { grid-template-columns: 1fr; align-items: start; }
}
@media print {
  body { background: white !important; color: black !important; }
  header { background: white !important; color: black !important; }
  .metric, article, .diagram-shell, .table-shell { break-inside: avoid; box-shadow: none !important; }
  main { width: 100%; }
}
`.trim();

const ROADMAP_STYLES = `
body.roadmap { color: #dbeafe; background-color: #07111f; background-image: linear-gradient(rgba(96,165,250,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,.055) 1px, transparent 1px); background-size: 32px 32px; }
.roadmap-hero { color: #eff6ff; background: radial-gradient(circle at 82% 15%, rgba(34,211,238,.2), transparent 34%), linear-gradient(135deg, #0f1b35, #07111f 70%); border-bottom: 1px solid #203452; }
.roadmap-hero .eyebrow { color: #67e8f9; }
.roadmap-hero .hero-copy { color: #a9bed8; }
.roadmap-scope-banner { display: grid; grid-template-columns: auto 1fr; gap: 1rem; align-items: center; max-width: 820px; margin-top: 1.5rem; padding: 1rem; border: 1px solid #28516d; border-radius: 14px; background: rgba(8,47,73,.46); }
.roadmap-scope-banner > span { padding: .42rem .62rem; border-radius: 999px; color: #083344; background: #67e8f9; font: 850 .68rem/1 "SFMono-Regular", Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
.roadmap-scope-banner strong { display: block; color: #ecfeff; }
.roadmap-scope-banner p { margin: .3rem 0 0; color: #a5d8e8; line-height: 1.5; }
.roadmap-hero .metric-row { border: 1px solid #28415f; background: #28415f; }
.roadmap-hero .metric { background: rgba(7,17,31,.86); }
.roadmap-hero .metric strong { color: #67e8f9; }
.roadmap-section { padding-block: 2.4rem; border-bottom: 1px solid #203452; }
.roadmap-section .section-heading > span { color: #07111f; background: #67e8f9; }
.roadmap-section .section-heading p { color: #67e8f9; }
.roadmap .diagram-shell { border-color: #28415f; background: rgba(10,28,48,.78); }
.roadmap .diagram-heading { border-color: #28415f; color: #bfdbfe; }
.roadmap .graph-edge { stroke: #22d3ee; }
.roadmap marker path { fill: #22d3ee; }
.roadmap .graph-node rect { fill: #0e2239; stroke: #3b82f6; }
.roadmap .graph-id { fill: #67e8f9; }
.roadmap .graph-title { fill: #eff6ff; }
.roadmap .graph-subtitle { fill: #a9bed8; }
.phase-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 1rem; }
.phase-card { position: relative; min-height: 330px; padding: 1.2rem; overflow: hidden; border: 1px solid #28415f; border-radius: 16px; background: linear-gradient(145deg, rgba(16,40,66,.92), rgba(8,23,40,.95)); box-shadow: 0 24px 60px rgba(0,0,0,.18); }
.phase-card::after { position: absolute; inset: auto -20px -45px auto; width: 130px; height: 130px; border: 1px solid rgba(103,232,249,.16); border-radius: 999px; content: ""; }
.phase-card-top { display: flex; align-items: center; justify-content: space-between; }
.phase-number { color: #35587a; font: 800 2.2rem/1 "SFMono-Regular", Consolas, monospace; }
.status { padding: .32rem .55rem; border: 1px solid #3b82f6; border-radius: 999px; color: #bfdbfe; font-size: .68rem; font-weight: 800; text-transform: uppercase; }
.status-status-completed, .status-completed, .status-done { color: #a7f3d0; border-color: #10b981; }
.status-status-next, .status-next, .status-active { color: #fde68a; border-color: #f59e0b; }
.phase-id { margin: 1.35rem 0 .35rem; color: #67e8f9; font: 750 .75rem/1 "SFMono-Regular", Consolas, monospace; }
.phase-card h3 { margin-bottom: .75rem; color: #f8fafc; font-size: 1.25rem; }
.phase-goal { min-height: 4.5rem; color: #a9bed8; line-height: 1.55; }
.phase-card dl { display: grid; grid-template-columns: 88px 1fr; gap: .7rem; margin: 1.1rem 0 0; font-size: .78rem; }
.phase-card dt { color: #6f8cab; }
.phase-card dd { margin: 0; color: #c9d8e9; line-height: 1.45; }
.requirement-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: .8rem; }
.requirement-card { padding: 1rem; border-left: 3px solid #22d3ee; border-radius: 0 12px 12px 0; background: rgba(16,40,66,.72); }
.requirement-card > span { color: #67e8f9; }
.requirement-card p { margin: .65rem 0; color: #dbeafe; line-height: 1.5; }
.requirement-card small { color: #7894b2; }
.risk-stack { display: grid; gap: .8rem; }
.roadmap-risk { padding: 1rem; border: 1px solid #513f3f; border-radius: 14px; background: rgba(48,25,30,.5); }
.roadmap-risk > div { display: flex; align-items: baseline; gap: .55rem; }
.roadmap-risk h3 { margin: 0; font-size: 1rem; }
.roadmap-risk > div > span { color: #fdba74; }
.roadmap-risk p { display: grid; grid-template-columns: 110px 1fr; gap: .6rem; margin: .8rem 0 0; color: #d7c0c2; font-size: .8rem; line-height: 1.45; }
.roadmap-risk strong { color: #fb923c; font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; }
.roadmap-risk-copy { min-width: 0; }
.unknown-panel { padding: 1.2rem; border: 1px solid #5b4b29; border-radius: 14px; color: #fde68a; background: rgba(66,48,13,.4); line-height: 1.55; }
.roadmap .empty-state { border-color: #31506e; color: #8ca8c4; }
.roadmap .empty-state.resolved { color: #a7f3d0; border-color: #166534; }
.roadmap .reference-intro { color: #a9bed8; }
.roadmap .reference-card { border-color: #28415f; background: rgba(16,40,66,.72); }
.roadmap .reference-card:target { outline-color: #22d3ee; }
.roadmap .reference-heading em, .roadmap .reference-card dt { color: #67e8f9; }
.roadmap .reference-card > p { color: #dbeafe; }
.roadmap .reference-card dd { color: #8ca8c4; }
.roadmap footer { color: #7894b2; }
`.trim();

const PLAN_STYLES = `
body.plan { color: #1c1917; background: #f4efe5; }
.plan-hero { color: #fafaf9; background: radial-gradient(circle at 78% 14%, rgba(167,139,250,.32), transparent 34%), linear-gradient(135deg, #241b3d, #151322 72%); }
.plan-hero .eyebrow { color: #c4b5fd; }
.plan-hero .hero-copy { color: #d6d3e4; }
.phase-scope-banner { display: grid; grid-template-columns: minmax(170px, auto) 1fr; gap: 1rem; align-items: stretch; max-width: 920px; margin-top: 1.5rem; overflow: hidden; border: 1px solid #6d5a91; border-radius: 16px; background: rgba(15,23,42,.58); }
.phase-scope-marker { display: flex; justify-content: center; flex-direction: column; padding: 1rem; background: linear-gradient(135deg, #6d28d9, #4338ca); }
.phase-scope-marker small { margin-bottom: .45rem; color: #ddd6fe; font: 800 .62rem/1.2 "SFMono-Regular", Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; }
.phase-scope-marker > strong { color: #fff; font-size: 1.4rem; }
.phase-scope-marker .identity { padding: 0; color: inherit; background: transparent; font-size: inherit; }
.phase-scope-copy { min-width: 0; padding: 1rem; }
.phase-scope-copy > strong { display: block; color: #f5f3ff; font-size: 1rem; }
.phase-scope-copy p { margin: .45rem 0 0; color: #d6d3e4; line-height: 1.55; }
.plan-hero .metric-row { border: 1px solid #51456c; background: #51456c; }
.plan-hero .metric { background: rgba(21,19,34,.88); }
.plan-hero .metric strong { color: #ddd6fe; }
.plan-section { padding-block: 2.4rem; border-bottom: 1px solid #d8cebd; }
.plan-section .section-heading > span { color: #fff; background: #6d28d9; }
.plan-section .section-heading p { color: #7c3aed; }
.brief-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.brief-grid > div { padding: 1.15rem; border: 1px solid #d8cebd; border-radius: 14px; background: #fffdf8; }
.brief-grid h3 { margin-bottom: .9rem; color: #6d28d9; font-size: .75rem; letter-spacing: .12em; text-transform: uppercase; }
.brief-grid ul { padding-left: 1.1rem; }
.brief-grid li, .brief-grid p { line-height: 1.55; }
.brief-requirement { display: grid; grid-template-columns: auto 1fr; gap: .55rem; }
.brief-requirement-copy { min-width: 0; }
.change-stack, .task-stack, .risk-stack, .commit-stack { display: grid; gap: 1rem; }
.change-card { padding: 1.2rem; border: 1px solid #cfc3b2; border-radius: 16px; background: #fffdf8; box-shadow: 0 12px 36px rgba(66,48,28,.06); }
.change-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.change-heading > div:first-child > span { color: #7c3aed; }
.change-heading h3 { margin: .25rem 0 0; font-size: 1.15rem; }
.change-heading em { display: inline-flex; margin-top: .55rem; padding: .3rem .48rem; border-radius: 999px; color: #6d28d9; background: #ede9fe; font-size: .66rem; font-style: normal; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.target { display: flex; align-items: flex-end; flex-direction: column; gap: .35rem; text-align: right; }
.target code { padding: .35rem .5rem; border-radius: 6px; color: #4338ca; background: #eef2ff; }
.target small { color: #78716c; }
.delta-lane { display: grid; grid-template-columns: 1fr 36px 1fr; align-items: stretch; gap: .65rem; margin-top: 1rem; }
.delta { padding: 1rem; border-radius: 12px; }
.delta span { display: block; margin-bottom: .55rem; font-size: .68rem; font-weight: 850; letter-spacing: .1em; text-transform: uppercase; }
.delta p { margin: 0; line-height: 1.55; }
.delta.before { border: 1px solid #d6d3d1; background: #f5f5f4; }
.delta.before span { color: #57534e; }
.delta.after { border: 1px solid #c4b5fd; background: #f5f3ff; }
.delta.after span { color: #6d28d9; }
.delta-arrow { display: grid; place-items: center; color: #7c3aed; font-size: 1.5rem; }
.code-delta { display: grid; grid-template-columns: 1fr 1fr; gap: .65rem; margin-top: .8rem; }
.code-panel { min-width: 0; overflow: hidden; border: 1px solid #292524; border-radius: 12px; background: #1c1917; }
.code-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .65rem .8rem; color: #e7e5e4; border-bottom: 1px solid #44403c; }
.code-panel-heading strong { font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; }
.code-panel-heading span { color: #a8a29e; font: 700 .64rem/1 "SFMono-Regular", Consolas, monospace; }
.code-panel pre { max-height: 320px; margin: 0; padding: .9rem; overflow: auto; color: #e7e5e4; font-size: .75rem; line-height: 1.55; tab-size: 2; white-space: pre; }
.syntax-comment { color: #8b9a88; font-style: italic; }
.syntax-keyword { color: #c4b5fd; font-weight: 700; }
.syntax-string { color: #86efac; }
.syntax-number { color: #fdba74; }
.syntax-literal { color: #f9a8d4; font-weight: 700; }
.syntax-function { color: #93c5fd; }
.syntax-property { color: #67e8f9; }
.syntax-variable { color: #fde68a; }
.missing-detail { display: flex; min-height: 118px; align-items: center; justify-content: center; flex-direction: column; gap: .35rem; padding: 1rem; border: 1px dashed #c4b5fd; border-radius: 12px; color: #7c3aed; background: #faf5ff; text-align: center; }
.missing-detail strong { font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; }
.missing-detail span { color: #78716c; font-size: .75rem; }
.contract-impact { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .65rem; margin-top: .8rem; }
.contract-impact > div { padding: .8rem; border: 1px solid #d8cebd; border-radius: 10px; background: #f8f3ea; }
.contract-impact strong, .database-detail > div:first-child > strong { display: block; margin-bottom: .4rem; color: #7c3aed; font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; }
.contract-impact p, .database-detail p { margin: 0; color: #57534e; line-height: 1.5; }
.expected-result { margin-top: .8rem; }
.expected-result .code-panel { border-color: #14532d; background: #052e16; }
.expected-result .code-panel-heading { color: #dcfce7; border-color: #166534; }
.expected-result .code-panel-heading span { color: #86efac; }
.expected-result .code-panel pre { max-height: 420px; }
.database-detail { display: grid; grid-template-columns: minmax(180px, .65fr) 1fr 1fr; gap: .65rem; margin-top: .8rem; padding: .8rem; border: 1px solid #a5b4fc; border-radius: 12px; background: #eef2ff; }
.application-flow-stack { display: grid; gap: 1rem; }
.application-flow-card { overflow: hidden; border: 1px solid #a5b4fc; border-radius: 16px; background: #fffdf8; box-shadow: 0 12px 36px rgba(76,29,149,.07); }
.application-flow-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 1rem; color: #fff; background: linear-gradient(135deg, #312e81, #5b21b6); }
.application-flow-header > div > span { color: #ddd6fe; }
.application-flow-header h3 { margin: .3rem 0 0; font-size: 1.2rem; }
.flow-phase { display: inline-flex; flex: 0 0 auto; align-items: center; gap: .3rem; padding: .35rem .5rem; border: 1px solid; border-radius: 999px; font-size: .68rem; font-style: normal; font-weight: 800; }
.flow-phase .identity { padding: 0; color: inherit; background: transparent; font-size: inherit; }
.flow-phase-current { color: #dcfce7; border-color: #4ade80; background: rgba(20,83,45,.45); }
.flow-phase-future { color: #fef3c7; border-color: #fbbf24; background: rgba(120,53,15,.48); }
.application-flow-future { border-color: #f59e0b; }
.application-flow-meta, .application-flow-delta { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; border-bottom: 1px solid #ddd6fe; background: #ddd6fe; }
.application-flow-meta > div, .application-flow-delta > div { padding: .85rem 1rem; background: #faf5ff; }
.application-flow-meta small, .application-flow-delta small, .application-flow-evidence > small { display: block; margin-bottom: .38rem; color: #7c3aed; font-size: .65rem; font-weight: 850; letter-spacing: .09em; text-transform: uppercase; }
.application-flow-meta strong, .application-flow-meta code { color: #292524; }
.application-flow-delta p { margin: 0; color: #44403c; line-height: 1.5; }
.application-flow-delta > div:last-child { background: #f0fdf4; }
.mermaid-shell { padding: 1rem; overflow-x: auto; background: #fff; }
.mermaid-shell .mermaid { min-width: 760px; margin: 0; color: #44403c; background: #fff; font: 600 .76rem/1.5 "SFMono-Regular", Consolas, monospace; white-space: pre; }
.mermaid-shell svg { display: block; max-width: none !important; height: auto; margin-inline: auto; }
.change-point-shell { padding: 1rem; border-top: 1px solid #ddd6fe; background: #faf5ff; }
.change-point-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .75rem; }
.change-point-heading strong { color: #5b21b6; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; }
.change-point-heading span { color: #78716c; font: 700 .68rem/1 "SFMono-Regular", Consolas, monospace; }
.change-point-table tbody th { width: 88px; }
.change-point-table td:nth-child(2) { width: 76px; }
.change-point-table td:nth-child(3) { min-width: 260px; }
.change-point-table td:nth-child(3) code, .change-point-table td:nth-child(3) small { display: block; }
.change-point-table td:nth-child(3) small { margin-top: .35rem; color: #78716c; }
.application-flow-evidence { padding: .85rem 1rem; border-top: 1px solid #e7ded0; background: #f8f3ea; }
.reason { display: grid; grid-template-columns: 42px 1fr; gap: .6rem; margin: 1rem 0 0; color: #57534e; line-height: 1.5; }
.reason strong { color: #7c3aed; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; }
.reason-copy { min-width: 0; }
.table-shell { overflow-x: auto; border: 1px solid #cfc3b2; border-radius: 14px; background: #fffdf8; }
table { width: 100%; border-collapse: collapse; font-size: .82rem; }
th, td { padding: .85rem; border-bottom: 1px solid #e7ded0; text-align: left; vertical-align: top; }
thead th { color: #78716c; background: #f8f3ea; font-size: .67rem; letter-spacing: .1em; text-transform: uppercase; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
.coverage-table tbody th { min-width: 280px; }
.coverage-table tbody th span, .coverage-table tbody th small { display: block; }
.coverage-table tbody th small { margin-top: .4rem; color: #57534e; font-weight: 500; line-height: 1.45; }
.coverage-table td:last-child strong, .coverage-table td:last-child span { display: block; }
.coverage-table td:last-child strong { color: #6d28d9; font-size: 1.2rem; }
.coverage-table td:last-child span { color: #78716c; font-size: .7rem; }
.plan .diagram-shell { margin-bottom: 1rem; border-color: #cfc3b2; background: #fffdf8; }
.plan .diagram-heading { border-color: #e7ded0; }
.plan .graph-edge { stroke: #7c3aed; }
.plan marker path { fill: #7c3aed; }
.plan .graph-node rect { fill: #f5f3ff; stroke: #8b5cf6; }
.plan .graph-id { fill: #6d28d9; }
.plan .graph-title { fill: #292524; }
.plan .graph-subtitle { fill: #78716c; }
.task-card { display: grid; grid-template-columns: 64px 1fr; overflow: hidden; border: 1px solid #cfc3b2; border-radius: 16px; background: #fffdf8; }
.task-index { padding: 1.15rem .75rem; color: #a78bfa; background: #241b3d; font: 800 1.4rem/1 "SFMono-Regular", Consolas, monospace; }
.task-body { padding: 1.15rem; }
.task-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.task-title > div > span { color: #7c3aed; }
.task-title h3 { margin: .25rem 0 0; font-size: 1.15rem; }
.commit-badge { padding: .35rem .5rem; border-radius: 6px; color: #fff; background: #6d28d9; font: 750 .68rem/1 "SFMono-Regular", Consolas, monospace; }
.task-change { margin: 1rem 0; color: #44403c; line-height: 1.55; }
.task-meta { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
.task-meta > div, .file-strip, .verification-box, .evidence-line { padding: .75rem; border-radius: 10px; background: #f8f3ea; }
.task-meta small, .file-strip > small, .verification-box > small, .evidence-line > small { display: block; margin-bottom: .5rem; color: #78716c; font-size: .65rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.file-strip, .verification-box, .evidence-line { margin-top: .75rem; }
.file-chip { color: #4338ca; background: #eef2ff; }
.task-chip { color: #6d28d9; background: #f5f3ff; }
.check-list { display: grid; gap: .45rem; margin: 0; padding: 0; list-style: none; }
.check-list li { position: relative; padding-left: 1.35rem; line-height: 1.45; }
.check-list li::before { position: absolute; left: 0; color: #16a34a; content: "\\2713"; font-weight: 900; }
.file-table tbody th { min-width: 280px; }
.risk-card { padding: 1rem; border: 1px solid #fed7aa; border-radius: 14px; background: #fff7ed; }
.risk-title { display: flex; align-items: baseline; gap: .55rem; }
.risk-title > span { color: #c2410c; }
.risk-title h3 { margin: 0; font-size: 1rem; }
.risk-card dl { display: grid; grid-template-columns: 110px 1fr; gap: .65rem; margin: 1rem 0 0; font-size: .8rem; }
.risk-card dt { color: #c2410c; font-weight: 800; }
.risk-card dd { margin: 0; line-height: 1.45; }
.commit-card { display: grid; grid-template-columns: 40px 1fr; gap: .75rem; padding: 1rem; border: 1px solid #d8cebd; border-radius: 14px; background: #fffdf8; }
.commit-order { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 999px; color: #fff; background: #1c1917; font-weight: 850; }
.commit-card p { margin: 0; color: #7c3aed; }
.commit-card h3 { margin: .35rem 0 .7rem; font-size: .88rem; }
.commit-card small { display: block; margin-top: .7rem; color: #78716c; }
.manual-grid { display: grid; grid-template-columns: 1fr; gap: .8rem; }
.manual-card { display: grid; grid-template-columns: minmax(210px, .32fr) 1fr; gap: 1rem; padding: 1rem; border: 1px solid #bae6fd; border-radius: 14px; background: #f0f9ff; }
.manual-heading { display: grid; align-content: start; grid-template-columns: auto 1fr; gap: .5rem; }
.manual-heading > span { color: #0369a1; }
.manual-heading strong { line-height: 1.4; }
.manual-requirement { grid-column: 1 / -1; color: #57534e; }
.manual-heading em { grid-column: 1 / -1; justify-self: start; padding: .3rem .45rem; border-radius: 999px; color: #0369a1; background: #e0f2fe; font-size: .68rem; font-style: normal; }
.manual-copy { display: grid; gap: .75rem; }
.manual-copy > div { padding: .75rem; border-radius: 10px; background: rgba(255,255,255,.68); }
.manual-copy small { display: block; margin-bottom: .35rem; color: #0369a1; font-size: .65rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.manual-copy p { margin: 0; color: #44403c; line-height: 1.55; }
.plan .single-note, .plan .empty-state { color: #78716c; border-color: #cfc3b2; background: #fffdf8; }
.plan .empty-state.resolved { color: #166534; border-color: #86efac; background: #f0fdf4; }
.plan .reference-intro { color: #57534e; }
.plan .reference-card { border-color: #d8cebd; background: #fffdf8; }
.plan .reference-card:target { outline-color: #8b5cf6; }
.plan .reference-heading em, .plan .reference-card dt { color: #7c3aed; }
.plan .reference-card dd { color: #78716c; }
.plan footer { color: #78716c; }
@media (max-width: 720px) {
  .brief-grid, .task-meta { grid-template-columns: 1fr; }
  .phase-scope-banner { grid-template-columns: 1fr; }
  .delta-lane { grid-template-columns: 1fr; }
  .delta-arrow { transform: rotate(90deg); }
  .code-delta, .contract-impact, .database-detail { grid-template-columns: 1fr; }
  .application-flow-header { flex-direction: column; }
  .application-flow-meta, .application-flow-delta { grid-template-columns: 1fr; }
  .manual-card { grid-template-columns: 1fr; }
  .change-heading, .task-title { align-items: flex-start; flex-direction: column; }
  .target { align-items: flex-start; text-align: left; }
  .task-card { grid-template-columns: 46px 1fr; }
}
`.trim();

function stylesFor(kind) {
  return `${SHARED_STYLES}\n${kind === "roadmap" ? ROADMAP_STYLES : PLAN_STYLES}`;
}

export function renderArtifact(kind, source, options = {}) {
  const validation = kind === "plan"
    ? validatePlan(source, { evidenceRegistry: options.evidenceRegistry })
    : kind === "roadmap"
      ? validateRoadmap(source, { evidenceRegistry: options.evidenceRegistry })
      : null;
  if (!validation) {
    const error = new Error(`Unknown render kind: ${kind}`);
    error.code = "ARTIFACT_KIND_UNKNOWN";
    throw error;
  }
  if (!validation.valid) {
    const error = new Error(`Cannot render invalid ${kind}: ${validation.errors[0]?.message ?? "unknown error"}`);
    error.code = "ARTIFACT_INVALID";
    error.validation = validation;
    throw error;
  }

  const title = validation.document.title?.text ?? `Phasecraft ${kind}`;
  const phaseContext = kind === "plan" ? planPhaseContext(validation.document, options.phase) : null;
  const artifactScope = kind === "roadmap" ? "all-phases" : "single-phase";
  const browserTitle = kind === "roadmap"
    ? `All Phases · ${title} · Phasecraft Roadmap`
    : planBrowserTitle(title, phaseContext.current);
  const reviewManifest = new ReviewManifestBuilder();
  const body = kind === "roadmap"
    ? renderRoadmap(validation, options.evidenceRegistry, reviewManifest)
    : renderPlan(validation, options.evidenceRegistry, { phase: phaseContext.current }, reviewManifest);
  const reviewManifestScript = `<script type="application/json" id="phasecraft-review-manifest">${escapeJsonForHtml(reviewManifest.toJSON(body))}</script>`;
  const hasMermaid = kind === "plan"
    && (validation.document.sections.get("Application Flows")?.entries.length ?? 0) > 0;
  const mermaidRuntime = hasMermaid ? `<script data-phasecraft-renderer="mermaid" src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script data-phasecraft-renderer="mermaid-init">
if (window.mermaid) {
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    deterministicIds: true,
    deterministicIDSeed: "${validation.sourceHash}",
    flowchart: { curve: "basis", htmlLabels: false, useMaxWidth: false },
    themeVariables: {
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      primaryColor: "#ede9fe",
      primaryTextColor: "#292524",
      primaryBorderColor: "#7c3aed",
      lineColor: "#6d28d9",
      secondaryColor: "#f0fdf4",
      tertiaryColor: "#fff7ed"
    }
  });
  window.mermaid.run({ querySelector: ".mermaid" });
}
</script>` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="phasecraft-source-sha256" content="${validation.sourceHash}">
<meta name="phasecraft-schema-version" content="${ARTIFACT_SCHEMA_VERSION}">
<meta name="phasecraft-view" content="${kind === "roadmap" ? "roadmap-atlas" : "execution-cockpit"}">
<meta name="phasecraft-artifact-scope" content="${artifactScope}">
${phaseContext?.current ? `<meta name="phasecraft-executable-phase" content="${escapeHtml(phaseContext.current)}">` : ""}
<title>${escapeHtml(browserTitle)}</title>
<style>${stylesFor(kind)}</style>
</head>
<body class="${kind}" data-artifact-scope="${artifactScope}"${phaseContext?.current ? ` data-executable-phase="${escapeHtml(phaseContext.current)}"` : ""}>
${body}
<footer>Authoritative source: Markdown / schema v${ARTIFACT_SCHEMA_VERSION} / scope ${artifactScope}${phaseContext?.current ? ` / executable phase ${escapeHtml(phaseContext.current)}` : ""} / SHA-256 ${validation.sourceHash}</footer>
${reviewManifestScript}
${mermaidRuntime}
</body>
</html>
`;
  return { html, validation };
}

export async function renderArtifactFile(kind, sourcePath, outputPath, options = {}) {
  const source = await readFile(sourcePath, "utf8");
  let evidenceRegistry;
  if (options.evidenceFile) evidenceRegistry = JSON.parse(await readFile(options.evidenceFile, "utf8"));
  const result = renderArtifact(kind, source, {
    evidenceRegistry,
    phase: options.phase ?? (kind === "plan" ? phaseFromPath(sourcePath) : null),
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, result.html, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporary, outputPath);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    throw cause;
  }
  return {
    kind,
    sourcePath,
    outputPath,
    sourceHash: result.validation.sourceHash,
    warnings: result.validation.warnings,
  };
}
