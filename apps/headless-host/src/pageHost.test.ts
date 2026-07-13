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

function lifecycleHarness(navigateResult: { errorText?: string } = {}) {
  const owners = new Map<string, string>();
  let eventHandler: ((event: { method: string; params: unknown; sessionId?: string }) => void) | null =
    null;
  const send = vi.fn(async (method: string) => {
    if (method === "Target.createBrowserContext") return { browserContextId: "browser-context-1" };
    if (method === "Target.createTarget") return { targetId: "target-1" };
    if (method === "Target.attachToTarget") return { sessionId: "mgmt-1" };
    if (method === "Page.navigate") return navigateResult;
    return {};
  });
  const cdp = {
    onEvent: vi.fn(
      (handler: (event: { method: string; params: unknown; sessionId?: string }) => void) => {
        eventHandler = handler;
      }
    ),
    send,
    claimSession: vi.fn((sessionId: string, owner: string) => owners.set(sessionId, owner)),
    releaseSession: vi.fn((sessionId: string) => owners.delete(sessionId)),
    releaseSlotSessions: vi.fn(),
    ownerOf: vi.fn((sessionId?: string) => (sessionId ? owners.get(sessionId) : undefined)),
  };
  const host = new PageHost(cdp as never, new ConsoleHistoryStore());
  const input = {
    slotId: "panel-1",
    contextId: "context-1",
    panelUrl: "https://example.com",
    panelInit: {},
    tabId: 1,
  };
  return {
    host,
    input,
    send,
    fireDocumentReady: () =>
      eventHandler?.({ method: "Page.domContentEventFired", params: {}, sessionId: "mgmt-1" }),
  };
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

describe("PageHost navigation readiness", () => {
  it("waits for the CDP document event without imposing a wall-clock deadline", async () => {
    const { host, input, send, fireDocumentReady } = lifecycleHarness();
    let settled = false;
    const loading = host.loadPanel(input).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("Page.navigate", { url: input.panelUrl }, "mgmt-1"));
    expect(settled).toBe(false);

    fireDocumentReady();
    await expect(loading).resolves.toBeUndefined();
  });

  it("rejects immediately on a concrete navigation error and cleans up the target", async () => {
    const { host, input, send } = lifecycleHarness({ errorText: "net::ERR_NAME_NOT_RESOLVED" });

    await expect(host.loadPanel(input)).rejects.toThrow(
      "panel navigation failed: net::ERR_NAME_NOT_RESOLVED"
    );
    expect(send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "target-1" });
  });

  it("rejects an outstanding readiness wait when the panel is unloaded", async () => {
    const { host, input, send } = lifecycleHarness();
    const loading = host.loadPanel(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("Page.navigate", { url: input.panelUrl }, "mgmt-1"));

    await host.unloadPanel(input.slotId);
    await expect(loading).rejects.toThrow("unloaded before document readiness");
  });
});

describe("PageHost.domSnapshot", () => {
  it("requires and returns explicit global observation bounds", async () => {
    const limits = {
      textChars: 32768,
      textNodes: 2000,
      structureNodes: 500,
      depth: 8,
      childrenPerNode: 50,
      leafTextChars: 160,
    };
    const send = vi.fn(async (_method: string, params: { expression?: string }) => ({
      result: {
        value: {
          kind: "synth",
          text: "bounded text",
          structure: { tag: "body" },
          truncated: true,
          limits,
          observed: { textNodes: 2000, structureNodes: 500 },
        },
      },
      expression: params?.expression,
    }));
    const cdp = { onEvent: vi.fn(), send };
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

    await expect(host.domSnapshot("panel-1")).resolves.toEqual({
      kind: "synth",
      text: "bounded text",
      structure: { tag: "body" },
      truncated: true,
      limits,
      observed: { textNodes: 2000, structureNodes: 500 },
    });
    const expression = (send.mock.calls[0]?.[1] as { expression?: string }).expression ?? "";
    expect(expression).toContain("structureNodes: 500");
    expect(expression).not.toContain("innerText");
  });
});
