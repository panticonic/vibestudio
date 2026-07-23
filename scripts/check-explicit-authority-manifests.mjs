import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnitAuthorityManifest } from "../packages/shared/src/authorityManifest.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.join(root, "workspace");
const executableRoots = new Set(["about", "apps", "extensions", "panels", "workers"]);
const failures = [];

for (const rootName of executableRoots) {
  const category = path.join(workspaceRoot, rootName);
  if (!fs.existsSync(category)) continue;
  for (const entry of fs.readdirSync(category, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(category, entry.name, "package.json");
    if (!fs.existsSync(file)) continue;
    let packageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      failures.push(`${path.relative(root, file)}: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (packageJson.vibestudio === undefined) continue;
    try {
      parseUnitAuthorityManifest(
        packageJson.vibestudio.authority,
        `${packageJson.name ?? path.relative(workspaceRoot, file)} vibestudio.authority`
      );
    } catch (error) {
      failures.push(`${path.relative(root, file)}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(
    "Authority manifests are explicit requests, never generated grants. Edit the source manifest intentionally."
  );
  process.exitCode = 1;
} else {
  console.log("Explicit executable-unit authority manifests are structurally valid.");
}
