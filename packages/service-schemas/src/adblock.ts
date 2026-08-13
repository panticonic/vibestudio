import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export const AdBlockListConfigSchema = z
  .object({
    ads: z.boolean(),
    privacy: z.boolean(),
    annoyances: z.boolean(),
    social: z.boolean(),
  })
  .strict();

export const AdBlockConfigSchema = z
  .object({
    enabled: z.boolean(),
    lists: AdBlockListConfigSchema,
    customLists: z.array(z.string()),
    whitelist: z.array(z.string()),
    lastUpdated: z.number().optional(),
  })
  .strict();

export const AdBlockStatsSchema = z
  .object({
    blockedRequests: z.number().int().nonnegative(),
    blockedElements: z.number().int().nonnegative(),
  })
  .strict();

const AdBlockListNameSchema = z.enum(["ads", "privacy", "annoyances", "social"]);

export const adblockMethods = defineServiceMethods({
  getConfig: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description: "Read the native browser ad-blocking configuration.",
    args: z.tuple([]),
    returns: AdBlockConfigSchema,
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
      description: "Turn ad blocking on or off for the whole workspace.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    },
    description: "Enable or disable native browser ad blocking globally.",
    args: z.tuple([z.boolean()]),
    returns: z.boolean(),
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
      description: "Turn a specific ad-blocking filter list on or off.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    },
    description: "Enable or disable one built-in native filter list.",
    args: z.tuple([AdBlockListNameSchema, z.boolean()]),
    returns: z.boolean(),
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
      description: "Add a custom filter list for ad blocking.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    },
    description: "Add a custom native filter-list URL and rebuild the active engine.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
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
      description: "Remove a custom filter list from ad blocking.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    },
    description: "Remove a custom native filter-list URL and rebuild the active engine.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
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
    description: "Stop native ad blocking for a domain.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
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
      description: "Start blocking ads again on a website you previously allowed.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    },
    description: "Resume native ad blocking for a whitelisted domain.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
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
    description: "Read aggregate native ad-blocking counters.",
    args: z.tuple([]),
    returns: AdBlockStatsSchema,
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
      description: "Reset the ad-blocking statistics to zero.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    },
    description: "Clear aggregate native ad-blocking counters.",
    args: z.tuple([]),
    returns: z.boolean(),
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
      description: "Rebuild the ad blocker with the latest filter lists.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    },
    description: "Rebuild the native ad-blocking engine from configured lists.",
    args: z.tuple([]),
    returns: z.boolean(),
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
    description: "Report whether the native ad-blocking engine is active.",
    args: z.tuple([]),
    returns: z.boolean(),
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
    description: "Read native ad-blocking counters for one Electron web contents.",
    args: z.tuple([z.number()]),
    returns: AdBlockStatsSchema,
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
    description: "Report whether native ad blocking is enabled for one Electron web contents.",
    args: z.tuple([z.number()]),
    returns: z.boolean(),
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
      description: "Turn ad blocking on or off for a specific panel.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    },
    description: "Enable or disable native ad blocking for one Electron web contents.",
    args: z.tuple([z.number(), z.boolean()]),
    returns: z.boolean(),
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
      description: "Reset a specific panel's ad-blocking statistics to zero.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    },
    description: "Clear native ad-blocking counters for one Electron web contents.",
    args: z.tuple([z.number()]),
    returns: z.boolean(),
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
    description: "Read the main-frame URL tracked for one Electron web contents.",
    args: z.tuple([z.number()]),
    returns: z.string().optional(),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
});

export type AdBlockConfig = z.infer<typeof AdBlockConfigSchema>;
export type AdBlockListConfig = z.infer<typeof AdBlockListConfigSchema>;
export type AdBlockStats = z.infer<typeof AdBlockStatsSchema>;
