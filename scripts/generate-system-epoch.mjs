#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(packageJson.version ?? "");
if (!semver.valid(version)) throw new Error(`Invalid application SemVer: ${version}`);
const epoch = semver.major(version);
const destination = path.join(root, "packages/shared/src/vcs/systemEpoch.generated.ts");
const content =
  "/** Generated from the root application SemVer by scripts/generate-system-epoch.mjs. */\n" +
  `export const GENERATED_WORKSPACE_SYSTEM_EPOCH = ${epoch} as const;\n`;

if (process.argv.includes("--check")) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, "utf8") !== content) {
    throw new Error(
      `Generated workspace epoch is stale; run node scripts/generate-system-epoch.mjs`
    );
  }
  console.log(`Workspace system epoch ${epoch} matches application ${packageJson.version}.`);
} else {
  fs.writeFileSync(destination, content, "utf8");
  console.log(`Generated workspace system epoch ${epoch} from ${packageJson.version}.`);
}
