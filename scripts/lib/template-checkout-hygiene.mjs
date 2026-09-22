import * as fs from "node:fs";
import * as path from "node:path";

const DERIVED_DIRECTORY_NAMES = new Set(["node_modules", ".cache", "coverage", "dist"]);

function derivedArtifacts(root, relative = "") {
  const artifacts = [];
  const directory = path.join(root, relative);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory() && DERIVED_DIRECTORY_NAMES.has(entry.name)) {
      artifacts.push(entryRelative);
      continue;
    }
    if (entry.isDirectory()) {
      artifacts.push(...derivedArtifacts(root, entryRelative));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) artifacts.push(entryRelative);
  }
  return artifacts;
}

export function templateCheckoutHygieneFailures(selected) {
  return selected.sources.flatMap(({ id }) =>
    derivedArtifacts(selected.checkouts[id]).map((artifact) => ({
      template: id,
      checkout: selected.checkouts[id],
      artifact,
    }))
  );
}

export function assertTemplateCheckoutHygiene(selected) {
  const failures = templateCheckoutHygieneFailures(selected);
  if (failures.length === 0) return;
  const details = failures
    .map(({ template, checkout, artifact }) => `  ${template}: ${path.join(checkout, artifact)}`)
    .join("\n");
  throw new Error(
    `Development template checkouts contain host-owned derived artifacts:\n${details}\n` +
      "Run tests and typechecks through the Vibestudio userland commands; template checkouts are source-only."
  );
}
