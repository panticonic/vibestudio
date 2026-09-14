#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const { requireDevelopmentTemplateCheckouts } = createRequire(import.meta.url)(
  "../src/dev/developmentTemplateConfig.cjs"
);
const templates = requireDevelopmentTemplateCheckouts(root).sources.map(({ id }) => id);

for (const template of templates) {
  const result = spawnSync(
    process.execPath,
    [vitest, "run", "--config", path.join(root, "vitest.userland.config.ts")],
    {
      cwd: root,
      env: { ...process.env, VIBESTUDIO_USERLAND_TEMPLATE: template },
      stdio: "inherit",
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
