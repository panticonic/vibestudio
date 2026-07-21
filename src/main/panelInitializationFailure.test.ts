import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPanelInitializationFailure,
  readPanelInitializationFailure,
  recordPanelInitializationFailure,
} from "./panelInitializationFailure.js";

describe("panel initialization failure state", () => {
  beforeEach(() => {
    clearPanelInitializationFailure();
    vi.restoreAllMocks();
  });

  it("records a typed caught failure with its initialization trigger", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const error = new Error("workspace-state rejected the snapshot");

    expect(recordPanelInitializationFailure("electron-host-ready", error)).toEqual({
      timestamp: 1234,
      phase: "panel-tree",
      trigger: "electron-host-ready",
      message: "workspace-state rejected the snapshot",
      stack: error.stack,
    });
  });

  it("returns a defensive snapshot and clears it for the next attempt", () => {
    recordPanelInitializationFailure("held-electron-host-ready", "service unavailable");
    const snapshot = readPanelInitializationFailure();
    expect(snapshot).not.toBeNull();
    if (snapshot) snapshot.message = "mutated by test";

    expect(readPanelInitializationFailure()?.message).toBe("service unavailable");
    clearPanelInitializationFailure();
    expect(readPanelInitializationFailure()).toBeNull();
  });
});
