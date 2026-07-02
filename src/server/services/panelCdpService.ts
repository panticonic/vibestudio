import { z } from "zod";
import { assertHttpUrl } from "@vibez1/shared/httpUrl";
import type { ServiceDefinition } from "@vibez1/shared/serviceDefinition";
import type { CallerKind } from "@vibez1/shared/serviceDispatcher";
import type {
  PanelAccessPermissionDeps,
  PanelAccessPermissionTarget,
} from "./panelAccessPermission.js";
import { requirePanelAccessPermission } from "./panelAccessPermission.js";

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

export function createPanelCdpService(deps: PanelCdpServiceDeps): ServiceDefinition {
  async function requireTarget(panelId: string): Promise<PanelAccessPermissionTarget> {
    const target = await deps.getTarget(panelId);
    if (!target) throw new Error(`Panel not found: ${panelId}`);
    return target;
  }

  function recordAccess(
    method: string,
    ctx: Parameters<ServiceDefinition["handler"]>[0],
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

  return {
    name: "panelCdp",
    description: "Approval-gated server CDP access for panel targets",
    policy: { allowed: ["shell", "server", "panel", "app", "worker", "do"] },
    methods: {
      getCdpEndpoint: {
        description: "Return a single-use CDP WebSocket endpoint for an approved panel target.",
        args: z.tuple([z.string()]),
      },
      navigate: {
        description: "Navigate an approved browser panel target through its active CDP host.",
        args: z.tuple([z.string(), z.string()]),
      },
      reload: {
        description: "Reload an approved panel target through its active CDP host.",
        args: z.tuple([z.string()]),
      },
      goBack: {
        description: "Drive browser history back on an approved panel target.",
        args: z.tuple([z.string()]),
      },
      goForward: {
        description: "Drive browser history forward on an approved panel target.",
        args: z.tuple([z.string()]),
      },
      stop: {
        description: "Stop loading an approved panel target through its active CDP host.",
        args: z.tuple([z.string()]),
      },
      consoleHistory: {
        description: "Read console history from an approved panel target's active CDP host.",
        args: z.tuple([z.string(), consoleHistoryOptionsSchema]),
      },
      "hostProvider.open": {
        description: "Internal shell/server transport: open a streamed CDP host-provider channel.",
        args: z.tuple([z.string(), z.string()]),
        returns: z.instanceof(Response),
        policy: { allowed: ["shell", "server"] },
        access: { sensitivity: "admin" },
      },
      "hostProvider.send": {
        description:
          "Internal shell/server transport: deliver a CDP host-provider frame to the bridge.",
        args: z.tuple([z.string(), z.string()]),
        returns: z.void(),
        policy: { allowed: ["shell", "server"] },
        access: { sensitivity: "admin" },
      },
      "hostProvider.close": {
        description: "Internal shell/server transport: close a CDP host-provider channel.",
        args: z.tuple([z.string()]),
        returns: z.void(),
        policy: { allowed: ["shell", "server"] },
        access: { sensitivity: "admin" },
      },
    },
    handler: async (ctx, method, args) => {
      const hostProviderCaller = {
        id: ctx.caller.runtime.id,
        kind: ctx.caller.runtime.kind,
      };
      switch (method) {
        case "hostProvider.open": {
          if (!deps.hostProvider) throw new Error("CDP host provider transport is unavailable");
          return deps.hostProvider.open(args[0] as string, args[1] as string, hostProviderCaller);
        }

        case "hostProvider.send": {
          if (!deps.hostProvider) throw new Error("CDP host provider transport is unavailable");
          await deps.hostProvider.send(args[0] as string, args[1] as string, hostProviderCaller);
          return;
        }

        case "hostProvider.close": {
          if (!deps.hostProvider) throw new Error("CDP host provider transport is unavailable");
          await deps.hostProvider.close(args[0] as string, hostProviderCaller);
          return;
        }

        case "getCdpEndpoint": {
          const panelId = args[0] as string;
          const requesterEntityId = ctx.caller.runtime.id;
          const target = await requireTarget(panelId);
          const permission = await requirePanelAccessPermission(deps, ctx, "cdp", target);
          if (!permission.allowed) {
            recordAccess(method, ctx, target, { reason: permission.reason ?? "CDP access denied" });
            throw new Error(permission.reason ?? "CDP access denied");
          }
          recordAccess(method, ctx, target);
          return deps.getEndpoint(panelId, requesterEntityId);
        }

        case "consoleHistory": {
          const panelId = args[0] as string;
          const requesterEntityId = ctx.caller.runtime.id;
          const target = await requireTarget(panelId);
          const permission = await requirePanelAccessPermission(deps, ctx, "cdp", target);
          if (!permission.allowed) {
            recordAccess(method, ctx, target, { reason: permission.reason ?? "CDP access denied" });
            throw new Error(permission.reason ?? "CDP access denied");
          }
          if (!deps.consoleHistory) {
            throw new Error("Panel console history is not available");
          }
          recordAccess(method, ctx, target);
          return deps.consoleHistory(
            panelId,
            requesterEntityId,
            (args[1] as PanelConsoleHistoryOptions | undefined) ?? undefined
          );
        }

        case "navigate":
        case "reload":
        case "goBack":
        case "goForward":
        case "stop": {
          const panelId = args[0] as string;
          const requesterEntityId = ctx.caller.runtime.id;
          const target = await requireTarget(panelId);
          const op = method === "navigate" ? "navigate" : method;
          if (method === "navigate") {
            assertHttpUrl(args[1]);
          }
          const permission = await requirePanelAccessPermission(deps, ctx, op, target);
          if (!permission.allowed) {
            recordAccess(method, ctx, target, {
              reason: permission.reason ?? `Panel ${method} denied`,
            });
            throw new Error(permission.reason ?? `Panel ${method} denied`);
          }
          if (!deps.drive) {
            throw new Error(`Panel CDP driver is not available for ${method}`);
          }
          recordAccess(method, ctx, target);
          return deps.drive(panelId, requesterEntityId, method, args.slice(1));
        }

        default:
          throw new Error(`Unknown panelCdp method: ${method}`);
      }
    },
  };
}
