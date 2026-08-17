import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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
      // Installed dependencies are never template content, and a checkout that
      // has been `pnpm install`-ed would otherwise report thousands of
      // "undeclared paths" that no one should add to the manifest.
      if (entry.name === ".git" || entry.name === "node_modules") return [];
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walkFiles(root, child) : [child];
    })
    .sort();
}

const EXACT_NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function validateExactExternalDependencies(root: string, files: readonly string[]): void {
  for (const relativePath of files.filter(
    (candidate) => candidate === "package.json" || candidate.endsWith("/package.json")
  )) {
    const packageJsonPath = path.join(root, relativePath);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
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

/**
 * Validate a template checkout, and optionally repair what is mechanically
 * derivable.
 *
 * `meta/vibestudio.yml` is GENERATED from `meta/template.yml`, and the runtime
 * compares it by exact text. So an ordinary edit — even a re-wrapped long line
 * from an editor — makes every workspace built on that checkout fail to boot
 * with "not the canonical generated runtime manifest". Until now this script
 * could only report that, leaving the fix to be done by hand against a
 * serializer whose exact output nobody can predict. `--fix` writes what the
 * manifest says it should be.
 *
 * Returns whether anything was repaired, so callers can tell "was already fine"
 * from "is fine now".
 */
export function validateTemplateRepository(
  root: string,
  options: { fix?: boolean; bootOnly?: boolean } = {}
): { repaired: string[] } {
  const repaired: string[] = [];
  const manifest = parseTemplateManifestContent(
    fs.readFileSync(path.join(root, "meta/template.yml"), "utf8"),
    WORKSPACE_SYSTEM_EPOCH
  );
  const files = walkFiles(root);
  try {
    validateTemplateSnapshotInventory(manifest.inventory, files);
  } catch (error) {
    // The bare path list does not say what to do with it. A half-authored
    // panel sitting in a checkout is an ordinary dev state, and the remedy is
    // always the same edit — so hand it over instead of making each person
    // rediscover it.
    const message = error instanceof Error ? error.message : String(error);
    const undeclared = [...message.matchAll(/(?:^|\s)([\w.-]+\/[\w./-]+)/gu)].map((m) => m[1]!);
    const units = [...new Set(undeclared.map((p) => p.split("/").slice(0, 2).join("/")))];
    throw new Error(
      `${message}\n\n` +
        `Add these to the \`inventory.units\` list in meta/template.yml (keep it sorted):\n` +
        units.map((unit) => `    - ${unit}`).join("\n") +
        `\nOr delete the paths if they are scratch files.`
    );
  }
  // Exact-version pinning is a PUBLISHING policy for a template being released,
  // not something a workspace needs in order to boot — a caret range in a peer
  // dependency runs fine. `bootOnly` is for callers (the mobile smoke preflight)
  // asking the narrower question "can a workspace start from this checkout?",
  // which must not fail on policy a running workspace never consults.
  if (!options.bootOnly) validateExactExternalDependencies(root, files);
  const runtimePath = path.join(root, "meta/vibestudio.yml");
  if (manifest.dependencies.length === 0) {
    if (!fs.existsSync(runtimePath))
      throw new Error("Dependency-free root is missing meta/vibestudio.yml");
    const expected = canonicalTemplateYaml(rootRuntimeFromTemplateManifest(manifest));
    if (fs.readFileSync(runtimePath, "utf8") !== expected) {
      if (!options.fix) {
        throw new Error(
          "meta/vibestudio.yml is not the canonical flattened root runtime — " +
            "it is generated from meta/template.yml and compared by exact text. " +
            "Re-run with --fix to regenerate it."
        );
      }
      fs.writeFileSync(runtimePath, expected);
      repaired.push("meta/vibestudio.yml");
    }
  } else if (fs.existsSync(runtimePath)) {
    throw new Error("Contribution template must not contain a root runtime manifest");
  }
  return { repaired };
}

function main(): void {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const bootOnly = args.includes("--boot-only");
  const directoryArgument = args.find((arg) => !arg.startsWith("--"));
  if (!directoryArgument) throw new Error("Usage: validate-template-repository DIR [--fix]");
  const root = path.resolve(directoryArgument);
  const manifest = parseTemplateManifestContent(
    fs.readFileSync(path.join(root, "meta/template.yml"), "utf8"),
    WORKSPACE_SYSTEM_EPOCH
  );
  const files = walkFiles(root);
  const { repaired } = validateTemplateRepository(root, { fix, bootOnly });
  for (const file of repaired) process.stderr.write(`regenerated ${file}\n`);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
