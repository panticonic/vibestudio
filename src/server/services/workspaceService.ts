/**
 * Workspace RPC service — current-workspace configuration and lifecycle.
 *
 * Server-wide catalog discovery, creation, deletion, and routing live only on
 * the stable hub's `hubControl` service. A workspace child never deputies for
 * that control plane.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { Workspace, WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { ApprovalDetailFormat, ApprovalPrincipal } from "@vibestudio/shared/approvals";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetLaunchResult,
  HostTargetLaunchSessionSnapshot,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "@vibestudio/shared/hostTargets";
import { normalizeWorkspaceRepoPath, splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";
import type {
  WorkspaceAppVersions,
  WorkspaceHeartbeatSelector,
  WorkspaceHeartbeatStatus,
  WorkspaceHeartbeatTickResult,
  WorkspaceRecurringJobStatus,
  WorkspaceUnitDiagnostics,
  WorkspaceUnitLogRecord,
  WorkspaceUnitStatus,
} from "@vibestudio/service-schemas/workspace";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { ContextIngestionRecorder } from "./contextIntegrityStore.js";
import type { WorkspaceTreeScanner } from "../vcsHost/workspaceTreeScanner.js";
import { parseSkillFrontmatter } from "../vcsHost/workspaceSkills.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

// Wire data types live in the shared schema module (single source of truth
// for server registration and typed clients). Re-exported here because many
// server-side modules import them from this file.
export type {
  WorkspaceAppVersionRecord,
  WorkspaceAppVersions,
  WorkspaceHeartbeatSelector,
  WorkspaceHeartbeatStatus,
  WorkspaceHeartbeatTickResult,
  WorkspaceRecurringJobStatus,
  WorkspaceUnitDiagnostics,
  WorkspaceUnitLogRecord,
  WorkspaceUnitStatus,
} from "@vibestudio/service-schemas/workspace";

export type { SkillEntry } from "../vcsHost/workspaceSkills.js";

export interface WorkspaceServiceDeps {
  workspace: Workspace;
  /** User-facing catalog name. Falls back to config.id for standalone tests/hosts. */
  activeWorkspaceName?: string;
  treeScanner?: WorkspaceTreeScanner;
  getConfig: () => WorkspaceConfig;
  setConfigField: (key: string, value: unknown, ctx: ServiceContext) => void | Promise<void>;
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
  /** Workspace-unit operational status rows, including extension health. */
  listUnits?: () => Promise<WorkspaceUnitStatus[]> | WorkspaceUnitStatus[];
  /** Restart a workspace unit through the owning manager. */
  restartUnit?: (ctx: ServiceContext, name: string) => Promise<void>;
  /** Query retained logs for a workspace unit. */
  listUnitLogs?: (
    name: string,
    opts?: {
      since?: number;
      sinceSeq?: number;
      level?: WorkspaceUnitLogRecord["level"];
      limit?: number;
    }
  ) => Promise<WorkspaceUnitLogRecord[]> | WorkspaceUnitLogRecord[];
  unitDiagnostics?: (
    name: string,
    opts?: {
      since?: number;
      sinceSeq?: number;
      level?: WorkspaceUnitLogRecord["level"];
      limit?: number;
      errorLimit?: number;
    }
  ) => Promise<WorkspaceUnitDiagnostics> | WorkspaceUnitDiagnostics;
  /** Bake an active approved app build into the packaging payload directory. */
  bakeAppDist?: (sourceOrName: string, opts?: { outDir?: string }) => Promise<unknown> | unknown;
  /** List active and rollback-capable versions for an app unit. */
  listAppVersions?: (sourceOrName: string) => Promise<WorkspaceAppVersions> | WorkspaceAppVersions;
  /** Roll an app unit back to a previous active build. */
  rollbackAppVersion?: (sourceOrName: string, buildKey?: string) => Promise<unknown> | unknown;
  /** List declarative scheduled jobs from meta/vibestudio.yml with durable run state. */
  listRecurringJobs?: () => Promise<WorkspaceRecurringJobStatus[]> | WorkspaceRecurringJobStatus[];
  listHeartbeats?: () => Promise<WorkspaceHeartbeatStatus[]> | WorkspaceHeartbeatStatus[];
  runHeartbeatNow?: (
    selector: WorkspaceHeartbeatSelector
  ) => Promise<WorkspaceHeartbeatTickResult> | WorkspaceHeartbeatTickResult;
  pauseHeartbeat?: (selector: WorkspaceHeartbeatSelector) => Promise<{ ok: true }> | { ok: true };
  resumeHeartbeat?: (selector: WorkspaceHeartbeatSelector) => Promise<{ ok: true }> | { ok: true };
  /** List app candidates that can be selected as the active app for a host target. */
  listHostTargetCandidates?: (
    target: HostTarget
  ) => Promise<HostTargetCandidate[]> | HostTargetCandidate[];
  /** Read the active per-workspace selection for a host target. */
  getHostTargetSelection?: (
    target: HostTarget
  ) =>
    | Promise<{ selection: HostTargetSelection | null; valid: boolean; reason?: string }>
    | { selection: HostTargetSelection | null; valid: boolean; reason?: string };
  /** Persist a per-workspace selection for a host target. */
  setHostTargetSelection?: (
    target: HostTarget,
    input: HostTargetSelectionInput
  ) => Promise<HostTargetSelection> | HostTargetSelection;
  /** Clear a persisted per-workspace selection for a host target. */
  clearHostTargetSelection?: (target: HostTarget) => Promise<void> | void;
  /** List retained versions for a host-target candidate. */
  listHostTargetVersions?: (
    target: HostTarget,
    sourceOrName: string
  ) => Promise<WorkspaceAppVersions> | WorkspaceAppVersions;
  /** Materialize a retained build for a specific ref through the build system. */
  prepareHostTargetPinnedRef?: (
    target: HostTarget,
    sourceOrName: string,
    ref: string
  ) => Promise<unknown> | unknown;
  /** Launch/reload the selected target app in this host. */
  launchHostTarget?: (
    target: HostTarget
  ) => Promise<HostTargetLaunchResult> | HostTargetLaunchResult;
  beginHostTargetLaunch?: (
    target: HostTarget
  ) => Promise<HostTargetLaunchSessionSnapshot> | HostTargetLaunchSessionSnapshot;
  getHostTargetLaunchSession?: (
    sessionId: string
  ) => Promise<HostTargetLaunchSessionSnapshot | null> | HostTargetLaunchSessionSnapshot | null;
  resolveHostTargetLaunchSessionApproval?: (
    sessionId: string,
    decision: "once" | "deny"
  ) => Promise<HostTargetLaunchSessionSnapshot> | HostTargetLaunchSessionSnapshot;
  cancelHostTargetLaunchSession?: (sessionId: string) => Promise<void> | void;
  /** Queue used to gate userland workspace mutations. */
  approvalQueue?: Pick<ApprovalQueue, "requestUserland">;
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

type WorkspaceApprovalOperation = "setInitPanels" | "setConfigField";

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

async function requireAppUnitManagementAccess(
  deps: WorkspaceServiceDeps,
  ctx: ServiceContext,
  method: string,
  name: string
): Promise<void> {
  if (isTrustedWorkspaceCaller(ctx, deps)) return;
  if (ctx.caller.runtime.kind !== "app") {
    throw new ServiceError(
      "workspace",
      method,
      `workspace.${method} is not accessible to ${ctx.caller.runtime.kind} callers`,
      "EACCES"
    );
  }
  const rows = deps.listUnits ? await deps.listUnits() : [];
  const row = rows.find(
    (unit) => unit.kind === "app" && (unit.name === name || unit.source === name)
  );
  if (!row) {
    throw new ServiceError("workspace", method, `Unknown app unit: ${name}`, "ENOENT");
  }
  const normalizedSource = row.source.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const callerId = ctx.caller.runtime.id;
  if (
    callerId === row.name ||
    callerId === normalizedSource ||
    callerId.startsWith(`app:${normalizedSource}:`)
  )
    return;
  throw new ServiceError(
    "workspace",
    method,
    `workspace.${method} can only manage the calling app`,
    "EACCES"
  );
}

function truncateApprovalValue(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function safeSubjectSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._:/-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 48) || "unknown";
}

function describeValue(value: unknown): { value: string; format: "plain" | "tree" } {
  try {
    const brief = describeValueBrief(value);
    const yaml = toYamlish(value, 0).trim();
    const lines = yaml.split("\n");
    if (lines.length <= 2) return { value: brief, format: "plain" };
    return { value: `${brief}\n${truncateApprovalValue(yaml, 800)}`, format: "tree" };
  } catch {
    return { value: "[complex value]", format: "plain" };
  }
}

function describeValueBrief(value: unknown): string {
  if (value == null) return "none";
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "empty list";
    const items = value.filter((v): v is string => typeof v === "string");
    if (items.length === value.length && items.length <= 3) return items.join(", ");
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "empty";
    if (keys.length <= 3) return keys.join(", ");
    return `${keys.length} settings`;
  }
  return String(value);
}

function toYamlish(value: unknown, depth: number): string {
  const indent = "  ".repeat(depth);
  if (value == null) return "~";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value))
    return value.map((v) => `\n${indent}- ${toYamlish(v, depth + 1)}`).join("");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries
      .map(([k, v]) => {
        const child = toYamlish(v, depth + 1);
        return child.includes("\n") ? `\n${indent}${k}:${child}` : `\n${indent}${k}: ${child}`;
      })
      .join("");
  }
  return String(value);
}

type WorkspaceApprovalDetail = { label: string; value: string; format?: ApprovalDetailFormat };

function resolveWorkspacePrincipal(
  deps: WorkspaceServiceDeps,
  ctx: ServiceContext,
  method: WorkspaceApprovalOperation
): ApprovalPrincipal {
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "app" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do"
  ) {
    throw new ServiceError(
      "workspace",
      method,
      "Workspace mutation approvals are only available to panel, app, worker, and DO callers",
      "EACCES"
    );
  }
  if (!deps.approvalQueue) {
    throw new ServiceError(
      "workspace",
      method,
      "Workspace mutation approval is unavailable",
      "EACCES"
    );
  }
  const identity = ctx.caller.code;
  if (!identity) {
    throw new ServiceError(
      "workspace",
      method,
      `Unknown caller identity: ${ctx.caller.runtime.id}`,
      "ENOENT"
    );
  }
  if (identity.callerKind !== ctx.caller.runtime.kind) {
    throw new ServiceError(
      "workspace",
      method,
      `Caller identity kind mismatch for ${ctx.caller.runtime.id}`,
      "EACCES"
    );
  }
  return {
    callerId: identity.callerId,
    callerKind: identity.callerKind,
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
  };
}

async function requireWorkspaceApproval(
  deps: WorkspaceServiceDeps,
  ctx: ServiceContext,
  operation: WorkspaceApprovalOperation,
  approval: {
    target: string;
    title: string;
    summary: string;
    warning?: string;
    details?: WorkspaceApprovalDetail[];
  }
): Promise<void> {
  if (isTrustedWorkspaceCaller(ctx, deps)) return;
  const principal = resolveWorkspacePrincipal(deps, ctx, operation);
  const approvalQueue = deps.approvalQueue;
  if (!approvalQueue) {
    throw new ServiceError(
      "workspace",
      operation,
      "Workspace mutation approval is unavailable",
      "EACCES"
    );
  }
  const result = await approvalQueue.requestUserland({
    principal,
    ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
    subject: {
      id: `workspace:${operation}:${safeSubjectSegment(approval.target)}:${randomUUID()}`,
      label: `workspace ${operation}`,
    },
    title: approval.title,
    summary: approval.summary,
    warning: approval.warning,
    details: [
      { label: "Caller", value: principal.callerId },
      { label: "Workspace", value: deps.getConfig().id },
      { label: "Target", value: truncateApprovalValue(approval.target) },
      ...(approval.details ?? []).map((detail) => ({
        ...detail,
        value: truncateApprovalValue(detail.value, 1000),
      })),
    ].slice(0, 8),
    promptOptions: "choices",
    options: [
      {
        value: "allow",
        label: "Allow",
        description: "Allow this workspace operation once.",
        tone: "primary",
      },
      {
        value: "deny",
        label: "Deny",
        description: "Block this workspace operation.",
        tone: "danger",
      },
    ],
  });
  if (result.kind !== "choice" || result.choice !== "allow") {
    throw new ServiceError("workspace", operation, "Workspace operation was denied", "EACCES");
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
  const stampExternalUnitLogs = async (
    ctx: ServiceContext,
    name: string,
    logs: readonly WorkspaceUnitLogRecord[],
    via: string
  ): Promise<void> => {
    if (logs.length === 0) return;
    const key = logs.some((entry) => entry.kind === "panel")
      ? `log:panel:${name}`
      : logs.some((entry) => entry.source === "lifecycle")
        ? "log:build"
        : "log:server";
    await deps.recordContextIngestion?.(ctx, {
      key,
      via,
      classification: "external",
    });
  };
  const { workspace } = deps;

  return {
    name: "workspace",
    description: "Current-workspace configuration, units, and lifecycle",
    authority: { principals: ["user", "code", "host"] },
    methods: workspaceMethods,
    handler: defineServiceHandler("workspace", workspaceMethods, {
      // -----------------------------------------------------------------
      // Reads
      // -----------------------------------------------------------------

      getInfo: () => ({
        path: workspace.path,
        statePath: workspace.statePath,
        contextProjectionsPath: workspace.contextProjectionsPath,
        config: deps.getConfig(),
      }),

      getActive: () => activeWorkspaceName(),

      getConfig: () => deps.getConfig(),

      validateConfig: (_ctx, [content]) => {
        parseWorkspaceConfigContentWithId(content, deps.getConfig().id);
        return { valid: true as const };
      },

      // -----------------------------------------------------------------
      // Writes
      // -----------------------------------------------------------------

      setInitPanels: async (ctx, [initPanels]) => {
        await requireWorkspaceApproval(deps, ctx, "setInitPanels", {
          target: deps.getConfig().id,
          title: "Change startup panels?",
          summary: "Changes which panels open when this workspace starts.",
          details: [{ label: "Panels to open", ...describeValue(initPanels) }],
        });
        await deps.setConfigField("initPanels", initPanels, ctx);
      },

      setConfigField: async (ctx, [key, value]) => {
        await requireWorkspaceApproval(deps, ctx, "setConfigField", {
          target: key,
          title: "Change a workspace setting?",
          summary: "Changes a workspace setting.",
          warning: "This affects how your workspace starts and runs.",
          details: [
            { label: "Setting", value: key },
            { label: "New value", ...describeValue(value) },
          ],
        });
        await deps.setConfigField(key, value, ctx);
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
            return {
              name: frontmatter.name ?? path.posix.basename(split.repoPath),
              description: frontmatter.description ?? "",
              dirPath: split.repoPath,
              skillPath: relative,
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

      "units.list": () => (deps.listUnits ? deps.listUnits() : []),

      "units.inspector": async (_ctx, [name]) => {
        const rows = deps.listUnits ? await deps.listUnits() : [];
        const row = rows.find((unit) => unit.name === name || unit.source === name);
        const url = row?.inspectorUrl ?? null;
        return url ? { url } : null;
      },

      "units.restart": async (ctx, [name]) => {
        if (!deps.restartUnit) throw new Error("Workspace unit restart not available");
        await deps.restartUnit(ctx, name);
      },

      "units.logs": async (ctx, [name, opts]) => {
        if (!deps.listUnitLogs) return [];
        const logs = await deps.listUnitLogs(name, opts);
        await stampExternalUnitLogs(ctx, name, logs, "workspace-units:logs");
        return logs;
      },

      "units.diagnostics": async (ctx, [name, opts]) => {
        if (!deps.unitDiagnostics) {
          const logs = deps.listUnitLogs ? await deps.listUnitLogs(name, opts) : [];
          await stampExternalUnitLogs(ctx, name, logs, "workspace-units:diagnostics");
          return {
            unit: null,
            logs,
            errors: logs.filter((entry) => entry.level === "error"),
            builds: [],
            dropped: { entries: 0, errors: 0 },
            capacity: { entries: 0, errors: 0 },
          };
        }
        const diagnostics = await deps.unitDiagnostics(name, opts);
        await stampExternalUnitLogs(
          ctx,
          name,
          [...diagnostics.logs, ...diagnostics.errors],
          "workspace-units:diagnostics"
        );
        if (diagnostics.builds.length > 0) {
          await deps.recordContextIngestion?.(ctx, {
            key: "log:build",
            via: "workspace-units:diagnostics",
            classification: "external",
          });
        }
        return diagnostics;
      },

      "units.versions": (_ctx, [name]) => {
        if (!deps.listAppVersions) return { current: null, previous: [], retentionLimit: 0 };
        return deps.listAppVersions(name);
      },

      "units.rollback": async (ctx, [name, opts]) => {
        if (!deps.rollbackAppVersion) throw new Error("App rollback is not available");
        await requireAppUnitManagementAccess(deps, ctx, "units.rollback", name);
        return deps.rollbackAppVersion(name, opts?.buildKey);
      },

      "units.bakeAppDist": async (ctx, [sourceOrName, opts]) => {
        if (!isTrustedWorkspaceCaller(ctx, deps)) {
          throw new ServiceError(
            "workspace",
            "units.bakeAppDist",
            `workspace.units.bakeAppDist is not accessible to ${ctx.caller.runtime.kind} callers`,
            "EACCES"
          );
        }
        if (!deps.bakeAppDist) {
          throw new Error("App dist bake is not available");
        }
        return deps.bakeAppDist(sourceOrName, opts);
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

      "hostTargets.list": (_ctx, [target]) => {
        if (!deps.listHostTargetCandidates) return [];
        return deps.listHostTargetCandidates(target);
      },

      "hostTargets.getSelection": (_ctx, [target]) => {
        if (!deps.getHostTargetSelection) {
          return {
            selection: null,
            valid: false,
            reason: "Host target selection is unavailable",
          };
        }
        return deps.getHostTargetSelection(target);
      },

      "hostTargets.setSelection": (_ctx, [target, input]) => {
        if (!deps.setHostTargetSelection) throw new Error("Host target selection is unavailable");
        return deps.setHostTargetSelection(target, input);
      },

      "hostTargets.clearSelection": (_ctx, [target]) => {
        if (!deps.clearHostTargetSelection) return;
        return deps.clearHostTargetSelection(target);
      },

      "hostTargets.versions": (_ctx, [target, sourceOrName]) => {
        if (!deps.listHostTargetVersions) {
          return { current: null, previous: [], retentionLimit: 0 };
        }
        return deps.listHostTargetVersions(target, sourceOrName);
      },

      "hostTargets.preparePinnedRef": (_ctx, [target, sourceOrName, ref]) => {
        if (!deps.prepareHostTargetPinnedRef) {
          throw new Error("Pinned ref preparation is unavailable");
        }
        return deps.prepareHostTargetPinnedRef(target, sourceOrName, ref);
      },

      "hostTargets.launch": (_ctx, [target]) => {
        if (!deps.launchHostTarget) {
          return {
            status: "unavailable",
            launched: false,
            target,
            reason: "Host target launch is unavailable",
            details: [],
          } satisfies HostTargetLaunchResult;
        }
        return deps.launchHostTarget(target);
      },

      "hostTargets.beginLaunch": (_ctx, [target]) => {
        if (!deps.beginHostTargetLaunch) {
          throw new Error("Host target launch sessions are unavailable");
        }
        return deps.beginHostTargetLaunch(target);
      },

      "hostTargets.getLaunchSession": async (_ctx, [sessionId]) =>
        (await deps.getHostTargetLaunchSession?.(sessionId)) ?? null,

      "hostTargets.resolveLaunchSessionApproval": (_ctx, [sessionId, decision]) => {
        if (!deps.resolveHostTargetLaunchSessionApproval) {
          throw new Error("Host target launch sessions are unavailable");
        }
        return deps.resolveHostTargetLaunchSessionApproval(sessionId, decision);
      },

      "hostTargets.cancelLaunchSession": async (_ctx, [sessionId]) => {
        await deps.cancelHostTargetLaunchSession?.(sessionId);
      },
    }),
  };
}
