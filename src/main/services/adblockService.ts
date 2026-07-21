import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { AdBlockManager } from "../adblock/index.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const adblockMethods = defineServiceMethods({
  getConfig: { args: z.tuple([]), access: { sensitivity: "read" } },
  setEnabled: { args: z.tuple([z.boolean()]), access: { sensitivity: "write" } },
  setListEnabled: {
    args: z.tuple([z.enum(["ads", "privacy", "annoyances", "social"]), z.boolean()]),
    access: { sensitivity: "write" },
  },
  addCustomList: { args: z.tuple([z.string()]), access: { sensitivity: "write" } },
  removeCustomList: {
    args: z.tuple([z.string()]),
    access: { sensitivity: "destructive" },
  },
  addToWhitelist: {
    args: z.tuple([z.string()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "write" },
  },
  removeFromWhitelist: {
    args: z.tuple([z.string()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "destructive" },
  },
  getStats: {
    args: z.tuple([]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  resetStats: { args: z.tuple([]), access: { sensitivity: "destructive" } },
  rebuildEngine: { args: z.tuple([]), access: { sensitivity: "write" } },
  isActive: {
    args: z.tuple([]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  getStatsForPanel: {
    args: z.tuple([z.number()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  isEnabledForPanel: {
    args: z.tuple([z.number()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "read" },
  },
  setEnabledForPanel: {
    args: z.tuple([z.number(), z.boolean()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "write" },
  },
  resetStatsForPanel: {
    args: z.tuple([z.number()]),
    authority: { principals: ["user", "code"] },
    access: { sensitivity: "write" },
  },
  getPanelUrl: {
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
