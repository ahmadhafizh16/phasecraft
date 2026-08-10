import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_SCHEMA_VERSION, validatePlan, validateRoadmap } from "./artifacts.mjs";

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(value) {
  const escaped = escapeHtml(value);
  return escaped.replace(/`([^`]+)`/gu, "<code>$1</code>");
}

function renderContent(content) {
  const output = [];
  let listOpen = false;
  for (const { text } of content) {
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

function categoryClass(heading) {
  const prefix = heading.split("-")[0].toLowerCase();
  return ["t", "ch", "r", "c", "m", "p"].includes(prefix) ? `card-${prefix}` : "card-default";
}

function renderDocument(document) {
  const sections = [];
  for (const section of document.sections.values()) {
    const body = [];
    const content = renderContent(section.content);
    if (content) body.push(`<div class="section-copy">${content}</div>`);
    if (section.entries.length > 0) {
      body.push('<div class="card-grid">');
      for (const entry of section.entries) {
        body.push(`<article class="card ${categoryClass(entry.heading)}">`);
        body.push(`<h3>${renderInline(entry.heading)}</h3>`);
        if (entry.fields.size > 0) {
          body.push("<dl>");
          for (const [name, field] of entry.fields) {
            body.push(`<dt>${escapeHtml(name)}</dt><dd>${renderInline(field.value)}</dd>`);
          }
          body.push("</dl>");
        }
        const entryContent = renderContent(entry.content);
        if (entryContent) body.push(`<div class="entry-copy">${entryContent}</div>`);
        body.push("</article>");
      }
      body.push("</div>");
    }
    sections.push(`<section id="${escapeHtml(section.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-"))}">
<h2>${escapeHtml(section.name)}</h2>
${body.join("\n")}
</section>`);
  }
  return sections.join("\n");
}

const STYLES = `
:root {
  color-scheme: light;
  --ink: #18201d;
  --muted: #65716b;
  --paper: #f4f1e8;
  --panel: #fffdf7;
  --line: #d9d2c2;
  --green: #146b52;
  --orange: #b95124;
  --blue: #285f8f;
  --violet: #6d4c87;
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: var(--paper); }
header { padding: 3.5rem max(1.25rem, calc((100vw - 1120px) / 2)); background: var(--ink); color: var(--paper); }
.eyebrow { color: #9ec8b8; font-size: .75rem; letter-spacing: .16em; text-transform: uppercase; }
h1 { max-width: 900px; margin: .6rem 0 1rem; font-family: Georgia, serif; font-size: clamp(2.2rem, 6vw, 4.8rem); line-height: .98; font-weight: 500; }
.meta { display: flex; flex-wrap: wrap; gap: .65rem; color: #c8d0cc; font-size: .78rem; }
.meta span { border: 1px solid #4f5b56; border-radius: 999px; padding: .35rem .65rem; }
main { width: min(1120px, calc(100% - 2rem)); margin: 0 auto; padding: 2.5rem 0 5rem; }
section { padding: 1.8rem 0 2.4rem; border-bottom: 1px solid var(--line); }
h2 { margin: 0 0 1.2rem; font-family: Georgia, serif; font-size: clamp(1.7rem, 3vw, 2.5rem); font-weight: 500; }
.section-copy { max-width: 850px; line-height: 1.65; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 1rem; }
.card { position: relative; overflow: hidden; padding: 1.1rem; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: 0 8px 24px rgb(38 36 30 / 5%); }
.card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--green); }
.card-r::before { background: var(--orange); }
.card-ch::before, .card-p::before { background: var(--blue); }
.card-c::before, .card-m::before { background: var(--violet); }
.card h3 { margin: 0 0 .9rem; padding-left: .35rem; font-size: 1rem; }
dl { display: grid; grid-template-columns: minmax(90px, .35fr) 1fr; gap: .55rem .75rem; margin: 0; font-size: .84rem; line-height: 1.45; }
dt { color: var(--muted); text-transform: capitalize; }
dd { margin: 0; overflow-wrap: anywhere; }
code { padding: .1em .3em; border-radius: 4px; background: #e8e3d6; color: #7b341a; }
footer { width: min(1120px, calc(100% - 2rem)); margin: 0 auto; padding: 1.2rem 0 2.5rem; color: var(--muted); font-size: .75rem; overflow-wrap: anywhere; }
@media (max-width: 620px) {
  header { padding-top: 2.4rem; padding-bottom: 2.4rem; }
  main { padding-top: 1.3rem; }
  dl { grid-template-columns: 1fr; gap: .15rem; }
  dd { margin-bottom: .6rem; }
}
@media print {
  body { background: white; }
  header { background: white; color: black; padding-top: 1rem; }
  .eyebrow, .meta { color: #444; }
  .card { break-inside: avoid; box-shadow: none; }
}
`.trim();

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

  const title = validation.document.title?.text ?? "Phasecraft artifact";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="phasecraft-source-sha256" content="${validation.sourceHash}">
<meta name="phasecraft-schema-version" content="${ARTIFACT_SCHEMA_VERSION}">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
<div class="eyebrow">Phasecraft ${escapeHtml(kind)} / schema v${ARTIFACT_SCHEMA_VERSION}</div>
<h1>${escapeHtml(title)}</h1>
<div class="meta"><span>source ${validation.sourceHash}</span><span>${validation.references.length} evidence references</span><span>${validation.warnings.length} audit warnings</span></div>
</header>
<main>
${renderDocument(validation.document)}
</main>
<footer>Generated deterministically from authoritative Markdown. Source SHA-256: ${validation.sourceHash}</footer>
</body>
</html>
`;
  return { html, validation };
}

export async function renderArtifactFile(kind, sourcePath, outputPath, options = {}) {
  const source = await readFile(sourcePath, "utf8");
  let evidenceRegistry;
  if (options.evidenceFile) evidenceRegistry = JSON.parse(await readFile(options.evidenceFile, "utf8"));
  const result = renderArtifact(kind, source, { evidenceRegistry });
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
