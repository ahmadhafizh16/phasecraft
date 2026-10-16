import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { reviewClientJs } from "../runtime/review-ui.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const directory of ["runtime", "bin"]) {
  for (const file of (await readdir(path.join(root, directory))).filter((name) => name.endsWith(".mjs")).sort()) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, directory, file)], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
const pi = await readFile(path.join(root, "pi", "phasecraft.ts"), "utf8");
const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: pi, stdio: ["pipe", "inherit", "inherit"] });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
new Script(reviewClientJs(), { filename: "phasecraft-review-client.js" });
process.stdout.write("All runtime, installer, Pi, and generated browser scripts passed syntax checks.\n");
