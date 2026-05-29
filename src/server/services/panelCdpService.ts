import { z } from "zod";
import { assertHttpUrl } from "@natstack/shared/httpUrl";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
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

  return {
    name: "panelCdp",
    description: "Approval-gated server CDP access for panel targets",
    policy: { allowed: ["shell", "server", "panel", "worker", "do"] },
    methods: {
      getCdpEndpoint: { args: z.tuple([z.string()]) },
      navigate: { args: z.tuple([z.string(), z.string()]) },
      reload: { args: z.tuple([z.string()]) },
      goBack: { args: z.tuple([z.string()]) },
      goForward: { args: z.tuple([z.string()]) },
      stop: { args: z.tuple([z.string()]) },
      consoleHistory: { args: z.tuple([z.string(), consoleHistoryOptionsSchema]) },
    },
    handler: async (ctx, method, args) => {
      const panelId = args[0] as string;
      const requesterEntityId = ctx.caller.runtime.id;
      const target = await requireTarget(panelId);

      switch (method) {
        case "getCdpEndpoint": {
          const permission = await requirePanelAccessPermission(deps, ctx, "cdp", target);
          if (!permission.allowed) {
            throw new Error(permission.reason ?? "CDP access denied");
          }
          return deps.getEndpoint(panelId, requesterEntityId);
        }

        case "consoleHistory": {
          const permission = await requirePanelAccessPermission(deps, ctx, "cdp", target);
          if (!permission.allowed) {
            throw new Error(permission.reason ?? "CDP access denied");
          }
          if (!deps.consoleHistory) {
            throw new Error("Panel console history is not available");
          }
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
          const op = method === "navigate" ? "navigate" : method;
          if (method === "navigate") {
            assertHttpUrl(args[1]);
          }
          const permission = await requirePanelAccessPermission(deps, ctx, op, target);
          if (!permission.allowed) {
            throw new Error(permission.reason ?? `Panel ${method} denied`);
          }
          if (!deps.drive) {
            throw new Error(`Panel CDP driver is not available for ${method}`);
          }
          return deps.drive(panelId, requesterEntityId, method, args.slice(1));
        }

        default:
          throw new Error(`Unknown panelCdp method: ${method}`);
      }
    },
  };
}
