import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { browserLaunchCommand, openExternalBrowser } from "./openExternalBrowser.js";

describe("browserLaunchCommand", () => {
  const url = "https://auth.example.test/authorize?state=opaque";

  it.each([
    ["darwin", { command: "open", args: [url] }],
    ["linux", { command: "xdg-open", args: [url] }],
    ["win32", { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] }],
  ] as const)("uses the native %s launcher without a shell", (platform, expected) => {
    expect(browserLaunchCommand(url, platform)).toEqual(expected);
  });

  it("rejects non-browser protocols", () => {
    expect(() => browserLaunchCommand("file:///tmp/secret", "linux")).toThrow(
      "Cannot open non-HTTP browser URL"
    );
  });
});

describe("openExternalBrowser", () => {
  it("waits for spawn before reporting success", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn().mockReturnValue(child);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;

    let settled = false;
    const launched = openExternalBrowser("https://auth.example.test", {
      platform: "linux",
      spawnProcess,
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(spawnProcess).toHaveBeenCalledWith("xdg-open", ["https://auth.example.test"], {
      detached: true,
      stdio: "ignore",
    });

    child.emit("spawn");
    await launched;
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("reports launcher failure immediately", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn().mockReturnValue(child);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const launched = openExternalBrowser("https://auth.example.test", {
      platform: "linux",
      spawnProcess,
    });

    child.emit("error", new Error("xdg-open is missing"));
    await expect(launched).rejects.toThrow("xdg-open is missing");
  });
});
