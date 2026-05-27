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
}

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
