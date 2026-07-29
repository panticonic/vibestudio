import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import YAML from "yaml";
import type {
  VcsListDirectoryResult,
  VcsReadFileResult,
  VcsResolveRepositoryResult,
  VcsStateNodeRef,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import {
  WorkspaceConfigSchema,
  WorkspaceConfigTopLayerSchema,
  WorkspaceCreationDescriptorSchema,
} from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceConfig,
  WorkspaceCreationDescriptor,
  WorkspaceTemplateLock,
} from "@vibestudio/workspace-contracts/types";
import { assertTemplateLockIntegrityForRead } from "@vibestudio/workspace/templateLock";
import {
  WORKSPACE_COMPOSITION_SOURCE_PATH,
  composeWorkspaceConfig,
  parseWorkspaceConfigFragment,
  projectWorkspaceConfigMutationToTop,
} from "@vibestudio/workspace/configComposition";
import type { TemplateWorkspaceObservation } from "@workspace/template-composer";
import type { ExtensionContextLike } from "./context.js";
import { listSemanticRepositoryFiles, semanticRepositoryDigest } from "./semanticRepository.js";

export const OBSERVATION_CONTEXT = "template-composer-observation";
export const META_REPOSITORY = "meta";
export const TOP_CONFIG_PATH = "vibestudio.yml";
export const LOCK_PATH = "templates.lock.yml";
export const COMPOSITION_SOURCE_PATH = WORKSPACE_COMPOSITION_SOURCE_PATH.slice("meta/".length);

export interface SemanticWorkspaceObservation extends TemplateWorkspaceObservation {
  workspaceId: string;
  mainEventId: string;
  mainState: VcsStateNodeRef;
  runtimeTop: WorkspaceRuntimeManifest;
  top: ReturnType<typeof WorkspaceConfigTopLayerSchema.parse>;
  metaRepository: NonNullable<VcsResolveRepositoryResult>;
  modifiedTemplateRepoPaths: ReadonlySet<string>;
}

type WorkspaceTopLayer = ReturnType<typeof WorkspaceConfigTopLayerSchema.parse>;
type WorkspaceRuntimeManifest = Omit<WorkspaceConfig, "id">;

/**
 * A bootstrap template owns portable runtime declarations. These declarations
 * remain workspace-owned because inheriting them would grant authority or
 * erase an explicit local suppression.
 */
export function bootstrapWorkspaceSource(
  runtimeTop: WorkspaceRuntimeManifest,
  templates: WorkspaceTopLayer["templates"] = { use: [] }
): WorkspaceTopLayer {
  const authoredUpstreams = Object.fromEntries(
    Object.entries(runtimeTop.git?.upstreams ?? {}).flatMap(([section, repositories]) => {
      const authored = Object.fromEntries(
        Object.entries(repositories).filter(
          ([, upstream]) => upstream.authorName !== undefined || upstream.authorEmail !== undefined
        )
      );
      return Object.keys(authored).length > 0 ? [[section, authored]] : [];
    })
  );
  return WorkspaceConfigTopLayerSchema.parse({
    systemEpoch: runtimeTop.systemEpoch,
    templates,
    ...(runtimeTop.providers ? { providers: runtimeTop.providers } : {}),
    ...(runtimeTop.trust ? { trust: runtimeTop.trust } : {}),
    ...(Object.keys(authoredUpstreams).length > 0 ? { git: { upstreams: authoredUpstreams } } : {}),
  });
}

export function projectBootstrapRuntimeToSource(
  runtimeTop: WorkspaceRuntimeManifest,
  nodes: readonly {
    nodeId: string;
    alias: string;
    parents: readonly string[];
    fragment: Parameters<typeof composeWorkspaceConfig>[1][number]["config"];
  }[],
  workspaceId: string,
  templates: WorkspaceTopLayer["templates"] = { use: [] }
): WorkspaceTopLayer {
  const source = bootstrapWorkspaceSource(runtimeTop, templates);
  const ancestors = new Map<string, Set<string>>();
  const layers = nodes.map((node) => {
    const inherited = new Set<string>();
    for (const parent of node.parents) {
      inherited.add(parent);
      for (const ancestor of ancestors.get(parent) ?? []) inherited.add(ancestor);
    }
    ancestors.set(node.nodeId, inherited);
    return {
      nodeId: node.nodeId,
      alias: node.alias,
      ancestors: [...inherited],
      config: node.fragment,
    };
  });
  const expected = composeWorkspaceConfig(source, layers, workspaceId);
  return WorkspaceConfigTopLayerSchema.parse(
    projectWorkspaceConfigMutationToTop(source, expected, {
      ...runtimeTop,
      id: workspaceId,
    })
  );
}

function textContent(file: NonNullable<VcsReadFileResult>): string {
  return file.content.kind === "text"
    ? file.content.text
    : Buffer.from(file.content.base64, "base64").toString("utf8");
}

async function readFile(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  repositoryId: string,
  relativePath: string
): Promise<VcsReadFileResult> {
  return ctx.rpc.call("main", "vcs.readFile", {
    state,
    repositoryId,
    file: { kind: "path", path: relativePath },
  });
}

async function listDirectory(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  directory: string
): Promise<NonNullable<VcsListDirectoryResult>["entries"]> {
  const entries: NonNullable<VcsListDirectoryResult>["entries"] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.rpc.call<VcsListDirectoryResult>("main", "vcs.listDirectory", {
      state,
      path: directory,
      ...(cursor ? { cursor } : {}),
      limit: 500,
    });
    if (!page) break;
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}

async function repositoryPaths(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef
): Promise<Set<string>> {
  const result = new Set<string>();
  const roots = await listDirectory(ctx, state, "");
  for (const root of roots) {
    if (root.repositoryRoot) result.add(root.path);
    if (root.kind !== "directory" || root.repositoryRoot) continue;
    for (const child of await listDirectory(ctx, state, root.path)) {
      if (child.repositoryRoot) result.add(child.path);
    }
  }
  return result;
}

async function ensureObservationContext(ctx: ExtensionContextLike): Promise<void> {
  await ctx.rpc.call("main", "runtime.createContext", { contextId: OBSERVATION_CONTEXT });
}

export async function observeWorkspace(
  ctx: ExtensionContextLike
): Promise<SemanticWorkspaceObservation> {
  await ensureObservationContext(ctx);
  const status = await ctx.rpc.call<VcsStatusResult>("main", "vcs.status", {
    contextId: OBSERVATION_CONTEXT,
  });
  const mainState = { kind: "event" as const, eventId: status.mainEventId };
  const info = await ctx.workspace.getInfo();
  if (!info.config) throw new Error("Workspace info did not expose its resolved configuration");
  const config = info.config as WorkspaceConfig;
  const metaRepository = await ctx.rpc.call<VcsResolveRepositoryResult>(
    "main",
    "vcs.resolveRepository",
    { state: mainState, repoPath: META_REPOSITORY }
  );
  if (!metaRepository) throw new Error("Workspace has no semantic meta repository");
  const topFile = await readFile(ctx, mainState, metaRepository.repositoryId, TOP_CONFIG_PATH);
  if (!topFile) throw new Error(`Workspace has no ${META_REPOSITORY}/${TOP_CONFIG_PATH}`);
  const parsedRuntime = WorkspaceConfigSchema.parse({
    ...(YAML.parse(textContent(topFile)) as object),
    id: info.id,
  });
  const { id: _runtimeId, ...runtimeTop } = parsedRuntime;
  const lockFile = await readFile(ctx, mainState, metaRepository.repositoryId, LOCK_PATH);
  const lock: WorkspaceTemplateLock | undefined = lockFile
    ? assertTemplateLockIntegrityForRead(YAML.parse(textContent(lockFile)) as unknown)
    : undefined;
  const sourceFile = await readFile(
    ctx,
    mainState,
    metaRepository.repositoryId,
    COMPOSITION_SOURCE_PATH
  );
  const storedSource = sourceFile
    ? WorkspaceConfigTopLayerSchema.parse(YAML.parse(textContent(sourceFile)) as unknown)
    : undefined;
  let top: ReturnType<typeof WorkspaceConfigTopLayerSchema.parse>;
  if (lock) {
    if (!storedSource) {
      throw new Error(
        `Workspace template lock exists without ${WORKSPACE_COMPOSITION_SOURCE_PATH}`
      );
    }
    const ancestors = new Map<string, Set<string>>();
    const layers = [];
    for (const node of lock.nodes) {
      const inherited = new Set<string>();
      for (const parent of node.parents) {
        inherited.add(parent);
        for (const ancestor of ancestors.get(parent) ?? []) inherited.add(ancestor);
      }
      ancestors.set(node.nodeId, inherited);
      const fragmentFile = await readFile(
        ctx,
        mainState,
        metaRepository.repositoryId,
        `templates/${node.nodeId}.yml`
      );
      if (!fragmentFile) {
        throw new Error(`Workspace is missing generated template fragment ${node.nodeId}`);
      }
      layers.push({
        nodeId: node.nodeId,
        alias: node.alias,
        ancestors: [...inherited],
        config: parseWorkspaceConfigFragment(textContent(fragmentFile), node.nodeId),
      });
    }
    const prior = composeWorkspaceConfig(storedSource, layers, info.id);
    top = WorkspaceConfigTopLayerSchema.parse(
      projectWorkspaceConfigMutationToTop(storedSource, prior, {
        ...runtimeTop,
        id: info.id,
      })
    );
  } else {
    const descriptor = await readBootstrapDescriptor(info.statePath);
    const templates = storedSource?.templates ?? { use: [] };
    top = descriptor
      ? bootstrapWorkspaceSource(runtimeTop, templates)
      : WorkspaceConfigTopLayerSchema.parse({ ...runtimeTop, templates });
  }
  const localRepoPaths = await repositoryPaths(ctx, mainState);
  const modifiedTemplateRepoPaths = new Set<string>();
  for (const repoPath of Object.keys(lock?.repositories ?? {})) {
    localRepoPaths.delete(repoPath);
    const repository = await ctx.rpc.call<VcsResolveRepositoryResult>(
      "main",
      "vcs.resolveRepository",
      { state: mainState, repoPath }
    );
    const expected = lock?.repositories[repoPath];
    if (
      !repository ||
      !expected ||
      semanticRepositoryDigest(
        await listSemanticRepositoryFiles(ctx, mainState, repository.repositoryId)
      ) !== expected.subtreeDigest
    ) {
      modifiedTemplateRepoPaths.add(repoPath);
    }
  }
  return {
    workspaceId: info.id,
    runtimeTop,
    roots: top.templates?.use ?? [],
    ...(lock ? { lock } : {}),
    localRepoPaths,
    externallyOwnedRepoPaths: new Set(),
    conflicts: top.templates?.conflicts,
    overrides: top.templates?.overrides,
    expectedSystemEpoch: top.systemEpoch,
    mainEventId: status.mainEventId,
    mainState,
    top,
    metaRepository,
    modifiedTemplateRepoPaths,
  };
}

export async function readBootstrapDescriptor(
  statePath: string
): Promise<WorkspaceCreationDescriptor | null> {
  try {
    const text = await fsp.readFile(path.join(statePath, "workspace-creation", "v1.json"), "utf8");
    return WorkspaceCreationDescriptorSchema.parse(JSON.parse(text) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
