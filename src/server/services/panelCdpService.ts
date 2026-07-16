import { z } from "zod";
import { assertHttpUrl } from "@vibestudio/shared/httpUrl";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { contextBoundaryAuthority } from "@vibestudio/service-schemas/authority/contextBoundary";
import type { CallerKind, ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type {
  PanelAccessPermissionDeps,
  PanelAccessPermissionTarget,
} from "./panelAccessPermission.js";
import { preparePanelAccessAuthority } from "./panelAccessPermission.js";

export interface CdpEndpoint {
  wsEndpoint: string;
  token?: string;
}

export type PanelConsoleHistoryLevel = "debug" | "info" | "warning" | "error" | "unknown";

export interface PanelConsoleHistoryOptions {
  limit?: number;
  errorLimit?: number;
  levels?: PanelConsoleHistoryLevel[];
}

export interface PanelConsoleHistoryEntry {
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
  drive?(
    panelId: string,
    requesterEntityId: string,
    command: "navigate" | "reload" | "goBack" | "goForward" | "stop",
    args: unknown[]
  ): Promise<unknown>;
  consoleHistory?(
    panelId: string,
    requesterEntityId: string,
    options?: PanelConsoleHistoryOptions
  ): Promise<PanelConsoleHistoryResult>;
  hostProvider?: {
    open(sessionId: string, hostConnectionId: string, caller: PanelCdpHostProviderCaller): Response;
    send(sessionId: string, data: string, caller: PanelCdpHostProviderCaller): void | Promise<void>;
    close(sessionId: string, caller: PanelCdpHostProviderCaller): void | Promise<void>;
  };
  logAccess?(event: PanelCdpAccessEvent): void;
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

const consoleHistoryOptionsSchema = z
  .object({
    limit: z.number().optional(),
    errorLimit: z.number().optional(),
    levels: z.array(z.enum(["debug", "info", "warning", "error", "unknown"])).optional(),
  })
  .optional();

const screenshotOptionsSchema = z
  .object({
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().min(0).max(100).optional(),
  })
  .optional();

const screenshotResultSchema = z.object({
  data: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number(),
  height: z.number(),
});

const panelCdpAuthority = (method: string) =>
  contextBoundaryAuthority({
    service: "panelCdp",
    method,
    principals: ["user", "host", "code", "entity"],
  });

const panelCdpMethods = defineServiceMethods({
  getCdpEndpoint: {
    description: "Return a single-use CDP WebSocket endpoint for an approved panel target.",
    args: z.tuple([z.string()]),
    access: { sensitivity: "admin" },
    authority: panelCdpAuthority("getCdpEndpoint"),
  },
  navigate: {
    description: "Navigate an approved browser panel target through its active CDP host.",
    args: z.tuple([z.string(), z.string()]),
    access: { sensitivity: "write" },
    authority: panelCdpAuthority("navigate"),
  },
  reload: {
    description: "Reload an approved panel target through its active CDP host.",
    args: z.tuple([z.string()]),
    access: { sensitivity: "write" },
    authority: panelCdpAuthority("reload"),
  },
  goBack: {
    description: "Drive browser history back on an approved panel target.",
    args: z.tuple([z.string()]),
    access: { sensitivity: "write" },
    authority: panelCdpAuthority("goBack"),
  },
  goForward: {
    description: "Drive browser history forward on an approved panel target.",
    args: z.tuple([z.string()]),
    access: { sensitivity: "write" },
    authority: panelCdpAuthority("goForward"),
  },
  stop: {
    description: "Stop loading an approved panel target through its active CDP host.",
    args: z.tuple([z.string()]),
    access: { sensitivity: "write" },
    authority: panelCdpAuthority("stop"),
  },
  consoleHistory: {
    description: "Read console history from an approved panel target's active CDP host.",
    args: z.tuple([z.string(), consoleHistoryOptionsSchema]),
    access: { sensitivity: "read" },
    authority: panelCdpAuthority("consoleHistory"),
  },
  screenshot: {
    description:
      "Capture a screenshot of an approved panel target through its active CDP host " +
      "(force-paints hidden/unslotted panels). Returns base64 image data + mime type; " +
      "no CDP WebSocket client needed.",
    args: z.tuple([z.string(), screenshotOptionsSchema]),
    returns: screenshotResultSchema,
    access: { sensitivity: "read" },
    authority: panelCdpAuthority("screenshot"),
  },
  "hostProvider.open": {
    description: "Internal shell/server transport: open a streamed CDP host-provider channel.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.instanceof(Response),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "admin" as const },
  },
  "hostProvider.send": {
    description:
      "Internal shell/server transport: deliver a CDP host-provider frame to the bridge.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "admin" as const },
  },
  "hostProvider.close": {
    description: "Internal shell/server transport: close a CDP host-provider channel.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "admin" as const },
  },
});

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

  async function prepareCdpAccess(
    ctx: ServiceContext,
    method: string,
    panelId: string,
    operation: "cdp" | "navigate" | "reload" | "goBack" | "goForward" | "stop"
  ) {
    const target = await requireTarget(panelId);
    try {
      return await preparePanelAccessAuthority(deps, ctx, operation, target);
    } catch (error) {
      recordAccess(method, ctx, target, {
        reason: error instanceof Error ? error.message : `Panel ${method} denied`,
      });
      throw error;
    }
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

  async function drive(
    ctx: ServiceContext,
    method: "navigate" | "reload" | "goBack" | "goForward" | "stop",
    panelId: string,
    args: unknown[]
  ): Promise<unknown> {
    if (method === "navigate") assertHttpUrl(args[0]);
    await recordCdpAccess(ctx, method, panelId);
    if (!deps.drive) throw new Error(`Panel CDP driver is not available for ${method}`);
    return deps.drive(panelId, ctx.caller.runtime.id, method, args);
  }

  return {
    name: "panelCdp",
    description: "Approval-gated server CDP access for panel targets",
    // `agent` = linked external sessions (Claude Code et al.) driving the
    // frontend-dev loop over the CLI; every target op below is gated by the
    // same context-boundary permission as sandboxed code callers.
    authority: { principals: ["user", "host", "code", "entity"] },
    methods: panelCdpMethods,
    authorityPreparation: {
      "panelCdp.getCdpEndpoint.contextBoundary": (ctx, [panelId]) =>
        prepareCdpAccess(ctx, "getCdpEndpoint", String(panelId), "cdp"),
      "panelCdp.navigate.contextBoundary": (ctx, [panelId, url]) => {
        assertHttpUrl(String(url));
        return prepareCdpAccess(ctx, "navigate", String(panelId), "navigate");
      },
      "panelCdp.reload.contextBoundary": (ctx, [panelId]) =>
        prepareCdpAccess(ctx, "reload", String(panelId), "reload"),
      "panelCdp.goBack.contextBoundary": (ctx, [panelId]) =>
        prepareCdpAccess(ctx, "goBack", String(panelId), "goBack"),
      "panelCdp.goForward.contextBoundary": (ctx, [panelId]) =>
        prepareCdpAccess(ctx, "goForward", String(panelId), "goForward"),
      "panelCdp.stop.contextBoundary": (ctx, [panelId]) =>
        prepareCdpAccess(ctx, "stop", String(panelId), "stop"),
      "panelCdp.consoleHistory.contextBoundary": (ctx, [panelId]) =>
        prepareCdpAccess(ctx, "consoleHistory", String(panelId), "cdp"),
      "panelCdp.screenshot.contextBoundary": (ctx, [panelId]) =>
        prepareCdpAccess(ctx, "screenshot", String(panelId), "cdp"),
    },
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
        return deps.getEndpoint(panelId, ctx.caller.runtime.id);
      },
      consoleHistory: async (ctx, [panelId, options]) => {
        await recordCdpAccess(ctx, "consoleHistory", panelId);
        if (!deps.consoleHistory) throw new Error("Panel console history is not available");
        return deps.consoleHistory(panelId, ctx.caller.runtime.id, options);
      },
      screenshot: async (ctx, [panelId, options]) => {
        await recordCdpAccess(ctx, "screenshot", panelId);
        if (!deps.screenshot) throw new Error("Panel screenshot is not available");
        return deps.screenshot(panelId, ctx.caller.runtime.id, options);
      },
      navigate: (ctx, [panelId, url]) => drive(ctx, "navigate", panelId, [url]),
      reload: (ctx, [panelId]) => drive(ctx, "reload", panelId, []),
      goBack: (ctx, [panelId]) => drive(ctx, "goBack", panelId, []),
      goForward: (ctx, [panelId]) => drive(ctx, "goForward", panelId, []),
      stop: (ctx, [panelId]) => drive(ctx, "stop", panelId, []),
    }),
  };
}
