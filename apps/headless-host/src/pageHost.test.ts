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
  let eventHandler:
    | ((event: { method: string; params: unknown; sessionId?: string }) => void)
    | null = null;
  const send = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "Target.createBrowserContext") return { browserContextId: "browser-context-1" };
    if (method === "Target.createTarget") return { targetId: "target-1" };
    if (method === "Target.attachToTarget") return { sessionId: "mgmt-1" };
    if (method === "Page.navigate") return navigateResult;
    if (method === "Target.closeTarget") return { success: true };
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
    fireLoad: () =>
      eventHandler?.({ method: "Page.loadEventFired", params: {}, sessionId: "mgmt-1" }),
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
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Page.navigate", { url: input.panelUrl }, "mgmt-1")
    );
    expect(settled).toBe(false);

    fireDocumentReady();
    await expect(loading).resolves.toBeUndefined();
  });

  it("publishes native document and load transitions to readiness observers", async () => {
    const { host, input, send, fireDocumentReady, fireLoad } = lifecycleHarness();
    const changed = vi.fn();
    host.onViewChanged(changed);
    const loading = host.loadPanel(input);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Page.navigate", { url: input.panelUrl }, "mgmt-1")
    );

    fireDocumentReady();
    await loading;
    fireLoad();

    expect(changed).toHaveBeenNthCalledWith(1, input.slotId);
    expect(changed).toHaveBeenNthCalledWith(2, input.slotId);
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
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Page.navigate", { url: input.panelUrl }, "mgmt-1")
    );

    await host.unloadPanel(input.slotId);
    await expect(loading).rejects.toThrow("unloaded before document readiness");
  });

  it("closes the final renderer without deleting its live owner's storage", async () => {
    const { host, input, send, fireDocumentReady } = lifecycleHarness();
    const loading = host.loadPanel(input);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Page.navigate", { url: input.panelUrl }, "mgmt-1")
    );
    fireDocumentReady();
    await loading;

    await host.unloadPanel(input.slotId);

    expect(send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "target-1" });
    expect(send).not.toHaveBeenCalledWith("Target.disposeBrowserContext", expect.anything());
    expect(host.contextIds()).toEqual([input.contextId]);
    const replacement = host.loadPanel({ ...input, tabId: 2 });
    await vi.waitFor(() => expect(send.mock.calls.filter(([method]) => method === "Page.navigate")).toHaveLength(2));
    fireDocumentReady();
    await replacement;
    expect(send.mock.calls.filter(([method]) => method === "Target.createBrowserContext")).toHaveLength(1);
    await host.retireContext(input.contextId);
    expect(send).toHaveBeenCalledWith("Target.disposeBrowserContext", { browserContextId: "browser-context-1" });
    expect(host.slots()).toEqual([]);
    expect(host.contextIds()).toEqual([]);
  });

  it("reclaims every owned renderer and browser context when the context is retired", async () => {
    const { host, input, send, fireDocumentReady } = lifecycleHarness();
    const loading = host.loadPanel(input);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("Page.navigate", { url: input.panelUrl }, "mgmt-1")
    );
    fireDocumentReady();
    await loading;

    const pages = (host as unknown as { pages: Map<string, unknown> }).pages;
    pages.set("panel-2", {
      slotId: "panel-2",
      contextId: input.contextId,
      targetId: "target-2",
      mgmtSessionId: "mgmt-2",
      relaySessionId: null,
      panelUrl: input.panelUrl,
      lastUsedAt: 0,
    });

    await host.retireContext(input.contextId);
    expect(send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "target-1" });
    expect(send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "target-2" });
    expect(send).toHaveBeenCalledWith("Target.disposeBrowserContext", {
      browserContextId: "browser-context-1",
    });
  });

  it("retains a failed context disposal for a confirmed retry", async () => {
    const { host, input, send, fireDocumentReady } = lifecycleHarness();
    const loading = host.loadPanel(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("Page.navigate", { url: input.panelUrl }, "mgmt-1"));
    fireDocumentReady();
    await loading;
    await host.unloadPanel(input.slotId);
    send.mockRejectedValueOnce(new Error("disposal failed"));
    await expect(host.retireContext(input.contextId)).rejects.toThrow("disposal failed");
    expect(host.contextIds()).toEqual([input.contextId]);
    await host.reconcileContextOwners([], [input.contextId]);
    expect(host.contextIds()).toEqual([]);
  });

  it("keeps ownership of a renderer whose close was not confirmed", async () => {
    const { host, input, send, fireDocumentReady } = lifecycleHarness();
    const loading = host.loadPanel(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("Page.navigate", { url: input.panelUrl }, "mgmt-1"));
    fireDocumentReady();
    await loading;
    send.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ targetInfos: [{ targetId: "target-1" }] });
    await expect(host.unloadPanel(input.slotId)).rejects.toThrow("did not close owned target");
    expect(host.slots()).toEqual([input.slotId]);
    await host.retireContext(input.contextId);
    expect(host.slots()).toEqual([]);
    expect(host.contextIds()).toEqual([]);
  });
});

describe("PageHost.domSnapshot", () => {
  it("requires and returns explicit global observation bounds", async () => {
    const limits = {
      textCharacters: 32768,
      textNodes: 2000,
      structureNodes: 500,
      depth: 8,
      childrenPerNode: 50,
      leafTextCharacters: 160,
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

describe("PageHost.panelPageObservation", () => {
  it("reads and validates the canonical boot and document readiness state", async () => {
    const value = {
      view: { url: "http://127.0.0.1/panel", loading: false },
      boot: {
        kind: "observed",
        observation: {
          phase: "ready",
          runtimeEntityId: "panel:nav-a",
          source: "panels/example",
          contextId: "ctx-a",
          effectiveVersion: "state-a",
          buildKey: "build-a",
        },
      },
    };
    const send = vi.fn(async () => ({ result: { value } }));
    const cdp = { onEvent: vi.fn(), send };
    const host = new PageHost(cdp as never, new ConsoleHistoryStore());
    const pages = (host as unknown as { pages: Map<string, unknown> }).pages;
    pages.set("panel-1", {
      slotId: "panel-1",
      contextId: "context-1",
      targetId: "target-1",
      mgmtSessionId: "mgmt-1",
      relaySessionId: null,
      panelUrl: "http://127.0.0.1/panel",
      lastUsedAt: 0,
    });

    await expect(host.panelPageObservation("panel-1")).resolves.toEqual(value);
    expect(send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining("__vibestudioPanelBoot"),
        returnByValue: true,
      }),
      "mgmt-1"
    );
  });
});


describe("PageHost relay ownership", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function relayHarness() {
    const attach = deferred<{ sessionId: string }>();
    const detach = deferred<unknown>();
    const send = vi.fn(async (method: string) => {
      if (method === "Target.attachToTarget") return attach.promise;
      if (method === "Target.detachFromTarget") return detach.promise;
      if (method === "Target.closeTarget") return { success: true };
      return {};
    });
    const cdp = {
      send, onEvent: vi.fn(), ownerOf: vi.fn(), claimSession: vi.fn(), releaseSession: vi.fn(), releaseSlotSessions: vi.fn(),
    };
    const host = new PageHost(cdp as never, new ConsoleHistoryStore());
    (host as unknown as { pages: Map<string, unknown> }).pages.set("panel-1", {
      slotId: "panel-1", contextId: "context-1", targetId: "target-1",
      mgmtSessionId: "mgmt-1", relaySessionId: null, panelUrl: "https://example.com", lastUsedAt: 0,
    });
    return { host, cdp, send, attach, detach };
  }

  it("initializes concurrent domains on one native session", async () => {
    const { host, send, attach, cdp } = relayHarness();
    const commands = ["Inspector.enable", "Page.enable", "Runtime.enable", "DOM.enable"];
    const pending = commands.map((method) => host.relaySend("panel-1", method, undefined));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    attach.resolve({ sessionId: "relay-1" });
    await Promise.all(pending);
    expect(send.mock.calls.filter(([method]) => method === "Target.attachToTarget")).toHaveLength(1);
    expect(cdp.claimSession).toHaveBeenCalledExactlyOnceWith("relay-1", "panel-1");
    for (const method of commands) expect(send).toHaveBeenCalledWith(method, undefined, "relay-1");
  });

  it("joins attachment and native detachment before allowing a new relay", async () => {
    const { host, send, attach, detach, cdp } = relayHarness();
    const opening = host.relaySend("panel-1", "Page.enable", undefined);
    const rejected = expect(opening).rejects.toThrow("relay is retiring");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const closing = host.detachRelay("panel-1");
    expect(host.detachRelay("panel-1")).toBe(closing);
    const next = host.relaySend("panel-1", "Runtime.enable", undefined);
    attach.resolve({ sessionId: "relay-1" });
    await rejected;
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("Target.detachFromTarget", { sessionId: "relay-1" }));
    expect(send.mock.calls.filter(([method]) => method === "Target.attachToTarget")).toHaveLength(1);
    detach.resolve({});
    await closing;
    await next;
    expect(cdp.releaseSession).toHaveBeenCalledExactlyOnceWith("relay-1");
    expect(send.mock.calls.filter(([method]) => method === "Target.attachToTarget")).toHaveLength(2);
  });

  it("retires an attachment in flight before closing the owned target", async () => {
    const { host, send, attach, detach, cdp } = relayHarness();
    const opening = host.relaySend("panel-1", "Page.enable", undefined);
    const rejected = expect(opening).rejects.toThrow("relay is retiring");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const closing = host.unloadPanel("panel-1");
    await expect(host.relaySend("panel-1", "Runtime.enable", undefined)).rejects.toThrow("no active page");
    attach.resolve({ sessionId: "relay-1" });
    await rejected;
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("Target.detachFromTarget", { sessionId: "relay-1" }));
    expect(cdp.releaseSession).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([method]) => method === "Target.closeTarget")).toBe(false);
    detach.resolve({});
    await closing;
    expect(send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "target-1" });
    expect(cdp.releaseSlotSessions).toHaveBeenCalledExactlyOnceWith("panel-1");
  });

  it("retains failed native detachment for a confirmed retry", async () => {
    const { host, send, attach, detach, cdp } = relayHarness();
    attach.resolve({ sessionId: "relay-1" });
    await host.relaySend("panel-1", "Page.enable", undefined);
    const closing = host.detachRelay("panel-1");
    const rejected = expect(closing).rejects.toThrow("native detach failed");
    detach.reject(new Error("native detach failed"));
    await rejected;
    expect(cdp.releaseSession).not.toHaveBeenCalled();
    await expect(host.relaySend("panel-1", "Page.enable", undefined)).rejects.toThrow("retirement is unconfirmed");
    send.mockImplementation(async () => ({}));
    await host.detachRelay("panel-1");
    expect(send.mock.calls.filter(([method]) => method === "Target.attachToTarget")).toHaveLength(1);
    expect(send.mock.calls.filter(([method]) => method === "Target.detachFromTarget")).toHaveLength(2);
    expect(cdp.releaseSession).toHaveBeenCalledExactlyOnceWith("relay-1");
  });

  it("accepts a native detach event as confirmation when the target closes independently", async () => {
    const { host, send, attach, detach, cdp } = relayHarness();
    attach.resolve({ sessionId: "relay-1" });
    await host.relaySend("panel-1", "Page.enable", undefined);
    const closing = host.detachRelay("panel-1");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("Target.detachFromTarget", { sessionId: "relay-1" }));
    const onEvent = cdp.onEvent.mock.calls[0]![0] as unknown as (event: unknown) => void;
    onEvent({ method: "Target.detachedFromTarget", params: { sessionId: "relay-1" } });
    detach.reject(new Error("session no longer exists"));
    await closing;
    expect(cdp.releaseSession).toHaveBeenCalledExactlyOnceWith("relay-1");
    send.mockImplementation(async () => ({ sessionId: "relay-2" }));
    await host.relaySend("panel-1", "Page.enable", undefined);
    expect(send).toHaveBeenLastCalledWith("Page.enable", undefined, "relay-2");
  });

  it("releases a failed attachment so another attempt can acquire the session", async () => {
    const { host, send, attach } = relayHarness();
    const opening = host.relaySend("panel-1", "Page.enable", undefined);
    const rejected = expect(opening).rejects.toThrow("native attach failed");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    attach.reject(new Error("native attach failed"));
    await rejected;
    send.mockImplementation(async () => ({ sessionId: "relay-2" }));
    await host.relaySend("panel-1", "Page.enable", undefined);
    expect(send).toHaveBeenLastCalledWith("Page.enable", undefined, "relay-2");
  });
});
