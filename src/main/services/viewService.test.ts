import { createHostCaller, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { setWorkspaceAppTrust } from "@vibestudio/shared/chromeTrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createViewService } from "./viewService.js";

// App trust is manifest-declared (meta/vibestudio.yml trust.chromeApps) and seeded
// per process when the workspace manifest loads. Seed the shipped defaults so
// the unauthorized-source rejection path is exercised as a live host sees it.
beforeEach(() => {
  setWorkspaceAppTrust({
    chromeApps: ["apps/shell", "apps/mobile"],
  });
});

afterEach(() => {
  setWorkspaceAppTrust(null);
});

function makeViewManager(capabilities: string[] = [], opts: { id?: string; source?: string } = {}) {
  const appId = opts.id ?? "@workspace-apps/shell";
  return {
    getViewInfo: vi.fn((id: string) =>
      id === appId
        ? {
            type: "app",
            workspaceIdentity: { workspaceId: "workspace-test", runtimeId: appId },
            visible: true,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            capabilities,
            codeIdentity: opts.source
              ? { source: opts.source, effectiveVersion: "test" }
              : undefined,
          }
        : null
    ),
    setThemeCss: vi.fn(),
    setViewVisible: vi.fn(),
  };
}

describe("view service", () => {
  it("admits verified native chrome for panel presentation through the canonical receiver", async () => {
    const nativeId = 'shell:workspace:["system-workspace","@workspace-apps/shell"]';
    const vm = makeViewManager(["panel-hosting"], { id: nativeId, source: "apps/shell" });
    const getViewInfo = vm.getViewInfo;
    const sealedVm = {
      ...vm,
      getViewInfo: (id: string) => {
        const info = getViewInfo(id);
        return info
          ? {
              ...info,
              hostChrome: true,
              workspaceIdentity: {
                workspaceId: "system-workspace",
                runtimeId: "@workspace-apps/shell",
              },
            }
          : null;
      },
    };
    const presentation = {
      panelId: "new-panel",
      status: "loaded",
      focused: true,
      loaded: true,
    };
    const theme = {
      accentColor: "violet",
      grayColor: "mauve",
      radius: "medium",
      scaling: "100%",
      panelBackground: "solid",
    };
    const lifecycle = {
      createPanel: vi.fn(async () => ({ id: "new-panel", title: "New" })),
      focusPanel: vi.fn(async () => presentation),
      ensureLoaded: vi.fn(async () => ({ ...presentation, focused: false })),
      getThemeConfig: vi.fn(() => theme),
    };
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(
      createViewService({
        workspaceId: "system-workspace",
        getViewManager: () => sealedVm as never,
        panelOrchestrator: lifecycle as never,
      })
    );
    const ctx = { caller: createHostCaller(nativeId, "shell") };

    await expect(
      dispatcher.dispatch(ctx, "view", "createPanel", [null, "panels/about"])
    ).resolves.toEqual({ id: "new-panel", title: "New" });
    await expect(dispatcher.dispatch(ctx, "view", "focusPanel", ["new-panel"])).resolves.toEqual(
      presentation
    );
    await expect(
      dispatcher.dispatch(ctx, "view", "ensurePanelLoaded", ["new-panel"])
    ).resolves.toEqual({ ...presentation, focused: false });
    await expect(dispatcher.dispatch(ctx, "view", "getThemeConfig", [])).resolves.toEqual(theme);
    expect(lifecycle.createPanel).toHaveBeenCalledWith(
      nativeId,
      "panels/about",
      { isRoot: true },
      undefined,
      undefined
    );

    // A host origin alone does not confer the sealed native chrome capability.
    await expect(
      dispatcher.dispatch(
        { caller: createHostCaller("other-host", "shell") },
        "view",
        "createPanel",
        [null, "panels/about"]
      )
    ).rejects.toThrow("restricted to app callers");
    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("ordinary-app", "app") },
        "view",
        "createPanel",
        [null, "panels/about"]
      )
    ).rejects.toThrow("requires app capability");
    expect(lifecycle.createPanel).toHaveBeenCalledTimes(1);
  });

  it("rejects ordinary apps for host-wide view controls", async () => {
    const vm = makeViewManager([]);
    const service = createViewService({
      workspaceId: "workspace-test",
      getViewManager: () => vm as never,
    });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "setThemeCss",
        [":root{}"]
      )
    ).rejects.toThrow(/cannot host workspace views/);

    expect(vm.setThemeCss).not.toHaveBeenCalled();
  });

  it("does not expose window compositor commands through workspace RPC", () => {
    const service = createViewService({
      workspaceId: "workspace-test",
      getViewManager: () => makeViewManager() as never,
    });
    for (const name of ["connectNativePanelAdapter", "applyNativePanelSurfaces", "setShellOverlay"])
      expect(service.methods).not.toHaveProperty(name);
  });
});
