import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openBridgeStream, type RpcEnvelope } from "@vibestudio/rpc";
import { FRAME_ERROR } from "@vibestudio/rpc/protocol/streamCodec";
import {
  RPC_PORT_GRANT_CHANNEL,
  RPC_PORT_LOST_CHANNEL,
  RPC_PORT_REQUEST_CHANNEL,
  type HostToRenderer,
  type RendererToHost,
} from "../connection/rendererPortProtocol.js";
import { createRpcPortTransport, type RendererPort } from "./rpcPortTransport.js";

vi.mock("electron", () => ({ ipcRenderer: {} }));

function harness(options: { homeWorkspaceId?: string } = {}) {
  const emitter = new EventEmitter();
  const sentToMain: unknown[][] = [];
  const ipc = {
    send: (channel: string, ...args: unknown[]) => sentToMain.push([channel, ...args]),
    on: (channel: string, listener: (event: { ports: RendererPort[] }, ...args: any[]) => void) =>
      emitter.on(channel, listener),
  };
  const transport = createRpcPortTransport({ ipc, ...options });
  const posted: RendererToHost[] = [];
  const port: RendererPort & { deliver(message: HostToRenderer): void } = {
    postMessage: (message) => posted.push(message as RendererToHost),
    close: vi.fn(),
    onmessage: null,
    deliver(message) {
      port.onmessage?.({ data: message });
    },
  };
  return {
    transport,
    posted,
    port,
    sentToMain,
    grant: (grant: unknown = {}, ports: RendererPort[] = [port]) =>
      emitter.emit(RPC_PORT_GRANT_CHANNEL, { ports }, grant),
    lost: (reason: string) => emitter.emit(RPC_PORT_LOST_CHANNEL, {}, reason),
    recovery: (...args: unknown[]) => emitter.emit("vibestudio:rpc:recovery", {}, ...args),
  };
}

const caller = { callerId: "client:chat:web:dev", callerKind: "client" as const };
const requestEnvelope = (id: string, destination = true): RpcEnvelope => ({
  from: "client:chat:web:dev",
  target: "main",
  ...(destination ? { destination: { kind: "workspace" as const, workspaceId: "other" } } : {}),
  delivery: { caller: { ...caller, workspaceId: "system" } },
  provenance: [caller],
  message: { type: "request", requestId: id, fromId: caller.callerId, method: "svc.m", args: [] },
});

describe("rpc port transport", () => {
  it("asks main once for its port and holds sends until it arrives", async () => {
    const h = harness();
    h.transport.open();
    h.transport.open();
    expect(h.sentToMain.filter(([channel]) => channel === RPC_PORT_REQUEST_CHANNEL)).toHaveLength(
      1
    );
    const sent = h.transport.transport.send(requestEnvelope("a"));
    expect(h.posted).toEqual([]);
    h.grant();
    await sent;
    expect(h.posted).toEqual([{ t: "send", envelope: requestEnvelope("a") }]);
  });

  it("delivers the host's messages and stream messages to their subscribers", () => {
    const h = harness();
    h.transport.open();
    h.grant();
    const envelopes: RpcEnvelope[] = [];
    h.transport.transport.onMessage((e) => envelopes.push(e));
    const streamed = vi.fn();
    h.transport.streams.onStreamMessage(streamed);
    h.port.deliver({ t: "message", envelope: requestEnvelope("x") });
    h.port.deliver({ t: "stream-message", message: { kind: "end", opId: "op" } });
    expect(envelopes).toHaveLength(1);
    expect(streamed).toHaveBeenCalledWith({ kind: "end", opId: "op" });
  });

  it("fails a waiting request with the exit reason main reports, answered as the host would", () => {
    const h = harness({ homeWorkspaceId: "system" });
    h.transport.open();
    h.grant();
    const envelopes: RpcEnvelope[] = [];
    h.transport.transport.onMessage((e) => envelopes.push(e));
    void h.transport.transport.send(requestEnvelope("pending"));
    h.lost("The connection process exited unexpectedly (code 9)");
    const [failure] = envelopes;
    expect(failure?.message).toMatchObject({
      type: "response",
      requestId: "pending",
      error: {
        message: "The connection process exited unexpectedly (code 9)",
        errorKind: "transport",
      },
    });
    expect(failure?.destination).toEqual({ kind: "workspace", workspaceId: "system" });
    expect(failure?.delivery.caller).toMatchObject({ callerKind: "server", workspaceId: "other" });
    expect(h.port.close).toHaveBeenCalled();
  });

  it("does not fail a request twice once its answer arrived", () => {
    const h = harness();
    h.transport.open();
    h.grant();
    const envelopes: RpcEnvelope[] = [];
    h.transport.transport.onMessage((e) => envelopes.push(e));
    void h.transport.transport.send(requestEnvelope("done", false));
    h.port.deliver({
      t: "message",
      envelope: {
        ...requestEnvelope("done", false),
        message: { type: "response", requestId: "done", result: 1 },
      },
    });
    h.port.deliver({ t: "closed", reason: "The window was closed" });
    expect(envelopes).toHaveLength(1);
  });

  it("errors open bridge streams and pending replies when the port ends", async () => {
    const h = harness();
    h.transport.open();
    h.grant();
    const messages: unknown[] = [];
    h.transport.streams.onStreamMessage((m) => messages.push(m));
    const opening = h.transport.streams.streamOpen({
      opId: "op-1",
      envelope: requestEnvelope("s", false),
    });
    h.port.deliver({ t: "closed", reason: "Retired" });
    await expect(opening).rejects.toThrow("Retired");
    expect(messages).toContainEqual(expect.objectContaining({ kind: "error", opId: "op-1" }));
  });

  it("answers a stream open with the host's reply and rejects with its failure", async () => {
    const h = harness();
    h.transport.open();
    h.grant();
    const ok = h.transport.streams.streamOpen({ opId: "a", envelope: requestEnvelope("a", false) });
    const bad = h.transport.streams.streamBodyChunk({ bodyId: "b", seq: 0, done: true });
    const [open, body] = h.posted as Extract<RendererToHost, { id: number }>[];
    h.port.deliver({ t: "reply", id: open!.id });
    h.port.deliver({
      t: "reply",
      id: body!.id,
      error: { message: "refused", errorKind: "access" },
    });
    await expect(ok).resolves.toBeUndefined();
    await expect(bad).rejects.toThrow("refused");
  });

  it("fails a send when main refuses the port, and asks afresh for the next one", async () => {
    const h = harness();
    const first = h.transport.transport.send(requestEnvelope("x", false));
    const refused = expect(first).rejects.toThrow("no longer attached");
    h.grant({ error: "The panel or app is no longer attached." }, []);
    await refused;
    // Nothing retries on its own: a later send is what asks again.
    expect(h.sentToMain.filter(([c]) => c === RPC_PORT_REQUEST_CHANNEL)).toHaveLength(1);
    const again = h.transport.transport.send(requestEnvelope("y", false));
    expect(h.sentToMain.filter(([c]) => c === RPC_PORT_REQUEST_CHANNEL)).toHaveLength(2);
    h.grant();
    await again;
    expect(h.posted).toEqual([{ t: "send", envelope: requestEnvelope("y", false) }]);
  });

  it("works with the bridge stream opener", async () => {
    const h = harness();
    h.transport.open();
    h.grant();
    const response = openBridgeStream(
      h.transport.streams,
      requestEnvelope("fetch", false),
      null,
      null
    );
    const [open] = h.posted as Extract<RendererToHost, { t: "stream-open" }>[];
    h.port.deliver({ t: "reply", id: open!.id });
    h.port.deliver({
      t: "stream-message",
      message: {
        kind: "head",
        opId: open!.message.opId,
        status: 200,
        statusText: "OK",
        headers: [],
      },
    });
    h.port.deliver({ t: "stream-message", message: { kind: "end", opId: open!.message.opId } });
    expect(await (await response).text()).toBe("");
    expect(FRAME_ERROR).toBeDefined();
  });
});

describe("recovery", () => {
  it("settles pending and later recovery with the renderer's original bootstrap failure", async () => {
    const h = harness();
    h.recovery("resubscribe", "project", "pending");
    h.transport.transport.observeBoot({
      phase: "failed",
      message: "Bundle could not be loaded",
      failureStage: "bundle-load",
    });
    await vi.waitFor(() =>
      expect(h.sentToMain).toContainEqual([
        "vibestudio:rpc:recovered",
        "pending",
        { message: "Bundle could not be loaded" },
      ])
    );
    h.recovery("resubscribe", "project", "later");
    await vi.waitFor(() =>
      expect(h.sentToMain).toContainEqual([
        "vibestudio:rpc:recovered",
        "later",
        { message: "Bundle could not be loaded" },
      ])
    );
  });

  it("acknowledges only after every renderer recovery handler has settled", async () => {
    const h = harness();
    let finish!: () => void;
    h.transport.transport.onRecovery(
      "resubscribe",
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    h.transport.transport.onRecovery("resubscribe", async () => {
      throw Object.assign(new Error("Replay failed"), { code: "CONNECTION_LOST" });
    });
    h.recovery("resubscribe", "project", "request");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sentToMain).toEqual([]);
    finish();
    await vi.waitFor(() =>
      expect(h.sentToMain).toContainEqual([
        "vibestudio:rpc:recovered",
        "request",
        { message: "Replay failed", code: "CONNECTION_LOST" },
      ])
    );
  });

  it("waits for runtime registration, including a replacement registration", async () => {
    const h = harness();
    h.recovery("cold-recover", "project", "first");
    await Promise.resolve();
    expect(h.sentToMain).toEqual([]);
    const handler = vi.fn();
    const stop = h.transport.transport.onRecovery("cold-recover", handler);
    await vi.waitFor(() =>
      expect(h.sentToMain).toContainEqual(["vibestudio:rpc:recovered", "first"])
    );
    stop();
    h.sentToMain.length = 0;
    h.recovery("cold-recover", "project", "second");
    await Promise.resolve();
    expect(h.sentToMain).toEqual([]);
    h.transport.transport.onRecovery("cold-recover", handler);
    await vi.waitFor(() =>
      expect(h.sentToMain).toContainEqual(["vibestudio:rpc:recovered", "second"])
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("recovers on a fresh port when the document's port ended", async () => {
    const h = harness();
    h.transport.open();
    h.grant();
    h.lost("The connection process exited unexpectedly (code 1)");
    const handler = vi.fn();
    h.transport.transport.onRecovery("cold-recover", handler);
    h.recovery("cold-recover", "project", "again");
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    h.grant();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith("project"));
  });
});
