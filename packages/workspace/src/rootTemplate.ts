import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import {
  readTemplateManifest,
  validateTemplateSnapshotInventory,
  type ParsedTemplateManifest,
} from "./templateManifest.js";

export interface RootTemplateRepositoryEvidence {
  repoPath: string;
}

/**
 * Validate the self-contained source carried by an exact root snapshot.
 *
 * Root creation imports this source as-is. Template composition state is not
 * synthesized here: the creation descriptor and semantic initialization keep
 * the exact upstream pin, import provenance, and per-repository source
 * baselines independently of any later source integration.
 */
export function validateRootTemplateSource(input: {
  workspaceId: string;
  expectedSystemEpoch: number;
  readFile(path: string): Uint8Array | null;
  snapshotPaths: readonly string[];
  repositories: readonly RootTemplateRepositoryEvidence[];
}): ParsedTemplateManifest {
  const manifest = readTemplateManifest({
    readFile: (filePath) => input.readFile(filePath),
    expectedSystemEpoch: input.expectedSystemEpoch,
  });
  validateTemplateSnapshotInventory(manifest.inventory, input.snapshotPaths);
  const discoveredRepositories = input.repositories
    .filter(({ repoPath }) => repoPath !== "meta")
    .map(({ repoPath }) => repoPath)
    .sort(compareUtf16CodeUnits);
  if (
    discoveredRepositories.length !== manifest.inventory.repositories.length ||
    discoveredRepositories.some(
      (repository, index) => repository !== manifest.inventory.repositories[index]
    )
  ) {
    throw new Error(
      `Root semantic repositories do not match template.repositories: ` +
        `declared ${manifest.inventory.repositories.join(", ")}; discovered ${discoveredRepositories.join(", ")}`
    );
  }

  return manifest;
}
