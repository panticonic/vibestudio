import { Buffer } from "node:buffer";
import YAML from "yaml";
import {
  canonicalJson,
  compareUtf16CodeUnits,
  sha256HexSyncText,
  sortForCanonicalJson,
} from "@vibestudio/content-addressing";
import type { VcsReadFileResult, VcsResolveRepositoryResult } from "@vibestudio/service-schemas/vcs";
import { normalizeWorkspaceRepoPath } from "@vibestudio/workspace/remotes";
import {
  WorkspaceConfigTopLayerSchema,
  WorkspaceTemplateDeclarationSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { WORKSPACE_PACKAGE_SCOPES } from "@vibestudio/workspace-contracts/sourceDirs";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { ExtensionContextLike } from "./context.js";
import type { SemanticWorkspaceObservation } from "./workspace.js";

const META_REPOSITORY = "meta";
const WORKSPACE_DEPENDENCY = "workspace:";

function isAuthoredWorkspacePackage(name: string): boolean {
  return WORKSPACE_PACKAGE_SCOPES.some((scope) => name.startsWith(scope));
}

export interface TemplateAuthoringRequest {
  name: string;
  description: string;
  parts: string[];
  parents?: string[];
}

export interface TemplateAuthoringInspection {
  request: TemplateAuthoringRequest;
  mainEventId: string;
  selectableParts: string[];
  requestedParts: string[];
  includedParts: string[];
  requiredParts: string[];
  inheritedParts: string[];
  parents: Array<{ alias: string; url: string; credential?: string }>;
  manifest: string;
  manifestDigest: `v1-sha256:${string}`;
  fingerprint: `v1-sha256:${string}`;
}

export interface TemplateAuthoringPart {
  repoPath: string;
  packageName?: string;
  templateAlias?: string;
}

function text(file: NonNullable<VcsReadFileResult>): string {
  return file.content.kind === "text"
    ? file.content.text
    : Buffer.from(file.content.base64, "base64").toString("utf8");
}

function canonicalYaml(value: unknown): string {
  return YAML.stringify(sortForCanonicalJson(value), {
    lineWidth: 0,
    sortMapEntries: true,
  });
}

function sourceOf(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = (value as { source?: unknown }).source;
  return typeof source === "string" ? source : null;
}

function targetSourceOf(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = (value as { target?: unknown }).target;
  return sourceOf(target);
}

function selectedRecords<T>(
  values: readonly T[] | undefined,
  selected: ReadonlySet<string>,
  source: (value: T) => string | null = sourceOf
): T[] | undefined {
  const result = (values ?? []).filter((value) => {
    const repoPath = source(value);
    return repoPath !== null && selected.has(repoPath);
  });
  return result.length ? result : undefined;
}

function selectedGitMap<T>(
  value: Record<string, Record<string, T>> | undefined,
  selected: ReadonlySet<string>
): Record<string, Record<string, T>> | undefined {
  if (!value) return undefined;
  const result: Record<string, Record<string, T>> = {};
  for (const [section, repos] of Object.entries(value)) {
    const kept = Object.fromEntries(
      Object.entries(repos).filter(([repo]) => selected.has(`${section}/${repo}`))
    );
    if (Object.keys(kept).length) result[section] = kept;
  }
  return Object.keys(result).length ? result : undefined;
}

function projectManifest(
  config: WorkspaceConfig,
  selected: ReadonlySet<string>,
  parents: TemplateAuthoringInspection["parents"],
  includeWorkspaceDefaults: boolean
): string {
  const upstreams = selectedGitMap(config.git?.upstreams, selected);
  const portableUpstreams = upstreams
    ? Object.fromEntries(
        Object.entries(upstreams).map(([section, repos]) => [
          section,
          Object.fromEntries(
            Object.entries(repos).map(([repo, upstream]) => {
              const { authorEmail: _email, authorName: _name, ...portable } = upstream;
              return [repo, portable];
            })
          ),
        ])
      )
    : undefined;
  const providers = config.providers
    ? Object.fromEntries(
        Object.entries(config.providers).filter(([, declaration]) => {
          if (!declaration) return false;
          const ref =
            "source" in declaration
              ? declaration.source
              : "extension" in declaration
                ? declaration.extension
                : null;
          return ref !== null && selected.has(ref);
        })
      )
    : undefined;
  const trust = config.trust
    ? Object.fromEntries(
        Object.entries(config.trust)
          .map(([key, values]) => [
            key,
            values?.filter((repoPath: string) => selected.has(repoPath)),
          ])
          .filter(([, values]) => Array.isArray(values) && values.length > 0)
      )
    : undefined;
  const hostTargets = config.hostTargets
    ? Object.fromEntries(
        Object.entries(config.hostTargets).filter(([, target]) => target && selected.has(target.app))
      )
    : undefined;
  return canonicalYaml(
    WorkspaceConfigTopLayerSchema.parse({
      systemEpoch: config.systemEpoch,
      templates: {
        use: parents.map(({ url, credential }) =>
          WorkspaceTemplateDeclarationSchema.parse({
            url,
            ...(credential ? { credential } : {}),
          })
        ),
      },
      ...(config.defaultRepo && selected.has(config.defaultRepo)
        ? { defaultRepo: config.defaultRepo }
        : {}),
      ...(selectedRecords(config.initPanels, selected) ? { initPanels: selectedRecords(config.initPanels, selected) } : {}),
      ...(selectedRecords(config.singletonObjects, selected)
        ? { singletonObjects: selectedRecords(config.singletonObjects, selected) }
        : {}),
      ...(selectedRecords(config.services, selected)
        ? { services: selectedRecords(config.services, selected) }
        : {}),
      ...(selectedRecords(config.routes, selected)
        ? { routes: selectedRecords(config.routes, selected) }
        : {}),
      ...(selectedRecords(config.extensions, selected)
        ? { extensions: selectedRecords(config.extensions, selected) }
        : {}),
      ...(selectedRecords(config.recurring, selected, targetSourceOf)
        ? { recurring: selectedRecords(config.recurring, selected, targetSourceOf) }
        : {}),
      ...(selectedRecords(config.heartbeats, selected, targetSourceOf)
        ? { heartbeats: selectedRecords(config.heartbeats, selected, targetSourceOf) }
        : {}),
      ...(selectedRecords(config.apps, selected)
        ? { apps: selectedRecords(config.apps, selected) }
        : {}),
      ...(includeWorkspaceDefaults && config.panelRestorePolicy
        ? { panelRestorePolicy: config.panelRestorePolicy }
        : {}),
      ...(includeWorkspaceDefaults && config.defaultAgentConfig
        ? { defaultAgentConfig: config.defaultAgentConfig }
        : {}),
      ...(config.git && (selectedGitMap(config.git.remotes, selected) || portableUpstreams)
        ? {
            git: {
              ...(selectedGitMap(config.git.remotes, selected)
                ? { remotes: selectedGitMap(config.git.remotes, selected) }
                : {}),
              ...(portableUpstreams ? { upstreams: portableUpstreams } : {}),
            },
          }
        : {}),
      ...(providers && Object.keys(providers).length ? { providers } : {}),
      ...(trust && Object.keys(trust).length ? { trust } : {}),
      ...(hostTargets && Object.keys(hostTargets).length ? { hostTargets } : {}),
    })
  );
}

async function repository(
  ctx: ExtensionContextLike,
  observation: SemanticWorkspaceObservation,
  repoPath: string
): Promise<NonNullable<VcsResolveRepositoryResult>> {
  const resolved = await ctx.rpc.call<VcsResolveRepositoryResult>("main", "vcs.resolveRepository", {
    state: observation.mainState,
    repoPath,
  });
  if (!resolved) throw new Error(`Workspace repository ${repoPath} disappeared`);
  return resolved;
}

async function packageMetadata(
  ctx: ExtensionContextLike,
  observation: SemanticWorkspaceObservation,
  repoPath: string
): Promise<{ name?: string; dependencies: string[] }> {
  const resolved = await repository(ctx, observation, repoPath);
  const file = await ctx.rpc.call<VcsReadFileResult>("main", "vcs.readFile", {
    state: observation.mainState,
    repositoryId: resolved.repositoryId,
    file: { kind: "path", path: "package.json" },
  });
  if (!file) return { dependencies: [] };
  let parsed: {
    name?: unknown;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(text(file)) as typeof parsed;
  } catch {
    throw new Error(`${repoPath}/package.json is not valid JSON`);
  }
  const dependencies = [
    ...Object.entries(parsed.dependencies ?? {}),
    ...Object.entries(parsed.devDependencies ?? {}),
    ...Object.entries(parsed.peerDependencies ?? {}),
    ...Object.entries(parsed.optionalDependencies ?? {}),
  ]
    .filter(
      ([name, version]) =>
        isAuthoredWorkspacePackage(name) &&
        typeof version === "string" &&
        version.startsWith(WORKSPACE_DEPENDENCY)
    )
    .map(([name]) => name);
  return {
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    dependencies: [...new Set(dependencies)].sort(compareUtf16CodeUnits),
  };
}

function runtimeReferences(config: WorkspaceConfig): Array<[owner: string, target: string]> {
  const refs: Array<[string, string]> = [];
  const add = (owner: string | null, target: string | null) => {
    if (owner && target) refs.push([owner, target]);
  };
  for (const item of config.initPanels ?? []) add(item.source, item.source);
  for (const item of config.singletonObjects ?? []) add(item.source, item.source);
  for (const item of config.services ?? []) add(item.source, item.source);
  for (const item of config.routes ?? []) add(item.source, item.source);
  for (const item of config.recurring ?? []) add(item.target.source, item.target.source);
  for (const item of config.heartbeats ?? []) add(item.target.source, item.target.source);
  for (const target of Object.values(config.hostTargets ?? {})) {
    if (!target) continue;
    for (const extension of target.requiresExtensions ?? []) add(target.app, extension);
  }
  return refs;
}

export async function inspectTemplateAuthoring(
  ctx: ExtensionContextLike,
  observation: SemanticWorkspaceObservation,
  rawRequest: TemplateAuthoringRequest
): Promise<TemplateAuthoringInspection> {
  const name = rawRequest.name.trim();
  const description = rawRequest.description.trim();
  if (!name) throw new Error("Template name is required");
  if (!description) throw new Error("Template description is required");
  const selectableParts = [...observation.localRepoPaths, ...Object.keys(observation.lock?.repositories ?? {})]
    .filter((repoPath) => repoPath !== META_REPOSITORY)
    .map(normalizeWorkspaceRepoPath)
    .sort(compareUtf16CodeUnits);
  const selectable = new Set(selectableParts);
  const requestedParts = [...new Set(rawRequest.parts.map(normalizeWorkspaceRepoPath))].sort(
    compareUtf16CodeUnits
  );
  if (!requestedParts.length) throw new Error("Choose at least one workspace part");
  for (const repoPath of requestedParts) {
    if (!selectable.has(repoPath)) throw new Error(`Unknown workspace repository ${repoPath}`);
  }
  const parentAliases = [...new Set(rawRequest.parents ?? [])].sort(compareUtf16CodeUnits);
  const parentNodes = parentAliases.map((alias) => {
    const node = observation.lock?.nodes.find((candidate) => candidate.alias === alias);
    if (!node) throw new Error(`Unknown installed parent template ${alias}`);
    return node;
  });
  const parentNodeIds = new Set(parentNodes.map((node) => node.nodeId));
  let addedParent = true;
  while (addedParent) {
    addedParent = false;
    for (const nodeId of [...parentNodeIds]) {
      const node = observation.lock?.nodes.find((candidate) => candidate.nodeId === nodeId);
      for (const parentNodeId of node?.parents ?? []) {
        if (parentNodeIds.has(parentNodeId)) continue;
        parentNodeIds.add(parentNodeId);
        addedParent = true;
      }
    }
  }
  const inherited = new Set(
    Object.entries(observation.lock?.repositories ?? {})
      .filter(([, ownership]) => parentNodeIds.has(ownership.nodeId))
      .map(([repoPath]) => repoPath)
  );
  for (const repoPath of requestedParts) {
    if (inherited.has(repoPath)) {
      throw new Error(
        `${repoPath} is already supplied by a selected parent; remove it from parts or remove that parent`
      );
    }
  }

  const metadata = new Map(
    await Promise.all(
      selectableParts.map(
        async (repoPath) => [repoPath, await packageMetadata(ctx, observation, repoPath)] as const
      )
    )
  );
  const packageOwners = new Map<string, string>();
  for (const [repoPath, value] of metadata) {
    if (!value.name) continue;
    const existing = packageOwners.get(value.name);
    if (existing && existing !== repoPath) {
      throw new Error(`Workspace package name ${value.name} is claimed by ${existing} and ${repoPath}`);
    }
    packageOwners.set(value.name, repoPath);
  }

  const included = new Set(requestedParts);
  const required = new Set<string>();
  const inheritedRequired = new Set<string>();
  const runtime = runtimeReferences(observation.runtimeTop as WorkspaceConfig);
  let changed = true;
  while (changed) {
    changed = false;
    for (const repoPath of [...included]) {
      for (const dependency of metadata.get(repoPath)?.dependencies ?? []) {
        const owner = packageOwners.get(dependency);
        if (!owner) {
          throw new Error(`${repoPath} depends on missing workspace package ${dependency}`);
        }
        if (inherited.has(owner)) {
          inheritedRequired.add(owner);
        } else if (!included.has(owner)) {
          included.add(owner);
          required.add(owner);
          changed = true;
        }
      }
      for (const [owner, target] of runtime) {
        if (owner !== repoPath || included.has(target)) continue;
        if (!selectable.has(target)) throw new Error(`${repoPath} references missing workspace part ${target}`);
        if (inherited.has(target)) inheritedRequired.add(target);
        else {
          included.add(target);
          required.add(target);
          changed = true;
        }
      }
    }
  }

  const parents = parentNodes.map((node) => ({
    alias: node.alias,
    url: node.pin.url,
    ...(node.pin.credential ? { credential: node.pin.credential } : {}),
  }));
  const includedParts = [...included].sort(compareUtf16CodeUnits);
  const manifest = projectManifest(
    observation.runtimeTop as WorkspaceConfig,
    new Set(includedParts),
    parents,
    includedParts.length + inherited.size === selectableParts.length
  );
  const manifestDigest = `v1-sha256:${sha256HexSyncText(manifest)}` as const;
  const request: TemplateAuthoringRequest = {
    name,
    description,
    parts: requestedParts,
    ...(parentAliases.length ? { parents: parentAliases } : {}),
  };
  const body = {
    protocol: "vibestudio-template-authoring-plan-v1",
    request,
    mainEventId: observation.mainEventId,
    includedParts,
    inheritedParts: [...inheritedRequired].sort(compareUtf16CodeUnits),
    parents,
    manifestDigest,
  };
  return {
    request,
    mainEventId: observation.mainEventId,
    selectableParts,
    requestedParts,
    includedParts,
    requiredParts: [...required].sort(compareUtf16CodeUnits),
    inheritedParts: [...inheritedRequired].sort(compareUtf16CodeUnits),
    parents,
    manifest,
    manifestDigest,
    fingerprint: `v1-sha256:${sha256HexSyncText(canonicalJson(body))}`,
  };
}

export async function listTemplateAuthoringParts(
  ctx: ExtensionContextLike,
  observation: SemanticWorkspaceObservation
): Promise<TemplateAuthoringPart[]> {
  const repoPaths = [
    ...observation.localRepoPaths,
    ...Object.keys(observation.lock?.repositories ?? {}),
  ]
    .filter((repoPath) => repoPath !== META_REPOSITORY)
    .map(normalizeWorkspaceRepoPath)
    .sort(compareUtf16CodeUnits);
  const aliases = new Map(
    (observation.lock?.nodes ?? []).map((node) => [node.nodeId, node.alias])
  );
  return Promise.all(
    repoPaths.map(async (repoPath) => {
      const metadata = await packageMetadata(ctx, observation, repoPath);
      const owner = observation.lock?.repositories?.[repoPath];
      const templateAlias = owner ? aliases.get(owner.nodeId) : undefined;
      return {
        repoPath,
        ...(metadata.name ? { packageName: metadata.name } : {}),
        ...(templateAlias ? { templateAlias } : {}),
      };
    })
  );
}
