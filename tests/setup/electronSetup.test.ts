import type { ElectronApplication } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestApi } from "../../src/main/testApi.js";
import { ensureHostedShellReady, panelInitializationFailureError } from "./electronSetup.js";

describe("hosted-shell initialization diagnostics", () => {
  afterEach(() => {
    delete globalThis.__testApi;
  });

  it("does not manufacture a terminal error while initialization is healthy", () => {
    expect(panelInitializationFailureError(null)).toBeNull();
  });

  it("formats the structured caught failure with its trigger and stack", () => {
    const error = panelInitializationFailureError({
      timestamp: 1234,
      phase: "panel-tree",
      trigger: "electron-host-ready",
      message: "missing workspace authority",
      stack: "PanelTreeError: missing workspace authority\n  at initializePanelTree",
    });

    expect(error?.message).toContain(
      "Hosted shell panel initialization failed during electron-host-ready: missing workspace authority"
    );
    expect(error?.message).toContain("PanelTreeError: missing workspace authority");
  });

  it("terminates readiness immediately from the authoritative test API state", async () => {
    const rpcCall = vi.fn();
    globalThis.__testApi = {
      readPanelInitializationFailure: () => ({
        timestamp: 1234,
        phase: "panel-tree",
        trigger: "electron-host-ready",
        message: "workspace-state denied the snapshot",
      }),
      rpcCall,
    } as unknown as TestApi;
    const app = {
      evaluate: async (callback: () => unknown) => callback(),
    } as unknown as ElectronApplication;

    await expect(
      ensureHostedShellReady(app, { panelSource: "panels/chat", timeoutMs: 30_000 })
    ).rejects.toThrow(
      "Hosted shell panel initialization failed during electron-host-ready: workspace-state denied the snapshot"
    );
    expect(rpcCall).not.toHaveBeenCalled();
  });
});
