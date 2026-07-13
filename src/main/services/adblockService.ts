import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { AdBlockManager } from "../adblock/index.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const adblockMethods = defineServiceMethods({
  getConfig: { args: z.tuple([]) },
  setEnabled: { args: z.tuple([z.boolean()]) },
  setListEnabled: {
    args: z.tuple([z.enum(["ads", "privacy", "annoyances", "social"]), z.boolean()]),
  },
  addCustomList: { args: z.tuple([z.string()]) },
  removeCustomList: { args: z.tuple([z.string()]) },
  addToWhitelist: { args: z.tuple([z.string()]), policy: { allowed: ["shell", "panel"] } },
  removeFromWhitelist: {
    args: z.tuple([z.string()]),
    policy: { allowed: ["shell", "panel"] },
  },
  getStats: { args: z.tuple([]), policy: { allowed: ["shell", "panel"] } },
  resetStats: { args: z.tuple([]) },
  rebuildEngine: { args: z.tuple([]) },
  isActive: { args: z.tuple([]), policy: { allowed: ["shell", "panel"] } },
  getStatsForPanel: { args: z.tuple([z.number()]), policy: { allowed: ["shell", "panel"] } },
  isEnabledForPanel: {
    args: z.tuple([z.number()]),
    policy: { allowed: ["shell", "panel"] },
  },
  setEnabledForPanel: {
    args: z.tuple([z.number(), z.boolean()]),
    policy: { allowed: ["shell", "panel"] },
  },
  resetStatsForPanel: {
    args: z.tuple([z.number()]),
    policy: { allowed: ["shell", "panel"] },
  },
  getPanelUrl: { args: z.tuple([z.number()]), policy: { allowed: ["shell", "panel"] } },
});

export function createAdblockService(deps: { adBlockManager: AdBlockManager }): ServiceDefinition {
  return {
    name: "adblock",
    description: "Ad blocking configuration and stats",
    policy: { allowed: ["shell"] },
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
