import { normalizeTemplateGitUrl } from "./templateCoordinates.js";
import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { ParsedTemplateManifest, TemplateRepositoryInventory } from "./templateManifest.js";

/**
 * Merging the manifests of the layers a workspace is composed from.
 *
 * Composition needs this because every template carries its own manifest, and
 * a template that depends on another declares only what it adds. The composed
 * tree holds both sets of repositories, so the composed manifest has to declare
 * both or inventory validation would call the base's files unowned.
 *
 * The rules stay deliberately blunt, because layered precedence is what made
 * the previous composition system unmaintainable. Declarations accumulate,
 * settings resolve to the last layer that stated them, and anything two layers
 * genuinely disagree about stops here instead of picking a winner quietly.
 */

/** Declarations that name a unit source: two layers naming one source is a mistake. */
const UNIQUE_SOURCE_LISTS = ["extensions", "apps"] as const;

/** Declarations that accumulate, where repeating a source is legitimate. */
const ACCUMULATING_LISTS = ["services", "routes", "singletonObjects"] as const;

/**
 * Settings that are records of independent named slots, merged one level deep.
 *
 * Replacing one of these wholesale punishes a dependent for naming a single
 * slot, and it did: Personal had to restate every provider Base declared,
 * which left its own manifest pointing at extensions it no longer listed.
 * Merging per slot lets a layer say only what it changes.
 *
 * One level only, and a slot's value is replaced rather than merged — a list
 * inside a slot stays the statement of the layer that made it, so a dependency
 * cannot quietly add itself to something like `trust.chromeApps`. `git` is
 * deliberately absent: its records nest further, and half-merging them would
 * be harder to predict than replacing them.
 */
export const MERGED_RECORD_SETTINGS = [
  "providers",
  "trust",
  "hostTargets",
  "defaultAgentConfig",
  "defaultAutomations",
] as const;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface TemplateManifestLayer {
  /** Which template this manifest came from, for diagnostics. */
  label: string;
  manifest: ParsedTemplateManifest;
}

export interface MergedTemplateManifest {
  /** Effective runtime document; never write it over authored workspace source. */
  document: Record<string, unknown>;
  inventory: TemplateRepositoryInventory;
}

function sourceOf(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const source = (entry as { source?: unknown }).source;
  return typeof source === "string" ? source : null;
}

/** Merge dependency-first manifests into the one a composed workspace runs on. */
export function mergeTemplateManifests(
  layers: readonly TemplateManifestLayer[]
): MergedTemplateManifest {
  if (layers.length === 0) throw new Error("A composed workspace needs at least one manifest");
  const top = layers[layers.length - 1]!;

  const epochs = new Map<number, string[]>();
  for (const layer of layers) {
    const epoch = layer.manifest.top.systemEpoch;
    epochs.set(epoch, [...(epochs.get(epoch) ?? []), layer.label]);
  }
  if (epochs.size > 1) {
    const described = [...epochs]
      .sort(([left], [right]) => left - right)
      .map(([epoch, labels]) => `${labels.join(", ")} at ${epoch}`)
      .join("; ");
    throw new Error(`Composed templates disagree about the workspace system epoch: ${described}`);
  }

  const owners = templateRepositoryOwners(layers);
  const repositories = [...owners.keys()];

  const document: Record<string, unknown> = {};
  // Settings resolve to the last layer that stated them, so a dependency
  // supplies the defaults its dependent does not bother to restate, and a
  // dependent that does state one is not overruled by what it builds on.
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.manifest.top)) {
      if (value === undefined) continue;
      if (key === "template" || key === "dependencies") continue;
      if ((UNIQUE_SOURCE_LISTS as readonly string[]).includes(key)) continue;
      if ((ACCUMULATING_LISTS as readonly string[]).includes(key)) continue;
      const slots = (MERGED_RECORD_SETTINGS as readonly string[]).includes(key)
        ? plainRecord(value)
        : null;
      if (slots) {
        document[key] = { ...(plainRecord(document[key]) ?? {}), ...slots };
        continue;
      }
      document[key] = value;
    }
  }

  for (const key of [...UNIQUE_SOURCE_LISTS, ...ACCUMULATING_LISTS]) {
    const merged: unknown[] = [];
    const declarations = new Map<string, string>();
    for (const layer of layers) {
      const entries = (layer.manifest.top as Record<string, unknown>)[key] as
        | readonly unknown[]
        | undefined;
      const replacements = new Set(
        (layer.manifest.overrides ?? []).map((override) => override.repoPath)
      );
      const replaced = new Set<string>();
      for (const entry of entries ?? []) {
        const source = sourceOf(entry);
        const repoPath = source
          ?.replace("@workspace-extensions/", "extensions/")
          .replace("@workspace-apps/", "apps/");
        if (source && declarations.has(source)) {
          if (repoPath && replacements.has(repoPath)) {
            if (!replaced.has(source))
              for (let index = merged.length - 1; index >= 0; index--)
                if (sourceOf(merged[index]) === source) merged.splice(index, 1);
            replaced.add(source);
          } else if ((UNIQUE_SOURCE_LISTS as readonly string[]).includes(key)) {
            throw new Error(
              `Composed templates both declare source ${key}:${source}: ${declarations.get(source)} and ${layer.label}`
            );
          }
        }
        if (source) declarations.set(source, layer.label);
        merged.push(entry);
      }
    }
    if (merged.length) document[key] = merged;
  }

  // A composed workspace is the template at the top of the stack: its name and
  // description are what a person chose to install, not its dependency's.
  const presentation = top.manifest.presentation;
  document["template"] = {
    ...(presentation?.name === undefined ? {} : { name: presentation.name }),
    ...(presentation?.description === undefined ? {} : { description: presentation.description }),
    // Keep the top template's direct dependencies in the materialized source.
    // They are authoring provenance, not runtime settings, but a workspace
    // created from this tree must still know which repositories came from an
    // upstream when it later publishes itself as a template.
    ...(top.manifest.dependencies.length > 0 ? { dependencies: top.manifest.dependencies } : {}),

    repositories: [...repositories].sort(compareUtf16CodeUnits),
  };

  return {
    document,
    inventory: {
      repositories: [...repositories].sort(compareUtf16CodeUnits),
    },
  };
}

const sourceKey = (source: string) =>
  /^(git\+)?https?:/.test(source) ? normalizeTemplateGitUrl(source) : source;

/** Every collision must name the exact dependency whose whole unit it replaces. */
export function templateRepositoryOwners(
  layers: readonly TemplateManifestLayer[]
): Map<string, TemplateManifestLayer> {
  const owners = new Map<string, TemplateManifestLayer>();
  const bySource = new Map(layers.map((layer) => [sourceKey(layer.label), layer]));
  const dependsOn = (
    layer: TemplateManifestLayer,
    target: string,
    seen = new Set<string>()
  ): boolean =>
    layer.manifest.dependencies.some((dependency) => {
      const key = sourceKey(dependency.url);
      if (key === target) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      const parent = bySource.get(key);
      return parent ? dependsOn(parent, target, seen) : false;
    });
  for (const layer of layers) {
    const overrides = new Map(
      (layer.manifest.overrides ?? []).map((override) => [override.repoPath, override])
    );
    for (const [repoPath, override] of overrides) {
      const prior = owners.get(repoPath);
      if (
        !layer.manifest.inventory.repositories.includes(repoPath) ||
        (prior && sourceKey(prior.label) !== sourceKey(override.source)) ||
        !dependsOn(layer, sourceKey(override.source))
      )
        throw new Error(
          `Invalid override ${repoPath} in ${layer.label}: ${override.source} must be the dependency that currently owns this unit`
        );
    }
    for (const repoPath of layer.manifest.inventory.repositories) {
      if (repoPath === "meta") continue;
      const prior = owners.get(repoPath);
      if (prior && !overrides.has(repoPath))
        throw new Error(
          `Composed templates both declare repository ${repoPath}: ${prior.label} and ${layer.label}; declare an explicit override`
        );
      owners.set(repoPath, layer);
    }
  }
  const top = layers.at(-1);
  if (top?.manifest.inventory.repositories.includes("meta")) owners.set("meta", top);
  return owners;
}
