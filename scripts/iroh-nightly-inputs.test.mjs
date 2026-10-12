import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Android nightly smoke uses its source-server producer entrypoint", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/iroh-e2e-nightly.yml"),
    "utf8"
  );
  const androidJob = workflow.slice(workflow.indexOf("  android-iroh-smoke:"));
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;

  assert.match(androidJob, /script: pnpm test:iroh-mobile-e2e/u);
  assert.doesNotMatch(androidJob, /pnpm build/u);
  assert.equal(
    scripts["test:iroh-mobile-e2e"],
    "node scripts/cli/mobile-smoke.mjs --platform android"
  );
});

test("public Vitest Iroh entrypoints prepare the development desktop host", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  for (const name of ["test:iroh", "test:iroh-e2e", "test:watch"]) {
    assert.match(
      scripts[name],
      /^NODE_ENV=development node scripts\/ensure-host-build\.mjs && /u,
      `${name} must prepare the host before starting Vitest`
    );
  }
});
