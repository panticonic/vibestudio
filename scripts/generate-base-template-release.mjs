#!/usr/bin/env node
/** Freeze the host release's exact base pin and rescue-readable system notes. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const workspaceRoot = path.join(root, "workspace");
const destination = path.join(root, "build-resources", "base-template-release.json");

const { WorkspaceConfigTopLayerSchema } = await import(
  path.join(root, "packages/workspace-contracts/src/workspaceConfigSchema.ts")
);
const { parseTemplateState } = await import(
  path.join(root, "packages/workspace/src/templateState.ts")
);
const { normalizeTemplateGitUrl } = await import(
  path.join(root, "packages/workspace/src/templateCoordinates.ts")
);
const { parseBaseTemplateReleaseArtifact } = await import(
  path.join(root, "packages/workspace/src/baseTemplateRelease.ts")
);
const { compareUtf16CodeUnits } = await import(
  path.join(root, "packages/content-addressing/src/index.ts")
);

const source = WorkspaceConfigTopLayerSchema.parse(
  YAML.parse(fs.readFileSync(path.join(workspaceRoot, "meta/templates/workspace.yml"), "utf8"))
);
const roots = source.templates?.use ?? [];
if (roots.length !== 1) {
  throw new Error(
    `The shipped workspace must declare exactly one release base template; found ${roots.length}`
  );
}
const baseUrl = normalizeTemplateGitUrl(roots[0].url);
const state = parseTemplateState(
  YAML.parse(fs.readFileSync(path.join(workspaceRoot, "meta/templates.state.yml"), "utf8"))
);
const node = state.nodes.find(
  (candidate) => normalizeTemplateGitUrl(candidate.pin.url) === baseUrl
);
if (!node) throw new Error(`Template relationship state does not contain release base ${baseUrl}`);

const systemRoot = path.join(workspaceRoot, "migrations", "system");
const systemNotes = [];
function collectSystemFacet(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSystemFacet(absolute);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported system migration entry ${absolute}`);
    const bytes = fs.readFileSync(absolute);
    const relativePath = path.relative(systemRoot, absolute).split(path.sep).join("/");
    if (entry.name.endsWith(".md")) {
      const notePath = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
      systemNotes.push({ path: notePath, markdown: bytes.toString("utf8") });
    }
  }
}
collectSystemFacet(systemRoot);
systemNotes.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));

const artifact = {
  version: 1,
  baseTemplate: node.pin,
  systemNotes,
};
parseBaseTemplateReleaseArtifact(artifact);
const content = `${JSON.stringify(artifact, null, 2)}\n`;
const current = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : null;
if (current === content) {
  console.log(`Base-template release artifact is current (${systemNotes.length} system note(s)).`);
  process.exit(0);
}
if (check) {
  console.error(
    "Base-template release artifact is stale. Run pnpm generate:base-template-release."
  );
  process.exit(1);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, content, "utf8");
console.log(`Wrote base-template release artifact with ${systemNotes.length} system note(s).`);
