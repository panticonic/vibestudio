#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevelopmentTemplateSet } from "../src/dev/developmentTemplateSet.js";
import { selectDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function optionValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) return argv[index + 1];
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

const sourceOnly = process.argv.includes("--source-only");
const checkpointRoot = optionValue("--checkpoint-root");
const explicitRoot = optionValue("--root");
if (sourceOnly) {
  const selected = selectDevelopmentTemplateCheckouts(repoRoot, {
    ...(explicitRoot ? { explicitRoot } : {}),
  });
  process.stdout.write(`${JSON.stringify(selected ?? null)}\n`);
} else {
  if (!checkpointRoot) throw new Error("--checkpoint-root is required");
  const selection = await resolveDevelopmentTemplateSet({
    repoRoot,
    checkpointRoot,
    ...(explicitRoot ? { explicitRoot } : {}),
    productionTemplates: process.argv.includes("--production-templates"),
  });
  process.stdout.write(`${JSON.stringify(selection)}\n`);
}
