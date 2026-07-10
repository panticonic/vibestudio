import { describe, expect, it, vi } from "vitest";
import { ConsoleHistoryStore } from "./consoleHistory.js";
import { PageHost } from "./pageHost.js";

function png(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  bytes.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function jpeg(width: number, height: number): string {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]).toString("base64");
}

function harness(data: string) {
  const send = vi.fn(async () => ({ data }));
  const cdp = {
    onEvent: vi.fn(),
    send,
  };
  const host = new PageHost(cdp as never, new ConsoleHistoryStore());
  const pages = (host as unknown as { pages: Map<string, unknown> }).pages;
  pages.set("panel-1", {
    slotId: "panel-1",
    contextId: "context-1",
    targetId: "target-1",
    mgmtSessionId: "mgmt-1",
    relaySessionId: null,
    panelUrl: "https://example.com",
    lastUsedAt: 0,
  });
  return { host, send };
}

describe("PageHost.captureScreenshot", () => {
  it("captures PNG through the management session and returns exact dimensions", async () => {
    const data = png(800, 600);
    const { host, send } = harness(data);

    await expect(host.captureScreenshot("panel-1", { format: "png" })).resolves.toEqual({
      data,
      mimeType: "image/png",
      width: 800,
      height: 600,
    });
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png" }, "mgmt-1");
  });

  it("forwards JPEG quality and reads JPEG dimensions", async () => {
    const data = jpeg(1024, 768);
    const { host, send } = harness(data);

    await expect(
      host.captureScreenshot("panel-1", { format: "jpeg", quality: 60 })
    ).resolves.toEqual({
      data,
      mimeType: "image/jpeg",
      width: 1024,
      height: 768,
    });
    expect(send).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 60 },
      "mgmt-1"
    );
  });
});
