#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { validateQualityInputs } from "./release-ci-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const config = require(path.join(root, "src/dev/developmentTemplateConfig.cjs"));

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
}

export function pinTemplateInputs({ sourceSha, manifestPath, templateRoot }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const templates = validateQualityInputs(manifest, sourceSha);
  const selection = config.selectDevelopmentTemplateCheckouts(root, { explicitRoot: templateRoot });
  if (!selection) throw new Error("CI template checkouts are unavailable");
  const expectedIds = selection.sources.map(({ id }) => id).sort();
  if (JSON.stringify(Object.keys(templates).sort()) !== JSON.stringify(expectedIds)) {
    throw new Error("CI template input manifest does not match the complete official registry");
  }
  for (const { id } of selection.sources) {
    const checkout = selection.checkouts[id];
    const expected = templates[id];
    if (config.developmentTemplateHead(checkout).dirty) {
      throw new Error(`CI template ${id} has unexpected local changes`);
    }
    if (git(checkout, "rev-parse", "HEAD") !== expected.commit) {
      execFileSync("git", ["-C", checkout, "fetch", "origin", expected.commit], {
        stdio: "inherit",
      });
      execFileSync("git", ["-C", checkout, "checkout", "--detach", expected.commit], {
        stdio: "inherit",
      });
    }
    if (
      git(checkout, "rev-parse", "HEAD") !== expected.commit ||
      git(checkout, "rev-parse", "HEAD^{tree}") !== expected.tree
    ) {
      throw new Error(`CI template ${id} differs from the exact quality input`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceSha, manifestPath, templateRoot] = process.argv.slice(2);
  try {
    if (
      !/^[a-f0-9]{40}$/u.test(sourceSha ?? "") ||
      !manifestPath ||
      !path.isAbsolute(manifestPath) ||
      !templateRoot ||
      !path.isAbsolute(templateRoot)
    ) {
      throw new Error(
        "Usage: pin-ci-template-inputs.mjs SOURCE_SHA ABSOLUTE_MANIFEST ABSOLUTE_TEMPLATE_ROOT"
      );
    }
    pinTemplateInputs({ sourceSha, manifestPath, templateRoot });
    console.log(`Pinned complete CI template source set for ${sourceSha}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
