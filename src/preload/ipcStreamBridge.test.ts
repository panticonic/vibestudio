import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcRenderer } from "electron";
import {
  openBridgeStream,
  type BridgeStreamMessage,
  type BridgeStreamOpen,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import { createIpcStreamBridge } from "./ipcStreamBridge.js";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcRenderer: Object.assign(new EventEmitter(), {
      invoke: vi.fn(async () => undefined),
      send: vi.fn(),
    }),
  };
});

const channel = "vibestudio:rpc:stream-message";
const envelope: RpcEnvelope = {
  from: "shell",
  target: "main",
  delivery: { caller: { callerId: "shell", callerKind: "shell" } },
  provenance: [{ callerId: "shell", callerKind: "shell" }],
  message: {
    type: "stream-request",
    requestId: "request",
    fromId: "shell",
    method: "gateway.fetch",
    args: [],
  },
};
const emit = (message: BridgeStreamMessage) => ipcRenderer.emit(channel, {}, message);
const opened = () =>
  vi
    .mocked(ipcRenderer.invoke)
    .mock.calls.filter(([name]) => name === "vibestudio:rpc:stream-open")
    .map(([, message]) => message as BridgeStreamOpen);

// Each test must release its actual stream subscriptions, not hide leaked listeners.
afterEach(() => {
  expect(ipcRenderer.listenerCount(channel)).toBe(0);
  vi.clearAllMocks();
});

describe("preload IPC stream subscriptions", () => {
  it("shares one native listener across concurrent streams and isolates bytes and terminal cleanup", async () => {
    const surface = createIpcStreamBridge();
    const requests = Array.from({ length: 24 }, () =>
      openBridgeStream(surface, envelope, null, null)
    );
    expect(ipcRenderer.listenerCount(channel)).toBe(1);
    const operations = opened();
    expect(new Set(operations.map(({ opId }) => opId)).size).toBe(24);
    for (const { opId } of operations)
      emit({ kind: "head", opId, status: 200, statusText: "OK", headers: [] });
    const responses = await Promise.all(requests);
    // A foreign operation cannot write or end any of these response bodies.
    emit({ kind: "chunk", opId: "foreign", seq: 1, chunk: new Uint8Array([255]) });
    emit({ kind: "end", opId: "foreign" });
    for (let index = 0; index < operations.length; index++) {
      const { opId } = operations[index]!;
      const response = responses[index]!;
      if (index % 3 === 0) {
        emit({ kind: "chunk", opId, seq: 1, chunk: new Uint8Array([index]) });
        emit({ kind: "end", opId });
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([index]));
        expect(ipcRenderer.send).toHaveBeenCalledWith("vibestudio:rpc:stream-ack", {
          opId,
          seq: 1,
        });
      } else if (index % 3 === 1) {
        const reading = response.text();
        emit({ kind: "error", opId, message: `failure-${index}` });
        await expect(reading).rejects.toThrow(`failure-${index}`);
      } else {
        await response.body!.cancel();
        expect(ipcRenderer.send).toHaveBeenCalledWith("vibestudio:rpc:stream-abort", opId);
      }
      expect(ipcRenderer.listenerCount(channel)).toBe(index === operations.length - 1 ? 0 : 1);
    }
  });

  it("releases an aborted head waiter without interrupting another stream and can attach again", async () => {
    const surface = createIpcStreamBridge();
    const abort = new AbortController();
    const abandoned = openBridgeStream(surface, envelope, abort.signal, null);
    const surviving = openBridgeStream(surface, envelope, null, null);
    const [first, second] = opened();
    // Let streamOpen settle before the abort rejects the awaited response head.
    await Promise.resolve();
    abort.abort();
    await expect(abandoned).rejects.toThrow("aborted");
    expect(ipcRenderer.send).toHaveBeenCalledWith("vibestudio:rpc:stream-abort", first!.opId);
    expect(ipcRenderer.listenerCount(channel)).toBe(1);
    emit({ kind: "head", opId: second!.opId, status: 200, statusText: "OK", headers: [] });
    emit({ kind: "end", opId: second!.opId });
    expect(await (await surviving).text()).toBe("");
    expect(ipcRenderer.listenerCount(channel)).toBe(0);
    const release = surface.onStreamMessage(vi.fn());
    expect(ipcRenderer.listenerCount(channel)).toBe(1);
    release();
    release();
  });

  it("owns duplicate callback subscriptions separately during terminal dispatch", () => {
    const surface = createIpcStreamBridge();
    const handler = vi.fn();
    const first = surface.onStreamMessage(handler);
    const second = surface.onStreamMessage(handler);
    first();
    first();
    emit({ kind: "end", opId: "one" });
    expect(handler).toHaveBeenCalledTimes(1);
    second();
    const selfReleasing = surface.onStreamMessage(() => selfReleasing());
    const other = surface.onStreamMessage(handler);
    emit({ kind: "end", opId: "two" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(ipcRenderer.listenerCount(channel)).toBe(1);
    other();
  });
});
