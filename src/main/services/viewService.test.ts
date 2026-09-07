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
    connectNativePanelAdapter: vi.fn(() => ({
      accepted: true,
      handshake: {
        protocolVersion: 2,
        hostGeneration: "host-1",
        shellGeneration: "shell-1",
        sealedLaunchIdentity: appId,
      },
    })),
    applyNativePanelSurfaces: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
      Promise.resolve({
        accepted: true,
        observation: {
          protocolVersion: 2,
          hostGeneration: "host-1",
          shellGeneration: "shell-1",
          desiredRevision: 1,
          observationRevision: 1,
          focusedWorkspaceId: null,
          surfaces: [],
        },
      })
    ),
    getPanelIdForNativeSlot: vi.fn(() => "panel-1"),
    getDeclaredPanelSlotIds: vi.fn((): string[] => []),
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
      authorizeWorkspaceMaterialization: async (id) => {
        if (id !== "workspace-test") throw new Error("Workspace access was removed");
      },
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

  it("authorizes empty-workspace focus and changes focus only for accepted snapshots", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const authorize = vi.fn(async (id: string) => {
      if (id !== "empty-workspace") throw new Error("Workspace access was removed");
    });
    const focus = vi.fn();
    const service = createViewService({
      workspaceId: "workspace-test",
      getViewManager: () => vm as never,
      authorizeWorkspaceMaterialization: authorize,
      onFocusedWorkspaceChanged: focus,
    });
    const request = {
      protocolVersion: 2 as const,
      hostGeneration: "host-1",
      shellGeneration: "shell-1",
      revision: 1,
      focusedWorkspaceId: "empty-workspace",
      surfaces: [],
    };
    vm.applyNativePanelSurfaces.mockResolvedValueOnce({
      accepted: true,
      observation: { ...request, desiredRevision: 1, observationRevision: 1 },
    });
    const caller = { caller: createVerifiedCaller("@workspace-apps/shell", "app") };
    await service.handler(caller, "applyNativePanelSurfaces", [request]);
    expect(authorize).toHaveBeenCalledWith("empty-workspace");
    expect(focus).toHaveBeenCalledWith("empty-workspace");
    focus.mockClear();
    vm.applyNativePanelSurfaces.mockResolvedValueOnce({
      accepted: false,
      reason: "stale-revision",
    });
    await service.handler(caller, "applyNativePanelSurfaces", [request]);
    expect(focus).not.toHaveBeenCalled();
    await expect(
      service.handler(caller, "applyNativePanelSurfaces", [
        { ...request, focusedWorkspaceId: "revoked" },
      ])
    ).rejects.toThrow("Workspace access was removed");
    expect(vm.applyNativePanelSurfaces).toHaveBeenCalledTimes(2);
  });

  it("allows a panel-hosting workspace app to converge one desired snapshot", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({
      workspaceId: "workspace-test",
      getViewManager: () => vm as never,
      authorizeWorkspaceMaterialization: async (id) => {
        if (id !== "workspace-test") throw new Error("Workspace access was removed");
      },
    });
    const request = {
      protocolVersion: 2 as const,
      hostGeneration: "host-1",
      shellGeneration: "shell-1",
      revision: 1,
      focusedWorkspaceId: null,
      surfaces: [
        {
          surfaceId: "panel-stack:primary",
          materialization: {
            workspaceId: "workspace-test",
            runtimeEntityId: "panel-1",
            leaseConnectionId: "binding-test",
          },
          visible: true,
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          focused: true,
        },
      ],
    };

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "applyNativePanelSurfaces",
        [request]
      )
    ).resolves.toMatchObject({ accepted: true });

    expect(vm.applyNativePanelSurfaces).toHaveBeenCalledWith("@workspace-apps/shell", request);
  });

  it("rejects unauthorized panel-hosting app sources for native panel slots", async () => {
    const callerId = "app:apps/field-mobile:device-1";
    const vm = makeViewManager(["panel-hosting"], {
      id: callerId,
      source: "apps/field-mobile",
    });
    const service = createViewService({
      workspaceId: "workspace-test",
      getViewManager: () => vm as never,
      authorizeWorkspaceMaterialization: async (id) => {
        if (id !== "workspace-test") throw new Error("Workspace access was removed");
      },
    });

    await expect(
      service.handler(
        { caller: createVerifiedCaller(callerId, "app") },
        "applyNativePanelSurfaces",
        [
          {
            protocolVersion: 2,
            hostGeneration: "host-1",
            shellGeneration: "shell-1",
            revision: 1,
            focusedWorkspaceId: null,
            surfaces: [],
          },
        ]
      )
    ).rejects.toThrow(/cannot place native panel slots/);

    expect(vm.applyNativePanelSurfaces).not.toHaveBeenCalled();
  });

  it("does not project a stale desired snapshot", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    vm.applyNativePanelSurfaces.mockResolvedValue({ accepted: false, reason: "stale-revision" });
    const onNativeSlotCleared = vi.fn();
    const service = createViewService({
      workspaceId: "workspace-test",
      getViewManager: () => vm as never,
      panelOrchestrator: { onNativeSlotCleared } as never,
    });
    const request = {
      protocolVersion: 2 as const,
      hostGeneration: "host-1",
      shellGeneration: "shell-1",
      revision: 1,
      focusedWorkspaceId: null,
      surfaces: [],
    };

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "applyNativePanelSurfaces",
        [request]
      )
    ).resolves.toEqual({ accepted: false, reason: "stale-revision" });
    expect(onNativeSlotCleared).not.toHaveBeenCalled();
  });

  it("rejects bootstrap shell callers for native panel slots", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({
      workspaceId: "workspace-test",
      getViewManager: () => vm as never,
      authorizeWorkspaceMaterialization: async (id) => {
        if (id !== "workspace-test") throw new Error("Workspace access was removed");
      },
    });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("shell", "shell") },
        "connectNativePanelAdapter",
        [{ sealedLaunchIdentity: "shell", supportedProtocolVersions: [2] }]
      )
    ).rejects.toThrow(/cannot place native panel slots/);

    expect(vm.connectNativePanelAdapter).not.toHaveBeenCalled();
  });
});
