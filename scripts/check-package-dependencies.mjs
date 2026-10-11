#!/usr/bin/env node

/**
 * Verify the production import graph reachable from every workspace package
 * entry/export against that package's manifest. The repository uses a hoisted
 * linker, so resolution success alone cannot reveal undeclared dependencies.
 */
import path from "node:path";
import process from "node:process";
import {
  findPackageDirectories,
  collectPackageManifestImportFindings,
} from "./lib/package-import-audit.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoots = ["packages", "apps"].map((part) => path.join(repositoryRoot, part));
const directories = (
  await Promise.all(workspaceRoots.map((root) => findPackageDirectories(root)))
).flat();
const failures = (
  await Promise.all(
    directories.map((directory) =>
      collectPackageManifestImportFindings(directory, repositoryRoot, {
        jsxRuntime: "react/jsx-runtime",
      })
    )
  )
).flat();

if (failures.length > 0) {
  console.error("Undeclared production package imports:\n");
  for (const failure of failures.sort((a, b) =>
    `${a.manifest}:${a.dependency}`.localeCompare(`${b.manifest}:${b.dependency}`)
  )) {
    console.error(
      `- ${failure.packageName} imports ${failure.dependency}${failure.typeOnly ? " as a type" : ""} ` +
        `in ${failure.importer} ` +
        `but does not declare it (${failure.manifest})`
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `Package dependency declarations match ${directories.length} workspace import graphs.`
  );
}
