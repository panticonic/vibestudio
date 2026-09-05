import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { ProcessAdapter } from "./index.js";
import { NativeOperationPort } from "./operationPort.js";

function fixture() {
  const adapter = Object.assign(new EventEmitter(), { postMessage: vi.fn(), bufferedAmount: 0 });
  const port = new NativeOperationPort(adapter as unknown as ProcessAdapter);
  return { adapter, port };
}

it("accepts only results for outstanding operations and retires on attempted owner dispatch", async () => {
  const { adapter, port } = fixture();
  const request = port.call("read", []);
  const frame = adapter.postMessage.mock.calls[0]![0];
  adapter.emit("message", { type: "operation-result", id: "invented", value: "forged" });
  adapter.emit("message", { type: "operation-result", id: frame.id, value: "native bytes" });
  await expect(request).resolves.toBe("native bytes");
  const pending = port.call("read", []);
  adapter.emit("message", {
    type: "operation",
    id: "guest",
    method: "hostTerminal.open",
    args: [],
  });
  await expect(pending).rejects.toThrow(/retired/);
  expect(() => adapter.emit("error", new Error("late send failure"))).not.toThrow();
});

it("retires cancelled request authority before sending cancellation and ignores its late result", async () => {
  const { adapter, port } = fixture();
  const controller = new AbortController();
  const pending = port.call("read", [], controller.signal);
  const frame = adapter.postMessage.mock.calls[0]![0];
  controller.abort(new Error("caller retired"));
  await expect(pending).rejects.toThrow("caller retired");
  expect(adapter.postMessage).toHaveBeenLastCalledWith({ type: "cancel-operation", id: frame.id });
  adapter.emit("message", { type: "operation-result", id: frame.id, value: "late bytes" });
  const next = port.call("read", []);
  const nextFrame = adapter.postMessage.mock.calls.at(-1)![0];
  adapter.emit("message", { type: "operation-result", id: nextFrame.id, value: "current bytes" });
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
