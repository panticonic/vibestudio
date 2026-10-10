import { panelCdpMethods } from "@vibestudio/service-schemas/panelCdp";
import type { BrowserAutomationRequest } from "@vibestudio/shared/panel/browserAutomation";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { CallerKind, ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type {
  PanelAccessPermissionDeps,
  PanelAccessPermissionTarget,
} from "./panelAccessPermission.js";
import { approvalTargetForPanel, preparePanelAccessAuthority } from "./panelAccessPermission.js";
import type { PanelEvaluateOptions, PanelEvaluateResult } from "@vibestudio/shared/panel/evaluate";

export type { PanelEvaluateOptions, PanelEvaluateResult };

export interface CdpEndpoint {
  wsEndpoint: string;
  token?: string;
}

export type PanelConsoleHistoryLevel = "debug" | "info" | "warning" | "error" | "unknown";

export interface PanelConsoleHistoryOptions {
  limit?: number;
  errorLimit?: number;
  levels?: PanelConsoleHistoryLevel[];
  sources?: Array<"console" | "lifecycle">;
  contains?: string;
  since?: number;
  until?: number;
  beforeSeq?: number;
}

export interface PanelConsoleHistoryEntry {
  seq?: number;
  timestamp: number;
  level: PanelConsoleHistoryLevel;
  message: string;
  line: number;
  sourceId: string;
  url: string;
}

export interface PanelConsoleHistoryResult {
  entries: PanelConsoleHistoryEntry[];
  errors: PanelConsoleHistoryEntry[];
  page: { nextBeforeSeq: number | null; hasOlder: boolean };
  dropped: {
    entries: number;
    errors: number;
  };
  capacity: {
    entries: number;
    errors: number;
  };
}

export interface PanelCdpHostProviderCaller {
  id: string;
  kind: CallerKind;
}

export interface PanelScreenshotOptions {
  format?: "png" | "jpeg";
  quality?: number;
}

export interface PanelScreenshotResult {
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export interface PanelCdpServiceDeps extends PanelAccessPermissionDeps {
  getTarget(
    panelId: string
  ): Promise<PanelAccessPermissionTarget | null> | PanelAccessPermissionTarget | null;
  /**
   * Ensure a CDP-capable host holds this target, then mint the server-local
   * handshake endpoint/token. The registration layer wires this to lease
   * assignment and provider-ready waiting before returning an endpoint.
   */
  getEndpoint(panelId: string, requesterEntityId: string): Promise<CdpEndpoint>;
  /**
   * One-RPC screenshot: the registration layer routes this to the active CDP
   * host's `captureScreenshot` host command (ViewManager.captureView — force-
   * paints hidden/unslotted views), so callers need no CDP WebSocket client.
   */
  screenshot?(
    panelId: string,
    requesterEntityId: string,
    options?: PanelScreenshotOptions
  ): Promise<PanelScreenshotResult>;
  /**
   * One-RPC `Runtime.evaluate`: the registration layer routes this to the
   * active CDP host's `evaluate` host command, which runs the caller's
   * expression under a bounded wrapper and returns a serialized result. This
   * exists so the common case never needs a raw CDP WebSocket endpoint.
   */
  evaluate?(
    panelId: string,
    requesterEntityId: string,
    expression: string,
    options?: PanelEvaluateOptions
  ): Promise<PanelEvaluateResult>;
  reload?(ctx: ServiceContext, panelId: string, runtimeEntityId: string): Promise<void>;
  stop?(panelId: string, requesterEntityId: string): Promise<unknown>;
  consoleHistory?(
    panelId: string,
    requesterEntityId: string,
    options?: PanelConsoleHistoryOptions
  ): Promise<PanelConsoleHistoryResult>;
  browserOperation?(
    panelId: string,
    request: BrowserAutomationRequest,
    signal?: AbortSignal
  ): Promise<unknown>;
  hostProvider?: {
    open(sessionId: string, hostConnectionId: string, caller: PanelCdpHostProviderCaller): Response;
    send(sessionId: string, data: string, caller: PanelCdpHostProviderCaller): void | Promise<void>;
    close(sessionId: string, caller: PanelCdpHostProviderCaller): void | Promise<void>;
  };
  logAccess?(event: PanelCdpAccessEvent): void;
  /** Advance an agent session's latch before inspected page bytes are returned. */
}

export interface PanelCdpAccessEvent {
  method: string;
  requesterId: string;
  requesterKind: string;
  targetId: string;
  targetKind?: string;
  targetSource?: string;
  denied?: boolean;
  reason?: string;
}

export function createPanelCdpService(deps: PanelCdpServiceDeps): ServiceDefinition {
  async function requireTarget(panelId: string): Promise<PanelAccessPermissionTarget> {
    const target = await deps.getTarget(panelId);
    if (!target) throw new Error(`Panel not found: ${panelId}`);
    return target;
  }

  function recordAccess(
    method: string,
    ctx: ServiceContext,
    target: PanelAccessPermissionTarget,
    denied?: { reason: string }
  ): void {
    deps.logAccess?.({
      method,
      requesterId: ctx.caller.runtime.id,
      requesterKind: ctx.caller.runtime.kind,
      targetId: target.id,
      targetKind: target.kind,
      targetSource: target.source,
      denied: denied ? true : undefined,
      reason: denied?.reason,
    });
  }

  async function recordCdpAccess(
    ctx: ServiceContext,
    method: string,
    panelId: string
  ): Promise<PanelAccessPermissionTarget> {
    const target = await requireTarget(panelId);
    recordAccess(method, ctx, target);
    return target;
  }

  return {
    name: "panelCdp",
    description: "Approval-gated server CDP access for panel targets",
    // `agent` = linked external sessions (attached over RPC) driving the
    // frontend-dev loop over the CLI; every target op below is gated by the
    // same context-boundary permission as sandboxed code callers.
    authority: { principals: ["user", "host", "code"] },
    methods: panelCdpMethods,
    authorityPreparation: Object.fromEntries(
      [
        ["getCdpEndpoint", "cdp"],
        ["browserOperation", "cdp"],
        ["consoleHistory", "cdp"],
        ["screenshot", "cdp"],
        ["evaluate", "cdp"],
        ["reload", "reload"],
        ["stop", "stop"],
      ].map(([method, operation]) => [
        `panelCdp.${method}.contextBoundary`,
        async (ctx: ServiceContext, args: unknown[]) => {
          const panelId = String(args[0]);
          const target = await requireTarget(panelId);
          return {
            selections: await preparePanelAccessAuthority(
              deps,
              ctx,
              operation as "cdp" | "navigate" | "reload" | "goBack" | "goForward" | "stop",
              target
            ),
            payload: null,
            target: approvalTargetForPanel(target),
          };
        },
      ])
    ),
    handler: defineServiceHandler("panelCdp", panelCdpMethods, {
      "hostProvider.open": (ctx, [sessionId, hostConnectionId]) => {
        if (!deps.hostProvider) throw new Error("CDP host provider transport is unavailable");
        return deps.hostProvider.open(sessionId, hostConnectionId, {
          id: ctx.caller.runtime.id,
          kind: ctx.caller.runtime.kind,
        });
      },
      "hostProvider.send": async (ctx, [sessionId, data]) => {
        if (!deps.hostProvider) throw new Error("CDP host provider transport is unavailable");
        await deps.hostProvider.send(sessionId, data, {
          id: ctx.caller.runtime.id,
          kind: ctx.caller.runtime.kind,
        });
      },
      "hostProvider.close": async (ctx, [sessionId]) => {
        if (!deps.hostProvider) throw new Error("CDP host provider transport is unavailable");
        await deps.hostProvider.close(sessionId, {
          id: ctx.caller.runtime.id,
          kind: ctx.caller.runtime.kind,
        });
      },
      getCdpEndpoint: async (ctx, [panelId]) => {
        await recordCdpAccess(ctx, "getCdpEndpoint", panelId);
        const endpoint = await deps.getEndpoint(panelId, ctx.caller.runtime.id);
        return endpoint;
      },
      browserOperation: async (ctx, [panelId, request]) => {
        await recordCdpAccess(ctx, "browserOperation", panelId);
        if (!deps.browserOperation) throw new Error("Native browser automation is unavailable");
        return deps.browserOperation(panelId, request, ctx.signal);
      },
      consoleHistory: async (ctx, [panelId, options]) => {
        await recordCdpAccess(ctx, "consoleHistory", panelId);
        if (!deps.consoleHistory) throw new Error("Panel console history is not available");
        const result = await deps.consoleHistory(panelId, ctx.caller.runtime.id, options);
        return result;
      },
      screenshot: async (ctx, [panelId, options]) => {
        await recordCdpAccess(ctx, "screenshot", panelId);
        if (!deps.screenshot) throw new Error("Panel screenshot is not available");
        const result = await deps.screenshot(panelId, ctx.caller.runtime.id, options);
        return result;
      },
      evaluate: async (ctx, [panelId, expression, options]) => {
        await recordCdpAccess(ctx, "evaluate", panelId);
        if (!deps.evaluate) throw new Error("Panel evaluation is not available");
        const result = await deps.evaluate(panelId, ctx.caller.runtime.id, expression, options);
        // An expression that threw still read the page to decide it should
        // throw, so the latch advances on the attempt, not on the outcome.
        return result;
      },
      reload: async (ctx, [panelId]) => {
        const target = await recordCdpAccess(ctx, "reload", panelId);
        if (!deps.reload) throw new Error("Panel reload driver is not available");
        await deps.reload(ctx, panelId, target.runtimeEntityId ?? panelId);
      },
      stop: async (ctx, [panelId]) => {
        await recordCdpAccess(ctx, "stop", panelId);
        if (!deps.stop) throw new Error("Panel CDP stop driver is not available");
        return deps.stop(panelId, ctx.caller.runtime.id);
      },
    }),
  };
}
