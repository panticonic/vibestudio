import { describe, expect, it, vi } from "vitest";
import { FullscreenPresentation } from "./fullscreenPresentation.js";

function harness(windowFullscreen = false) {
  const host = {
    isWindowFullscreen: () => windowFullscreen,
    setWindowFullscreen: vi.fn((value: boolean) => {
      windowFullscreen = value;
    }),
    canPresent: vi.fn(() => true),
    present: vi.fn(),
    exitDocument: vi.fn(async (_id: string) => {}),
  };
  return { host, fullscreen: new FullscreenPresentation(host) };
}

describe("fullscreen presentation ownership", () => {
  it("restores the original window mode when a panel exits", async () => {
    for (const alreadyFullscreen of [false, true]) {
      const { host, fullscreen } = harness(alreadyFullscreen);
      fullscreen.enterPanel("chat");
      expect(host.present).toHaveBeenLastCalledWith("chat");
      expect(host.isWindowFullscreen()).toBe(true);
      await fullscreen.escape();
      expect(fullscreen.viewId).toBeNull();
      expect(host.present).toHaveBeenLastCalledWith(null);
      expect(host.isWindowFullscreen()).toBe(alreadyFullscreen);
    }
  });

  it("keeps temporary media and panel presentation out of the saved window mode", async () => {
    for (const original of [false, true]) {
      const { fullscreen } = harness(original);
      fullscreen.enterPanel("chat");
      expect(fullscreen.windowFullscreen).toBe(original);
      fullscreen.enterHtml("chat");
      expect(fullscreen.windowFullscreen).toBe(original);
      await fullscreen.leaveHtml("chat");
      expect(fullscreen.windowFullscreen).toBe(original);
      await fullscreen.exit();
      expect(fullscreen.windowFullscreen).toBe(original);
    }
  });

  it("lets media fullscreen nest inside a fullscreen panel", async () => {
    const { host, fullscreen } = harness();
    fullscreen.enterPanel("chat");
    fullscreen.enterHtml("chat");
    host.exitDocument.mockImplementation(async (id) => {
      await fullscreen.leaveHtml(id);
    });
    await fullscreen.escape();
    expect(fullscreen.viewId).toBe("chat");
    expect(host.isWindowFullscreen()).toBe(true);
    await fullscreen.escape();
    expect(fullscreen.viewId).toBeNull();
    expect(host.isWindowFullscreen()).toBe(false);
  });

  it("restores browser chrome when the page exits HTML fullscreen itself", async () => {
    const { host, fullscreen } = harness();
    fullscreen.enterHtml("website");
    await fullscreen.leaveHtml("website");
    expect(fullscreen.viewId).toBeNull();
    expect(host.isWindowFullscreen()).toBe(false);
  });

  it("exits both nested modes through the fullscreen command", async () => {
    const { host, fullscreen } = harness(true);
    fullscreen.enterPanel("chat");
    fullscreen.enterHtml("chat");
    host.exitDocument.mockImplementation(async (id) => {
      await fullscreen.leaveHtml(id);
    });
    await fullscreen.toggleWindow();
    expect(fullscreen.viewId).toBeNull();
    expect(host.isWindowFullscreen()).toBe(false);
  });

  it("propagates a document exit failure and retains its presentation", async () => {
    const { host, fullscreen } = harness();
    const failure = new Error("renderer disconnected");
    host.exitDocument.mockRejectedValue(failure);
    fullscreen.enterHtml("website");
    await expect(fullscreen.exit()).rejects.toBe(failure);
    expect(fullscreen.viewId).toBe("website");
    expect(host.isWindowFullscreen()).toBe(true);
  });

  it("does not let a late document exit terminate a different owner", async () => {
    const { host, fullscreen } = harness();
    let finish!: () => void;
    host.exitDocument.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    fullscreen.enterHtml("old");
    const leaving = fullscreen.escape();
    await fullscreen.retire("old");
    fullscreen.enterHtml("new");
    finish();
    await leaving;
    await fullscreen.leaveHtml("old");
    expect(fullscreen.viewId).toBe("new");
  });

  it("settles ownership on navigation or destruction without running code in a replacement document", async () => {
    const { host, fullscreen } = harness();
    fullscreen.enterHtml("website");
    await fullscreen.retire("website");
    expect(fullscreen.viewId).toBeNull();
    expect(host.exitDocument).not.toHaveBeenCalled();
    expect(host.isWindowFullscreen()).toBe(false);
  });

  it("also exits the live document when its presentation is withdrawn", async () => {
    const { host, fullscreen } = harness();
    fullscreen.enterHtml("website");
    await fullscreen.retire("website", true);
    expect(fullscreen.viewId).toBeNull();
    expect(host.exitDocument).toHaveBeenCalledWith("website");
  });

  it("honors an OS window exit without restoring a previously fullscreen window", async () => {
    const { host, fullscreen } = harness(true);
    fullscreen.enterHtml("website");
    host.setWindowFullscreen(false);
    await fullscreen.windowLeftFullscreen();
    expect(fullscreen.viewId).toBeNull();
    expect(host.exitDocument).toHaveBeenCalledWith("website");
    expect(host.isWindowFullscreen()).toBe(false);
  });

  it("rejects hidden targets and another owner without changing native presentation", () => {
    const { host, fullscreen } = harness();
    host.canPresent.mockReturnValue(false);
    expect(() => fullscreen.enterHtml("hidden")).toThrow("presented panel");
    expect(host.setWindowFullscreen).not.toHaveBeenCalled();
    host.canPresent.mockReturnValue(true);
    fullscreen.enterPanel("chat");
    expect(() => fullscreen.enterHtml("other")).toThrow("owns fullscreen");
    expect(fullscreen.viewId).toBe("chat");
  });
});
