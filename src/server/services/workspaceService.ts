/**
 * Workspace RPC service — server-side workspace catalog and configuration.
 *
 * Single source of truth for all workspace operations: listing, reading config,
 * creating, deleting, switching, init-panel management. Lives on the server
 * because the server owns the workspace catalog (CentralDataManager) and the
 * filesystem ops; panels and workers reach it directly via WebSocket without
 * going through Electron.
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
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { Workspace, WorkspaceConfig } from "@vibestudio/shared/workspace/types";
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
import { workspaceMethods } from "@vibestudio/shared/serviceSchemas/workspace";
import type {
  WorkspaceAppVersions,
  WorkspaceHeartbeatSelector,
  WorkspaceHeartbeatStatus,
  WorkspaceHeartbeatTickResult,
  WorkspaceRecurringJobStatus,
  WorkspaceUnitDiagnostics,
  WorkspaceUnitLogRecord,
  WorkspaceUnitStatus,
} from "@vibestudio/shared/serviceSchemas/workspace";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { WorkspaceTreeScanner } from "../vcsHost/workspaceTreeScanner.js";
import { listWorkspaceSkillEntries } from "../vcsHost/workspaceSkills.js";
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
} from "@vibestudio/shared/serviceSchemas/workspace";

export type { SkillEntry } from "../vcsHost/workspaceSkills.js";

function isWorkspaceEntry(value: unknown): value is { name: string; lastOpened: number } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { lastOpened?: unknown }).lastOpened === "number"
  );
}

function fallbackWorkspaceEntry(name: string): { name: string; lastOpened: number } {
  return { name, lastOpened: 0 };
}

export interface CentralDataLike {
  listWorkspaces(): unknown[];
  hasWorkspace(name: string): boolean;
  addWorkspace(name: string): void;
  removeWorkspace(name: string): void;
  touchWorkspace(name: string): void;
  getWorkspaceEntry(name: string): unknown | null;
  getWorkspaceLocalServer?(name: string): { pid: number } | null | undefined;
  clearWorkspaceLocalServer?(name: string): void;
}

export interface WorkspaceServiceDeps {
  workspace: Workspace;
  treeScanner?: WorkspaceTreeScanner;
  getConfig: () => WorkspaceConfig;
  setConfigField: (key: string, value: unknown) => void;
  /** Central workspace catalog. null only in remote-server mode. */
  centralData: CentralDataLike | null;
  /** Create + register a new workspace on disk. */
  createWorkspace: (name: string, opts?: { forkFrom?: string }) => unknown;
  /** Delete a workspace directory from disk. */
  deleteWorkspaceDir: (name: string) => void;
  /**
   * Event bus for `workspace:relaunch-requested`: an attached desktop shell
   * subscribes and relaunches itself into the selected workspace. With no
   * shell attached the event is a no-op (the caller reconnects manually).
   */
  eventService?: {
    emit(event: "workspace:relaunch-requested", payload: { name: string }): void;
    getSubscriberCount?(event: "workspace:relaunch-requested"): number;
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
    throw new Error(`Invalid skill name or repo path: ${nameOrPath}`);
  }
  if (/^[a-zA-Z0-9_-]+$/.test(nameOrPath)) {
    const legacyPath = path.join(workspaceRoot, "skills", nameOrPath, "SKILL.md");
    if (await pathExists(legacyPath)) return legacyPath;
    try {
      const repoPath = normalizeWorkspaceRepoPath(nameOrPath);
      return path.join(workspaceRoot, repoPath, "SKILL.md");
    } catch {
      return legacyPath;
    }
  }
  try {
    const repoPath = normalizeWorkspaceRepoPath(nameOrPath);
    return path.join(workspaceRoot, repoPath, "SKILL.md");
  } catch {
    throw new Error(`Invalid skill name or repo path: ${nameOrPath}`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
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
  const { workspace } = deps;

  // The method table lives in the shared schema module (the single source of
  // truth typed clients derive from). Catalog-dependent methods (`create` /
  // `delete`) are conditionally registered based on whether we have a
  // workspace catalog (`centralData`) at all. In remote-server /
  // mobile-client mode there's no catalog here, so creation/deletion can't
  // be fulfilled — and advertising them only to fail with "Workspace creation
  // not available" AFTER schema validation is confusing for callers (they
  // see two completely different errors depending on whether their args
  // happen to be schema-valid). Omit the methods entirely instead: callers
  // get a single, consistent "Unknown workspace method: create" that makes
  // it obvious the API isn't available in this mode.
  let methods: ServiceDefinition["methods"] = workspaceMethods;
  if (!deps.centralData) {
    const { create: _create, delete: _delete, ...catalogFreeMethods } = workspaceMethods;
    methods = catalogFreeMethods;
  }

  return {
    name: "workspace",
    description: "Workspace catalog, configuration, and lifecycle (list, create, switch, etc.)",
    policy: {
      allowed: ["shell", "app", "panel", "worker", "do", "extension", "server"],
    },
    methods,
    handler: async (ctx, method, args) => {
      switch (method) {
        // -----------------------------------------------------------------
        // Reads
        // -----------------------------------------------------------------

        case "getInfo":
          return {
            path: workspace.path,
            statePath: workspace.statePath,
            contextsPath: workspace.contextsPath,
            config: deps.getConfig(),
          };

        case "list":
          return deps.centralData ? deps.centralData.listWorkspaces() : [];

        case "getActive":
          return deps.getConfig().id;

        case "getActiveEntry": {
          const active = deps.getConfig().id;
          const catalogEntry = deps.centralData?.getWorkspaceEntry(active);
          if (isWorkspaceEntry(catalogEntry)) return catalogEntry;

          const entries = deps.centralData ? deps.centralData.listWorkspaces() : [];
          const listedEntry = entries.find(
            (entry): entry is { name: string; lastOpened: number } =>
              isWorkspaceEntry(entry) && entry.name === active
          );
          return listedEntry ?? fallbackWorkspaceEntry(active);
        }

        case "getConfig":
          return deps.getConfig();

        // -----------------------------------------------------------------
        // Writes
        // -----------------------------------------------------------------

        case "create": {
          if (!deps.centralData) throw new Error("Workspace creation not available");
          const [name, opts] = args as [string, { forkFrom?: string } | undefined];
          await requireWorkspaceApproval(deps, ctx, "create", {
            target: name,
            title: "Create workspace?",
            summary: "This panel or worker wants to create a new workspace.",
            details: opts?.forkFrom ? [{ label: "Fork from", value: opts.forkFrom }] : undefined,
          });
          return deps.createWorkspace(name, opts);
        }

        case "delete": {
          if (!deps.centralData) throw new Error("Workspace deletion not available");
          const [name] = args as [string];
          if (name === deps.getConfig().id) {
            throw new Error("Cannot delete the currently running workspace");
          }
          const attachedServer = deps.centralData.getWorkspaceLocalServer?.(name);
          if (attachedServer?.pid) {
            try {
              process.kill(attachedServer.pid, 0);
              throw new Error(
                `Cannot delete workspace “${name}” while its server (PID ${attachedServer.pid}) is running. Stop that workspace server first.`
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                deps.centralData.clearWorkspaceLocalServer?.(name);
              } else if (!(error instanceof Error) || !error.message.startsWith("Cannot delete")) {
                throw new Error(
                  `Cannot verify whether workspace “${name}” server PID ${attachedServer.pid} is still running. Stop it before deleting the workspace.`
                );
              } else {
                throw error;
              }
            }
          }
          await requireWorkspaceApproval(deps, ctx, "delete", {
            target: name,
            title: "Delete workspace?",
            summary: "This panel or worker wants to permanently delete a workspace.",
            warning: "This removes the workspace directory and cannot be undone.",
          });
          deps.deleteWorkspaceDir(name);
          deps.centralData.removeWorkspace(name);
          return;
        }

        case "select": {
          const [name] = args as [string];
          if (!deps.centralData) {
            throw new Error("Workspace switching requires an attached desktop workspace catalog.");
          }
          if (!deps.centralData.hasWorkspace(name)) {
            const names = deps.centralData
              .listWorkspaces()
              .filter(isWorkspaceEntry)
              .map((entry) => entry.name);
            const suggestion = closestWorkspaceName(name, names);
            throw new Error(
              `Workspace "${name}" does not exist; create it first.${
                suggestion ? ` Did you mean "${suggestion}"?` : ""
              }`
            );
          }
          if (
            !deps.eventService ||
            !deps.eventService.getSubscriberCount ||
            deps.eventService.getSubscriberCount("workspace:relaunch-requested") === 0
          ) {
            throw new Error(
              "No desktop shell is attached to switch workspaces. Reconnect from the desktop app and try again."
            );
          }
          await requireWorkspaceApproval(deps, ctx, "select", {
            target: name,
            title: "Switch workspace?",
            summary: "This panel or worker wants to switch the active workspace.",
            warning: "Switching workspaces relaunches the app.",
          });
          // Touch the catalog so the workspace is marked as recently opened.
          deps.centralData.touchWorkspace(name);
          // Signal any attached desktop shell to relaunch into the new
          // workspace. With no shell attached the event goes nowhere and the
          // caller must reconnect manually.
          deps.eventService?.emit("workspace:relaunch-requested", { name });
          return;
        }

        case "setInitPanels": {
          const [initPanels] = args as [
            Array<{ source: string; stateArgs?: Record<string, unknown> }>,
          ];
          await requireWorkspaceApproval(deps, ctx, "setInitPanels", {
            target: deps.getConfig().id,
            title: "Change initial workspace panels?",
            summary: "This panel or worker wants to change the panels opened for this workspace.",
            details: [
              { label: "Init panels", value: describeJson(initPanels), format: "markdown" },
            ],
          });
          deps.setConfigField("initPanels", initPanels);
          return;
        }

        case "setConfigField": {
          const [key, value] = args as [string, unknown];
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
          deps.setConfigField(key, value);
          return;
        }

        // -----------------------------------------------------------------
        // Agent resource loading (filesystem reads from the workspace tree)
        // -----------------------------------------------------------------

        case "getAgentsMd": {
          // Read the workspace-level AGENTS.md from meta/. Missing file is not
          // an error — an empty string lets the agent resource loader fall back.
          const filePath = path.join(workspace.path, "meta", "AGENTS.md");
          try {
            return await fs.readFile(filePath, "utf-8");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw err;
          }
        }

        case "listSkills": {
          return await listWorkspaceSkillEntries(workspace.path);
        }

        case "readSkill": {
          const [nameOrPath] = args as [string];
          const skillMdPath = await resolveSkillMdPath(workspace.path, nameOrPath);
          return await fs.readFile(skillMdPath, "utf-8");
        }

        case "sourceTree": {
          if (!deps.treeScanner) throw new Error("Workspace source tree is unavailable");
          return deps.treeScanner.getSourceTree();
        }

        case "ensureContextFolder": {
          if (!deps.ensureContextFolder) {
            throw new ServiceError(
              "workspace",
              method,
              "Context folder materialization is unavailable",
              "ENOENT"
            );
          }
          const [contextId] = args as [string];
          await requireEnsureContextFolderAccess(deps, ctx, contextId);
          return await deps.ensureContextFolder(contextId);
        }

        case "findUnitForPath": {
          if (!deps.treeScanner) throw new Error("Workspace source tree is unavailable");
          const inputPath = normalizeWorkspaceRelativePath(args[0] as string);
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
        }

        case "units.list":
          return deps.listUnits ? await deps.listUnits() : [];

        case "units.inspector": {
          const [name] = args as [string];
          const rows = deps.listUnits ? await deps.listUnits() : [];
          const row = rows.find((unit) => unit.name === name || unit.source === name);
          const url = row?.inspectorUrl ?? null;
          return url ? { url } : null;
        }

        case "units.restart": {
          if (!deps.restartUnit) throw new Error("Workspace unit restart not available");
          const [name] = args as [string];
          await deps.restartUnit(ctx, name);
          return;
        }

        case "units.logs": {
          if (!deps.listUnitLogs) return [];
          const [name, opts] = args as [
            string,
            (
              | {
                  since?: number;
                  sinceSeq?: number;
                  level?: WorkspaceUnitLogRecord["level"];
                  limit?: number;
                }
              | undefined
            ),
          ];
          return await deps.listUnitLogs(name, opts);
        }

        case "units.diagnostics": {
          if (!deps.unitDiagnostics) {
            const [name, opts] = args as [
              string,
              (
                | {
                    since?: number;
                    sinceSeq?: number;
                    level?: WorkspaceUnitLogRecord["level"];
                    limit?: number;
                  }
                | undefined
              ),
            ];
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
          const [name, opts] = args as [
            string,
            (
              | {
                  since?: number;
                  sinceSeq?: number;
                  level?: WorkspaceUnitLogRecord["level"];
                  limit?: number;
                  errorLimit?: number;
                }
              | undefined
            ),
          ];
          return await deps.unitDiagnostics(name, opts);
        }

        case "units.versions": {
          if (!deps.listAppVersions) return { current: null, previous: [], retentionLimit: 0 };
          const [name] = args as [string];
          await requireAppUnitManagementAccess(deps, ctx, method, name);
          return await deps.listAppVersions(name);
        }

        case "units.rollback": {
          if (!deps.rollbackAppVersion) throw new Error("App rollback is not available");
          const [name, opts] = args as [string, { buildKey?: string } | undefined];
          await requireAppUnitManagementAccess(deps, ctx, method, name);
          return await deps.rollbackAppVersion(name, opts?.buildKey);
        }

        case "units.bakeAppDist": {
          if (!isTrustedWorkspaceCaller(ctx, deps)) {
            throw new ServiceError(
              "workspace",
              method,
              `workspace.${method} is not accessible to ${ctx.caller.runtime.kind} callers`,
              "EACCES"
            );
          }
          if (!deps.bakeAppDist) {
            throw new Error("App dist bake is not available");
          }
          const [sourceOrName, opts] = args as [string, { outDir?: string } | undefined];
          return await deps.bakeAppDist(sourceOrName, opts);
        }

        case "recurring.list":
          return deps.listRecurringJobs ? await deps.listRecurringJobs() : [];

        case "heartbeats.list":
          return deps.listHeartbeats ? await deps.listHeartbeats() : [];

        case "heartbeats.runNow": {
          const [name] = args as [string];
          if (!deps.runHeartbeatNow) {
            throw new ServiceError(
              "workspace",
              method,
              "Heartbeat controls are unavailable",
              "ENOENT"
            );
          }
          return deps.runHeartbeatNow(name);
        }

        case "heartbeats.pause": {
          const [name] = args as [string];
          if (!deps.pauseHeartbeat) {
            throw new ServiceError(
              "workspace",
              method,
              "Heartbeat controls are unavailable",
              "ENOENT"
            );
          }
          return deps.pauseHeartbeat(name);
        }

        case "heartbeats.resume": {
          const [name] = args as [string];
          if (!deps.resumeHeartbeat) {
            throw new ServiceError(
              "workspace",
              method,
              "Heartbeat controls are unavailable",
              "ENOENT"
            );
          }
          return deps.resumeHeartbeat(name);
        }

        case "hostTargets.list": {
          if (!deps.listHostTargetCandidates) return [];
          const [target] = args as [HostTarget];
          return await deps.listHostTargetCandidates(target);
        }

        case "hostTargets.getSelection": {
          if (!deps.getHostTargetSelection) {
            return {
              selection: null,
              valid: false,
              reason: "Host target selection is unavailable",
            };
          }
          const [target] = args as [HostTarget];
          return await deps.getHostTargetSelection(target);
        }

        case "hostTargets.setSelection": {
          if (!deps.setHostTargetSelection) throw new Error("Host target selection is unavailable");
          const [target, input] = args as [HostTarget, HostTargetSelectionInput];
          return await deps.setHostTargetSelection(target, input);
        }

        case "hostTargets.clearSelection": {
          if (!deps.clearHostTargetSelection) return;
          const [target] = args as [HostTarget];
          return await deps.clearHostTargetSelection(target);
        }

        case "hostTargets.versions": {
          if (!deps.listHostTargetVersions) {
            return { current: null, previous: [], retentionLimit: 0 };
          }
          const [target, sourceOrName] = args as [HostTarget, string];
          return await deps.listHostTargetVersions(target, sourceOrName);
        }

        case "hostTargets.preparePinnedRef": {
          if (!deps.prepareHostTargetPinnedRef) {
            throw new Error("Pinned ref preparation is unavailable");
          }
          const [target, sourceOrName, ref] = args as [HostTarget, string, string];
          return await deps.prepareHostTargetPinnedRef(target, sourceOrName, ref);
        }

        case "hostTargets.launch": {
          if (!deps.launchHostTarget) {
            const [target] = args as [HostTarget];
            return {
              status: "unavailable",
              launched: false,
              target,
              reason: "Host target launch is unavailable",
              details: [],
            } satisfies HostTargetLaunchResult;
          }
          const [target] = args as [HostTarget];
          return await deps.launchHostTarget(target);
        }

        case "hostTargets.beginLaunch": {
          const [target] = args as [HostTarget];
          if (!deps.beginHostTargetLaunch) {
            throw new Error("Host target launch sessions are unavailable");
          }
          return await deps.beginHostTargetLaunch(target);
        }

        case "hostTargets.getLaunchSession": {
          const [sessionId] = args as [string];
          return (await deps.getHostTargetLaunchSession?.(sessionId)) ?? null;
        }

        case "hostTargets.resolveLaunchSessionApproval": {
          const [sessionId, decision] = args as [string, "once" | "deny"];
          if (!deps.resolveHostTargetLaunchSessionApproval) {
            throw new Error("Host target launch sessions are unavailable");
          }
          return await deps.resolveHostTargetLaunchSessionApproval(sessionId, decision);
        }

        case "hostTargets.cancelLaunchSession": {
          const [sessionId] = args as [string];
          await deps.cancelHostTargetLaunchSession?.(sessionId);
          return;
        }

        default:
          throw new Error(`Unknown workspace method: ${method}`);
      }
    },
  };
}

function closestWorkspaceName(target: string, names: string[]): string | null {
  const normalized = target.toLowerCase();
  let best: { name: string; distance: number } | null = null;
  for (const name of names) {
    const distance = levenshtein(normalized, name.toLowerCase());
    if (!best || distance < best.distance) best = { name, distance };
  }
  if (!best || best.distance > Math.max(2, Math.floor(normalized.length / 3))) return null;
  return best.name;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] ?? 0) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}
