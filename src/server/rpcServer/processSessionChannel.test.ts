import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ProcessAdapter } from "@vibestudio/process-adapter";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import { ProcessSessionChannel } from "./processSessionChannel.js";

function fixture() {
  const proc = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(() => true),
    stdout: null,
    stderr: null,
    pid: 123,
  });
  const channel = new ProcessSessionChannel(proc as ProcessAdapter, "launch-token");
  return { proc, channel };
}

describe("process RPC session retirement", () => {
  it("retires on IPC disconnect without waiting for guest exit", () => {
    const { proc, channel } = fixture();
    const closed = vi.fn();
    const receive = vi.fn();
    channel.onClose(closed);
    channel.onMessage(receive);
    proc.emit("disconnect");
    proc.emit(
      "message",
      JSON.stringify({
        type: "ws:auth",
        token: "launch-token",
        contractVersion: RPC_CONTRACT_VERSION,
      })
    );
    proc.emit("exit", 0);
    expect(channel.readyState).not.toBe(channel.OPEN);
    expect(receive).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });
  it("retires despite a full delivery buffer and tolerates late send errors", () => {
    const { proc, channel } = fixture();
    const closed = vi.fn();
    channel.onClose(closed);
    proc.postMessage.mockImplementation(() => {
      throw new Error("buffer limit");
    });
    expect(() =>
      channel.sendMessage({
        type: "ws:auth-result",
        success: false,
        contractVersion: RPC_CONTRACT_VERSION,
        error: "denied",
      })
    ).not.toThrow();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(channel.readyState).not.toBe(channel.OPEN);
    expect(() => proc.emit("error", new Error("late send failure"))).not.toThrow();
  });
  it("rejects malformed input before emitting a protocol message", () => {
    const { proc, channel } = fixture();
    const receive = vi.fn();
    channel.onMessage(receive);
    proc.emit("message", "null");
    expect(receive).not.toHaveBeenCalled();
    expect(channel.readyState).not.toBe(channel.OPEN);
  });
});
