import { Buffer } from "node:buffer";
import YAML from "yaml";
import {
  canonicalJson,
  compareUtf16CodeUnits,
  sha256HexSyncText,
  sortForCanonicalJson,
} from "@vibestudio/content-addressing";
import type {
  VcsReadFileResult,
  VcsResolveRepositoryResult,
} from "@vibestudio/service-schemas/vcs";
import type {
  TemplateAuthoringInspection,
  TemplateAuthoringIntent,
} from "@vibestudio/service-schemas/templates";
import { normalizeWorkspaceRepoPath } from "@vibestudio/workspace/remotes";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
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

export interface TemplateAuthoringPart {
  repoPath: string;
  packageName?: string;
  templateAliases?: string[];
  templateUrls?: string[];
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
  dependencies: NonNullable<TemplateAuthoringIntent["dependencies"]>,
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
        Object.entries(config.hostTargets).filter(
          ([, target]) => target && selected.has(target.app)
        )
      )
    : undefined;
  return canonicalYaml(
    WorkspaceConfigTopLayerSchema.parse({
      systemEpoch: config.systemEpoch,
      templates: {
        use: dependencies,
      },
      ...(config.defaultRepo && selected.has(config.defaultRepo)
        ? { defaultRepo: config.defaultRepo }
        : {}),
      ...(selectedRecords(config.initPanels, selected)
        ? { initPanels: selectedRecords(config.initPanels, selected) }
        : {}),
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
  return parsePackageMetadata(repoPath, text(file));
}

function parsePackageMetadata(
  repoPath: string,
  source: string
): { name?: string; dependencies: string[] } {
  let parsed: {
    name?: unknown;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(source) as typeof parsed;
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

interface ResolvedAuthoringDependencies {
  dependencies: NonNullable<TemplateAuthoringIntent["dependencies"]>;
  dependencyParts: string[];
}

function resolveAuthoringDependencies(
  request: TemplateAuthoringIntent,
  observation: SemanticWorkspaceObservation
): ResolvedAuthoringDependencies {
  const dependencies = (request.dependencies ?? []).map((dependency) =>
    WorkspaceTemplateDeclarationSchema.parse({
      ...dependency,
      url: normalizeTemplateGitUrl(dependency.url),
    })
  );
  if (!dependencies.length) return { dependencies: [], dependencyParts: [] };
  if (!observation.state) return { dependencies, dependencyParts: [] };

  const nodesById = new Map(observation.state.nodes.map((node) => [node.nodeId, node]));
  const nodesByUrl = new Map(
    observation.state.nodes.map((node) => [normalizeTemplateGitUrl(node.pin.url), node])
  );
  const inheritedNodeIds = new Set<string>();
  const include = (nodeId: string) => {
    if (inheritedNodeIds.has(nodeId)) return;
    const node = nodesById.get(nodeId);
    if (!node) throw new Error(`Installed template closure is missing node ${nodeId}`);
    inheritedNodeIds.add(nodeId);
    node.parents.forEach(include);
  };
  for (const dependency of dependencies) {
    const node = nodesByUrl.get(dependency.url);
    if (node) include(node.nodeId);
  }
  return {
    dependencies,
    dependencyParts: Object.entries(observation.state.repositories)
      .filter(([, repository]) =>
        repository.contributions.some(({ nodeId }) => inheritedNodeIds.has(nodeId))
      )
      .map(([repoPath]) => normalizeWorkspaceRepoPath(repoPath))
      .sort(compareUtf16CodeUnits),
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

type AuthoringPackageMetadata = { name?: string; dependencies: string[] };

async function workspacePackageMetadata(
  ctx: ExtensionContextLike,
  observation: SemanticWorkspaceObservation,
  repoPaths: readonly string[]
): Promise<ReadonlyMap<string, AuthoringPackageMetadata>> {
  const entries: Array<readonly [string, AuthoringPackageMetadata]> = [];
  // A full workspace can contain hundreds of repositories. Keep semantic VCS
  // reads concurrent without flooding the extension RPC lane with an
  // unbounded Promise.all fan-out.
  const concurrency = 8;
  for (let offset = 0; offset < repoPaths.length; offset += concurrency) {
    entries.push(
      ...(await Promise.all(
        repoPaths
          .slice(offset, offset + concurrency)
          .map(
            async (repoPath) =>
              [repoPath, await packageMetadata(ctx, observation, repoPath)] as const
          )
      ))
    );
  }
  return new Map(entries);
}

export async function inspectTemplateAuthoring(
  ctx: ExtensionContextLike,
  observation: SemanticWorkspaceObservation,
  rawRequest: TemplateAuthoringIntent
): Promise<TemplateAuthoringInspection> {
  const name = rawRequest.name.trim();
  const description = rawRequest.description.trim();
  if (!name) throw new Error("Template name is required");
  if (!description) throw new Error("Template description is required");
  const resolvedDependencies = resolveAuthoringDependencies(rawRequest, observation);
  const inherited = new Set(resolvedDependencies.dependencyParts);
  const selectableParts = [
    ...new Set([
      ...observation.localRepoPaths,
      ...Object.keys(observation.state?.repositories ?? {}),
    ]),
  ]
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

  const metadata = await workspacePackageMetadata(ctx, observation, selectableParts);
  const packageOwners = new Map<string, string>();
  for (const [repoPath, value] of metadata) {
    if (!value.name) continue;
    const existing = packageOwners.get(value.name);
    if (existing && existing !== repoPath) {
      throw new Error(
        `Workspace package name ${value.name} is claimed by ${existing} and ${repoPath}`
      );
    }
    packageOwners.set(value.name, repoPath);
  }

  const included = new Set(requestedParts);
  const required = new Set<string>();
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
        if (!inherited.has(owner) && !included.has(owner)) {
          included.add(owner);
          required.add(owner);
          changed = true;
        }
      }
      for (const [owner, target] of runtime) {
        if (owner !== repoPath || included.has(target)) continue;
        if (!selectable.has(target) && !inherited.has(target))
          throw new Error(`${repoPath} references missing workspace part ${target}`);
        if (!inherited.has(target)) {
          included.add(target);
          required.add(target);
          changed = true;
        }
      }
    }
  }

  const includedParts = [...included].sort(compareUtf16CodeUnits);
  const overlapParts = requestedParts.filter((repoPath) => inherited.has(repoPath));
  const manifest = projectManifest(
    observation.runtimeTop as WorkspaceConfig,
    new Set(includedParts),
    resolvedDependencies.dependencies,
    selectableParts.every((repoPath) => included.has(repoPath) || inherited.has(repoPath))
  );
  const manifestDigest = `v1-sha256:${sha256HexSyncText(manifest)}` as const;
  const request: TemplateAuthoringIntent = {
    name,
    description,
    parts: requestedParts,
    ...(resolvedDependencies.dependencies.length
      ? { dependencies: resolvedDependencies.dependencies }
      : {}),
  };
  const body = {
    protocol: "vibestudio-template-authoring-plan-v1",
    request,
    mainEventId: observation.mainEventId,
    includedParts,
    dependencyParts: resolvedDependencies.dependencyParts,
    overlapParts,
    manifestDigest,
  };
  return {
    request,
    mainEventId: observation.mainEventId,
    selectableParts,
    requestedParts,
    includedParts,
    requiredParts: [...required].sort(compareUtf16CodeUnits),
    dependencyParts: resolvedDependencies.dependencyParts,
    overlapParts,
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
    ...new Set([
      ...observation.localRepoPaths,
      ...Object.keys(observation.state?.repositories ?? {}),
    ]),
  ]
    .filter((repoPath) => repoPath !== META_REPOSITORY)
    .map(normalizeWorkspaceRepoPath)
    .sort(compareUtf16CodeUnits);
  const aliases = new Map(
    (observation.state?.nodes ?? []).map((node) => [node.nodeId, node.alias])
  );
  const urls = new Map((observation.state?.nodes ?? []).map((node) => [node.nodeId, node.pin.url]));
  return Promise.all(
    repoPaths.map(async (repoPath) => {
      const metadata = await packageMetadata(ctx, observation, repoPath);
      const contributions = observation.state?.repositories?.[repoPath]?.contributions ?? [];
      const templateAliases = contributions
        .map(({ nodeId }) => aliases.get(nodeId))
        .filter((alias): alias is string => alias !== undefined);
      const templateUrls = contributions
        .map(({ nodeId }) => urls.get(nodeId))
        .filter((url): url is string => url !== undefined);
      return {
        repoPath,
        ...(metadata.name ? { packageName: metadata.name } : {}),
        ...(templateAliases.length ? { templateAliases } : {}),
        ...(templateUrls.length ? { templateUrls } : {}),
      };
    })
  );
}
