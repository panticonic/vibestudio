import { describe, expect, it } from "vitest";
import { FRAME_DATA, FRAME_END } from "@vibestudio/rpc/protocol/streamCodec";
import {
  decodeControlFrame,
  type SessionControlFrame,
} from "@vibestudio/rpc/protocol/sessionNegotiation";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import { SessionWebSocketShim, type PipeChannels } from "./webrtcSessionShim.js";

interface BulkWrite {
  streamId: number;
  type: number;
  payload: Uint8Array;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Let promise callbacks (metering settle handlers) run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  /** Interleaved op log so tests can assert exact ordering across channels. */
  const ops: string[] = [];
  const control: Array<{ frame: SessionControlFrame; lane: string | undefined }> = [];
  // Bulk writes settle ONLY when the test resolves them — the promise is the
  // backpressure signal the shim must meter.
  const bulk: BulkWrite[] = [];
  const dropped: number[] = [];
  const pipe: PipeChannels = {
    writeControl: (data, lane) => {
      control.push({ frame: decodeControlFrame(new TextDecoder().decode(data)), lane });
      ops.push("control");
      return Promise.resolve();
    },
    writeBulkFrame: (streamId, type, payload) => {
      ops.push(`bulk:${type}`);
      return new Promise<void>((resolve, reject) => {
        bulk.push({ streamId, type, payload, resolve, reject });
      });
    },
    dropBulkStream: (streamId) => {
      ops.push("drop");
      dropped.push(streamId);
    },
    bulkPendingBytes: () => 0,
    controlBufferedAmount: () => 0,
  };
  const closedSids: string[] = [];
  const shim = new SessionWebSocketShim("s1", pipe, (sid) => closedSids.push(sid));
  return { shim, ops, control, bulk, dropped, closedSids };
}

describe("SessionWebSocketShim — ws:* <-> session-frame translation", () => {
  it("delivers an inbound ws:auth to the message handler as a Buffer", () => {
    const h = harness();
    const got: string[] = [];
    h.shim.on("message", (data) => got.push((data as Buffer).toString()));
    const auth: WsClientMessage = {
      type: "ws:auth",
      contractVersion: 1,
      token: "grant",
      connectionId: "c1",
    };
    h.shim.deliverInbound(auth);
    expect(JSON.parse(got[0]!)).toMatchObject({
      type: "ws:auth",
      token: "grant",
      connectionId: "c1",
    });
  });

  it("translates a successful ws:auth-result into an open-result control frame", () => {
    const h = harness();
    const result: WsServerMessage = {
      type: "ws:auth-result",
      success: true,
      contractVersion: 1,
      callerId: "panel:c1",
      callerKind: "panel",
      connectionId: "c1",
      serverBootId: "boot-1",
      sessionDirty: false,
    };
    h.shim.send(JSON.stringify(result));
    expect(h.control[0]!.frame).toMatchObject({
      t: "open-result",
      sid: "s1",
      success: true,
      callerId: "panel:c1",
      serverBootId: "boot-1",
    });
  });

  it("marks a failed ws:auth-result terminal (no client auto-reopen)", () => {
    const h = harness();
    h.shim.send(
      JSON.stringify({
        type: "ws:auth-result",
        success: false,
        error: "Panel runtime is leased by Desktop",
      } satisfies WsServerMessage)
    );
    expect(h.control[0]!.frame).toMatchObject({
      t: "open-result",
      success: false,
      terminal: true,
      error: /leased/ as unknown as string,
    });
  });

  it("translates ws:routed / ws:event / routed-response-error frames", () => {
    const h = harness();
    const env = {
      from: "main",
      target: "panel:c1",
      delivery: { caller: { callerId: "main", callerKind: "server" as const } },
      provenance: [],
      message: { type: "response" as const, requestId: "r1", result: 1 },
    };
    h.shim.send(JSON.stringify({ type: "ws:routed", envelope: env } satisfies WsServerMessage));
    h.shim.send(
      JSON.stringify({ type: "ws:event", event: "x", payload: 7 } satisfies WsServerMessage)
    );
    h.shim.send(
      JSON.stringify({
        type: "ws:routed-response-error",
        targetId: "do:x",
        requestId: "r2",
        error: "gone",
        errorKind: "transport",
        errorCode: "TARGET_NOT_REACHABLE",
      } satisfies WsServerMessage)
    );
    expect(h.control.map((w) => w.frame.t)).toEqual(["routed", "event", "routed-response-error"]);
  });

  it("passes lane = sid on every control write (per-session scheduler fairness)", () => {
    const h = harness();
    h.shim.send(
      JSON.stringify({ type: "ws:event", event: "x", payload: 7 } satisfies WsServerMessage)
    );
    h.shim.close(4091, "lease revoked");
    expect(h.control.length).toBeGreaterThanOrEqual(2);
    for (const write of h.control) expect(write.lane).toBe("s1");
  });

  it("a non-streaming ws:rpc bridge call becomes an rpc control frame", () => {
    const h = harness();
    const env = {
      from: "main",
      target: "panel:c1",
      delivery: { caller: { callerId: "main", callerKind: "server" as const } },
      provenance: [],
      message: {
        type: "request" as const,
        requestId: "bridge-1",
        fromId: "main",
        method: "panel.ping",
        args: [],
      },
    };
    h.shim.send(JSON.stringify({ type: "ws:rpc", envelope: env } as WsServerMessage));
    expect(h.control[0]!.frame).toMatchObject({ t: "rpc", sid: "s1" });
  });

  it("close() writes a terminal closed-frame for lease-revoke codes and fires close handlers", () => {
    const h = harness();
    const closeArgs: unknown[][] = [];
    h.shim.on("close", (...args) => closeArgs.push(args));
    h.shim.close(4091, "lease revoked");
    expect(h.control[0]!.frame).toMatchObject({
      t: "closed",
      sid: "s1",
      code: 4091,
      terminal: true,
    });
    expect(closeArgs[0]![0]).toBe(4091);
    expect(h.closedSids).toEqual(["s1"]);
    // After close, the shim is no longer OPEN and drops further sends.
    expect(h.shim.readyState).toBe(3);
    h.shim.send(
      JSON.stringify({ type: "ws:event", event: "late", payload: 1 } satisfies WsServerMessage)
    );
    expect(h.control).toHaveLength(1);
  });

  it("remoteClosed() (client/pipe drop) fires close handlers without writing a frame", () => {
    const h = harness();
    const fired: unknown[][] = [];
    h.shim.on("close", (...a) => fired.push(a));
    h.shim.remoteClosed(1006, "pipe lost");
    expect(fired).toHaveLength(1);
    expect(h.control).toHaveLength(0); // no outbound frame — the client already knows
    expect(h.closedSids).toEqual(["s1"]);
  });

  it("off() removes the onFirstMessage-style handler (matches rpcServer's ws.off)", () => {
    const h = harness();
    const got: number[] = [];
    const handler = (): void => void got.push(1);
    h.shim.on("message", handler);
    h.shim.off("message", handler);
    h.shim.deliverInbound({ type: "ws:auth", contractVersion: 1, token: "t" });
    expect(got).toHaveLength(0);
  });
});

describe("SessionWebSocketShim — bulk stream surface", () => {
  it("meters bulk bytes into bufferedAmount until each write promise settles", async () => {
    const h = harness();
    h.shim.registerStream("req-1", 77);
    const bytes = new Uint8Array(10);
    expect(h.shim.sendStreamFrame("req-1", FRAME_DATA, bytes)).not.toBe(false);
    expect(h.shim.bufferedAmount).toBe(10);
    expect(h.shim.sendStreamFrame("req-1", FRAME_DATA, bytes)).not.toBe(false);
    expect(h.shim.bufferedAmount).toBe(20);
    h.bulk[0]!.resolve();
    await flush();
    expect(h.shim.bufferedAmount).toBe(10);
    h.bulk[1]!.resolve();
    await flush();
    expect(h.shim.bufferedAmount).toBe(0);
  });

  it("un-meters bulk bytes when the write REJECTS (pipe down mid-stream)", async () => {
    const h = harness();
    h.shim.registerStream("req-1", 77);
    const written = h.shim.sendStreamFrame("req-1", FRAME_DATA, new Uint8Array(8));
    expect(written).not.toBe(false);
    expect(h.shim.bufferedAmount).toBe(8);
    h.bulk[0]!.reject(new Error("pipe down"));
    await expect(written as Promise<void>).rejects.toThrow("pipe down");
    await flush();
    expect(h.shim.bufferedAmount).toBe(0);
  });

  it("sendStreamFrame writes RAW bytes for a registered request and returns the metered promise", async () => {
    const h = harness();
    h.shim.registerStream("req-1", 77);
    const bytes = new TextEncoder().encode("raw-body");
    const written = h.shim.sendStreamFrame("req-1", FRAME_DATA, bytes);
    expect(written).not.toBe(false);
    expect(h.bulk[0]).toMatchObject({ streamId: 77, type: FRAME_DATA });
    expect(h.bulk[0]!.payload).toBe(bytes); // no copy, no base64
    expect(h.shim.bufferedAmount).toBe(bytes.byteLength);
    h.bulk[0]!.resolve();
    await (written as Promise<void>);
    await flush();
    expect(h.shim.bufferedAmount).toBe(0);
  });

  it("sendStreamFrame returns false for an unregistered requestId and after END reaps the maps", () => {
    const h = harness();
    expect(h.shim.sendStreamFrame("nope", FRAME_DATA, new Uint8Array(1))).toBe(false);
    h.shim.registerStream("req-1", 77);
    const end = h.shim.sendStreamFrame(
      "req-1",
      FRAME_END,
      new TextEncoder().encode(JSON.stringify({ bytesIn: 3 }))
    );
    expect(end).not.toBe(false);
    // END reaped the id maps — a late frame for the same request is refused.
    expect(h.shim.sendStreamFrame("req-1", FRAME_DATA, new Uint8Array(1))).toBe(false);
    expect(h.bulk).toHaveLength(1);
  });

  it("sendStreamFrame returns false once the session is closed", () => {
    const h = harness();
    h.shim.registerStream("req-1", 77);
    h.shim.remoteClosed(1006, "gone");
    expect(h.shim.sendStreamFrame("req-1", FRAME_DATA, new Uint8Array(1))).toBe(false);
  });

  it("cancelStream(): dropBulkStream → maps reaped → inward cancel, in that order; NO settle frame", () => {
    const h = harness();
    const inbound: WsClientMessage[] = [];
    let reapedBeforeInwardCancel = false;
    h.shim.on("message", (data) => {
      // Runs during the inward delivery — the maps must ALREADY be reaped so
      // late producer frames can't resurrect the stream.
      reapedBeforeInwardCancel =
        h.shim.sendStreamFrame("req-1", FRAME_DATA, new Uint8Array(1)) === false;
      h.ops.push("inward");
      inbound.push(JSON.parse((data as Buffer).toString()));
    });
    h.shim.registerStream("req-1", 77);
    h.shim.cancelStream(77);

    // NO ERROR frame back to the client: it settled its stream locally on
    // abort before sending stream-cancel, and a queued ERROR would be discarded
    // by the immediately-following dropBulkStream anyway (frameScheduler.dropKey
    // drops everything queued under this streamId).
    expect(h.bulk).toHaveLength(0);
    // 1. the queued backlog is dropped, 2./3. maps reaped before the
    // inward stream-cancel reaches the server.
    expect(h.ops).toEqual(["drop", "inward"]);
    expect(h.dropped).toEqual([77]);
    expect(reapedBeforeInwardCancel).toBe(true);
    expect(inbound[0]).toMatchObject({
      type: "ws:rpc",
      envelope: { message: { type: "stream-cancel", requestId: "req-1" } },
    });

    // Cancelling again is a no-op (mapping already reaped).
    h.shim.cancelStream(77);
    expect(inbound).toHaveLength(1);
    expect(h.bulk).toHaveLength(0); // the in-handler sendStreamFrame probe wrote nothing
  });
});

describe("SessionWebSocketShim — inbound request bodies (§1.6)", () => {
  function bodyWithDrop(): { body: ReadableStream<Uint8Array>; drops: number; drop: () => void } {
    const state = { body: new ReadableStream<Uint8Array>(), drops: 0, drop: () => {} };
    state.drop = () => {
      state.drops++;
    };
    return state;
  }

  it("takeInboundBody hands the body out exactly once", () => {
    const { shim } = harness();
    const { body, drop } = bodyWithDrop();
    shim.registerInboundBody("req-1", body, drop);
    expect(shim.takeInboundBody("req-1")).toBe(body);
    expect(shim.takeInboundBody("req-1")).toBeUndefined();
    expect(shim.takeInboundBody("unknown")).toBeUndefined();
  });

  it("re-registering a requestId drops the OLD body loudly (client id re-use bug)", () => {
    const { shim } = harness();
    const first = bodyWithDrop();
    const second = bodyWithDrop();
    shim.registerInboundBody("req-1", first.body, first.drop);
    shim.registerInboundBody("req-1", second.body, second.drop);
    expect(first.drops).toBe(1);
    expect(shim.takeInboundBody("req-1")).toBe(second.body);
  });

  it("reaps the body when the stream's END frame is emitted (drop fires once)", async () => {
    const { shim, bulk } = harness();
    const { body, ...state } = bodyWithDrop();
    void body;
    shim.registerStream("req-1", 7);
    shim.registerInboundBody("req-1", bodyWithDrop().body, () => {
      state.drops++;
    });
    const written = shim.sendStreamFrame("req-1", FRAME_END, new Uint8Array(0));
    expect(written).not.toBe(false);
    bulk[0]!.resolve();
    await flush();
    expect(state.drops).toBe(1);
    // Already reaped — a second reap path must not double-fire.
    shim.cancelStream(7);
    expect(state.drops).toBe(1);
  });

  it("cancelStream drops the body along with the stream maps", () => {
    const { shim } = harness();
    const state = { drops: 0 };
    shim.registerStream("req-1", 7);
    shim.registerInboundBody("req-1", new ReadableStream<Uint8Array>(), () => {
      state.drops++;
    });
    shim.cancelStream(7);
    expect(state.drops).toBe(1);
  });

  it("session close drops every registered body", () => {
    const { shim } = harness();
    const state = { drops: 0 };
    shim.registerInboundBody("req-1", new ReadableStream<Uint8Array>(), () => state.drops++);
    shim.registerInboundBody("req-2", new ReadableStream<Uint8Array>(), () => state.drops++);
    shim.remoteClosed(1006, "pipe down");
    expect(state.drops).toBe(2);
  });
});
