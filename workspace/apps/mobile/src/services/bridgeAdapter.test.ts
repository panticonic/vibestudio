import { createBridgeAdapter } from "./bridgeAdapter";
import type { RpcConnectionStatus } from "@vibez1/rpc";
import type { WebRtcSession } from "@vibez1/rpc/transports/webrtcClient";
import type { PanelEntityId } from "@vibez1/shared/panel/ids";

function createAdapter(overrides?: Partial<Parameters<typeof createBridgeAdapter>[0]>) {
  return createBridgeAdapter({
    panelManager: {} as never,
    transport: {} as never,
    callbacks: { navigateToPanel: jest.fn() },
    deliverToPanel: jest.fn(),
    getPanelLease: jest.fn(),
    ...overrides,
  });
}

function makePanelSession(overrides: Partial<WebRtcSession> = {}): WebRtcSession {
  return {
    sid: "panel-session",
    callerId: jest.fn(() => "panel:runtime-a"),
    isClosed: jest.fn(() => false),
    close: jest.fn(),
    onMessage: jest.fn(() => jest.fn()),
    send: jest.fn(async () => undefined),
    status: jest.fn(() => "connected" as RpcConnectionStatus),
    ...overrides,
  } as unknown as WebRtcSession;
}

describe("bridgeAdapter panel init", () => {
  it("uses the mobile panel init provider when available", async () => {
    const panelManager = { getPanelInit: jest.fn() };
    const getPanelInit = jest.fn(async () => ({ entityId: "panel:nav-a", connectionId: "conn-a" }));
    const adapter = createAdapter({
      panelManager: panelManager as never,
      transport: {} as never,
      callbacks: { navigateToPanel: jest.fn() },
      getPanelInit,
    });

    await expect(adapter.handle("panel:tree/panel-a", "getPanelInit", [])).resolves.toEqual({
      entityId: "panel:nav-a",
      connectionId: "conn-a",
    });
    expect(getPanelInit).toHaveBeenCalledWith("panel:tree/panel-a");
    expect(panelManager.getPanelInit).not.toHaveBeenCalled();
  });

  it("falls back to the panel manager init provider", async () => {
    const panelManager = { getPanelInit: jest.fn(async () => ({ entityId: "panel:nav-a" })) };
    const adapter = createAdapter({
      panelManager: panelManager as never,
      transport: {} as never,
      callbacks: { navigateToPanel: jest.fn() },
    });

    await expect(adapter.handle("panel:tree/panel-a", "getPanelInit", [])).resolves.toEqual({
      entityId: "panel:nav-a",
    });
    expect(panelManager.getPanelInit).toHaveBeenCalledWith("panel:tree/panel-a");
  });
});

describe("bridgeAdapter CDP routing", () => {
  it.each(["getCdpEndpoint", "navigate", "goBack", "goForward", "stop"] as const)(
    "rejects mobile CDP fast-path method %s",
    async (method) => {
      const adapter = createAdapter();

      await expect(
        adapter.handle("panel:tree/panel-a", method, ["panel:tree/panel-b"])
      ).rejects.toThrow("CDP automation is routed through the server broker");
    }
  );
});

describe("bridgeAdapter panel session relay", () => {
  it("reopens the panel session when the cached session is closed", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    let firstClosed = false;
    const firstSession = makePanelSession({
      isClosed: jest.fn(() => firstClosed),
    });
    const secondSession = makePanelSession({
      sid: "panel-session-2",
      callerId: jest.fn(() => "panel:runtime-a"),
    });
    const openPanelSession = jest
      .fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const adapter = createAdapter({
      panelManager: {} as never,
      transport: { openPanelSession } as never,
      callbacks: { navigateToPanel: jest.fn() },
      deliverToPanel: jest.fn(),
      getPanelLease: jest.fn(() => ({
        runtimeEntityId: "panel:runtime-a" as PanelEntityId,
        connectionId: "conn-a",
      })),
    });

    await adapter.handle("panel:tree/panel-a", "postEnvelope", [{ id: "msg-1" }]);
    await waitFor(() => expect(firstSession.send).toHaveBeenCalledWith({ id: "msg-1" }));

    firstClosed = true;
    await adapter.handle("panel:tree/panel-a", "postEnvelope", [{ id: "msg-2" }]);
    await waitFor(() => expect(secondSession.send).toHaveBeenCalledWith({ id: "msg-2" }));

    expect(openPanelSession).toHaveBeenCalledTimes(2);
    expect(openPanelSession).toHaveBeenNthCalledWith(1, "panel:runtime-a", "conn-a");
    expect(openPanelSession).toHaveBeenNthCalledWith(2, "panel:runtime-a", "conn-a");
    expect(firstSession.close).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("closes and reopens the panel session when the runtime lease key changes", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    let lease = {
      runtimeEntityId: "panel:runtime-a" as PanelEntityId,
      connectionId: "conn-a",
    };
    const firstSession = makePanelSession();
    const secondSession = makePanelSession({
      sid: "panel-session-2",
      callerId: jest.fn(() => "panel:runtime-a"),
    });
    const openPanelSession = jest
      .fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const adapter = createAdapter({
      panelManager: {} as never,
      transport: { openPanelSession } as never,
      callbacks: { navigateToPanel: jest.fn() },
      deliverToPanel: jest.fn(),
      getPanelLease: jest.fn(() => lease),
    });

    await adapter.handle("panel:tree/panel-a", "postEnvelope", [{ id: "msg-1" }]);
    await waitFor(() => expect(firstSession.send).toHaveBeenCalledWith({ id: "msg-1" }));

    lease = {
      runtimeEntityId: "panel:runtime-a" as PanelEntityId,
      connectionId: "conn-b",
    };
    await adapter.handle("panel:tree/panel-a", "postEnvelope", [{ id: "msg-2" }]);
    await waitFor(() => expect(secondSession.send).toHaveBeenCalledWith({ id: "msg-2" }));

    expect(openPanelSession).toHaveBeenCalledTimes(2);
    expect(openPanelSession).toHaveBeenNthCalledWith(1, "panel:runtime-a", "conn-a");
    expect(openPanelSession).toHaveBeenNthCalledWith(2, "panel:runtime-a", "conn-b");
    expect(firstSession.close).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("closes a cached session when the panel no longer has a runtime lease", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    let hasLease = true;
    const session = makePanelSession();
    const adapter = createAdapter({
      panelManager: {} as never,
      transport: { openPanelSession: jest.fn(async () => session) } as never,
      callbacks: { navigateToPanel: jest.fn() },
      deliverToPanel: jest.fn(),
      getPanelLease: jest.fn(() =>
        hasLease
          ? {
              runtimeEntityId: "panel:runtime-a" as PanelEntityId,
              connectionId: "conn-a",
            }
          : undefined
      ),
    });

    await adapter.handle("panel:tree/panel-a", "postEnvelope", [{ id: "msg-1" }]);
    await waitFor(() => expect(session.send).toHaveBeenCalledWith({ id: "msg-1" }));

    hasLease = false;
    await adapter.handle("panel:tree/panel-a", "postEnvelope", [{ id: "msg-2" }]);
    await waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        "[bridgeAdapter] postEnvelope relay failed (panel panel:tree/panel-a):",
        expect.any(Error)
      )
    );
    warnSpy.mockRestore();
  });
});

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}
