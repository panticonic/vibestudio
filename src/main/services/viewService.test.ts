import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
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
            visible: true,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            capabilities,
            codeIdentity: opts.source
              ? { source: opts.source, effectiveVersion: "test" }
              : undefined,
          }
        : null
    ),
    setHostedShellReady: vi.fn(),
    syncPanelSlots: vi.fn(
      (
        _: string,
        request: { revision: number; slots: unknown[] }
      ): {
        revision: number;
        slots: Record<string, { status: "bound" }>;
      } => ({
        revision: request.revision,
        slots: { "panel-stack:primary": { status: "bound" } },
      })
    ),
    getPanelIdForNativeSlot: vi.fn(() => "panel-1"),
    getDeclaredPanelSlotIds: vi.fn((): string[] => []),
    setThemeCss: vi.fn(),
    setViewVisible: vi.fn(),
  };
}

describe("view service", () => {
  it("rejects ordinary apps for host-wide view controls", async () => {
    const vm = makeViewManager([]);
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "setThemeCss",
        [":root{}"]
      )
    ).rejects.toThrow(/cannot host workspace views/);

    expect(vm.setThemeCss).not.toHaveBeenCalled();
  });

  it("allows a panel-hosting workspace app to converge one desired snapshot", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({ getViewManager: () => vm as never });
    const request = {
      rendererInstanceId: "renderer-test",
      revision: 1,
      slots: [
        {
          nativeSlotId: "panel-stack:primary",
          bindingId: "binding-test",
          bindingSequence: 1,
          panelId: "panel-1",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          focused: true,
        },
      ],
    };

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "syncNativePanelSlots",
        [request]
      )
    ).resolves.toEqual({
      revision: 1,
      slots: { "panel-stack:primary": { status: "bound" } },
    });

    expect(vm.syncPanelSlots).toHaveBeenCalledWith("@workspace-apps/shell", request);
  });

  it("rejects unauthorized panel-hosting app sources for native panel slots", async () => {
    const callerId = "app:apps/field-mobile:device-1";
    const vm = makeViewManager(["panel-hosting"], {
      id: callerId,
      source: "apps/field-mobile",
    });
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler({ caller: createVerifiedCaller(callerId, "app") }, "syncNativePanelSlots", [
        {
          rendererInstanceId: "renderer-test",
          revision: 1,
          slots: [],
        },
      ])
    ).rejects.toThrow(/cannot place native panel slots/);

    expect(vm.syncPanelSlots).not.toHaveBeenCalled();
  });

  it("returns revisioned observed state to the hosted shell", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    vm.syncPanelSlots.mockReturnValue({ revision: 2, slots: {} });
    const service = createViewService({ getViewManager: () => vm as never });
    const request = {
      rendererInstanceId: "renderer-test",
      revision: 2,
      slots: [],
    };

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "syncNativePanelSlots",
        [request]
      )
    ).resolves.toEqual({ revision: 2, slots: {} });

    expect(vm.syncPanelSlots).toHaveBeenCalledWith("@workspace-apps/shell", request);
  });

  it("does not project a stale desired snapshot", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    vm.syncPanelSlots.mockImplementation(() => {
      throw new Error("stale native panel snapshot revision 1");
    });
    const onNativeSlotCleared = vi.fn();
    const service = createViewService({
      getViewManager: () => vm as never,
      panelOrchestrator: { onNativeSlotCleared } as never,
    });
    const request = {
      rendererInstanceId: "renderer-test",
      revision: 1,
      slots: [],
    };

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "syncNativePanelSlots",
        [request]
      )
    ).rejects.toThrow(/stale native panel snapshot/);
    expect(onNativeSlotCleared).not.toHaveBeenCalled();
  });

  it("rejects bootstrap shell callers for native panel slots", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "setHostedShellReady", [
        { ready: true, rendererInstanceId: "renderer-test" },
      ])
    ).rejects.toThrow(/cannot place native panel slots/);

    expect(vm.setHostedShellReady).not.toHaveBeenCalled();
  });
});
