import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { evidenceRegistry, validPlan } from "./artifacts.mjs";
import { sha256 } from "../runtime/artifacts.mjs";
import { renderArtifactFile } from "../runtime/render.mjs";

export const passingChecks = [{ name: "positive and boundary behavior", passed: true }];

export async function writePlan(state, options = {}) {
  const phase = state.activePhase ?? "P-01";
  const directory = path.join(state.artifactRoot, "plan", "phases", `${phase}-fixture`);
  const source = options.source ?? validPlan.replaceAll("src/session.mjs", options.file ?? "feature.txt")
    .replaceAll(", test/session.test.mjs", "").replaceAll("P-01", phase);
  const evidencePath = path.join(state.artifactRoot, "research", "EVIDENCE.json");
  await mkdir(directory, { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidenceRegistry));
  await writeFile(path.join(directory, "PLAN.md"), source);
  await renderArtifactFile("plan", path.join(directory, "PLAN.md"), path.join(directory, "plan.html"), { evidenceFile: evidencePath });
  const verification = options.verification ?? `# ${phase} Plan Verification

**Outcome:** APPROVED
**Plan SHA-256:** ${sha256(source)}

## Integrity Gate
- Status: passed
- Checks: Structural validation and source binding passed.

## Findings
None.

## Human Q&A
None.

## Execution Gate
- Status: approved
- Reason: All checks passed.
`;
  await writeFile(path.join(directory, "PLAN-VERIFICATION.md"), verification);
  return { directory, source, verification };
}
