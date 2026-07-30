import { z } from "zod";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
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
  const readAuthority: ServiceAuthorityPolicy = {
    principals: ["host", "user", "code"],
  };
  const methods = defineServiceMethods({
    markPanelActive: {
      capability: "panel.presence.update",
      tier: {
        tier: "gated",
        session: "family",
        residency: "supervision",
        family: "presence.control",
        rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
      },
      presentation: {
        title: "Mark a panel as active",
        action: "mark a panel as active",
        description: "Allows {requesterKind} to mark a panel as active.",
        group: "accounts",
        authorityCategory: {
          domain: "people",
          verb: "act",
        },
      },
      args: z.tuple([z.string()]),
    },
    markPanelsOwned: {
      capability: "panel.presence.update",
      tier: {
        tier: "gated",
        session: "family",
        residency: "supervision",
        family: "presence.control",
        rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
      },
      presentation: {
        title: "Claim ownership of panels",
        action: "claim ownership of panels",
        description: "Allows {requesterKind} to claim ownership of panels.",
        group: "accounts",
        authorityCategory: {
          domain: "people",
          verb: "act",
        },
      },
      args: z.tuple([z.array(z.string())]),
    },
    getPanelActiveOwner: {
      capability: "panel.presence.read",
      tier: {
        tier: "gated",
        session: "family",
        residency: "supervision",
        family: "presence.read",
        rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
      },
      presentation: {
        title: "View who is using a panel",
        action: "view who is using a panel",
        description: "Allows {requesterKind} to view who is using a panel.",
        group: "accounts",
        authorityCategory: {
          domain: "people",
          verb: "see",
        },
      },
      args: z.tuple([z.string()]),
      authority: readAuthority,
      access: { sensitivity: "read" as const },
    },
  });
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
