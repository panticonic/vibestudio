import { z } from "zod";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

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
  const readPolicy: ServiceAuthorityPolicy = {
    principals: ["host", "user", "code", "entity"],
  };
  const methods = {
    markPanelActive: { args: z.tuple([z.string()]) },
    markPanelsOwned: { args: z.tuple([z.array(z.string())]) },
    getPanelActiveOwner: { args: z.tuple([z.string()]), authority: readPolicy },
  };
  return {
    name: "presence",
    description: "Active shell/panel ownership",
    authority: { principals: ["host", "user"] },
    methods,
    handler: defineServiceHandler("presence", methods, {
      markPanelActive: (ctx, [panelId]) =>
        deps.presence.markPanelActive(panelId, ctx.caller.runtime.id),
      markPanelsOwned: (ctx, [panelIds]) => {
        deps.presence.markPanelsOwned(panelIds, ctx.caller.runtime.id);
        return;
      },
      getPanelActiveOwner: (_ctx, [panelId]) => deps.presence.getPanelActiveOwner(panelId),
    }),
  };
}
