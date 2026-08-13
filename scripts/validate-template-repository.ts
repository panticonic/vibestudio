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

const EXACT_NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function validateExactExternalDependencies(root: string, files: readonly string[]): void {
  for (const relativePath of files.filter(
    (candidate) => candidate === "package.json" || candidate.endsWith("/package.json")
  )) {
    const packageJsonPath = path.join(root, relativePath);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const field of ["dependencies", "devDependencies"] as const) {
      const declarations = packageJson[field];
      if (!declarations || typeof declarations !== "object" || Array.isArray(declarations))
        continue;
      for (const [name, rawSpecifier] of Object.entries(declarations)) {
        if (typeof rawSpecifier !== "string") {
          throw new Error(`${relativePath} ${field}.${name} must be a string`);
        }
        if (rawSpecifier === "workspace:*") continue;
        if (!EXACT_NPM_VERSION.test(rawSpecifier)) {
          throw new Error(
            `${relativePath} ${field}.${name} must use an exact version or workspace:*; got ${rawSpecifier}`
          );
        }
      }
    }
  }
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
validateExactExternalDependencies(root, files);
const runtimePath = path.join(root, "meta/vibestudio.yml");
if (manifest.dependencies.length === 0) {
  if (!fs.existsSync(runtimePath))
    throw new Error("Dependency-free root is missing meta/vibestudio.yml");
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
