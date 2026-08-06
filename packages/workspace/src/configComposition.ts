import YAML from "yaml";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  WorkspaceConfigFragmentSchema,
  WorkspaceConfigSchema,
  WorkspaceConfigTopLayerSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { normalizeRemoteUrl, validateWorkspaceGitConfig } from "./remotes.js";

type Manifest = ReturnType<typeof WorkspaceConfigTopLayerSchema.parse>;
type FragmentManifest = ReturnType<typeof WorkspaceConfigFragmentSchema.parse>;

/**
 * User-authored workspace layer owned exclusively by the userland composer.
 * The host consumes only `meta/vibestudio.yml`, the flattened runtime result.
 */
export const WORKSPACE_COMPOSITION_SOURCE_PATH = "meta/templates/workspace.yml";

export interface WorkspaceConfigFragmentLayer {
  nodeId: string;
  alias: string;
  /** Complete ancestor set. Every ancestor must precede this layer. */
  ancestors: readonly string[];
  config: FragmentManifest;
}

export class ManifestEntryConflictError extends Error {
  readonly code = "ManifestEntryConflict";
  /** Canonical `disable`/redeclaration address of the contested declaration. */
  readonly address: string;
  constructor(
    readonly section: string,
    readonly key: string,
    readonly claimants: readonly string[]
  ) {
    const address = key === section ? section : `${section}/${key}`;
    super(
      `Unrelated templates ${claimants.join(" and ")} both declare ${address}; ` +
        `redeclare it in ${WORKSPACE_COMPOSITION_SOURCE_PATH} to choose one`
    );
    this.address = address;
    this.name = "ManifestEntryConflictError";
  }
}

interface OwnedValue<T> {
  value: T;
  nodeId: string;
  alias: string;
  ancestors: ReadonlySet<string>;
}

const canonical = (value: unknown): string => {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, visit(child)])
    );
  };
  return JSON.stringify(visit(value));
};

function parseMapping(content: string, label: string): unknown {
  const parsed: unknown = YAML.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a configuration mapping`);
  }
  return parsed;
}

export function parseWorkspaceConfigTopLayer(content: string): Manifest {
  return WorkspaceConfigTopLayerSchema.parse(
    parseMapping(content, WORKSPACE_COMPOSITION_SOURCE_PATH)
  );
}

export function parseWorkspaceConfigFragment(content: string, nodeId: string): FragmentManifest {
  return WorkspaceConfigFragmentSchema.parse(parseMapping(content, `meta/templates/${nodeId}.yml`));
}

function declarationKey(section: string, value: Record<string, unknown>): string {
  switch (section) {
    case "extensions":
    case "apps":
      return String(value["source"]);
    case "services":
      return `${String(value["source"])}/${String(value["name"])}`;
    case "routes":
      return `${String(value["source"])}${String(value["path"])}`;
    case "singletonObjects":
      return `${String(value["source"])}/${String(value["className"])}/${String(value["key"])}`;
    case "recurring":
    case "heartbeats":
      return String(value["name"]);
    default:
      throw new Error(`Unsupported layered declaration section ${section}`);
  }
}

const KEYED_SECTIONS = new Set([
  "extensions",
  "apps",
  "services",
  "routes",
  "singletonObjects",
  "recurring",
  "heartbeats",
]);

/**
 * Every inherited declaration has an address in the one `disable` namespace.
 * Lists use their schema-defined identity, scalar/map sections are one whole
 * declaration, and Git uses its already-canonical remote/upstream address.
 * The workspace layer is deliberately never disabled: redeclaring a value is
 * the general way to bring an inherited declaration back.
 */
function inheritedAddress(section: string, key: string): string {
  return `${section}/${key}`;
}

/**
 * A scalar/map section is one whole declaration, so its `disable` address is
 * the bare section name. Users author these by hand; `defaultRepo` reads far
 * better than a doubled `defaultRepo/defaultRepo`.
 */
function wholeSectionAddress(section: string): string {
  return section;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Project a mutation made against resolved configuration back onto the
 * workspace-authored layer. Unchanged inherited values are never copied.
 * Removing an inherited keyed declaration becomes an explicit `disable`.
 */
export function projectWorkspaceConfigMutationToTop(
  top: Manifest,
  current: WorkspaceConfig,
  next: WorkspaceConfig
): Manifest {
  const projected = structuredClone(top) as Record<string, unknown>;
  const disabled = new Set(top.disable ?? []);
  for (const section of Object.keys({ ...current, ...next })) {
    if (section === "id" || section === "systemEpoch") continue;
    const before = current[section as keyof WorkspaceConfig] as unknown;
    const after = next[section as keyof WorkspaceConfig] as unknown;
    if (canonical(before) === canonical(after)) continue;
    if (KEYED_SECTIONS.has(section)) {
      const topValues = Array.isArray(projected[section])
        ? (projected[section] as Array<Record<string, unknown>>)
        : [];
      const byKey = new Map(topValues.map((value) => [declarationKey(section, value), value]));
      const beforeByKey = new Map(
        (Array.isArray(before) ? before : []).map((value) => [
          declarationKey(section, value as Record<string, unknown>),
          value,
        ])
      );
      const afterByKey = new Map(
        (Array.isArray(after) ? after : []).map((value) => [
          declarationKey(section, value as Record<string, unknown>),
          value,
        ])
      );
      for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
        const prior = beforeByKey.get(key);
        const value = afterByKey.get(key);
        if (canonical(prior) === canonical(value)) continue;
        const disableKey = inheritedAddress(section, key);
        if (value === undefined) {
          byKey.delete(key);
          disabled.add(disableKey);
        } else {
          byKey.set(key, value as Record<string, unknown>);
          disabled.delete(disableKey);
        }
      }
      if (byKey.size > 0) projected[section] = [...byKey.values()];
      else delete projected[section];
      continue;
    }
    if (section === "git") {
      const topRemotes = flattenGitRemotes(top.git);
      const topUpstreams = flattenGitUpstreams(top.git);
      const currentRemotes = flattenGitRemotes(before as Manifest["git"]);
      const nextRemotes = flattenGitRemotes(after as Manifest["git"]);
      const currentUpstreams = flattenGitUpstreams(before as Manifest["git"]);
      const nextUpstreams = flattenGitUpstreams(after as Manifest["git"]);
      const projectGit = (
        kind: "remotes" | "upstreams",
        currentValues: Map<string, unknown>,
        nextValues: Map<string, unknown>,
        topValues: Map<string, unknown>
      ) => {
        for (const key of new Set([...currentValues.keys(), ...nextValues.keys()])) {
          const prior = currentValues.get(key);
          const value = nextValues.get(key);
          if (canonical(prior) === canonical(value)) continue;
          const address = inheritedAddress(`git.${kind}`, key);
          if (value === undefined) {
            topValues.delete(key);
            disabled.add(address);
          } else {
            topValues.set(key, structuredClone(value));
            disabled.delete(address);
          }
        }
      };
      projectGit("remotes", currentRemotes, nextRemotes, topRemotes);
      projectGit("upstreams", currentUpstreams, nextUpstreams, topUpstreams);
      const git: NonNullable<Manifest["git"]> = {};
      for (const [key, remote] of topRemotes) {
        const [repoSection, repo, name] = key.split("/");
        git.remotes ??= {};
        git.remotes[repoSection!] ??= {};
        git.remotes[repoSection!]![repo!] ??= {};
        git.remotes[repoSection!]![repo!]![name!] = remote as { url: string; branch?: string };
      }
      for (const [key, upstream] of topUpstreams) {
        const [repoSection, repo] = key.split("/");
        git.upstreams ??= {};
        git.upstreams[repoSection!] ??= {};
        git.upstreams[repoSection!]![repo!] = upstream as NonNullable<
          NonNullable<Manifest["git"]>["upstreams"]
        >[string][string];
      }
      if (git.remotes || git.upstreams) projected["git"] = git;
      else delete projected["git"];
      continue;
    }
    const address = wholeSectionAddress(section);
    if (after === undefined) {
      delete projected[section];
      disabled.add(address);
    } else {
      // Scalar/map sections are layer values, not recursively merged. A
      // partial projection would accidentally erase sibling map fields.
      projected[section] = structuredClone(after);
      disabled.delete(address);
    }
  }
  if (disabled.size > 0) projected["disable"] = [...disabled].sort();
  else delete projected["disable"];
  return WorkspaceConfigTopLayerSchema.parse(projected);
}

function insertOwned<T>(
  section: string,
  key: string,
  owned: OwnedValue<T>,
  values: Map<string, OwnedValue<T>>,
  workspaceKeys: ReadonlySet<string>
): void {
  const previous = values.get(key);
  if (
    previous &&
    !owned.ancestors.has(previous.nodeId) &&
    !previous.ancestors.has(owned.nodeId) &&
    !workspaceKeys.has(key)
  ) {
    throw new ManifestEntryConflictError(section, key, [previous.alias, owned.alias]);
  }
  values.set(key, owned);
}

function layerArraySection(
  section: keyof Manifest,
  layers: readonly WorkspaceConfigFragmentLayer[],
  top: Manifest,
  disabled: ReadonlySet<string>
): unknown[] | undefined {
  const topValues = (top[section] as unknown[] | undefined) ?? [];
  const topByKey = new Map(
    topValues.map((value) => [declarationKey(section, value as Record<string, unknown>), value])
  );
  const inherited = new Map<string, OwnedValue<unknown>>();
  for (const layer of layers) {
    const values = (layer.config[section as keyof FragmentManifest] as unknown[] | undefined) ?? [];
    for (const value of values) {
      const key = declarationKey(section, value as Record<string, unknown>);
      // Two unrelated templates agreeing byte-for-byte are not in conflict;
      // there is nothing for the workspace to choose between. Matches the
      // equality bypass `composeGit` already applies.
      const prior = inherited.get(key);
      if (prior && canonical(prior.value) === canonical(value)) continue;
      insertOwned(
        section,
        key,
        {
          value,
          nodeId: layer.nodeId,
          alias: layer.alias,
          ancestors: new Set(layer.ancestors),
        },
        inherited,
        new Set(topByKey.keys())
      );
    }
  }
  for (const key of [...inherited.keys()]) {
    if (disabled.has(inheritedAddress(section, key))) inherited.delete(key);
  }
  const merged = new Map<string, unknown>([...inherited].map(([key, owned]) => [key, owned.value]));
  for (const [key, value] of topByKey) merged.set(key, value);
  return merged.size > 0 ? [...merged.values()] : undefined;
}

/**
 * Resolve one whole-value section across the template layers. A scalar section
 * is subject to the same ownership rule as a keyed one: a descendant may
 * override its ancestor, but two unrelated templates cannot silently decide it
 * by layer order — that order tie-breaks on content-addressed node ids, so the
 * winner would flip whenever an unrelated pin moved.
 */
function layerWholeSection(
  section: keyof Manifest,
  layers: readonly WorkspaceConfigFragmentLayer[],
  top: Manifest,
  disabled: ReadonlySet<string>
): unknown {
  if (top[section] !== undefined) return top[section];
  const owned = new Map<string, OwnedValue<unknown>>();
  for (const layer of layers) {
    const value = layer.config[section as keyof FragmentManifest];
    if (value === undefined) continue;
    const prior = owned.get(section);
    if (prior && canonical(prior.value) === canonical(value)) continue;
    insertOwned(
      section,
      section,
      {
        value,
        nodeId: layer.nodeId,
        alias: layer.alias,
        ancestors: new Set(layer.ancestors),
      },
      owned,
      // The workspace layer does not declare it; that case returned above.
      new Set()
    );
  }
  const selected = owned.get(section);
  if (!selected || disabled.has(wholeSectionAddress(section))) return undefined;
  return selected.value;
}

function flattenGitRemotes(git: Manifest["git"]): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [section, repos] of Object.entries(git?.remotes ?? {})) {
    for (const [repo, remotes] of Object.entries(repos)) {
      for (const [name, remote] of Object.entries(remotes)) {
        values.set(`${section}/${repo}/${name}`, {
          ...remote,
          url: normalizeRemoteUrl(remote.url),
        });
      }
    }
  }
  return values;
}

function flattenGitUpstreams(git: Manifest["git"]): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const [section, repos] of Object.entries(git?.upstreams ?? {})) {
    for (const [repo, upstream] of Object.entries(repos)) {
      values.set(`${section}/${repo}`, upstream);
    }
  }
  return values;
}

function composeGit(
  layers: readonly WorkspaceConfigFragmentLayer[],
  top: Manifest,
  disabled: ReadonlySet<string>
): Manifest["git"] {
  const topRemotes = flattenGitRemotes(top.git);
  const topUpstreams = flattenGitUpstreams(top.git);
  const remotes = new Map<string, OwnedValue<unknown>>();
  const upstreams = new Map<string, OwnedValue<unknown>>();
  for (const layer of layers) {
    for (const [key, value] of flattenGitRemotes(layer.config.git)) {
      const prior = remotes.get(key);
      if (prior && canonical(prior.value) === canonical(value)) continue;
      insertOwned(
        "git.remotes",
        key,
        {
          value,
          nodeId: layer.nodeId,
          alias: layer.alias,
          ancestors: new Set(layer.ancestors),
        },
        remotes,
        new Set(topRemotes.keys())
      );
    }
    for (const [key, value] of flattenGitUpstreams(layer.config.git)) {
      const prior = upstreams.get(key);
      if (prior && canonical(prior.value) === canonical(value)) continue;
      insertOwned(
        "git.upstreams",
        key,
        {
          value,
          nodeId: layer.nodeId,
          alias: layer.alias,
          ancestors: new Set(layer.ancestors),
        },
        upstreams,
        new Set(topUpstreams.keys())
      );
    }
  }
  const remoteValues = new Map(
    [...remotes].map(([key, owned]) => [key, owned.value as { url: string; branch?: string }])
  );
  for (const [key, value] of topRemotes) {
    remoteValues.set(key, value as { url: string; branch?: string });
  }
  const upstreamValues = new Map(
    [...upstreams].map(([key, owned]) => [key, owned.value as Record<string, unknown>])
  );
  for (const [key, value] of topUpstreams) {
    upstreamValues.set(key, value as Record<string, unknown>);
  }
  for (const key of [...remoteValues.keys()]) {
    if (!topRemotes.has(key) && disabled.has(inheritedAddress("git.remotes", key))) {
      remoteValues.delete(key);
    }
  }
  for (const key of [...upstreamValues.keys()]) {
    if (!topUpstreams.has(key) && disabled.has(inheritedAddress("git.upstreams", key))) {
      upstreamValues.delete(key);
    }
  }
  if (remoteValues.size === 0 && upstreamValues.size === 0) return undefined;
  const result: NonNullable<Manifest["git"]> = {};
  for (const [key, remote] of remoteValues) {
    const [section, repo, name] = key.split("/");
    result.remotes ??= {};
    result.remotes[section!] ??= {};
    result.remotes[section!]![repo!] ??= {};
    result.remotes[section!]![repo!]![name!] = remote;
  }
  for (const [key, upstream] of upstreamValues) {
    const [section, repo] = key.split("/");
    result.upstreams ??= {};
    result.upstreams[section!] ??= {};
    result.upstreams[section!]![repo!] = upstream as unknown as NonNullable<
      NonNullable<Manifest["git"]>["upstreams"]
    >[string][string];
  }
  validateWorkspaceGitConfig(result);
  return result;
}

/**
 * Compose sanitized template layers in topological order, then apply the
 * workspace-authored layer. Unrelated templates never shadow each other by
 * ordering; the workspace resolves those conflicts by redeclaration.
 */
export function composeWorkspaceConfig(
  top: Manifest,
  layers: readonly WorkspaceConfigFragmentLayer[],
  workspaceId: string
): WorkspaceConfig {
  const seen = new Set<string>();
  for (const layer of layers) {
    if (seen.has(layer.nodeId)) throw new Error(`Duplicate template layer ${layer.nodeId}`);
    for (const ancestor of layer.ancestors) {
      if (!seen.has(ancestor)) {
        throw new Error(`Template layer ${layer.nodeId} precedes ancestor ${ancestor}`);
      }
    }
    if (layer.config.systemEpoch !== top.systemEpoch) {
      throw new Error(
        `Template ${layer.alias} systemEpoch ${layer.config.systemEpoch} is incompatible with workspace epoch ${top.systemEpoch}`
      );
    }
    seen.add(layer.nodeId);
  }
  const disabled = new Set(top.disable ?? []);
  const resolved: Record<string, unknown> = {
    id: workspaceId,
    systemEpoch: top.systemEpoch,
  };
  const wholeValueSections = [
    "defaultRepo",
    "panelRestorePolicy",
    "defaultAgentConfig",
    "hostTargets",
    "initPanels",
  ] as const;
  for (const section of wholeValueSections) {
    const value = layerWholeSection(section, layers, top, disabled);
    if (value !== undefined) resolved[section] = value;
  }

  for (const section of [
    "extensions",
    "apps",
    "services",
    "routes",
    "singletonObjects",
    "recurring",
    "heartbeats",
  ] as const) {
    const values = layerArraySection(section, layers, top, disabled);
    if (values) resolved[section] = values;
  }
  const git = composeGit(layers, top, disabled);
  if (git) resolved["git"] = git;
  for (const workspaceOnly of ["providers", "trust"] as const) {
    if (top[workspaceOnly] !== undefined) resolved[workspaceOnly] = top[workspaceOnly];
  }
  return WorkspaceConfigSchema.parse(resolved);
}
