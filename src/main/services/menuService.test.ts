import { describe, expect, it, vi } from "vitest";
import { createHostCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { createMenuService } from "./menuService.js";

const popup = vi.fn();
vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn(() => ({ popup })) },
}));

function harness(admitted: boolean) {
  const callerId = "shell:workspace:system-test";
  const viewManager = {
    getViewInfo: vi.fn((id: string) =>
      admitted && id === callerId
        ? {
            type: "app",
            hostChrome: true,
            capabilities: ["native-menus", "panel-hosting"],
            workspaceIdentity: {
              workspaceId: "system-test",
              runtimeId: "@workspace-apps/shell",
            },
          }
        : null
    ),
    getShellWebContents: vi.fn(() => null),
    getWindow: vi.fn(() => ({})),
  };
  const service = createMenuService({
    panelOrchestrator: {
      invalidateReadyPanels: vi.fn(),
      navigatePanelHistory: vi.fn(),
    } as never,
    panelRegistry: { getFocusedPanelId: vi.fn(() => null) } as never,
    getViewManager: () => viewManager as never,
    serverClient: null,
    getPanelWebContents: vi.fn(() => null),
  });
  const dispatcher = createTestServiceDispatcher();
  dispatcher.registerService(service);
  dispatcher.markInitialized();
  return { callerId, dispatcher };
}

describe("createMenuService", () => {
  it("admits a host-attributed shell session bound to admitted workspace chrome", async () => {
    const { callerId, dispatcher } = harness(true);

    await expect(
      dispatcher.dispatch(
        { caller: createHostCaller(callerId, "shell") },
        "menu",
        "showHamburger",
        [{ x: 12, y: 40 }]
      )
    ).resolves.toBeUndefined();
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({ x: 12, y: 40 }));
  });

  it("rejects a host-attributed shell session without an admitted chrome view", async () => {
    const { callerId, dispatcher } = harness(false);

    await expect(
      dispatcher.dispatch(
        { caller: createHostCaller(callerId, "shell") },
        "menu",
        "showHamburger",
        [{ x: 12, y: 40 }]
      )
    ).rejects.toThrow("restricted to app callers");
  });
});
