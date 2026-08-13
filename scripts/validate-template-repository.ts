import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalTemplateYaml,
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
  validateTemplateSnapshotInventory,
} from "@vibestudio/workspace/templateManifest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

function walkFiles(root: string, relative = ""): string[] {
  return fs
    .readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.name === ".git") return [];
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walkFiles(root, child) : [child];
    })
    .sort();
}

const directoryArgument = process.argv[2];
if (!directoryArgument) throw new Error("Usage: validate-template-repository DIR");
const root = path.resolve(directoryArgument);
const manifest = parseTemplateManifestContent(
  fs.readFileSync(path.join(root, "meta/template.yml"), "utf8"),
  WORKSPACE_SYSTEM_EPOCH
);
const files = walkFiles(root);
validateTemplateSnapshotInventory(manifest.inventory, files);
const runtimePath = path.join(root, "meta/vibestudio.yml");
if (manifest.dependencies.length === 0) {
  if (!fs.existsSync(runtimePath)) throw new Error("Dependency-free root is missing meta/vibestudio.yml");
  const expected = canonicalTemplateYaml(rootRuntimeFromTemplateManifest(manifest));
  if (fs.readFileSync(runtimePath, "utf8") !== expected) {
    throw new Error("meta/vibestudio.yml is not the canonical flattened root runtime");
  }
} else if (fs.existsSync(runtimePath)) {
  throw new Error("Contribution template must not contain a root runtime manifest");
}
process.stdout.write(
  `${JSON.stringify(
    {
      root,
      epoch: WORKSPACE_SYSTEM_EPOCH,
      dependencies: manifest.dependencies,
      repositories: manifest.inventory.repositories,
      files: files.length,
      rootCapable: manifest.dependencies.length === 0,
    },
    null,
    2
  )}\n`
);
