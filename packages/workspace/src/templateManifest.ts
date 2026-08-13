import YAML from "yaml";
import { z } from "zod";
import { sortForCanonicalJson } from "@vibestudio/content-addressing";
import {
  WorkspaceConfigFragmentSchema,
  WorkspaceConfigTopLayerSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceConfig,
  WorkspaceTemplateDeclaration,
  WorkspaceTemplatePresentation,
} from "@vibestudio/workspace-contracts/types";
import { normalizeTemplateGitUrl, TEMPLATE_SOURCE_MANIFEST_PATH } from "./templateCoordinates.js";
import { composeWorkspaceConfig } from "./configComposition.js";

type ParsedTopLayer = ReturnType<typeof WorkspaceConfigTopLayerSchema.parse>;
export type ParsedTemplateFragment = ReturnType<typeof WorkspaceConfigFragmentSchema.parse>;

export interface TemplateRepositoryInventory {
  repositories: string[];
  files: string[];
}

export interface ParsedTemplateManifest {
  top: ParsedTopLayer;
  dependencies: WorkspaceTemplateDeclaration[];
  fragment: ParsedTemplateFragment;
  fragmentYaml: string;
  inventory: TemplateRepositoryInventory;
  presentation?: WorkspaceTemplatePresentation;
  excludedSuggestions: { trust?: unknown; providers?: unknown };
}

const CanonicalInventoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "must be a canonical relative path"
  );

const TemplateAuthoringMetadataSchema = z
  .object({
    name: z.unknown().optional(),
    description: z.unknown().optional(),
    repositories: z.array(CanonicalInventoryPathSchema),
    files: z.array(CanonicalInventoryPathSchema),
  })
  .strict();

function uniqueSortedPaths(paths: readonly string[], label: string): string[] {
  const unique = new Set(paths);
  if (unique.size !== paths.length) throw new Error(`${label} contains duplicate paths`);
  return [...unique].sort();
}

const GENERATED_TEMPLATE_PATHS = new Set([TEMPLATE_SOURCE_MANIFEST_PATH, "meta/vibestudio.yml"]);

/**
 * Prove that every released byte has exactly one manifest owner. The two
 * manifests are intrinsic to the format; all other paths must belong to one
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
      !GENERATED_TEMPLATE_PATHS.has(file) &&
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

export function sanitizeTemplateManifest(top: ParsedTopLayer): ParsedTemplateFragment {
  const {
    templates: _templates,
    disable: _disable,
    trust: _trust,
    providers: _providers,
    template: _template,
    git,
    ...accepted
  } = top;
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
  return WorkspaceConfigFragmentSchema.parse({
    ...accepted,
    ...(git === undefined
      ? {}
      : {
          git: {
            ...(git.remotes === undefined ? {} : { remotes: git.remotes }),
            ...(upstreams === undefined ? {} : { upstreams }),
          },
        }),
  });
}

/** Flatten one dependency-free root manifest into the exact host runtime form. */
export function rootRuntimeFromTemplateManifest(
  manifest: ParsedTemplateManifest
): Omit<WorkspaceConfig, "id"> {
  if (manifest.dependencies.length > 0) {
    throw new Error("A root runtime cannot be generated from a template with dependencies");
  }
  const authoredUpstreams = Object.fromEntries(
    Object.entries(manifest.top.git?.upstreams ?? {}).flatMap(([section, repositories]) => {
      const authored = Object.fromEntries(
        Object.entries(repositories).filter(
          ([, upstream]) => upstream.authorName !== undefined || upstream.authorEmail !== undefined
        )
      );
      return Object.keys(authored).length > 0 ? [[section, authored]] : [];
    })
  );
  const composed = composeWorkspaceConfig(
    WorkspaceConfigTopLayerSchema.parse({
      systemEpoch: manifest.top.systemEpoch,
      ...(manifest.top.providers ? { providers: manifest.top.providers } : {}),
      ...(manifest.top.trust ? { trust: manifest.top.trust } : {}),
      ...(Object.keys(authoredUpstreams).length > 0
        ? { git: { upstreams: authoredUpstreams } }
        : {}),
    }),
    [{ nodeId: "root", alias: "root", ancestors: [], config: manifest.fragment }],
    "root"
  );
  const { id: _id, ...runtime } = composed;
  return runtime;
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
  const authoring = TemplateAuthoringMetadataSchema.parse(raw["template"]);
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
  if (top.templates?.overrides && Object.keys(top.templates.overrides).length > 0) {
    throw new Error("template manifests cannot impose exact template overrides");
  }
  const dependencies = (top.templates?.use ?? []).map((declaration) => ({
    ...declaration,
    url: normalizeTemplateGitUrl(declaration.url),
  }));
  if (top.templates?.registry && dependencies.length > 0) {
    throw new Error("template manifests cannot replace the workspace template registry");
  }
  const fragment = sanitizeTemplateManifest(top);
  return {
    top,
    dependencies,
    fragment,
    fragmentYaml: canonicalTemplateYaml(fragment),
    inventory: { repositories, files },
    ...(top.template === undefined ? {} : { presentation: top.template }),
    excludedSuggestions: {
      ...(top.trust === undefined ? {} : { trust: top.trust }),
      ...(top.providers === undefined ? {} : { providers: top.providers }),
    },
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
