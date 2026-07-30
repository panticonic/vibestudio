import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { AdBlockManager } from "../adblock/index.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const adblockMethods = defineServiceMethods({
  getConfig: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    args: z.tuple([]),
    access: { sensitivity: "read" },
  },
  setEnabled: {
    capability: "adblock.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Turn ad blocking on or off",
      action: "turn ad blocking on or off",
      description: "Allows {requesterKind} to turn ad blocking on or off.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
    args: z.tuple([z.boolean()]),
    access: { sensitivity: "write" },
  },
  setListEnabled: {
    capability: "adblock.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Turn an ad-blocking list on or off",
      action: "turn an ad-blocking list on or off",
      description: "Allows {requesterKind} to turn an ad-blocking list on or off.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
    args: z.tuple([z.enum(["ads", "privacy", "annoyances", "social"]), z.boolean()]),
    access: { sensitivity: "write" },
  },
  addCustomList: {
    capability: "adblock.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Add a custom ad-blocking list",
      action: "add a custom ad-blocking list",
      description: "Allows {requesterKind} to add a custom ad-blocking list.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
    args: z.tuple([z.string()]),
    access: { sensitivity: "write" },
  },
  removeCustomList: {
    capability: "adblock.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.retire",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Remove a custom ad-blocking list",
      action: "remove a custom ad-blocking list",
      description: "Allows {requesterKind} to remove a custom ad-blocking list.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
    args: z.tuple([z.string()]),
    access: { sensitivity: "destructive" },
  },
  addToWhitelist: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    args: z.tuple([z.string()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "write" },
  },
  removeFromWhitelist: {
    capability: "adblock.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.retire",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Resume blocking ads on a website",
      action: "resume blocking ads on a website",
      description: "Allows {requesterKind} to resume blocking ads on a website.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
    args: z.tuple([z.string()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "destructive" },
  },
  getStats: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    args: z.tuple([]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  resetStats: {
    capability: "adblock.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Clear ad-blocking statistics",
      action: "clear ad-blocking statistics",
      description: "Allows {requesterKind} to clear ad-blocking statistics.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
    args: z.tuple([]),
    access: { sensitivity: "destructive" },
  },
  rebuildEngine: {
    capability: "adblock.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Refresh ad blocking",
      action: "refresh ad blocking",
      description: "Allows {requesterKind} to refresh ad blocking.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
    args: z.tuple([]),
    access: { sensitivity: "write" },
  },
  isActive: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    args: z.tuple([]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  getStatsForPanel: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    args: z.tuple([z.number()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  isEnabledForPanel: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    args: z.tuple([z.number()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  setEnabledForPanel: {
    capability: "adblock.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Change ad blocking for a panel",
      action: "change ad blocking for a panel",
      description: "Allows {requesterKind} to change ad blocking for a panel.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
    args: z.tuple([z.number(), z.boolean()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "write" },
  },
  resetStatsForPanel: {
    capability: "adblock.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Clear a panel's ad-blocking statistics",
      action: "clear a panel's ad-blocking statistics",
      description: "Allows {requesterKind} to clear a panel's ad-blocking statistics.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
    args: z.tuple([z.number()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "write" },
  },
  getPanelUrl: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    args: z.tuple([z.number()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
});

export function createAdblockService(deps: { adBlockManager: AdBlockManager }): ServiceDefinition {
  return {
    name: "adblock",
    description: "Ad blocking configuration and stats",
    authority: { principals: ["user", "host", "code"] },
    methods: adblockMethods,
    handler: defineServiceHandler("adblock", adblockMethods, {
      getConfig: () => deps.adBlockManager.getConfig(),
      setEnabled: async (_ctx, [enabled]) => {
        const manager = deps.adBlockManager;
        await manager.setEnabled(enabled);
        return true;
      },
      setListEnabled: async (_ctx, [list, enabled]) => {
        await deps.adBlockManager.setListEnabled(list, enabled);
        return true;
      },
      addCustomList: async (_ctx, [url]) => {
        await deps.adBlockManager.addCustomList(url);
        return true;
      },
      removeCustomList: async (_ctx, [url]) => {
        await deps.adBlockManager.removeCustomList(url);
        return true;
      },
      addToWhitelist: (_ctx, [domain]) => {
        deps.adBlockManager.addToWhitelist(domain);
        return true;
      },
      removeFromWhitelist: (_ctx, [domain]) => {
        deps.adBlockManager.removeFromWhitelist(domain);
        return true;
      },
      getStats: () => deps.adBlockManager.getStats(),
      resetStats: () => {
        deps.adBlockManager.resetStats();
        return true;
      },
      rebuildEngine: async () => {
        await deps.adBlockManager.rebuildEngine();
        return true;
      },
      isActive: () => deps.adBlockManager.isActive(),
      getStatsForPanel: (_ctx, [webContentsId]) =>
        deps.adBlockManager.getStatsForPanel(webContentsId),
      isEnabledForPanel: (_ctx, [webContentsId]) =>
        deps.adBlockManager.isEnabledForPanel(webContentsId),
      setEnabledForPanel: (_ctx, [webContentsId, enabled]) => {
        deps.adBlockManager.setEnabledForPanel(webContentsId, enabled);
        return true;
      },
      resetStatsForPanel: (_ctx, [webContentsId]) => {
        deps.adBlockManager.resetStatsForPanel(webContentsId);
        return true;
      },
      getPanelUrl: (_ctx, [webContentsId]) => deps.adBlockManager.getPanelUrl(webContentsId),
    }),
  };
}
