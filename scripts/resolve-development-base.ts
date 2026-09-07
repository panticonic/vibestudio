#!/usr/bin/env node
/**
 * Print the development Base selection as JSON for plain-JS callers.
 *
 * Resolving a Base worktree into an exact pin is asynchronous and Git-bound and
 * lives in TypeScript with the rest of the dev-loop code. Scripts that cannot
 * import it (the mobile smoke is plain `.mjs` run by bare node) shell out here
 * rather than growing a second, drifting resolver.
 *
 * Emits `null` when no development Base is selected, meaning the caller should
 * let the workspace runtime use the canonical pinned release.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevelopmentBaseSelection } from "../src/dev/developmentBaseSelection.js";
import { selectDevelopmentBaseCheckout } from "../src/dev/developmentBaseConfig.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function optionValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === name) return argv[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

const sourceOnly = process.argv.includes("--source-only");
const checkpointTarget = optionValue("--checkpoint-target");
if (!sourceOnly && !checkpointTarget) {
  throw new Error("--checkpoint-target is required: a dirty Base worktree needs a private clone");
}

const explicitCheckout = optionValue("--checkout");
if (sourceOnly) {
  const selected = selectDevelopmentBaseCheckout(repoRoot, {
    ...(explicitCheckout ? { explicitCheckout } : {}),
    productionBase: false,
  });
  process.stdout.write(
    `${JSON.stringify(selected ? fs.realpathSync(path.resolve(selected)) : null)}\n`
  );
} else {
  if (!checkpointTarget) {
    throw new Error("--checkpoint-target is required: a dirty Base worktree needs a private clone");
  }
  const selection = await resolveDevelopmentBaseSelection({
    repoRoot,
    checkpointTarget,
    ...(explicitCheckout ? { explicitCheckout } : {}),
    productionBase: process.argv.includes("--production-base"),
  });
  process.stdout.write(`${JSON.stringify(selection)}\n`);
}
