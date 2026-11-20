import { decodeRpcJson, encodeRpcJson } from "@vibestudio/rpc/wireJson";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { ProcessAdapter } from "./index.js";
import { NativeOperationPort } from "./operationPort.js";

function fixture() {
  const adapter = Object.assign(new EventEmitter(), { postMessage: vi.fn(), bufferedAmount: 0 });
  const port = new NativeOperationPort(adapter as unknown as ProcessAdapter);
  const sent = (index: number) =>
    decodeRpcJson(adapter.postMessage.mock.calls.at(index)![0]) as { id: string; args?: unknown[] };
  const receive = (value: object) => adapter.emit("message", encodeRpcJson(value));
  return { adapter, port, sent, receive };
}

it("preserves the worker error for all pending and later operations", async () => {
  const { adapter, port } = fixture();
  const first = port.call("mkdir", []);
  const second = port.call("read", []);
  const failure = new Error("Worker IPC failed");
  adapter.emit("error", failure);
  await expect(first).rejects.toBe(failure);
  await expect(second).rejects.toBe(failure);
  await expect(port.call("read", [])).rejects.toBe(failure);
});

it("keeps a slow operation pending until its actual response arrives", async () => {
  vi.useFakeTimers();
  const { port, sent, receive } = fixture();
  const pending = port.call("mkdir", []);
  const frame = sent(0);
  const settled = vi.fn();
  void pending.then(settled, settled);
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).not.toHaveBeenCalled();
    receive({ type: "operation-result", id: frame.id, value: "created" });
    await expect(pending).resolves.toBe("created");
  } finally {
    port.retire();
    vi.useRealTimers();
  }
});

it("accepts only results for outstanding operations and retires on attempted owner dispatch", async () => {
  const { adapter, port, sent, receive } = fixture();
  const request = port.call("read", []);
  const frame = sent(0);
  receive({ type: "operation-result", id: "invented", value: "forged" });
  receive({ type: "operation-result", id: frame.id, value: "native bytes" });
  await expect(request).resolves.toBe("native bytes");
  const pending = port.call("read", []);
  receive({
    type: "operation",
    id: "guest",
    method: "hostTerminal.open",
    args: [],
  });
  await expect(pending).rejects.toThrow(/retired/);
  expect(() => adapter.emit("error", new Error("late send failure"))).not.toThrow();
});

it("retires cancelled request authority before sending cancellation and ignores its late result", async () => {
  const { port, sent, receive } = fixture();
  const controller = new AbortController();
  const pending = port.call("read", [], controller.signal);
  const frame = sent(0);
  controller.abort(new Error("caller retired"));
  await expect(pending).rejects.toThrow("caller retired");
  expect(sent(-1)).toEqual({ type: "cancel-operation", id: frame.id });
  receive({ type: "operation-result", id: frame.id, value: "late bytes" });
  const next = port.call("read", []);
  const nextFrame = sent(-1);
  receive({ type: "operation-result", id: nextFrame.id, value: "current bytes" });
  await expect(next).resolves.toBe("current bytes");
  port.retire();
});

it("bounds both outstanding operations and transport backlog", async () => {
  const { adapter, port } = fixture();
  adapter.bufferedAmount = 33 * 1024 * 1024;
  await expect(port.call("read", [])).rejects.toThrow(/byte limit/);
  adapter.bufferedAmount = 0;
  const operations = Array.from({ length: 128 }, () =>
    port.call("read", []).catch((error) => error)
  );
  await expect(port.call("read", [])).rejects.toThrow(/limit reached/);
  port.retire();
  expect((await Promise.all(operations)).every((error) => error instanceof Error)).toBe(true);
});

it("carries exact byte windows through a JSON-only process adapter", async () => {
  const { port, sent, receive } = fixture();
  const backing = Uint8Array.of(91, 0, 255, 92);
  const call = port.call("write", [backing.subarray(1, 3), new Uint8Array()]);
  const head = sent(0);
  expect(head.args).toEqual([Uint8Array.of(0, 255), new Uint8Array()]);
  receive({
    type: "operation-result",
    id: head.id,
    value: { bytes: Buffer.from(backing).subarray(1, 3) },
  });
  await expect(call).resolves.toEqual({ bytes: Uint8Array.of(0, 255) });
  port.retire();
});

it("does not treat an unencoded control object as a native result", async () => {
  const { adapter, port, sent } = fixture();
  const call = port.call("read", []);
  adapter.emit("message", { type: "operation-result", id: sent(0).id, value: "raw" });
  await expect(call).rejects.toThrow(/retired/);
});
