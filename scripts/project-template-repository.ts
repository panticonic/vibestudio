import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalTemplateYaml,
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
  validateTemplateSnapshotInventory,
} from "@vibestudio/workspace/templateManifest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

interface Arguments {
  source: string;
  destination: string;
  apply: boolean;
}

function parseArguments(argv: readonly string[]): Arguments {
  let source: string | undefined;
  let destination: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source") source = argv[++index];
    else if (argument === "--destination") destination = argv[++index];
    else if (argument === "--apply") apply = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!source || !destination) {
    throw new Error(
      "Usage: project-template-repository --source DIR --destination GIT_DIR [--apply]"
    );
  }
  return { source: path.resolve(source), destination: path.resolve(destination), apply };
}

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

function assertDestination(destination: string, source: string): void {
  if (destination === source || destination.startsWith(`${source}${path.sep}`)) {
    throw new Error("Template projection destination must be a separate checkout");
  }
  if (
    !fs.statSync(destination).isDirectory() ||
    !fs.statSync(path.join(destination, ".git")).isDirectory()
  ) {
    throw new Error(`Template projection destination is not a Git checkout: ${destination}`);
  }
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  assertDestination(args.destination, args.source);
  const manifest = parseTemplateManifestContent(
    fs.readFileSync(path.join(args.source, "meta/template.yml"), "utf8"),
    WORKSPACE_SYSTEM_EPOCH
  );
  const sourceFiles = walkFiles(args.source);
  const projected = [
    ...new Set([
      ...sourceFiles.filter(
        (file) =>
          file === "meta/template.yml" ||
          manifest.inventory.files.includes(file) ||
          manifest.inventory.repositories.some((repository) =>
            file.startsWith(`${repository}/`)
          )
      ),
      "meta/vibestudio.yml",
    ]),
  ].sort();
  validateTemplateSnapshotInventory(manifest.inventory, projected);
  const current = walkFiles(args.destination);
  const summary = {
    source: args.source,
    destination: args.destination,
    repositories: manifest.inventory.repositories,
    supportFiles: manifest.inventory.files,
    includedFiles: projected.length,
    removedFiles: current.filter((file) => !projected.includes(file)),
  };
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  for (const entry of fs.readdirSync(args.destination)) {
    if (entry !== ".git") fs.rmSync(path.join(args.destination, entry), { recursive: true });
  }
  for (const relative of projected) {
    const destination = path.join(args.destination, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (relative === "meta/vibestudio.yml") {
      fs.writeFileSync(
        destination,
        canonicalTemplateYaml(rootRuntimeFromTemplateManifest(manifest)),
        "utf8"
      );
      continue;
    }
    const source = path.join(args.source, relative);
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
  }
  process.stdout.write(`${JSON.stringify({ ...summary, applied: true }, null, 2)}\n`);
}

main();
