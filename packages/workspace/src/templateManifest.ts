import YAML from "yaml";
import { sortForCanonicalJson } from "@vibestudio/content-addressing";
import {
  WorkspaceTemplateAuthoringMetadataSchema,
  WorkspaceConfigTopLayerSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceConfig,
  WorkspaceTemplatePresentation,
} from "@vibestudio/workspace-contracts/types";
import { TEMPLATE_SOURCE_MANIFEST_PATH } from "./templateCoordinates.js";
import { normalizeRemoteUrl, validateWorkspaceGitConfig } from "./remotes.js";

type ParsedTopLayer = ReturnType<typeof WorkspaceConfigTopLayerSchema.parse>;

export interface TemplateRepositoryInventory {
  repositories: string[];
  files: string[];
}

export interface ParsedTemplateManifest {
  top: ParsedTopLayer;
  inventory: TemplateRepositoryInventory;
  presentation?: WorkspaceTemplatePresentation;
}

function uniqueSortedPaths(paths: readonly string[], label: string): string[] {
  const unique = new Set(paths);
  if (unique.size !== paths.length) throw new Error(`${label} contains duplicate paths`);
  return [...unique].sort();
}

/**
 * Prove that every released byte has exactly one manifest owner. The source
 * manifest is intrinsic to the format; all other paths must belong to one
 * declared semantic repository or be named explicitly as a support file.
 */
export function validateTemplateSnapshotInventory(
  inventory: TemplateRepositoryInventory,
  snapshotPaths: readonly string[]
): void {
  for (const [index, repository] of inventory.repositories.entries()) {
    for (const other of inventory.repositories.slice(index + 1)) {
      if (repository.startsWith(`${other}/`) || other.startsWith(`${repository}/`)) {
        throw new Error(`template.repositories overlap: ${repository} and ${other}`);
      }
    }
  }
  const paths = new Set(snapshotPaths);
  if (!paths.has(TEMPLATE_SOURCE_MANIFEST_PATH)) {
    throw new Error(`template snapshot is missing required ${TEMPLATE_SOURCE_MANIFEST_PATH}`);
  }
  for (const file of inventory.files) {
    if (!paths.has(file)) throw new Error(`template.files declares missing path ${file}`);
  }
  for (const repository of inventory.repositories) {
    const prefix = `${repository}/`;
    if (![...paths].some((file) => file.startsWith(prefix))) {
      throw new Error(`template.repositories declares empty or missing repository ${repository}`);
    }
  }
  const unowned = [...paths].filter(
    (file) =>
      file !== TEMPLATE_SOURCE_MANIFEST_PATH &&
      !inventory.files.includes(file) &&
      !inventory.repositories.some((repository) => file.startsWith(`${repository}/`))
  );
  if (unowned.length > 0) {
    throw new Error(`template snapshot contains undeclared paths: ${unowned.sort().join(", ")}`);
  }
}

export function canonicalTemplateYaml(value: unknown): string {
  return YAML.stringify(sortForCanonicalJson(value), { lineWidth: 0, sortMapEntries: true });
}

function runtimeManifest(top: ParsedTopLayer): Omit<WorkspaceConfig, "id"> {
  const { template: _template, git, ...accepted } = top;
  const upstreams =
    git?.upstreams === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(git.upstreams).map(([section, repositories]) => [
            section,
            Object.fromEntries(
              Object.entries(repositories).map(([repo, upstream]) => {
                const {
                  authorEmail: _authorEmail,
                  authorName: _authorName,
                  ...portable
                } = upstream;
                return [repo, portable];
              })
            ),
          ])
        );
  return {
    ...accepted,
    ...(git === undefined
      ? {}
      : {
          git: {
            ...(git.remotes === undefined ? {} : { remotes: git.remotes }),
            ...(upstreams === undefined ? {} : { upstreams }),
          },
        }),
  } as Omit<WorkspaceConfig, "id">;
}

/** Project one self-contained source manifest into its runtime form. */
export function rootRuntimeFromTemplateManifest(
  manifest: ParsedTemplateManifest
): Omit<WorkspaceConfig, "id"> {
  const projected = structuredClone(runtimeManifest(manifest.top));
  validateWorkspaceGitConfig(projected.git);
  for (const repositories of Object.values(projected.git?.remotes ?? {})) {
    for (const remotes of Object.values(repositories)) {
      for (const remote of Object.values(remotes)) remote.url = normalizeRemoteUrl(remote.url);
    }
  }
  return projected;
}

export function parseTemplateManifestContent(
  content: string,
  expectedSystemEpoch: number
): ParsedTemplateManifest {
  const document = YAML.parse(content) as unknown;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("template manifest must be a mapping");
  }
  const raw = document as Record<string, unknown>;
  const authoring = WorkspaceTemplateAuthoringMetadataSchema.parse(raw["template"]);
  const repositories = uniqueSortedPaths(authoring.repositories, "template.repositories");
  const files = uniqueSortedPaths(authoring.files, "template.files");
  for (const file of files) {
    if (
      repositories.some((repository) => file === repository || file.startsWith(`${repository}/`))
    ) {
      throw new Error(`template.files path ${file} is already owned by a declared repository`);
    }
  }
  const top = WorkspaceConfigTopLayerSchema.parse({
    ...raw,
    template: {
      ...(authoring.name === undefined ? {} : { name: authoring.name }),
      ...(authoring.description === undefined ? {} : { description: authoring.description }),
    },
  });
  if (top.systemEpoch !== expectedSystemEpoch) {
    throw new Error(
      `systemEpoch ${top.systemEpoch} is incompatible with workspace epoch ${expectedSystemEpoch}`
    );
  }
  return {
    top,
    inventory: { repositories, files },
    ...(top.template === undefined ? {} : { presentation: top.template }),
  };
}

export function readTemplateManifest(input: {
  readFile(path: string): Uint8Array | null;
  expectedSystemEpoch: number;
}): ParsedTemplateManifest {
  const bytes = input.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
  if (!bytes) throw new Error(`missing required ${TEMPLATE_SOURCE_MANIFEST_PATH}`);
  return parseTemplateManifestContent(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    input.expectedSystemEpoch
  );
}
