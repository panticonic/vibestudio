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
const MERGED_RECORD_SETTINGS = ["providers", "trust", "hostTargets", "defaultAgentConfig"] as const;

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
  /** The composed manifest document, ready to serialize as the source manifest. */
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

  const owners = new Map<string, string>();
  const claim = (kind: "repository" | "file" | "source", value: string, label: string): void => {
    const key = `${kind}\0${value}`;
    const existing = owners.get(key);
    if (existing) {
      throw new Error(`Composed templates both declare ${kind} ${value}: ${existing} and ${label}`);
    }
    owners.set(key, label);
  };

  const repositories: string[] = [];
  const files: string[] = [];
  for (const layer of layers) {
    for (const repository of layer.manifest.inventory.repositories) {
      // `meta` is every template's own manifest repository, so each layer
      // declares it and only the composed manifest ends up in the tree.
      if (repository === "meta") continue;
      claim("repository", repository, layer.label);
      repositories.push(repository);
    }
    for (const file of layer.manifest.inventory.files) {
      claim("file", file, layer.label);
      files.push(file);
    }
  }
  if (layers.some((layer) => layer.manifest.inventory.repositories.includes("meta"))) {
    repositories.push("meta");
  }

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

  for (const key of UNIQUE_SOURCE_LISTS) {
    const merged: unknown[] = [];
    for (const layer of layers) {
      const entries = (layer.manifest.top as Record<string, unknown>)[key] as
        | readonly unknown[]
        | undefined;
      for (const entry of entries ?? []) {
        const source = sourceOf(entry);
        if (source) claim("source", `${key}:${source}`, layer.label);
        merged.push(entry);
      }
    }
    if (merged.length) document[key] = merged;
  }

  for (const key of ACCUMULATING_LISTS) {
    const merged: unknown[] = [];
    for (const layer of layers) {
      const entries = (layer.manifest.top as Record<string, unknown>)[key] as
        | readonly unknown[]
        | undefined;
      for (const entry of entries ?? []) merged.push(entry);
    }
    if (merged.length) document[key] = merged;
  }

  // A composed workspace is the template at the top of the stack: its name and
  // description are what a person chose to install, not its dependency's.
  const presentation = top.manifest.presentation;
  document["template"] = {
    ...(presentation?.name === undefined ? {} : { name: presentation.name }),
    ...(presentation?.description === undefined ? {} : { description: presentation.description }),
    repositories: [...repositories].sort(compareUtf16CodeUnits),
    files: [...files].sort(compareUtf16CodeUnits),
  };

  return {
    document,
    inventory: {
      repositories: [...repositories].sort(compareUtf16CodeUnits),
      files: [...files].sort(compareUtf16CodeUnits),
    },
  };
}
