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
const { assertTemplateLockIntegrityForRead } = await import(
  path.join(root, "packages/workspace/src/templateLock.ts")
);
const { normalizeTemplateGitUrl } = await import(
  path.join(root, "packages/workspace/src/templateCoordinates.ts")
);
const { parseBaseTemplateReleaseArtifact } = await import(
  path.join(root, "packages/workspace/src/baseTemplateRelease.ts")
);
const { canonicalSnapshotDigest, compareUtf16CodeUnits, sha256Hex } = await import(
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
const lock = assertTemplateLockIntegrityForRead(
  YAML.parse(fs.readFileSync(path.join(workspaceRoot, "meta/templates.lock.yml"), "utf8"))
);
const node = lock.nodes.find((candidate) => normalizeTemplateGitUrl(candidate.pin.url) === baseUrl);
if (!node) throw new Error(`The template lock does not contain release base ${baseUrl}`);

const systemRoot = path.join(workspaceRoot, "migrations", "system");
const systemNotes = [];
const systemFiles = [];
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
    const stat = fs.statSync(absolute);
    systemFiles.push({
      path: relativePath,
      mode: stat.mode & 0o111 ? 0o100755 : 0o100644,
      size: bytes.byteLength,
      contentHash: sha256Hex(bytes),
    });
    if (entry.name.endsWith(".md")) {
      const notePath = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
      systemNotes.push({ path: notePath, markdown: bytes.toString("utf8") });
    }
  }
}
collectSystemFacet(systemRoot);
systemFiles.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
systemNotes.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));

const systemContribution = lock.repositories["migrations/system"]?.contributions ?? [];
if (systemFiles.length === 0 && systemContribution.length > 0) {
  throw new Error("The template lock records migrations/system but the release workspace does not");
}
if (systemFiles.length > 0) {
  if (systemContribution.length !== 1 || systemContribution[0].nodeId !== node.nodeId) {
    throw new Error("migrations/system must be contributed only by the release base template");
  }
  const observedDigest = canonicalSnapshotDigest(systemFiles);
  if (systemContribution[0].subtreeDigest !== observedDigest) {
    throw new Error(
      `migrations/system does not match the pinned base contribution: expected ${systemContribution[0].subtreeDigest}, observed ${observedDigest}`
    );
  }
}

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
