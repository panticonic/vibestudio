#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTemplateCheckoutHygiene } from "./lib/template-checkout-hygiene.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const { requireDevelopmentTemplateCheckouts } = createRequire(import.meta.url)(
  "../src/dev/developmentTemplateConfig.cjs"
);
const selected = requireDevelopmentTemplateCheckouts(root);
assertTemplateCheckoutHygiene(selected);
const args = process.argv.slice(2);
let requestedTemplate;
let testName;
const filters = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  const value = args[index + 1];
  if (argument === "--") continue;
  if (argument === "--template" || argument === "--filter" || argument === "--test-name") {
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--template") {
      if (requestedTemplate) throw new Error("--template may be passed only once");
      requestedTemplate = value;
    } else if (argument === "--filter") {
      filters.push(value);
    } else {
      if (testName) throw new Error("--test-name may be passed only once");
      testName = value;
    }
    continue;
  }
  throw new Error(
    `Unknown userland test option ${JSON.stringify(argument)}; use --template, --filter, or --test-name`
  );
}
if (filters.length > 0 && !requestedTemplate) {
  throw new Error("Focused userland tests require --template so each filter has one source owner");
}
const knownTemplates = selected.sources.map(({ id }) => id);
if (requestedTemplate && !knownTemplates.includes(requestedTemplate)) {
  throw new Error(
    `Unknown userland template ${JSON.stringify(requestedTemplate)}; expected one of ${knownTemplates.join(", ")}`
  );
}
const templates = requestedTemplate ? [requestedTemplate] : knownTemplates;

for (const template of templates) {
  const checkout = selected.checkouts[template];
  const testFilters = filters.map((filter) => {
    if (path.isAbsolute(filter)) throw new Error(`--filter must be template-relative: ${filter}`);
    const resolved = path.resolve(checkout, filter);
    const relative = path.relative(checkout, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`--filter must stay inside the ${template} checkout: ${filter}`);
    }
    return resolved;
  });
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      ...testFilters,
      "--config",
      path.join(root, "vitest.userland.config.ts"),
      ...(testName ? ["--testNamePattern", testName] : []),
    ],
    {
      cwd: root,
      env: { ...process.env, VIBESTUDIO_USERLAND_TEMPLATE: template },
      stdio: "inherit",
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    assertTemplateCheckoutHygiene(selected);
    process.exit(result.status ?? 1);
  }
}
assertTemplateCheckoutHygiene(selected);
