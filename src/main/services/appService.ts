import { app, nativeTheme, shell } from "electron";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { appMethods } from "@vibestudio/service-schemas/app";
import { buildMethods } from "@vibestudio/service-schemas/build";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { ServerClient } from "../serverClient.js";
import type { ViewManager } from "../viewManager.js";
import type { AppOrchestrator } from "../appOrchestrator.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  requirePanelHostingAuthority,
  requireRuntimeCapability,
} from "@vibestudio/shared/serviceAuthorityChecks";

export function createAppService(deps: {
  panelOrchestrator: PanelOrchestrator;
  serverClient: ServerClient | null;
  getViewManager: () => ViewManager;
  getAppOrchestrator?: () => AppOrchestrator | null;
  connectionMode: "local" | "remote";
  remoteHost?: string;
}): ServiceDefinition {
  const serverClient = deps.serverClient;
  const callServer = serverClient
    ? (svc: string, m: string, a: unknown[]) => serverClient.call(svc, m, a)
    : null;
  const buildClient = callServer
    ? createTypedServiceClient("build", buildMethods, callServer)
    : null;
  const workspaceClient = callServer
    ? createTypedServiceClient("workspace", workspaceMethods, callServer)
    : null;
  return {
    name: "app",
    description: "App lifecycle, theme, devtools",
    authority: { principals: ["user", "code"] },
    methods: appMethods,
    handler: defineServiceHandler("app", appMethods, {
      getInfo: () => ({
        version: app.getVersion(),
        connectionMode: deps.connectionMode,
        remoteHost: deps.remoteHost,
        connectionStatus: deps.serverClient?.getConnectionStatus?.() ?? "connected",
        // Selected ICE path so a fresh badge mount shows "Relayed" on an
        // already-stable relay pipe, not only after the next transition.
        // Only the WebRTC client exposes candidateType(); the loopback WS
        // client omits it, so call defensively → null (unknown / local).
        connectionCandidateType: deps.serverClient?.candidateType?.() ?? null,
      }),
      getSystemTheme: () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
      setThemeMode: async (ctx, [mode]) => {
        await requireRuntimeCapability(ctx, "window-management", "app.setThemeMode");
        nativeTheme.themeSource = mode;
        return;
      },
      openDevTools: async (ctx) => {
        const vm = deps.getViewManager();
        await requireRuntimeCapability(ctx, "window-management", "app.openDevTools");
        vm.openDevTools(ctx.caller.runtime.kind === "app" ? ctx.caller.runtime.id : "shell");
        return;
      },
      openExternal: async (ctx, [url]) => {
        await requireRuntimeCapability(ctx, "open-external", "app.openExternal");
        if (!/^https?:\/\//i.test(url))
          throw new Error("Only http(s) URLs can be opened externally");
        await shell.openExternal(url);
        return;
      },
      openWorkspacePath: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "app.openWorkspacePath");
        const info = await workspaceClient?.getInfo();
        const workspacePath = info?.path;
        if (typeof workspacePath !== "string" || workspacePath.length === 0) {
          throw new Error("Workspace path unavailable");
        }
        const error = await shell.openPath(workspacePath);
        if (error) throw new Error(error);
        return;
      },
      clearBuildCache: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "app.clearBuildCache");
        const failures: string[] = [];
        if (buildClient) {
          try {
            await buildClient.recompute();
          } catch (e) {
            console.warn("[App] Build recompute failed:", e);
            failures.push(e instanceof Error ? e.message : String(e));
          }
        }
        try {
          deps.panelOrchestrator.invalidateReadyPanels();
        } catch (error) {
          console.warn("[App] Failed to invalidate panel states:", error);
          failures.push(error instanceof Error ? error.message : String(error));
        }
        if (failures.length > 0) {
          throw new Error(`Build cache refresh failed: ${failures.join("; ")}`);
        }
        return;
      },
      getShellPages: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "app.getShellPages");
        if (buildClient) {
          try {
            return await buildClient.getAboutPages();
          } catch (e) {
            console.warn("[App] Failed to fetch shell pages:", e);
            throw new Error(
              `Couldn't load shell pages: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
        return [];
      },
      applyUpdate: async (ctx, [appId]) => {
        await requirePanelHostingAuthority(ctx, "app.applyUpdate");
        return {
          applied: (await deps.getAppOrchestrator?.()?.applyPendingAppUpdate(appId)) ?? false,
        };
      },
      listPendingUpdates: async (ctx) => {
        await requirePanelHostingAuthority(ctx, "app.listPendingUpdates");
        return deps.getAppOrchestrator?.()?.listPendingAppUpdates() ?? [];
      },
    }),
  };
}
