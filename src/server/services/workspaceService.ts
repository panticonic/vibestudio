/**
 * Workspace RPC service — server-side workspace catalog and configuration.
 *
 * Child-facing façade for workspace operations: reading local configuration,
 * init-panel management, and hub-proxied catalog lifecycle. The hub is the sole
 * catalog/filesystem owner; panels and workers reach this façade directly over
 * the child connection.
 *
 * Method names match the runtime's `WorkspaceClient` interface (see
 * `workspace/packages/runtime/src/shared/workspace.ts`) so eval'd code can
 * `import { workspace } from "@workspace/runtime"` and call `workspace.list()`,
 * `workspace.create("name")`, etc. without an intermediate proxy.
 *
 * The `select` (workspace switch) method needs Electron's `app.relaunch()`,
 * which lives in the desktop shell. The server emits a
 * `workspace:relaunch-requested` event; an attached shell subscribes and
 * relaunches itself. With no shell attached the event goes nowhere and the
 * caller is expected to reconnect manually.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { hasPanelHostingAuthority } from "@vibestudio/shared/serviceAuthorityChecks";
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
import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import type { HubWorkspaceRoute } from "@vibestudio/service-schemas/hubControl";
import type {
  WorkspaceAppVersions,
  WorkspaceHeartbeatSelector,
  WorkspaceHeartbeatStatus,
  WorkspaceHeartbeatTickResult,
  WorkspaceRecurringJobStatus,
  WorkspaceEntry,
  WorkspaceUnitDiagnostics,
  WorkspaceUnitLogRecord,
  WorkspaceUnitStatus,
} from "@vibestudio/service-schemas/workspace";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { WorkspaceTreeScanner } from "../vcsHost/workspaceTreeScanner.js";
import { listWorkspaceSkillEntries } from "../vcsHost/workspaceSkills.js";

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

function isWorkspaceEntry(value: unknown): value is WorkspaceEntry {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { workspaceId?: unknown }).workspaceId === "string" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { lastOpened?: unknown }).lastOpened === "number"
  );
}

export interface WorkspaceCatalogClient {
  list(actorUserId: string): Promise<WorkspaceEntry[]>;
  create(actorUserId: string, name: string, opts?: { forkFrom?: string }): Promise<WorkspaceEntry>;
  delete(actorUserId: string, name: string): Promise<void>;
  select(actorUserId: string, deviceId: string, name: string): Promise<HubWorkspaceRoute>;
}

export interface WorkspaceServiceDeps {
  workspace: Workspace;
  /** User-facing catalog name. Falls back to config.id for standalone tests/hosts. */
  activeWorkspaceName?: string;
  treeScanner?: WorkspaceTreeScanner;
  getConfig: () => WorkspaceConfig;
  setConfigField: (key: string, value: unknown, ctx: ServiceContext) => void | Promise<void>;
  /** Required hub-owned catalog proxy; children never mutate the catalog. */
  workspaceCatalog: WorkspaceCatalogClient;
  /**
   * Event bus for `workspace:relaunch-requested`: an attached desktop shell
   * subscribes and relaunches itself into the selected workspace. With no
   * shell attached the event is a no-op (the caller reconnects manually).
   */
  eventService?: {
    emit(
      event: "workspace:relaunch-requested",
      payload: { name: string; route: HubWorkspaceRoute }
    ): void;
  };
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
  /**
   * Materialize a context's working folder (idempotent) and return its absolute
   * path. Backs `workspace.ensureContextFolder`; delegates to the
   * ContextFolderManager. Absent in remote-server/mobile-client mode.
   */
  ensureContextFolder?: (contextId: string) => Promise<{ dir: string }>;
  /** Resolve the owning context for runtime callers that request context materialization directly. */
  resolveCallerContext?: (callerId: string) => Promise<string | null> | string | null;
}

type WorkspaceApprovalOperation =
  | "create"
  | "delete"
  | "select"
  | "setInitPanels"
  | "setConfigField";

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

async function resolveSkillMdPath(workspaceRoot: string, nameOrPath: string): Promise<string> {
  if (typeof nameOrPath !== "string" || nameOrPath.length === 0) {
    throw new Error(`Invalid workspace repo path: ${nameOrPath}`);
  }
  try {
    const repoPath = normalizeWorkspaceRepoPath(nameOrPath);
    return path.join(workspaceRoot, repoPath, "SKILL.md");
  } catch {
    throw new Error(`Invalid workspace repo path: ${nameOrPath}`);
  }
}

async function requireEnsureContextFolderAccess(
  deps: WorkspaceServiceDeps,
  ctx: ServiceContext,
  contextId: string
): Promise<void> {
  if (await hasPanelHostingAuthority(ctx)) return;
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
  if (await hasPanelHostingAuthority(ctx)) return;
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

function describeJson(value: unknown): string {
  try {
    return `\`\`\`json\n${truncateApprovalValue(JSON.stringify(value, null, 2), 900).replace(/```/g, "'''")}\n\`\`\``;
  } catch {
    return "```text\n[unserializable value]\n```";
  }
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
    executionDigest: identity.executionDigest,
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
  if (await hasPanelHostingAuthority(ctx)) return;
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
  const { workspace } = deps;
  const actorUserId = (ctx: ServiceContext): string => {
    const userId = ctx.caller.subject?.userId;
    if (!userId || userId === "system") {
      throw new ServiceError("workspace", "catalog", "Workspace catalog requires a user", "EACCES");
    }
    return userId;
  };

  return {
    name: "workspace",
    description: "Workspace catalog, configuration, and lifecycle (list, create, switch, etc.)",
    authority: {
      principals: ["user", "code", "host"],
    },
    methods: workspaceMethods,
    handler: defineServiceHandler("workspace", workspaceMethods, {
      // -----------------------------------------------------------------
      // Reads
      // -----------------------------------------------------------------

      getInfo: () => ({
        path: workspace.path,
        statePath: workspace.statePath,
        contextsPath: workspace.contextsPath,
        config: deps.getConfig(),
      }),

      list: (ctx) => deps.workspaceCatalog.list(actorUserId(ctx)),

      getActive: () => activeWorkspaceName(),

      getActiveEntry: async (ctx) => {
        const active = activeWorkspaceName();
        const entries = await deps.workspaceCatalog.list(actorUserId(ctx));
        const listedEntry = entries.find(
          (entry) => isWorkspaceEntry(entry) && entry.name === active
        );
        if (!listedEntry) {
          throw new ServiceError(
            "workspace",
            "getActiveEntry",
            `The active workspace is missing from the hub catalog: ${active}`,
            "ENOENT"
          );
        }
        return listedEntry;
      },

      getConfig: () => deps.getConfig(),

      // -----------------------------------------------------------------
      // Writes
      // -----------------------------------------------------------------

      create: async (ctx, [name, opts]) => {
        await requireWorkspaceApproval(deps, ctx, "create", {
          target: name,
          title: "Create workspace?",
          summary: "This panel or worker wants to create a new workspace.",
          details: opts?.forkFrom ? [{ label: "Fork from", value: opts.forkFrom }] : undefined,
        });
        return deps.workspaceCatalog.create(actorUserId(ctx), name, opts);
      },

      delete: async (ctx, [name]) => {
        if (name === deps.getConfig().id) {
          throw new Error("Cannot delete the currently running workspace");
        }
        await requireWorkspaceApproval(deps, ctx, "delete", {
          target: name,
          title: "Delete workspace?",
          summary: "This panel or worker wants to permanently delete a workspace.",
          warning: "This removes the workspace directory and cannot be undone.",
        });
        await deps.workspaceCatalog.delete(actorUserId(ctx), name);
      },

      select: async (ctx, [name]) => {
        if (ctx.caller.runtime.kind !== "shell" || !ctx.caller.runtime.id.startsWith("shell:")) {
          throw new ServiceError(
            "workspace",
            "select",
            "Workspace switching requires an authenticated device shell",
            "EACCES"
          );
        }
        const deviceId = ctx.caller.runtime.id.slice("shell:".length);
        const route = await deps.workspaceCatalog.select(actorUserId(ctx), deviceId, name);
        // Signal any attached desktop shell to relaunch into the new
        // workspace. Exact control/workspace reaches are included so the
        // desktop can durably persist them before relaunching.
        deps.eventService?.emit("workspace:relaunch-requested", { name, route });
      },

      setInitPanels: async (ctx, [initPanels]) => {
        await requireWorkspaceApproval(deps, ctx, "setInitPanels", {
          target: deps.getConfig().id,
          title: "Change initial workspace panels?",
          summary: "This panel or worker wants to change the panels opened for this workspace.",
          details: [{ label: "Init panels", value: describeJson(initPanels), format: "markdown" }],
        });
        await deps.setConfigField("initPanels", initPanels, ctx);
      },

      setConfigField: async (ctx, [key, value]) => {
        await requireWorkspaceApproval(deps, ctx, "setConfigField", {
          target: key,
          title: "Change workspace config?",
          summary: "This panel or worker wants to write a field in meta/vibestudio.yml.",
          warning: "Changing workspace config can affect how the workspace starts and runs.",
          details: [
            { label: "Config key", value: key },
            { label: "New value", value: describeJson(value), format: "markdown" },
          ],
        });
        await deps.setConfigField(key, value, ctx);
      },

      // -----------------------------------------------------------------
      // Agent resource loading (filesystem reads from the workspace tree)
      // -----------------------------------------------------------------

      getAgentsMd: async () => {
        // Read the workspace-level AGENTS.md from meta/. Missing file is not
        // an error — an empty string lets the agent resource loader fall back.
        const filePath = path.join(workspace.path, "meta", "AGENTS.md");
        try {
          return await fs.readFile(filePath, "utf-8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw err;
        }
      },

      listSkills: () => listWorkspaceSkillEntries(workspace.path),

      readSkill: async (_ctx, [nameOrPath]) => {
        const skillMdPath = await resolveSkillMdPath(workspace.path, nameOrPath);
        return fs.readFile(skillMdPath, "utf-8");
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

      "units.logs": (_ctx, [name, opts]) => {
        if (!deps.listUnitLogs) return [];
        return deps.listUnitLogs(name, opts);
      },

      "units.diagnostics": async (_ctx, [name, opts]) => {
        if (!deps.unitDiagnostics) {
          const logs = deps.listUnitLogs ? await deps.listUnitLogs(name, opts) : [];
          return {
            unit: null,
            logs,
            errors: logs.filter((entry) => entry.level === "error"),
            builds: [],
            dropped: { entries: 0, errors: 0 },
            capacity: { entries: 0, errors: 0 },
          };
        }
        return deps.unitDiagnostics(name, opts);
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
        if (!(await hasPanelHostingAuthority(ctx))) {
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
