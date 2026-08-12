/**
 * Workspace RPC service — current-workspace configuration and lifecycle.
 *
 * Server-wide catalog discovery, creation, deletion, and routing live only on
 * the stable hub's `hubControl` service. A workspace child never deputies for
 * that control plane.
 */

import path from "node:path";
import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { fixedPreparedAuthoritySelection } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { Workspace, WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { normalizeWorkspaceRepoPath, splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import {
  workspaceMethods,
  WORKSPACE_PREPARED_CONFIG_AUTHORITY_RESOLVER,
  WORKSPACE_PREPARED_CONFIG_CAPABILITY,
} from "@vibestudio/service-schemas/workspace";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";
import type {
  WorkspaceHeartbeatSelector,
  WorkspaceHeartbeatStatus,
  WorkspaceHeartbeatTickResult,
  WorkspaceRecurringJobStatus,
} from "@vibestudio/service-schemas/workspace";
import type { ContextIngestionRecorder } from "./contextIntegrityStore.js";
import type { WorkspaceTreeScanner } from "../vcsHost/workspaceTreeScanner.js";
import { parseSkillFrontmatter } from "../vcsHost/workspaceSkills.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

// Wire data types live in the shared schema module (single source of truth
// for server registration and typed clients). Re-exported here because many
// server-side modules import them from this file.
export type {
  WorkspaceHeartbeatSelector,
  WorkspaceHeartbeatStatus,
  WorkspaceHeartbeatTickResult,
  WorkspaceRecurringJobStatus,
} from "@vibestudio/service-schemas/workspace";

export type { SkillEntry } from "../vcsHost/workspaceSkills.js";

export interface WorkspaceServiceDeps {
  workspace: Workspace;
  /** Opaque host-owned workspace identity; unlike config.id this exists for every workspace. */
  workspaceId?: string;
  /** User-facing catalog name. Falls back to config.id for standalone tests/hosts. */
  activeWorkspaceName?: string;
  treeScanner?: WorkspaceTreeScanner;
  getConfig: () => WorkspaceConfig;
  setConfigField: (key: string, value: unknown, ctx: ServiceContext) => void | Promise<void>;
  applyPreparedConfig?: (
    input: {
      expectedBaseDigest: string;
      nextState: WorkspaceConfig;
      resultDigest: string;
      allowedPathScope: string[];
      summary: string;
    },
    ctx: ServiceContext
  ) => Promise<{ changed: boolean; resultDigest: string; config: WorkspaceConfig }>;
  /**
   * Context-bound semantic file access. This is the single resource-loading
   * path for agents and installed units; production delegates to FsService so
   * exact VCS lineage is latched before any name or byte reaches the caller.
   */
  contextFiles: {
    readFile: (ctx: ServiceContext, filePath: string, contextId?: string) => Promise<string>;
    readManagedFiles: (
      ctx: ServiceContext,
      patterns: readonly string[],
      contextId?: string
    ) => Promise<Array<{ path: string; content: string }>>;
  };
  /** Durably advance a model session's content latch before read bytes are returned. */
  recordContextIngestion?: ContextIngestionRecorder;
  /** List declarative scheduled jobs from meta/vibestudio.yml with durable run state. */
  listRecurringJobs?: () => Promise<WorkspaceRecurringJobStatus[]> | WorkspaceRecurringJobStatus[];
  listHeartbeats?: () => Promise<WorkspaceHeartbeatStatus[]> | WorkspaceHeartbeatStatus[];
  runHeartbeatNow?: (
    selector: WorkspaceHeartbeatSelector
  ) => Promise<WorkspaceHeartbeatTickResult> | WorkspaceHeartbeatTickResult;
  pauseHeartbeat?: (selector: WorkspaceHeartbeatSelector) => Promise<{ ok: true }> | { ok: true };
  resumeHeartbeat?: (selector: WorkspaceHeartbeatSelector) => Promise<{ ok: true }> | { ok: true };
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  /**
   * Materialize a context's working folder (idempotent) and return its absolute
   * path. Backs `workspace.ensureContextFolder`; delegates to the
   * ContextFolderManager. Absent in remote-server/mobile-client mode.
   */
  ensureContextFolder?: (contextId: string) => Promise<{ dir: string }>;
  /** Resolve the owning context for runtime callers that request context materialization directly. */
  resolveCallerContext?: (callerId: string) => Promise<string | null> | string | null;
}

type WorkspaceTreeNode = {
  path: string;
  isUnit: boolean;
  children: WorkspaceTreeNode[];
};

function collectWorkspaceUnitPaths(nodes: WorkspaceTreeNode[]): Set<string> {
  const units = new Set<string>();
  for (const node of nodes) {
    if (node.isUnit) units.add(node.path);
    for (const childPath of collectWorkspaceUnitPaths(node.children)) {
      units.add(childPath);
    }
  }
  return units;
}

const SAFE_WORKSPACE_PATH_SEGMENT = /^[A-Za-z0-9._@-]+$/;

function normalizeWorkspaceRelativePath(input: string): string {
  const normalized = input.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized === ".") return "";
  if (normalized.includes("\\") || normalized.includes("\0")) {
    throw new Error(`Invalid workspace path: ${JSON.stringify(input)}`);
  }
  for (const segment of normalized.split("/")) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      !SAFE_WORKSPACE_PATH_SEGMENT.test(segment)
    ) {
      throw new Error(`Invalid workspace path: ${JSON.stringify(input)}`);
    }
  }
  return normalized;
}

function resolveSkillMdPath(nameOrPath: string): string {
  if (typeof nameOrPath !== "string" || nameOrPath.length === 0) {
    throw new Error(`Invalid workspace repo path: ${nameOrPath}`);
  }
  try {
    const repoPath = normalizeWorkspaceRepoPath(nameOrPath);
    return `/${repoPath}/SKILL.md`;
  } catch {
    throw new Error(`Invalid workspace repo path: ${nameOrPath}`);
  }
}

function isTrustedWorkspaceCaller(ctx: ServiceContext, deps: WorkspaceServiceDeps): boolean {
  return isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability });
}

async function requireEnsureContextFolderAccess(
  deps: WorkspaceServiceDeps,
  ctx: ServiceContext,
  contextId: string
): Promise<void> {
  if (isTrustedWorkspaceCaller(ctx, deps) || ctx.caller.runtime.kind === "extension") return;
  const kind = ctx.caller.runtime.kind;
  if (kind !== "panel" && kind !== "worker" && kind !== "do") {
    throw new ServiceError(
      "workspace",
      "ensureContextFolder",
      `workspace.ensureContextFolder is not accessible to ${kind} callers`,
      "EACCES"
    );
  }
  if (!deps.resolveCallerContext) {
    throw new ServiceError(
      "workspace",
      "ensureContextFolder",
      "Caller context resolution is unavailable",
      "EACCES"
    );
  }
  const callerContextId = await deps.resolveCallerContext(ctx.caller.runtime.id);
  if (callerContextId !== contextId) {
    throw new ServiceError(
      "workspace",
      "ensureContextFolder",
      "Caller's runtime context does not match requested context",
      "EACCES"
    );
  }
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): ServiceDefinition {
  const activeWorkspaceName = () => deps.activeWorkspaceName ?? deps.getConfig().id;
  const resourceContext = (
    ctx: ServiceContext,
    options: { contextId: string } | undefined,
    method: "listSkills" | "readSkill"
  ): string | undefined => {
    const kind = ctx.caller.runtime.kind;
    const contextlessHost = kind === "server" || kind === "shell";
    if (contextlessHost && !options?.contextId) {
      throw new ServiceError(
        "workspace",
        method,
        `${kind} callers must provide an explicit contextId for semantic workspace resources`,
        "EINVAL"
      );
    }
    if (!contextlessHost && options?.contextId) {
      throw new ServiceError(
        "workspace",
        method,
        `${kind} callers cannot override their verified ambient context`,
        "EINVAL"
      );
    }
    return options?.contextId;
  };
  const { workspace } = deps;

  return {
    name: "workspace",
    description: "Current-workspace configuration, units, and lifecycle",
    authority: { principals: ["user", "code", "host"] },
    methods: workspaceMethods,
    authorityPreparation: {
      [WORKSPACE_PREPARED_CONFIG_AUTHORITY_RESOLVER]: (ctx, [rawInput]) => {
        if (!ctx.caller.code && !ctx.caller.executionSession) {
          return { selections: [], payload: null };
        }
        const input = rawInput as {
          resultDigest: string;
          allowedPathScope: string[];
          summary: string;
        };
        const resource = {
          type: "workspace-config",
          label: "Configuration",
          value: input.resultDigest,
        };
        return {
          selections: [
            fixedPreparedAuthoritySelection({
              capability: WORKSPACE_PREPARED_CONFIG_CAPABILITY,
              resourceKey: `workspace-config:${input.resultDigest}`,
              challenge: {
                title: "Apply workspace configuration",
                description: input.summary,
                deniedReason: "Applying this workspace configuration was not allowed",
                dedupKey: `workspace-config:${input.resultDigest}`,
                resource,
                operation: {
                  kind: "workspace",
                  verb: "apply workspace configuration",
                  object: resource,
                  groupKey: `workspace-config:${input.resultDigest}`,
                },
                substance: {
                  kind: "change-set",
                  summary: input.summary,
                  facts: [
                    { label: "Result digest", value: input.resultDigest },
                    { label: "Allowed paths", value: input.allowedPathScope.join(", ") },
                  ],
                },
              },
            }),
          ],
          payload: null,
        };
      },
    },
    handler: defineServiceHandler("workspace", workspaceMethods, {
      // -----------------------------------------------------------------
      // Reads
      // -----------------------------------------------------------------

      getInfo: () => {
        const config = deps.getConfig();
        const name = activeWorkspaceName();
        return {
          id: deps.workspaceId ?? config.id ?? name,
          name,
          path: workspace.path,
          statePath: workspace.statePath,
          contextProjectionsPath: workspace.contextProjectionsPath,
          config,
        };
      },

      getActive: () => activeWorkspaceName(),

      getConfig: () => deps.getConfig(),

      validateConfig: async (_ctx, [content]) => {
        parseWorkspaceConfigContentWithId(content, deps.getConfig().id);
        return { valid: true as const };
      },

      // -----------------------------------------------------------------
      // Writes
      // -----------------------------------------------------------------

      setInitPanels: async (ctx, [initPanels]) => {
        await deps.setConfigField("initPanels", initPanels, ctx);
      },

      setConfigField: async (ctx, [key, value]) => {
        await deps.setConfigField(key, value, ctx);
      },

      applyPreparedConfig: (ctx, [input]) => {
        if (!deps.applyPreparedConfig) {
          throw new Error("Prepared workspace config publishing is unavailable");
        }
        return deps.applyPreparedConfig(input, ctx);
      },

      // -----------------------------------------------------------------
      // Agent resource loading (filesystem reads from the workspace tree)
      // -----------------------------------------------------------------

      getAgentsMd: async (ctx) => {
        try {
          return await deps.contextFiles.readFile(ctx, "/meta/AGENTS.md");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw err;
        }
      },

      listSkills: async (ctx, [options]) => {
        const files = await deps.contextFiles.readManagedFiles(
          ctx,
          ["*/SKILL.md", "*/*/SKILL.md"],
          resourceContext(ctx, options, "listSkills")
        );
        const entries = await Promise.all(
          files.map(async ({ path: skillPath, content }) => {
            const relative = skillPath.replace(/^\/+/, "");
            const split = splitRepoPath(relative);
            if (!split || split.repoRelPath !== "SKILL.md") return null;
            try {
              normalizeWorkspaceRepoPath(split.repoPath);
            } catch {
              return null;
            }
            const frontmatter = parseSkillFrontmatter(content);
            if (frontmatter.agentVisible === false) return null;
            return {
              name: frontmatter.name ?? path.posix.basename(split.repoPath),
              description: frontmatter.description ?? "",
              dirPath: split.repoPath,
              skillPath: relative,
              ...(frontmatter.onboarding !== undefined
                ? { onboarding: frontmatter.onboarding }
                : {}),
            };
          })
        );
        return entries
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((left, right) => compareUtf16CodeUnits(left.dirPath, right.dirPath));
      },

      readSkill: async (ctx, [nameOrPath, options]) => {
        return deps.contextFiles.readFile(
          ctx,
          resolveSkillMdPath(nameOrPath),
          resourceContext(ctx, options, "readSkill")
        );
      },

      sourceTree: () => {
        if (!deps.treeScanner) throw new Error("Workspace source tree is unavailable");
        return deps.treeScanner.getSourceTree();
      },

      ensureContextFolder: async (ctx, [contextId]) => {
        if (!deps.ensureContextFolder) {
          throw new ServiceError(
            "workspace",
            "ensureContextFolder",
            "Context folder materialization is unavailable",
            "ENOENT"
          );
        }
        await requireEnsureContextFolderAccess(deps, ctx, contextId);
        return deps.ensureContextFolder(contextId);
      },

      findUnitForPath: async (_ctx, [pathInput]) => {
        if (!deps.treeScanner) throw new Error("Workspace source tree is unavailable");
        const inputPath = normalizeWorkspaceRelativePath(pathInput);
        const tree = await deps.treeScanner.getSourceTree();
        const units = [...collectWorkspaceUnitPaths(tree.children as WorkspaceTreeNode[])].sort(
          (a, b) => b.length - a.length
        );
        const unitPath = units.find(
          (unit) => inputPath === unit || inputPath.startsWith(`${unit}/`)
        );
        if (!unitPath) return null;
        return {
          unitPath,
          relativePath: inputPath === unitPath ? "" : inputPath.slice(unitPath.length + 1),
        };
      },

      "recurring.list": () => (deps.listRecurringJobs ? deps.listRecurringJobs() : []),

      "heartbeats.list": () => (deps.listHeartbeats ? deps.listHeartbeats() : []),

      "heartbeats.runNow": (_ctx, [name]) => {
        if (!deps.runHeartbeatNow) {
          throw new ServiceError(
            "workspace",
            "heartbeats.runNow",
            "Heartbeat controls are unavailable",
            "ENOENT"
          );
        }
        return deps.runHeartbeatNow(name);
      },

      "heartbeats.pause": (_ctx, [name]) => {
        if (!deps.pauseHeartbeat) {
          throw new ServiceError(
            "workspace",
            "heartbeats.pause",
            "Heartbeat controls are unavailable",
            "ENOENT"
          );
        }
        return deps.pauseHeartbeat(name);
      },

      "heartbeats.resume": (_ctx, [name]) => {
        if (!deps.resumeHeartbeat) {
          throw new ServiceError(
            "workspace",
            "heartbeats.resume",
            "Heartbeat controls are unavailable",
            "ENOENT"
          );
        }
        return deps.resumeHeartbeat(name);
      },
    }),
  };
}
