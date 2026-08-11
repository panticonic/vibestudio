import * as path from "node:path";

import { BUILDABLE_UNIT_DIRS } from "@vibestudio/workspace-contracts/sourceDirs";

import { getBytes, readTreeDirectory } from "../services/blobstoreService.js";
import {
  discoverPackageGraphFromManifests,
  type PackageGraph,
  type PackageGraphManifest,
} from "./packageGraph.js";

async function readSectionManifests(
  blobsDir: string,
  stateHash: string,
  section: (typeof BUILDABLE_UNIT_DIRS)[number]
): Promise<PackageGraphManifest[]> {
  const entries = await readTreeDirectory(blobsDir, stateHash, section.dir);
  if (!entries) return [];

  return Promise.all(
    entries
      .filter((entry) => entry.kind === "dir" && !entry.name.startsWith("."))
      .map(async (entry): Promise<PackageGraphManifest | null> => {
        if (entry.kind !== "dir") return null;
        const relativePath = path.posix.join(section.dir, entry.name);
        const unitEntries = await readTreeDirectory(blobsDir, entry.treeHash);
        if (!unitEntries) return null;
        const manifestName = section.kind === "template" ? "template.json" : "package.json";
        const manifest = unitEntries.find(
          (candidate) => candidate.kind === "file" && candidate.name === manifestName
        );
        if (!manifest || manifest.kind !== "file") {
          if (section.kind === "template") {
            console.warn(
              `[PackageGraph] Template directory ${entry.name} has no template.json, skipping`
            );
          }
          return null;
        }
        const bytes = await getBytes(blobsDir, manifest.contentHash);
        if (!bytes) {
          throw new Error(
            `Package graph manifest blob ${manifest.contentHash} is missing for ${relativePath}/${manifestName}`
          );
        }
        const source = bytes.toString("utf8");
        return {
          relativePath,
          kind: section.kind,
          ...(section.kind === "template" ? { templateJson: source } : { packageJson: source }),
        };
      })
  ).then((manifests) => manifests.filter((manifest) => manifest !== null));
}

/** Derive a package graph from manifest-sized CAS reads only. */
export async function discoverPackageGraphAtTree(
  blobsDir: string,
  stateHash: string,
  workspaceRoot: string
): Promise<PackageGraph> {
  const sections = await Promise.all(
    BUILDABLE_UNIT_DIRS.map((section) => readSectionManifests(blobsDir, stateHash, section))
  );
  return discoverPackageGraphFromManifests(workspaceRoot, sections.flat());
}
