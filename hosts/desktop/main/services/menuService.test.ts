import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import { createMenuService } from "./menuService.js";

const popup = vi.fn();
vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn(() => ({ popup })) },
}));

const callerId = "window:chat:1";

function harness(capabilities: ClientCapability[] | null) {
  const nativeWindow = {};
  const popupFor = vi.fn();
  const service = createMenuService({
    panelOrchestrator: {} as never,
    panelRegistry: { getFocusedPanelId: vi.fn(() => null) } as never,
    getViewManager: () => ({}) as never,
    clientWindows: {
      byCaller: (id: string) =>
        capabilities && id === callerId
          ? ({
              windowId: "window:chat:1",
              spec: { capabilities },
              browserWindow: () => nativeWindow,
            } as never)
          : null,
    },
    menus: { popup: popupFor } as never,
    getPanelWebContents: vi.fn(() => null),
  });
  const dispatcher = createTestServiceDispatcher();
  dispatcher.registerService(service);
  dispatcher.markInitialized();
  return { dispatcher, popupFor, nativeWindow };
}

const client = () => ({ caller: createVerifiedCaller(callerId, "client") });

describe("createMenuService", () => {
  it("opens the calling client's own contributed popup, whether or not it hosts panels", async () => {
    const { dispatcher, popupFor, nativeWindow } = harness(["native-menus"]);

    await expect(
      dispatcher.dispatch(client(), "menu", "showHamburger", [{ x: 12, y: 40 }])
    ).resolves.toBeUndefined();
    expect(popupFor).toHaveBeenCalledWith("window:chat:1", nativeWindow, { x: 12, y: 40 });
  });

  it("rejects a client that was not granted native-menus", async () => {
    const { dispatcher, popupFor } = harness(["notifications"]);

    await expect(
      dispatcher.dispatch(client(), "menu", "showHamburger", [{ x: 12, y: 40 }])
    ).rejects.toThrow("requires client capability 'native-menus'");
    expect(popupFor).not.toHaveBeenCalled();
  });

  it("rejects a caller that is no client window", async () => {
    const { dispatcher } = harness(null);

    await expect(
      dispatcher.dispatch(client(), "menu", "showContext", [[], { x: 0, y: 0 }])
    ).rejects.toThrow(/no open window|requires client capability/);
  });
});
