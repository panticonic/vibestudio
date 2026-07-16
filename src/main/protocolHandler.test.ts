import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectDeepLink } from "@vibestudio/shared/connect";
import { createPanelDeepLink } from "@vibestudio/shared/panelLocation";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const app = {
    isPackaged: false,
    setAsDefaultProtocolClient: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return app;
    }),
  };
  return { app, handlers };
});

vi.mock("electron", () => ({ app: mocks.app }));

const FP = "AA".repeat(32);
function pair(room: string, code: string) {
  return { room, fp: FP, code, sig: "wss://signal.example/", v: 2 as const, ice: "all" as const };
}
function expectedPairing(room: string, code: string) {
  return { room, fp: FP, code, sig: "wss://signal.example/", v: 2, ice: "all" };
}

describe("protocolHandler", () => {
  const link = createConnectDeepLink(pair("room-1111-2222", "A".repeat(32)));

  beforeEach(() => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.app.isPackaged = false;
    mocks.app.setAsDefaultProtocolClient.mockReset();
    mocks.app.on.mockClear();
  });

  it("buffers a valid link until the renderer drains it", async () => {
    const mod = await import("./protocolHandler.js");
    mod.enqueueConnectLink(link);

    expect(mod.getPendingConnectLink()).toEqual(expectedPairing("room-1111-2222", "A".repeat(32)));
    expect(mod.getPendingConnectLink()).toBeNull();
  });

  it("can peek a buffered link without draining it", async () => {
    const mod = await import("./protocolHandler.js");
    mod.enqueueConnectLink(link);

    const expected = expectedPairing("room-1111-2222", "A".repeat(32));
    expect(mod.peekPendingConnectLink()).toEqual(expected);
    expect(mod.peekPendingConnectLink()).toEqual(expected);
    expect(mod.getPendingConnectLink()).toEqual(expected);
    expect(mod.peekPendingConnectLink()).toBeNull();
  });

  it("dispatches fresh links to live listeners", async () => {
    const mod = await import("./protocolHandler.js");
    const listener = vi.fn();
    const off = mod.onConnectLink(listener);

    mod.enqueueConnectLink(link);
    off();
    mod.enqueueConnectLink(createConnectDeepLink(pair("room-3333-4444", "B".repeat(32))));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expectedPairing("room-1111-2222", "A".repeat(32)));
  });

  it("captures macOS open-url and argv-borne second-instance links", async () => {
    const mod = await import("./protocolHandler.js");
    mod.installEarlyOpenUrlBuffer();

    const preventDefault = vi.fn();
    mocks.handlers.get("open-url")?.({ preventDefault }, link);
    expect(preventDefault).toHaveBeenCalled();
    expect(mod.getPendingConnectLink()?.room).toBe("room-1111-2222");

    const secondLink = createConnectDeepLink(pair("room-5555-6666", "C".repeat(32)));
    mocks.handlers.get("second-instance")?.({}, ["--flag", secondLink]);
    expect(mod.getPendingConnectLink()).toEqual(expectedPairing("room-5555-6666", "C".repeat(32)));
  });

  it("buffers and dispatches canonical panel locations through the same OS protocol", async () => {
    const mod = await import("./protocolHandler.js");
    const location = {
      source: "about/server-logs",
      workspace: "dev-123",
      ref: "state:abc",
      stateArgs: { filter: "error" },
      disposition: "root" as const,
    };
    const listener = vi.fn();
    mod.onPanelLocation(listener);
    mod.enqueueProtocolLink(createPanelDeepLink(location));

    expect(listener).toHaveBeenCalledWith(location);
    expect(mod.peekPendingPanelLocation()).toEqual(location);
    expect(mod.getPendingPanelLocation()).toEqual(location);
    expect(mod.getPendingPanelLocation()).toBeNull();
  });

  it("surfaces a stale/invalid link's actionable error instead of swallowing it", async () => {
    const mod = await import("./protocolHandler.js");
    const errorListener = vi.fn();
    mod.onConnectLinkError(errorListener);

    // A v1-style link (no v=2) — the parser rejects it with the re-pair message.
    mod.enqueueConnectLink(
      "vibestudio://connect?room=room-1111-2222&fp=" +
        FP +
        "&code=" +
        "A".repeat(24) +
        "&sig=wss://signal.example/&v=1"
    );

    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(errorListener.mock.calls[0]?.[0]).toMatch(/old protocol version|re-pair/i);
    // Buffered too, then drained once.
    expect(mod.getPendingConnectLinkError()).toMatch(/re-pair/i);
    expect(mod.getPendingConnectLinkError()).toBeNull();
    // A failed parse must NOT leave a pending (dial-able) link.
    expect(mod.getPendingConnectLink()).toBeNull();
  });

  it("a subsequent valid link clears a buffered parse error", async () => {
    const mod = await import("./protocolHandler.js");
    mod.enqueueConnectLink("vibestudio://connect?room=x&v=1");
    expect(mod.getPendingConnectLinkError()).not.toBeNull();
    mod.getPendingConnectLinkError(); // drain
    mod.enqueueConnectLink(link);
    expect(mod.getPendingConnectLinkError()).toBeNull();
    expect(mod.getPendingConnectLink()?.room).toBe("room-1111-2222");
  });

  it("registers packaged and development protocol handlers", async () => {
    const mod = await import("./protocolHandler.js");
    mocks.app.isPackaged = true;
    mod.registerProtocol();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenLastCalledWith("vibestudio");

    mocks.app.isPackaged = false;
    mod.registerProtocol();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenLastCalledWith(
      "vibestudio",
      process.execPath,
      expect.any(Array)
    );
  });
});
