import { describe, expect, it } from "vitest";
import { serializeRpcFailure } from "@vibestudio/rpc";
import { DeviceDriverRelay, type DeviceDriverEvents } from "./deviceDriverRelay.js";

function fixture() {
  const live = new Set<string>();
  const sent: Array<{ callerId: string; event: string; payload: unknown }> = [];
  const closers = new Map<string, () => void>();
  const events: DeviceDriverEvents = {
    emitToCaller(callerId, event, payload) {
      sent.push({ callerId, event, payload });
      return live.has(callerId);
    },
    requestCaller(callerId, event, payload, onClosed) {
      if (!live.has(callerId)) return null;
      sent.push({ callerId, event, payload });
      closers.set(callerId, onClosed);
      return () => closers.delete(callerId);
    },
    hasLiveCaller: (callerId) => live.has(callerId),
  };
  const relay = new DeviceDriverRelay(events);
  const connect = (runtimeId: string, kind: "terminal" | "desktop" = "terminal", userId = "u1") => {
    live.add(runtimeId);
    relay.register({ runtimeId, userId, kind });
  };
  const disconnect = (runtimeId: string) => {
    live.delete(runtimeId);
    closers.get(runtimeId)?.();
  };
  return { relay, sent, connect, disconnect };
}

const callIdOf = (sent: Array<{ payload: unknown }>) =>
  (sent.at(-1)!.payload as { callId: string }).callId;

describe("DeviceDriverRelay", () => {
  it("settles a drive with the driver's answer and addresses only that driver", async () => {
    const f = fixture();
    f.connect("shell:t");
    const call = f.relay.drive("u1", { deviceKind: "terminal", op: "list", args: [{}] });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      callerId: "shell:t",
      event: "development:device-drive-request",
      payload: { op: "list", args: [{}] },
    });
    f.relay.answer("shell:t", "u1", callIdOf(f.sent), { ok: true, value: [1] });
    await expect(call).resolves.toEqual([1]);
  });

  it("carries the driver's complete failure to the caller", async () => {
    const f = fixture();
    f.connect("shell:t");
    const call = f.relay.drive("u1", { deviceKind: "terminal", op: "launch" });
    f.relay.answer("shell:t", "u1", callIdOf(f.sent), {
      ok: false,
      failure: serializeRpcFailure(Object.assign(new Error("no such client"), { code: "ENOENT" })),
    });
    await expect(call).rejects.toMatchObject({ message: "no such client", code: "ENOENT" });
  });

  it("rejects when the driver disconnects while the call is pending", async () => {
    const f = fixture();
    f.connect("shell:t");
    const call = f.relay.drive("u1", { deviceKind: "terminal", op: "waitForText" });
    f.disconnect("shell:t");
    await expect(call).rejects.toMatchObject({ code: "EDEVICE_GONE" });
    expect(f.relay.list("u1")).toEqual([]);
  });

  it("tells the driver when the caller cancels, and rejects with the caller's reason", async () => {
    const f = fixture();
    f.connect("shell:t");
    const abort = new AbortController();
    const call = f.relay.drive("u1", { deviceKind: "terminal", op: "waitForText" }, abort.signal);
    const callId = callIdOf(f.sent);
    abort.abort(new Error("test over"));
    await expect(call).rejects.toThrow("test over");
    expect(f.sent.at(-1)).toMatchObject({
      event: "development:device-drive-cancel",
      payload: { callId },
    });
    expect(() => f.relay.answer("shell:t", "u1", callId, { ok: true })).toThrow(/Unknown/u);
  });

  it("refuses without a connected driver of the kind, or with more than one", async () => {
    const f = fixture();
    await expect(f.relay.drive("u1", { deviceKind: "desktop", op: "list" })).rejects.toMatchObject({
      code: "EDEVICE_UNAVAILABLE",
    });
    f.connect("shell:a", "desktop");
    f.connect("shell:b", "desktop");
    await expect(f.relay.drive("u1", { deviceKind: "desktop", op: "list" })).rejects.toMatchObject({
      code: "EDEVICE_AMBIGUOUS",
    });
    await expect(f.relay.drive("u2", { deviceKind: "desktop", op: "list" })).rejects.toMatchObject({
      code: "EDEVICE_UNAVAILABLE",
    });
  });

  it("accepts an answer only from the addressed driver of the same user", async () => {
    const f = fixture();
    f.connect("shell:t");
    f.connect("shell:other", "terminal", "u2");
    const call = f.relay.drive("u1", { deviceKind: "terminal", op: "list" });
    const callId = callIdOf(f.sent);
    expect(() => f.relay.answer("shell:other", "u2", callId, { ok: true })).toThrow(/Unknown/u);
    f.relay.answer("shell:t", "u1", callId, { ok: true, value: "ok" });
    await expect(call).resolves.toBe("ok");
  });
});
