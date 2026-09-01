#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installerHelp, restartMessage, runInstaller } from "./install.mjs";
import { run as runRuntime } from "../runtime/phasecraft.mjs";

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv) {
  const [command = "help", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(installerHelp());
    return;
  }
  if (["install", "check", "uninstall"].includes(command)) {
    const result = await runInstaller([command, ...rest]);
    if (result.action === "help") {
      process.stdout.write(result.help);
      return;
    }
    output(result);
    if (command === "check" && !result.healthy) process.exitCode = 1;
    const message = restartMessage(result);
    if (message) process.stdout.write(`${message}\n`);
    return;
  }
  const runtimeArgs = command === "runtime" ? rest : argv;
  output(await runRuntime(runtimeArgs));
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: cause.message,
      code: cause.code ?? "UNEXPECTED_ERROR",
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export { main };
