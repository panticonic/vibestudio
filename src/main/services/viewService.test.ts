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
    connectNativePanelAdapter: vi.fn(() => ({
      accepted: true,
      handshake: {
        protocolVersion: 1,
        hostGeneration: "host-1",
        shellGeneration: "shell-1",
        sealedLaunchIdentity: appId,
      },
    })),
    applyNativePanelSurfaces: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
      Promise.resolve({
        accepted: true,
        observation: {
          protocolVersion: 1,
          hostGeneration: "host-1",
          shellGeneration: "shell-1",
          desiredRevision: 1,
          observationRevision: 1,
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
      protocolVersion: 1 as const,
      hostGeneration: "host-1",
      shellGeneration: "shell-1",
      revision: 1,
      surfaces: [
        {
          surfaceId: "panel-stack:primary",
          materialization: { runtimeEntityId: "panel-1", leaseConnectionId: "binding-test" },
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
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler(
        { caller: createVerifiedCaller(callerId, "app") },
        "applyNativePanelSurfaces",
        [
          {
            protocolVersion: 1,
            hostGeneration: "host-1",
            shellGeneration: "shell-1",
            revision: 1,
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
      getViewManager: () => vm as never,
      panelOrchestrator: { onNativeSlotCleared } as never,
    });
    const request = {
      protocolVersion: 1 as const,
      hostGeneration: "host-1",
      shellGeneration: "shell-1",
      revision: 1,
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
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("shell", "shell") },
        "connectNativePanelAdapter",
        [{ sealedLaunchIdentity: "shell", supportedProtocolVersions: [1] }]
      )
    ).rejects.toThrow(/cannot place native panel slots/);

    expect(vm.connectNativePanelAdapter).not.toHaveBeenCalled();
  });
});
