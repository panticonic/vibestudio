import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { createAdblockService } from "./adblockService.js";

function createManager() {
  return {
    getConfig: vi.fn(() => ({})),
    setEnabled: vi.fn(),
    setListEnabled: vi.fn(),
    addCustomList: vi.fn(),
    removeCustomList: vi.fn(),
    addToWhitelist: vi.fn(),
    removeFromWhitelist: vi.fn(),
    getStats: vi.fn(() => ({ blockedRequests: 0 })),
    resetStats: vi.fn(),
    rebuildEngine: vi.fn(),
    isActive: vi.fn(() => true),
    getStatsForPanel: vi.fn(() => ({ blockedRequests: 0 })),
    isEnabledForPanel: vi.fn(() => true),
    setEnabledForPanel: vi.fn(),
    resetStatsForPanel: vi.fn(),
    getPanelUrl: vi.fn(() => "https://example.test/"),
  };
}

function adblockPanelCaller() {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../workspace/about/adblock/package.json", import.meta.url), "utf8")
  ) as {
    vibestudio: {
      authority: {
        requests: Array<{
          capability: string;
          resource: { kind: "exact"; key: string } | { kind: "prefix"; prefix: string };
        }>;
      };
    };
  };
  return createVerifiedCaller("panel:about-adblock", "panel", {
    callerId: "panel:about-adblock",
    callerKind: "panel",
    repoPath: "about/adblock",
    effectiveVersion: "test-version",
    executionDigest: "a".repeat(64),
    requested: manifest.vibestudio.authority.requests,
  });
}

describe("createAdblockService", () => {
  it("allows panel callers to use panel adblock methods", async () => {
    const manager = createManager();
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(createAdblockService({ adBlockManager: manager as never }));
    dispatcher.markInitialized();

    const result = await dispatcher.dispatch(
      { caller: adblockPanelCaller() },
      "adblock",
      "getPanelUrl",
      [123]
    );

    expect(result).toBe("https://example.test/");
    expect(manager.getPanelUrl).toHaveBeenCalledWith(123);
  });

  it("lets the declared ad-block settings panel read and update global configuration", async () => {
    const manager = createManager();
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(createAdblockService({ adBlockManager: manager as never }));
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch({ caller: adblockPanelCaller() }, "adblock", "getConfig", [])
    ).resolves.toEqual({});
    await expect(
      dispatcher.dispatch({ caller: adblockPanelCaller() }, "adblock", "setEnabled", [false])
    ).resolves.toBe(true);
    expect(manager.setEnabled).toHaveBeenCalledWith(false);
  });
});
