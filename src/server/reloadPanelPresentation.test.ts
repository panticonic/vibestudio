import { describe, expect, it, vi } from "vitest";

import { reloadRegisteredPanelPresentation } from "./reloadPanelPresentation.js";

describe("reloadRegisteredPanelPresentation", () => {
  it("reloads a registered panel in place without replacing its lease", async () => {
    const bridge = {
      isTargetRegistered: vi.fn(() => true),
      sendHostCommand: vi.fn(async () => ({
        panelId: "panel:tree/chat",
        operation: "reload" as const,
        status: "reloaded",
        loaded: true,
        rebuilt: false,
        reloaded: true,
      })),
    };

    await expect(
      reloadRegisteredPanelPresentation(bridge, "panel:tree/chat")
    ).resolves.toBe(true);
    expect(bridge.sendHostCommand).toHaveBeenCalledWith(
      "panel:tree/chat",
      "reloadPanel",
      []
    );
  });

  it("leaves an unregistered panel to the allocation fallback", async () => {
    const bridge = {
      isTargetRegistered: vi.fn(() => false),
      sendHostCommand: vi.fn(),
    };

    await expect(
      reloadRegisteredPanelPresentation(bridge, "panel:tree/chat")
    ).resolves.toBe(false);
    expect(bridge.sendHostCommand).not.toHaveBeenCalled();
  });

  it("fails when a registered host reports that it did not reload", async () => {
    const bridge = {
      isTargetRegistered: vi.fn(() => true),
      sendHostCommand: vi.fn(async () => ({ reloaded: false })),
    };

    await expect(
      reloadRegisteredPanelPresentation(bridge, "panel:tree/chat")
    ).rejects.toThrow("Presentation host did not reload panel panel:tree/chat");
  });
});
