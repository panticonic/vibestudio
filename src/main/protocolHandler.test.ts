import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectDeepLink } from "@vibestudio/shared/connect";
import { createPanelDeepLink } from "@vibestudio/shared/panelLocation";
import { createShellSurfaceLink } from "@vibestudio/shared/shellSurface";

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

function pair(code: string) {
  return {
    endpointId: "aa".repeat(32),
    relays: ["https://relay.example/"],
    code,
    exp: 2_000_000_000_000,
    v: 4 as const,
  };
}
function expectedPairing(code: string) {
  return pair(code);
}

describe("protocolHandler", () => {
  const link = createConnectDeepLink(pair("A".repeat(32)));

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

    expect(mod.getPendingConnectLink()).toEqual(expectedPairing("A".repeat(32)));
    expect(mod.getPendingConnectLink()).toBeNull();
  });

  it("can peek a buffered link without draining it", async () => {
    const mod = await import("./protocolHandler.js");
    mod.enqueueConnectLink(link);

    const expected = expectedPairing("A".repeat(32));
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
    mod.enqueueConnectLink(createConnectDeepLink(pair("B".repeat(32))));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expectedPairing("A".repeat(32)));
  });

  it("captures macOS open-url and argv-borne second-instance links", async () => {
    const mod = await import("./protocolHandler.js");
    mod.installEarlyOpenUrlBuffer();

    const preventDefault = vi.fn();
    mocks.handlers.get("open-url")?.({ preventDefault }, link);
    expect(preventDefault).toHaveBeenCalled();
    expect(mod.getPendingConnectLink()?.endpointId).toBe("aa".repeat(32));

    const secondLink = createConnectDeepLink(pair("C".repeat(32)));
    mocks.handlers.get("second-instance")?.({}, ["--flag", secondLink]);
    expect(mod.getPendingConnectLink()).toEqual(expectedPairing("C".repeat(32)));
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

    // An old query-style link — the compact parser rejects it with the re-pair message.
    mod.enqueueConnectLink(
      "vibestudio://connect?room=room-1111-2222&fp=" +
        "AA".repeat(32) +
        "&code=" +
        "A".repeat(24) +
        "&sig=wss://signal.example/&v=1"
    );

    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(errorListener.mock.calls[0]?.[0]).toMatch(
      /not a Vibestudio pair URL|unsupported pairing protocol/i
    );
    // Buffered too, then drained once.
    expect(mod.getPendingConnectLinkError()).toMatch(/not a Vibestudio pair URL|fresh link/i);
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
    expect(mod.getPendingConnectLink()?.endpointId).toBe("aa".repeat(32));
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

  it("routes shell-surface deep links to their own buffer and listeners", async () => {
    const mod = await import("./protocolHandler.js");
    const seen: unknown[] = [];
    mod.onShellSurface((target) => seen.push(target));
    mod.enqueueProtocolLink(
      createShellSurfaceLink({ kind: "command-agent", prompt: "Add a scene", mode: "quickfire" })
    );
    expect(seen).toEqual([{ kind: "command-agent", prompt: "Add a scene", mode: "quickfire" }]);
    expect(mod.getPendingShellSurface()).toEqual({
      kind: "command-agent",
      prompt: "Add a scene",
      mode: "quickfire",
    });
    expect(mod.getPendingShellSurface()).toBeNull();
    // An https share URL to an About page takes the same path.
    mod.enqueueProtocolLink(
      createShellSurfaceLink({ kind: "about", page: "permissions" }, "https")
    );
    expect(mod.getPendingShellSurface()).toEqual({ kind: "about", page: "permissions" });
    // A malformed surface link surfaces an error instead of falling through to pairing.
    mod.enqueueProtocolLink("vibestudio://about?v=1&page=../etc");
    expect(mod.getPendingConnectLinkError()).toMatch(/About page/);
    expect(mod.getPendingConnectLink()).toBeNull();
  });
});
