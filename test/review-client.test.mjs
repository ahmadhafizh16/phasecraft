import assert from "node:assert/strict";
import { runInNewContext, Script } from "node:vm";
import test from "node:test";
import { reviewClientJs } from "../runtime/review-ui.mjs";

function clientFunction(name, next, context = {}) {
  const source = reviewClientJs();
  new Script(source);
  return runInNewContext(`(${source.slice(source.indexOf(`function ${name}(`), source.indexOf(next)).trim()})`, context);
}

test("generated review client preserves selection text and normalizes whitespace without corrupting letters", () => {
  const projection = clientFunction("projection", "function selectionChanged(", { state: { projections: new Map() } });
  const anchor = {
    dataset: { phasecraftAnchor: "plan/goal" },
    cloneNode: () => ({ innerText: "  Session\t success\n checks  ", querySelectorAll: () => [] }),
  };
  assert.equal(projection(anchor), "Session success checks");
});

test("generated Markdown preview formats code while escaping hostile feedback", () => {
  const render = clientFunction("safeMarkdown", "async function saveDraft(");
  assert.match(render("**review**\n\n`session`"), /<strong>review<\/strong>[\s\S]*<code>session<\/code>/u);
  assert.equal(render('<img src=x onerror="alert(1)">'), "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
});
