import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { CallerKind, ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { UserSubject } from "@vibestudio/identity/types";
import type { PanelAccessOperation } from "@vibestudio/shared/panelAccessPolicy";
import { panelTreeMethods } from "@vibestudio/service-schemas/panelTree";
import type {
  PanelAccessPermissionDeps,
  PanelAccessPermissionTarget,
} from "./panelAccessPermission.js";
import { requirePanelAccessPermission } from "./panelAccessPermission.js";

export interface PanelTreeBridgeRequest {
  callerId: string;
  callerKind: CallerKind;
  method: string;
  args: unknown[];
  /**
   * Host-verified acting user. Threaded intact so entity creation preserves
   * both the human owner and the original runtime lineage. Attribution only;
   * authorization stays in this service. Undefined for subjectless system work.
   */
  subject?: UserSubject;
}

export interface PanelTreeSourceValidationRequest {
  method: "create" | "navigate";
  source: string;
  options: Record<string, unknown>;
  targetPanelId?: string;
}

export interface PanelTreeServiceDeps extends PanelAccessPermissionDeps {
  bridge(request: PanelTreeBridgeRequest): Promise<unknown>;
  validateOpenPanelSource?(request: PanelTreeSourceValidationRequest): Promise<void>;
}

const METHOD_ACCESS: Partial<Record<string, PanelAccessOperation>> = {
  create: "openPanel",
  reload: "reload",
  close: "close",
  archive: "archive",
  unload: "unload",
  movePanel: "movePanel",
  navigate: "replacePanel",
  navigateHistory: "replacePanel",
  takeOver: "takeOver",
  openDevTools: "openDevTools",
  rebuildPanel: "rebuildPanel",
  rebuildAndReload: "rebuildAndReload",
  updatePanelState: "updatePanelState",
  setCollapsed: "updatePanelState",
  setStateArgs: "stateArgs.set",
};

const READONLY_AGENT_METHODS = new Set([
  "_agent.snapshot",
  "_agent.tree",
  "_agent.state",
  "_agent.routes",
]);

function toOptionsRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function createPanelTreeService(deps: PanelTreeServiceDeps): ServiceDefinition {
  async function bridge(ctx: ServiceContext, method: string, args: unknown[]): Promise<unknown> {
    return deps.bridge({
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      method,
      args,
      // Stamp the acting user as owner on create/move (WP3). Attribution only.
      ...(ctx.caller.subject ? { subject: ctx.caller.subject } : {}),
    });
  }

  async function targetFor(
    ctx: ServiceContext,
    panelId: string
  ): Promise<PanelAccessPermissionTarget> {
    const meta = (await bridge(ctx, "metadata", [panelId])) as PanelAccessPermissionTarget | null;
    if (!meta) return { id: panelId };
    return { ...meta, id: panelId };
  }

  async function targetForCreate(
    ctx: ServiceContext,
    args: unknown[]
  ): Promise<PanelAccessPermissionTarget> {
    const source = typeof args[0] === "string" ? args[0] : undefined;
    const options = (args[1] ?? {}) as { parentId?: string | null; contextId?: string | null };
    const requestedContextId =
      typeof options.contextId === "string" && options.contextId.length > 0
        ? options.contextId
        : undefined;
    const enrich = (target: PanelAccessPermissionTarget): PanelAccessPermissionTarget => ({
      ...target,
      ...(source ? { requestedSource: source } : {}),
      ...(requestedContextId ? { requestedContextId } : {}),
      ...(source
        ? { operationGroupKey: `runtime-open:${requestedContextId ?? ""}:${source}` }
        : {}),
    });
    if (typeof options.parentId === "string" && options.parentId.length > 0) {
      return enrich(await targetFor(ctx, options.parentId));
    }
    if (ctx.caller.runtime.kind === "panel" && deps.resolveRequesterPanel) {
      const requesterPanel = await deps.resolveRequesterPanel(ctx.caller);
      if (requesterPanel) return enrich(requesterPanel);
    }
    return enrich({ id: "workspace-root", title: "Workspace root", source: "workspace-root" });
  }

  function operationFor(method: string, args: unknown[]): PanelAccessOperation | undefined {
    if (method === "callAgent") {
      const agentMethod = args[1];
      if (agentMethod === "_agent.setMode") return "updatePanelState";
      return undefined;
    }
    return METHOD_ACCESS[method];
  }

  function assertAllowedAgentMethod(method: string, args: unknown[]): void {
    if (method !== "callAgent") return;
    const agentMethod = args[1];
    if (agentMethod === "_agent.setMode" || READONLY_AGENT_METHODS.has(String(agentMethod))) return;
    throw new Error(`Unknown panel agent method: ${String(agentMethod)}`);
  }

  async function validatePanelSourceBeforeMutation(method: string, args: unknown[]): Promise<void> {
    if (!deps.validateOpenPanelSource) return;
    if (method === "create" && typeof args[0] === "string") {
      await deps.validateOpenPanelSource({
        method,
        source: args[0],
        options: toOptionsRecord(args[1]),
      });
      return;
    }
    if (method === "navigate" && typeof args[1] === "string") {
      await deps.validateOpenPanelSource({
        method,
        source: args[1],
        options: toOptionsRecord(args[2]),
        targetPanelId: typeof args[0] === "string" ? args[0] : undefined,
      });
    }
  }

  async function dispatch(
    ctx: ServiceContext,
    method: keyof typeof panelTreeMethods & string,
    args: unknown[]
  ): Promise<unknown> {
    assertAllowedAgentMethod(method, args);
    await validatePanelSourceBeforeMutation(method, args);
    const op = operationFor(method, args);
    if (op) {
      const target =
        method === "create"
          ? await targetForCreate(ctx, args)
          : await targetFor(
              ctx,
              method === "movePanel"
                ? (args[0] as { panelId: string }).panelId
                : (args[0] as string)
            );
      // Context-changing ops gate on their DESTINATION context, not the
      // panel's current one. `navigate` carries it in options; `navigateHistory`
      // moves into a stored history entry whose context can be foreign+existing,
      // so peek it (non-mutating) before the gate.
      if (method === "navigate") {
        const navContextId = (args[2] as { contextId?: string } | undefined)?.contextId;
        if (typeof navContextId === "string" && navContextId.length > 0) {
          target.requestedContextId = navContextId;
        }
      } else if (method === "navigateHistory") {
        const destContextId = (await bridge(ctx, "historyTargetContext", args)) as string | null;
        if (typeof destContextId === "string" && destContextId.length > 0) {
          target.requestedContextId = destContextId;
        }
      }
      const permission = await requirePanelAccessPermission(deps, ctx, op, target);
      if (!permission.allowed) {
        throw new Error(permission.reason ?? `${method} denied for panel ${target.id}`);
      }
    }
    if (method === "expandIds") {
      const panelIds = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      for (const panelId of panelIds) {
        const target = await targetFor(ctx, panelId);
        const permission = await requirePanelAccessPermission(
          deps,
          ctx,
          "updatePanelState",
          target
        );
        if (!permission.allowed) {
          throw new Error(permission.reason ?? `${method} denied for panel ${target.id}`);
        }
      }
    }

    return bridge(ctx, method, args);
  }

  return {
    name: "panelTree",
    description: "Server-mediated panel tree handles and control operations",
    // Authorized chrome gets full access through requirePanelAccessPermission.
    // Runtime callers (panel/worker/do/app) may also reach this service but are
    // scoped by resource grants unless they hold the chrome capability.
    policy: { allowed: ["panel", "worker", "do", "shell", "server", "app"] },
    methods: panelTreeMethods,
    handler: defineServiceHandler("panelTree", panelTreeMethods, {
      ensureLoaded: (ctx, args) => dispatch(ctx, "ensureLoaded", args),
      focus: (ctx, args) => dispatch(ctx, "focus", args),
      list: (ctx, args) => dispatch(ctx, "list", args),
      roots: (ctx, args) => dispatch(ctx, "roots", args),
      getTreeSnapshot: (ctx, args) => dispatch(ctx, "getTreeSnapshot", args),
      getFocusedPanelId: (ctx, args) => dispatch(ctx, "getFocusedPanelId", args),
      create: (ctx, args) => dispatch(ctx, "create", args),
      getRuntimeLease: (ctx, args) => dispatch(ctx, "getRuntimeLease", args),
      getStateArgs: (ctx, args) => dispatch(ctx, "getStateArgs", args),
      setStateArgs: (ctx, args) => dispatch(ctx, "setStateArgs", args),
      reload: (ctx, args) => dispatch(ctx, "reload", args),
      close: (ctx, args) => dispatch(ctx, "close", args),
      archive: (ctx, args) => dispatch(ctx, "archive", args),
      archiveOwnedRoots: (ctx, args) => dispatch(ctx, "archiveOwnedRoots", args),
      unload: (ctx, args) => dispatch(ctx, "unload", args),
      movePanel: (ctx, args) => dispatch(ctx, "movePanel", args),
      navigate: (ctx, args) => dispatch(ctx, "navigate", args),
      navigateHistory: (ctx, args) => dispatch(ctx, "navigateHistory", args),
      takeOver: (ctx, args) => dispatch(ctx, "takeOver", args),
      openDevTools: (ctx, args) => dispatch(ctx, "openDevTools", args),
      rebuildPanel: (ctx, args) => dispatch(ctx, "rebuildPanel", args),
      rebuildAndReload: (ctx, args) => dispatch(ctx, "rebuildAndReload", args),
      updatePanelState: (ctx, args) => dispatch(ctx, "updatePanelState", args),
      snapshot: (ctx, args) => dispatch(ctx, "snapshot", args),
      callAgent: (ctx, args) => dispatch(ctx, "callAgent", args),
      metadata: (ctx, args) => dispatch(ctx, "metadata", args),
      getCollapsedIds: (ctx, args) => dispatch(ctx, "getCollapsedIds", args),
      setCollapsed: (ctx, args) => dispatch(ctx, "setCollapsed", args),
      expandIds: (ctx, args) => dispatch(ctx, "expandIds", args),
    }),
  };
}
