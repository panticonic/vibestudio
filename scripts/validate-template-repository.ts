import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import {
  buildUnitKindForPath,
  packageManifestContractError,
} from "../src/server/buildV2/packageGraph.js";
import {
  parseTemplateManifestContent,
  templateRepositories,
} from "@vibestudio/workspace/templateManifest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

function walkFiles(root: string, relative = ""): string[] {
  return fs
    .readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      // Installed dependencies are never template content, and a checkout that
      // has been `pnpm install`-ed would otherwise report thousands of
      // "undeclared paths" that no one should add to the manifest.
      if (entry.name === ".git" || entry.name === "node_modules") return [];
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walkFiles(root, child) : [child];
    })
    .sort();
}

export function validateExternalDependencySpecifiers(root: string, files: readonly string[]): void {
  for (const relativePath of files.filter(
    (candidate) => candidate === "package.json" || candidate.endsWith("/package.json")
  )) {
    const packageJsonPath = path.join(root, relativePath);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    // Published workspace manifests describe compatibility. The host reuses a
    // shipped dependency when it satisfies the declared range and otherwise
    // performs the ordinary isolated install. Keep this boundary deliberately
    // small: registry semver ranges and workspace packages are supported;
    // paths, URLs, Git refs, and package-manager aliases are not.
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const) {
      const declarations = packageJson[field];
      if (!declarations || typeof declarations !== "object" || Array.isArray(declarations))
        continue;
      for (const [name, rawSpecifier] of Object.entries(declarations)) {
        if (typeof rawSpecifier !== "string") {
          throw new Error(`${relativePath} ${field}.${name} must be a string`);
        }
        if (rawSpecifier === "workspace:*" || semver.validRange(rawSpecifier)) continue;
        throw new Error(
          `${relativePath} ${field}.${name} must use a registry semver range or workspace:*; got ${rawSpecifier}`
        );
      }
    }
  }
}

/**
 * Validate one self-contained workspace source manifest and its declared files.
 */
export function validateTemplateRepository(
  root: string,
  options: { bootOnly?: boolean } = {}
): void {
  parseTemplateManifestContent(
    fs.readFileSync(path.join(root, "meta/vibestudio.yml"), "utf8"),
    WORKSPACE_SYSTEM_EPOCH
  );
  const files = walkFiles(root);
  const repositories = templateRepositories(files);
  for (const unit of repositories) {
    const kind = buildUnitKindForPath(unit);
    const marker = `${unit}/package.json`;
    if (!kind || kind === "template" || !files.includes(marker)) continue;
    const error = packageManifestContractError(
      unit,
      kind,
      fs.readFileSync(path.join(root, marker), "utf8")
    );
    if (error) throw new Error(`${marker}: ${error}`);
  }
  if (!options.bootOnly) validateExternalDependencySpecifiers(root, files);
}

function main(): void {
  const args = process.argv.slice(2);
  const unknownOption = args.find((arg) => arg.startsWith("--") && arg !== "--boot-only");
  if (unknownOption) throw new Error(`Unknown option: ${unknownOption}`);
  const bootOnly = args.includes("--boot-only");
  const directoryArgument = args.find((arg) => !arg.startsWith("--"));
  if (!directoryArgument) throw new Error("Usage: validate-template-repository DIR [--boot-only]");
  const root = path.resolve(directoryArgument);
  const files = walkFiles(root);
  validateTemplateRepository(root, { bootOnly });
  process.stdout.write(
    `${JSON.stringify(
      {
        root,
        epoch: WORKSPACE_SYSTEM_EPOCH,
        repositories: templateRepositories(files),
        files: files.length,
      },
      null,
      2
    )}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
