import { z } from "zod";
import { browserUrlFromPanelSource } from "@vibestudio/shared/panelChrome";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import type { CallerKind, ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type {
  PanelAccessPermissionDeps,
  PanelAccessPermissionTarget,
} from "./panelAccessPermission.js";
import { approvalTargetForPanel, preparePanelAccessAuthority } from "./panelAccessPermission.js";
import type { ContextIngestionRecorder } from "./contextIntegrityStore.js";
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
  hostProvider?: {
    open(sessionId: string, hostConnectionId: string, caller: PanelCdpHostProviderCaller): Response;
    send(sessionId: string, data: string, caller: PanelCdpHostProviderCaller): void | Promise<void>;
    close(sessionId: string, caller: PanelCdpHostProviderCaller): void | Promise<void>;
  };
  logAccess?(event: PanelCdpAccessEvent): void;
  /** Advance an agent session's latch before inspected page bytes are returned. */
  recordContextIngestion?: ContextIngestionRecorder;
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
    limit: z.number().int().min(1).max(1000).optional(),
    errorLimit: z.number().int().min(0).max(500).optional(),
    levels: z.array(z.enum(["debug", "info", "warning", "error", "unknown"])).optional(),
    sources: z.array(z.enum(["console", "lifecycle"])).optional(),
    contains: z.string().max(512).optional(),
    since: z.number().optional(),
    until: z.number().optional(),
    beforeSeq: z.number().int().positive().optional(),
  })
  .optional();

const screenshotOptionsSchema = z
  .object({
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().min(0).max(100).optional(),
  })
  .optional();

const evaluateOptionsSchema = z
  .object({
    timeoutMs: z.number().positive().optional(),
    valueLimit: z.number().positive().optional(),
  })
  .optional();

const evaluateResultSchema = z.object({
  ok: z.boolean(),
  type: z.string(),
  value: z.string().nullable(),
  error: z.string().nullable(),
  truncated: z.boolean(),
});

const screenshotResultSchema = z.object({
  data: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number(),
  height: z.number(),
});

function cdpBoundaryAuthority(method: string) {
  // Minting the raw CDP endpoint is the one promptable primary effect. Bind it
  // to the stable user-facing capability; the wire method name is transport,
  // not authority vocabulary. The other CDP helpers are open primary methods
  // whose dynamically selected cross-context leaf remains independently gated.
  const capability = method === "getCdpEndpoint" ? "panel.inspect" : `service:panelCdp.${method}`;
  return {
    requirement: requirementForPrincipals(["code", "user", "host"], capability),
    resource: {
      kind: "argument" as const,
      index: 0,
      presentation: { type: "panel", label: "Panel" },
    },
    prepared: {
      resolver: `panelCdp.${method}.contextBoundary`,
      leaves: [
        {
          capability: "context.boundary",
          requirement: fixedPreparedAuthorityRequirement(
            requirementForPrincipals(["code", "user", "host"], "context.boundary")
          ),
          tier: { selectedFrom: ["gated", "critical"] as const },
        },
      ],
    },
  };
}

const panelCdpMethods = defineServiceMethods({
  getCdpEndpoint: {
    capability: "panel.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale:
        "Mints one short-lived authenticated endpoint for the exact already-authorized native CDP target",
    },
    presentation: {
      title: "Inspect a panel with developer tools",
      action: "inspect a panel with developer tools",
      description: "Allows {requesterKind} to inspect a panel with developer tools.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
    description: "Return a single-use CDP WebSocket endpoint for an approved panel target.",
    args: z.tuple([z.string()]),
    authority: cdpBoundaryAuthority("getCdpEndpoint"),
    access: { sensitivity: "admin" },
  },
  stop: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Stops loading in the exact native webContents selected by the receiver-bound target",
    },
    description: "Stop loading an approved panel target through its active CDP host.",
    args: z.tuple([z.string()]),
    authority: cdpBoundaryAuthority("stop"),
    access: { sensitivity: "write" },
  },
  consoleHistory: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale: "Returns a bounded observation from the exact authenticated native CDP provider",
    },
    description: "Read console history from an approved panel target's active CDP host.",
    args: z.tuple([z.string(), consoleHistoryOptionsSchema]),
    authority: cdpBoundaryAuthority("consoleHistory"),
    access: { sensitivity: "read" },
  },
  evaluate: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Runs one bounded expression in the exact native view selected by receiver-bound target authority",
    },
    description:
      "Evaluate one expression in an approved panel target through its active CDP host. " +
      "The expression runs under a bounded wrapper (8s) and the result is serialized to a " +
      "string, so no CDP WebSocket client is needed for the common inspect-and-poke case.",
    args: z.tuple([z.string(), z.string(), evaluateOptionsSchema]),
    returns: evaluateResultSchema,
    authority: cdpBoundaryAuthority("evaluate"),
    // Arbitrary page script can mutate the document it runs in; this is not a
    // read-only observation even when the caller only means to look.
    access: { sensitivity: "write" },
  },
  reload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Reloads the exact receiver-bound panel generation without exposing its host lease mechanics",
    },
    description: "Reload an approved panel target through its product lifecycle.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    authority: cdpBoundaryAuthority("reload"),
    access: { sensitivity: "write" },
  },
  screenshot: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Force-paints and captures the exact native view selected by receiver-bound target authority",
    },
    description:
      "Capture a screenshot of an approved panel target through its active CDP host " +
      "(force-paints hidden/unslotted panels). Returns base64 image data + mime type; " +
      "no CDP WebSocket client needed.",
    args: z.tuple([z.string(), screenshotOptionsSchema]),
    returns: screenshotResultSchema,
    authority: cdpBoundaryAuthority("screenshot"),
    access: { sensitivity: "read" },
  },
  "hostProvider.open": {
    capability: "panel.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale: "Opens one authenticated provider stream for an already-minted exact CDP session",
    },
    presentation: {
      title: "Inspect a panel",
      action: "inspect a panel",
      description: "Allows {requesterKind} to inspect a panel.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
    description: "Internal shell/server transport: open a streamed CDP host-provider channel.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.instanceof(Response),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "admin" as const },
  },
  "hostProvider.send": {
    capability: "panel.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale:
        "Relays one frame inside the exact authenticated CDP provider session without product policy",
    },
    presentation: {
      title: "Control an inspected panel",
      action: "control an inspected panel",
      description: "Allows {requesterKind} to control an inspected panel.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
    description:
      "Internal shell/server transport: deliver a CDP host-provider frame to the bridge.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "admin" as const },
  },
  "hostProvider.close": {
    capability: "panel.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale:
        "Closes the exact authenticated CDP provider stream and only reduces transport authority",
    },
    presentation: {
      title: "Stop inspecting a panel",
      action: "stop inspecting a panel",
      description: "Allows {requesterKind} to stop inspecting a panel.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
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

  async function recordCdpAccess(
    ctx: ServiceContext,
    method: string,
    panelId: string
  ): Promise<PanelAccessPermissionTarget> {
    const target = await requireTarget(panelId);
    recordAccess(method, ctx, target);
    return target;
  }

  async function recordCdpIngestion(
    ctx: ServiceContext,
    target: PanelAccessPermissionTarget,
    method: "getCdpEndpoint" | "consoleHistory" | "screenshot" | "evaluate"
  ): Promise<void> {
    const browserUrl =
      typeof target.source === "string" ? browserUrlFromPanelSource(target.source) : null;
    let key = `log:panel:${target.id}`;
    if (browserUrl) {
      try {
        const url = new URL(browserUrl);
        if (url.protocol === "http:" || url.protocol === "https:") {
          key = `web:${url.hostname.toLowerCase()}`;
        }
      } catch {
        // A stale browser source is still outside content. Keep panel-scoped
        // lineage rather than turning an otherwise valid inspection into an
        // agent-facing failure.
      }
    }
    await deps.recordContextIngestion?.(ctx, {
      key,
      via: `panel-cdp:${method}`,
      classification: "external",
    });
  }

  return {
    name: "panelCdp",
    description: "Approval-gated server CDP access for panel targets",
    // `agent` = linked external sessions (Claude Code et al.) driving the
    // frontend-dev loop over the CLI; every target op below is gated by the
    // same context-boundary permission as sandboxed code callers.
    authority: { principals: ["user", "host", "code"] },
    methods: panelCdpMethods,
    authorityPreparation: Object.fromEntries(
      [
        ["getCdpEndpoint", "cdp"],
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
        const target = await recordCdpAccess(ctx, "getCdpEndpoint", panelId);
        const endpoint = await deps.getEndpoint(panelId, ctx.caller.runtime.id);
        await recordCdpIngestion(ctx, target, "getCdpEndpoint");
        return endpoint;
      },
      consoleHistory: async (ctx, [panelId, options]) => {
        const target = await recordCdpAccess(ctx, "consoleHistory", panelId);
        if (!deps.consoleHistory) throw new Error("Panel console history is not available");
        const result = await deps.consoleHistory(panelId, ctx.caller.runtime.id, options);
        await recordCdpIngestion(ctx, target, "consoleHistory");
        return result;
      },
      screenshot: async (ctx, [panelId, options]) => {
        const target = await recordCdpAccess(ctx, "screenshot", panelId);
        if (!deps.screenshot) throw new Error("Panel screenshot is not available");
        const result = await deps.screenshot(panelId, ctx.caller.runtime.id, options);
        await recordCdpIngestion(ctx, target, "screenshot");
        return result;
      },
      evaluate: async (ctx, [panelId, expression, options]) => {
        const target = await recordCdpAccess(ctx, "evaluate", panelId);
        if (!deps.evaluate) throw new Error("Panel evaluation is not available");
        const result = await deps.evaluate(panelId, ctx.caller.runtime.id, expression, options);
        // An expression that threw still read the page to decide it should
        // throw, so the latch advances on the attempt, not on the outcome.
        await recordCdpIngestion(ctx, target, "evaluate");
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
