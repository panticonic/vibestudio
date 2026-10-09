import { WorkspaceAppCompatibilitySchema } from "@vibestudio/workspace-contracts/appCompatibility";
import {
  mergeTemplateManifests,
  MERGED_RECORD_SETTINGS,
  type TemplateManifestLayer,
} from "./templateManifestMerge.js";
import { normalizeTemplateGitUrl } from "./templateCoordinates.js";
import YAML from "yaml";
import { discoverRepos } from "@vibestudio/shared/runtime/repoDiscovery";
import { normalizeWorkspaceRepoPath, splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import { sortForCanonicalJson } from "@vibestudio/content-addressing";
import {
  WorkspaceTemplateAuthoringMetadataSchema,
  WorkspaceConfigTopLayerSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceTemplateOverride,
  WorkspaceTemplateInstallation,
  WorkspaceTemplateDependency,
  WorkspaceTemplatePresentation,
} from "@vibestudio/workspace-contracts/types";
import { TEMPLATE_SOURCE_MANIFEST_PATH } from "./templateCoordinates.js";

type ParsedTopLayer = ReturnType<typeof WorkspaceConfigTopLayerSchema.parse>;

export interface ParsedTemplateManifest {
  top: ParsedTopLayer;
  /** Templates this one is built on, in declaration order. Empty when it stands alone. */
  dependencies: WorkspaceTemplateDependency[];
  overrides?: WorkspaceTemplateOverride[];
  presentation?: WorkspaceTemplatePresentation;
}

/** Validate the exact source layout and derive its repository membership. */
export function templateRepositories(snapshotPaths: readonly string[]): string[] {
  if (!snapshotPaths.includes(TEMPLATE_SOURCE_MANIFEST_PATH))
    throw new Error(`template snapshot is missing required ${TEMPLATE_SOURCE_MANIFEST_PATH}`);
  const unowned = snapshotPaths.filter(
    (file) =>
      file.startsWith("/") ||
      file.includes("\\") ||
      file.includes("\0") ||
      file.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      !splitRepoPath(file)?.repoRelPath
  );
  if (unowned.length)
    throw new Error(
      `template snapshot contains paths outside repository layout: ${unowned.sort().join(", ")}`
    );
  return discoverRepos([...snapshotPaths]).map(({ repoPath }) =>
    normalizeWorkspaceRepoPath(repoPath)
  );
}

export function canonicalTemplateYaml(value: unknown): string {
  return YAML.stringify(sortForCanonicalJson(value), { lineWidth: 0, sortMapEntries: true });
}

/** Project authored workspace settings into the resolved runtime document. */
export function rootRuntimeFromTemplateManifest(
  manifest: ParsedTemplateManifest
): Omit<ParsedTopLayer, "template"> {
  const { template: _template, ...runtime } = manifest.top;
  return structuredClone(runtime);
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
  const authoring = WorkspaceTemplateAuthoringMetadataSchema.parse(
    raw["template"] === undefined ? {} : raw["template"]
  );
  const top = WorkspaceConfigTopLayerSchema.parse({
    ...raw,
    template: {
      ...(authoring.name === undefined ? {} : { name: authoring.name }),
      ...(authoring.description === undefined ? {} : { description: authoring.description }),
    },
  });
  WorkspaceAppCompatibilitySchema.parse(top);
  if (top.systemEpoch !== expectedSystemEpoch) {
    throw new Error(
      `systemEpoch ${top.systemEpoch} is incompatible with workspace epoch ${expectedSystemEpoch}`
    );
  }
  return {
    top,
    dependencies: authoring.dependencies ?? [],
    overrides: authoring.overrides ?? [],
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

export function templateManifestDocument(
  manifest: ParsedTemplateManifest
): Record<string, unknown> {
  return {
    ...manifest.top,
    template: {
      ...manifest.presentation,
      ...(manifest.dependencies.length ? { dependencies: manifest.dependencies } : {}),
      ...(manifest.overrides?.length ? { overrides: manifest.overrides } : {}),
    },
  };
}

/** Walk the authored dependency graph against its exact installed declarations, offline. */
export function installedDependencyLayers(
  manifest: ParsedTemplateManifest,
  installation: WorkspaceTemplateInstallation | null
): TemplateManifestLayer[] {
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
    visiting.add(key);
    for (const parent of parsed.dependencies) visit(parent);
    visiting.delete(key);
    visited.add(key);
    layers.push({ label: source.pin.url, manifest: parsed });
  };
  for (const dependency of manifest.dependencies) visit(dependency);
  return layers;
}

/** Export only the desired settings that differ from installed dependencies. */
export function authoredTemplateManifest(
  manifest: ParsedTemplateManifest,
  installation: WorkspaceTemplateInstallation | null
): ParsedTemplateManifest {
  const inheritedLayers = installedDependencyLayers(manifest, installation);
  if (!inheritedLayers.length) return manifest;
  const inherited = mergeTemplateManifests(inheritedLayers).document;
  const document = templateManifestDocument(manifest);
  const same = (a: unknown, b: unknown) => canonicalTemplateYaml(a) === canonicalTemplateYaml(b);
  for (const [key, value] of Object.entries(document)) {
    if (key === "template" || key === "systemEpoch") continue;
    const baseline = inherited[key];
    if (same(value, baseline)) {
      delete document[key];
      continue;
    }
    if (
      ["services", "routes", "singletonObjects", "extensions", "apps"].includes(key) &&
      Array.isArray(value)
    ) {
      const prior = Array.isArray(baseline) ? baseline : [];
      const own = value.filter((entry) => !prior.some((candidate) => same(candidate, entry)));
      if (own.length) document[key] = own;
      else delete document[key];
    } else if (
      (MERGED_RECORD_SETTINGS as readonly string[]).includes(key) &&
      value &&
      typeof value === "object"
    ) {
      const prior =
        baseline && typeof baseline === "object" ? (baseline as Record<string, unknown>) : {};
      const own = Object.fromEntries(
        Object.entries(value).filter(([slot, setting]) => !same(setting, prior[slot]))
      );
      if (Object.keys(own).length) document[key] = own;
      else delete document[key];
    }
  }
  const authored = parseTemplateManifestContent(
    canonicalTemplateYaml(document),
    manifest.top.systemEpoch
  );
  const restored = mergeTemplateManifests([
    ...inheritedLayers,
    { label: "workspace", manifest: authored },
  ]).document;
  if (
    !same(
      rootRuntimeFromTemplateManifest(
        parseTemplateManifestContent(canonicalTemplateYaml(restored), manifest.top.systemEpoch)
      ),
      rootRuntimeFromTemplateManifest(manifest)
    )
  )
    throw new Error(
      "Template dependencies cannot reproduce the desired workspace settings; edit the dependency or declare a whole-repository override before publishing"
    );
  return authored;
}
