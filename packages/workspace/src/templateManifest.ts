import { mergeTemplateManifests, type TemplateManifestLayer } from "./templateManifestMerge.js";
import { normalizeTemplateGitUrl } from "./templateCoordinates.js";
import YAML from "yaml";
import { sortForCanonicalJson } from "@vibestudio/content-addressing";
import {
  WorkspaceTemplateAuthoringMetadataSchema,
  WorkspaceConfigTopLayerSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceConfig,
  WorkspaceTemplateOverride,
  WorkspaceTemplateInstallation,
  WorkspaceTemplateDependency,
  WorkspaceTemplatePresentation,
} from "@vibestudio/workspace-contracts/types";
import { TEMPLATE_SOURCE_MANIFEST_PATH } from "./templateCoordinates.js";
import { normalizeRemoteUrl, validateWorkspaceGitConfig } from "./remotes.js";

type ParsedTopLayer = ReturnType<typeof WorkspaceConfigTopLayerSchema.parse>;

export interface TemplateRepositoryInventory {
  repositories: string[];
}

export interface ParsedTemplateManifest {
  top: ParsedTopLayer;
  inventory: TemplateRepositoryInventory;
  /** Templates this one is built on, in declaration order. Empty when it stands alone. */
  dependencies: WorkspaceTemplateDependency[];
  overrides?: WorkspaceTemplateOverride[];
  installation?: WorkspaceTemplateInstallation;
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
 * declared semantic repository.
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
  for (const repository of inventory.repositories) {
    const prefix = `${repository}/`;
    if (![...paths].some((file) => file.startsWith(prefix))) {
      throw new Error(`template.repositories declares empty or missing repository ${repository}`);
    }
  }
  const unowned = [...paths].filter(
    (file) =>
      file !== TEMPLATE_SOURCE_MANIFEST_PATH &&
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
  const projected = structuredClone(runtimeManifest(effectiveTemplateManifest(manifest).top));
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
    inventory: { repositories },
    dependencies: authoring.dependencies ?? [],
    overrides: authoring.overrides ?? [],
    ...(authoring.installation ? { installation: authoring.installation } : {}),
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

/** The authoritative document contains authored settings plus exact dependency declarations.
 * Effective settings are calculated, never written over the authored layer. */
export function effectiveTemplateManifest(
  manifest: ParsedTemplateManifest
): ParsedTemplateManifest {
  if (!manifest.installation) return manifest;
  const { upstream } = manifest.installation;
  const layers = installedDependencyLayers(manifest);
  const merged = mergeTemplateManifests([
    ...layers,
    { label: upstream?.url ?? "workspace", manifest },
  ]);
  return parseTemplateManifestContent(
    canonicalTemplateYaml(merged.document),
    manifest.top.systemEpoch
  );
}

export function templateManifestDocument(
  manifest: ParsedTemplateManifest
): Record<string, unknown> {
  return {
    ...manifest.top,
    template: {
      ...manifest.presentation,
      repositories: manifest.inventory.repositories,
      ...(manifest.dependencies.length ? { dependencies: manifest.dependencies } : {}),
      ...(manifest.overrides?.length ? { overrides: manifest.overrides } : {}),
    },
  };
}

/** Walk the authored dependency graph against its exact installed declarations, offline. */
export function installedDependencyLayers(
  manifest: ParsedTemplateManifest
): TemplateManifestLayer[] {
  const installation = manifest.installation;
  if (!installation) return [];
  const entries = new Map<string, (typeof installation.sources)[number]>();
  for (const source of installation.sources) {
    const key = normalizeTemplateGitUrl(source.pin.url);
    if (entries.has(key)) throw new Error(`Duplicate installed template source ${key}`);
    entries.set(key, source);
  }
  if (installation.upstream) {
    const upstream = entries.get(normalizeTemplateGitUrl(installation.upstream.url));
    if (!upstream || upstream.pin.commit !== installation.upstream.commit)
      throw new Error("Template upstream must identify its exact recorded source baseline");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const layers: TemplateManifestLayer[] = [];
  const visit = (dependency: WorkspaceTemplateDependency) => {
    const key = normalizeTemplateGitUrl(dependency.url);
    if (
      visiting.has(key) ||
      (installation.upstream && key === normalizeTemplateGitUrl(installation.upstream.url))
    )
      throw new Error(`Template dependency cycle at ${key}`);
    const source = entries.get(key);
    if (!source || (dependency.commit && dependency.commit !== source.pin.commit))
      throw new Error(
        `Dependency ${key} has no matching installed exact source; resolve the dependency before using it`
      );
    if (visited.has(key)) return;
    const parsed = parseTemplateManifestContent(source.manifest, manifest.top.systemEpoch);
    if (parsed.installation)
      throw new Error("Installed source declarations cannot contain nested installations");
    visiting.add(key);
    for (const parent of parsed.dependencies) visit(parent);
    visiting.delete(key);
    visited.add(key);
    layers.push({ label: source.pin.url, manifest: parsed });
  };
  for (const dependency of manifest.dependencies) visit(dependency);
  return layers;
}
