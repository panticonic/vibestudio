import { z } from "zod";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServicePolicy } from "@vibestudio/shared/servicePolicy";

export interface ActivePanelRecord {
  panelId: string;
  ownerCallerId: string;
  updatedAt: number;
}

export interface PresenceTracker {
  markPanelActive(panelId: string, ownerCallerId: string): ActivePanelRecord;
  getPanelActiveOwner(panelId: string): ActivePanelRecord | null;
  markPanelsOwned(panelIds: string[], ownerCallerId: string): void;
}

export function createPresenceTracker(
  deps: {
    eventService?: Pick<EventService, "emit">;
    now?: () => number;
  } = {}
): PresenceTracker {
  const now = deps.now ?? (() => Date.now());
  const activePanels = new Map<string, ActivePanelRecord>();
  return {
    markPanelActive(panelId, ownerCallerId) {
      const record = { panelId, ownerCallerId, updatedAt: now() };
      activePanels.set(panelId, record);
      deps.eventService?.emit("presence:panel-active", record);
      return record;
    },
    getPanelActiveOwner(panelId) {
      return activePanels.get(panelId) ?? null;
    },
    markPanelsOwned(panelIds, ownerCallerId) {
      for (const panelId of panelIds) {
        this.markPanelActive(panelId, ownerCallerId);
      }
    },
  };
}

export function createPresenceService(deps: { presence: PresenceTracker }): ServiceDefinition {
  const readPolicy: ServicePolicy = {
    allowed: ["server", "shell", "app", "panel", "worker", "do", "extension", "agent"],
  };
  return {
    name: "presence",
    description: "Active shell/panel ownership",
    policy: { allowed: ["server", "shell"] },
    methods: {
      markPanelActive: { args: z.tuple([z.string()]) },
      markPanelsOwned: { args: z.tuple([z.array(z.string())]) },
      getPanelActiveOwner: { args: z.tuple([z.string()]), policy: readPolicy },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "markPanelActive":
          return deps.presence.markPanelActive(args[0] as string, ctx.caller.runtime.id);
        case "markPanelsOwned":
          deps.presence.markPanelsOwned(args[0] as string[], ctx.caller.runtime.id);
          return;
        case "getPanelActiveOwner":
          return deps.presence.getPanelActiveOwner(args[0] as string);
        default:
          throw new Error(`Unknown presence method: ${method}`);
      }
    },
  };
}
