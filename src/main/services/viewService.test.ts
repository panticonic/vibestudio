import {
  createVerifiedCaller,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";

import { createViewService } from "./viewService.js";

function authorityCtx(caller: VerifiedCaller, panelHosting: boolean): ServiceContext {
  return {
    caller,
    authority: {
      allows: vi.fn(async ({ capability }) => capability === "panel-hosting" && panelHosting),
      assert: vi.fn(async () => undefined),
    },
  };
}

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
            appIdentity: opts.source ? { source: opts.source, executionDigest: "test" } : undefined,
          }
        : null
    ),
    setHostedShellReady: vi.fn(),
    bindPanelSlot: vi.fn(),
    updatePanelSlot: vi.fn(),
    clearPanelSlot: vi.fn(),
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
        authorityCtx(createVerifiedCaller("@workspace-apps/shell", "app"), false),
        "setThemeCss",
        [":root{}"]
      )
    ).rejects.toThrow(/cannot host workspace views/);

    expect(vm.setThemeCss).not.toHaveBeenCalled();
  });

  it("allows a panel-hosting workspace app to bind native panel slots", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({ getViewManager: () => vm as never });
    const request = {
      nativeSlotId: "panel-stack:primary",
      panelId: "panel-1",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      focused: true,
    };

    await expect(
      service.handler(
        authorityCtx(createVerifiedCaller("@workspace-apps/shell", "app"), true),
        "bindNativePanelSlot",
        [request]
      )
    ).resolves.toEqual({ status: "bound" });

    expect(vm.bindPanelSlot).toHaveBeenCalledWith("@workspace-apps/shell", request);
  });

  it("rejects unauthorized panel-hosting app sources for native panel slots", async () => {
    const callerId = "app:apps/field-mobile:device-1";
    const vm = makeViewManager(["panel-hosting"], {
      id: callerId,
      source: "apps/field-mobile",
    });
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler(
        authorityCtx(createVerifiedCaller(callerId, "app"), false),
        "bindNativePanelSlot",
        [
          {
            nativeSlotId: "panel-stack:primary",
            panelId: "panel-1",
            bounds: { x: 10, y: 20, width: 300, height: 200 },
          },
        ]
      )
    ).rejects.toThrow(/cannot place native panel slots/);

    expect(vm.bindPanelSlot).not.toHaveBeenCalled();
  });

  it("returns native panel slot update acknowledgements to the hosted shell", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    vm.updatePanelSlot.mockReturnValue({
      status: "missing",
      reason: "unknown native panel slot: panel-stack:primary",
    });
    const service = createViewService({ getViewManager: () => vm as never });
    const request = {
      nativeSlotId: "panel-stack:primary",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    };

    await expect(
      service.handler(
        authorityCtx(createVerifiedCaller("@workspace-apps/shell", "app"), true),
        "updateNativePanelSlot",
        [request]
      )
    ).resolves.toEqual({
      status: "missing",
      reason: "unknown native panel slot: panel-stack:primary",
    });

    expect(vm.updatePanelSlot).toHaveBeenCalledWith("@workspace-apps/shell", request);
  });

  it("rejects bootstrap shell callers for native panel slots", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler(
        authorityCtx(createVerifiedCaller("shell", "shell"), false),
        "setHostedShellReady",
        [{ ready: true }]
      )
    ).rejects.toThrow(/cannot place native panel slots/);

    expect(vm.setHostedShellReady).not.toHaveBeenCalled();
  });
});
