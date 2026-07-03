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

// §1.6 upload hop: a panel's streaming request body crosses the postMessage
// bridge as base64 chunk messages, reassembles host-side, and feeds the panel
// session's streamReadable(); the response streams back through deliverToPanel
// tagged __vibez1BridgeStream, ack-gated.
describe("bridgeAdapter upload streams", () => {
  const PANEL = "panel:tree/panel-a";

  function streamRequestEnvelope() {
    const caller = { callerId: "panel:runtime-a", callerKind: "panel" as const };
    return {
      from: "panel:runtime-a",
      target: "main",
      delivery: { caller },
      provenance: [caller],
      message: {
        type: "stream-request",
        requestId: "sreq-1",
        fromId: "panel:runtime-a",
        method: "gateway.fetch",
        args: [{ path: "/upload" }],
      },
    };
  }

  function base64Of(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
  }

  async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
  }

  function makeUploadFixture(overrides?: {
    streamReadable?: jest.Mock;
    session?: Partial<WebRtcSession>;
  }) {
    const seen: { body?: Uint8Array; envelope?: unknown } = {};
    const streamReadable =
      overrides?.streamReadable ??
      jest.fn(async (envelope: unknown, _signal: AbortSignal, body: ReadableStream<Uint8Array>) => {
        seen.envelope = envelope;
        seen.body = await drainStream(body);
        return {
          status: 201,
          statusText: "Created",
          headers: [["content-type", "application/json"]],
          finalUrl: "http://gw/upload",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([9, 9]));
              controller.close();
            },
          }),
        };
      });
    const session = makePanelSession({ streamReadable, ...overrides?.session } as never);
    const delivered: Array<{ __vibez1BridgeStream: boolean; msg: { kind: string; opId?: string; seq?: number } }> = [];
    // Auto-ack response chunks like the injected panel bootstrap does.
    const adapterBox: { current?: ReturnType<typeof createAdapter> } = {};
    const deliverToPanel = jest.fn((_panelId: string, payload: unknown) => {
      const tagged = payload as (typeof delivered)[number];
      delivered.push(tagged);
      if (tagged?.msg?.kind === "chunk") {
        void adapterBox.current?.handle(PANEL, "streamAck", [tagged.msg.opId, tagged.msg.seq]);
      }
    });
    const adapter = createAdapter({
      panelManager: {} as never,
      transport: { openPanelSession: jest.fn(async () => session) } as never,
      callbacks: { navigateToPanel: jest.fn() },
      deliverToPanel,
      getPanelLease: jest.fn(() => ({
        runtimeEntityId: "panel:runtime-a" as PanelEntityId,
        connectionId: "conn-a",
      })),
    });
    adapterBox.current = adapter;
    return { adapter, delivered, seen, streamReadable };
  }

  it("relays an upload: base64 body in, tagged ack-gated response out", async () => {
    const { adapter, delivered, seen, streamReadable } = makeUploadFixture();

    await adapter.handle(PANEL, "streamOpen", [
      { opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" },
    ]);
    await adapter.handle(PANEL, "streamBodyChunk", [
      { bodyId: "b-1", seq: 1, chunk: base64Of(new Uint8Array([1, 2, 3])) },
    ]);
    await adapter.handle(PANEL, "streamBodyChunk", [{ bodyId: "b-1", seq: 2, done: true }]);

    await waitFor(() => expect(delivered.at(-1)?.msg.kind).toBe("end"));
    expect(streamReadable).toHaveBeenCalledTimes(1);
    expect(seen.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(delivered[0]).toMatchObject({
      __vibez1BridgeStream: true,
      msg: { kind: "head", opId: "op-1", status: 201 },
    });
    const chunk = delivered.find((entry) => entry.msg.kind === "chunk");
    expect(chunk?.msg).toMatchObject({
      opId: "op-1",
      seq: 1,
      chunk: base64Of(new Uint8Array([9, 9])),
    });
  });

  it("rejects body chunks with no open upload stream (fail-loud ack)", async () => {
    const { adapter } = makeUploadFixture();
    await expect(
      adapter.handle(PANEL, "streamBodyChunk", [{ bodyId: "nope", seq: 1, chunk: base64Of(new Uint8Array([1])) }])
    ).rejects.toThrow(/No open bridge upload stream/);
  });

  it("streamAbort aborts the in-flight session stream", async () => {
    let seenSignal: AbortSignal | null = null;
    const streamReadable = jest.fn(
      (_envelope: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted upstream")));
        })
    );
    const { adapter } = makeUploadFixture({ streamReadable });

    await adapter.handle(PANEL, "streamOpen", [
      { opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" },
    ]);
    await waitFor(() => expect(streamReadable).toHaveBeenCalled());
    await adapter.handle(PANEL, "streamAbort", ["op-1"]);

    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
    await expect(
      adapter.handle(PANEL, "streamBodyChunk", [{ bodyId: "b-1", seq: 1, chunk: base64Of(new Uint8Array([1])) }])
    ).rejects.toThrow(/unknown bodyId/);
  });

  it("fails loudly when the panel session cannot stream a request body", async () => {
    const { adapter, delivered } = makeUploadFixture({
      streamReadable: undefined as never,
      session: { streamReadable: undefined },
    });

    await adapter.handle(PANEL, "streamOpen", [
      { opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" },
    ]);

    await waitFor(() => expect(delivered.at(-1)?.msg.kind).toBe("error"));
    expect((delivered.at(-1)?.msg as { message?: string }).message).toMatch(
      /require the WebRTC transport/
    );
  });

  it("closePanelSession tears down the panel's upload relay", async () => {
    const streamReadable = jest.fn(
      (_envelope: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("closed")));
        })
    );
    const { adapter } = makeUploadFixture({ streamReadable });

    await adapter.handle(PANEL, "streamOpen", [
      { opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" },
    ]);
    await waitFor(() => expect(streamReadable).toHaveBeenCalled());
    adapter.closePanelSession(PANEL);

    await expect(
      adapter.handle(PANEL, "streamBodyChunk", [{ bodyId: "b-1", seq: 1, chunk: base64Of(new Uint8Array([1])) }])
    ).rejects.toThrow(/No open bridge upload stream/);
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
