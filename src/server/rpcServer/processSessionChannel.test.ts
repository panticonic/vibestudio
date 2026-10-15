import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ProcessAdapter } from "@vibestudio/process-adapter";
import { envelopeFromMessage } from "@vibestudio/rpc";
import { encodeRpcJson } from "@vibestudio/rpc";
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
  const channel = new ProcessSessionChannel(proc as ProcessAdapter);
  return { proc, channel };
}

describe("process RPC session retirement", () => {
  it("holds stream delivery until the process pipe write completes and propagates its failure", async () => {
    const { proc, channel } = fixture();
    const envelope = envelopeFromMessage({
      selfId: "extension:test",
      from: "extension:test",
      target: "main",
      callerKind: "extension",
      message: {
        type: "stream-request",
        requestId: "git-pack",
        fromId: "extension:test",
        method: "credentials.proxyGitHttp",
        args: [],
      },
    });
    let deliver!: () => void;
    proc.postMessage.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        deliver = resolve;
      })
    );
    let settled = false;
    const pending = channel
      .sendStreamFrame(envelope, { kind: "chunk", bytes: new Uint8Array([1, 2, 3]) })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    deliver();
    await pending;
    expect(settled).toBe(true);
    const failure = new Error("process pipe closed");
    proc.postMessage.mockRejectedValueOnce(failure);
    await expect(channel.sendStreamFrame(envelope, { kind: "end", bytesIn: 3 })).rejects.toBe(
      failure
    );
    channel.close();
  });

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
        contractVersion: RPC_CONTRACT_VERSION,
      })
    );
    proc.emit("exit", 0);
    expect(channel.readyState).not.toBe(channel.OPEN);
    expect(receive).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("notifies the child over the RPC protocol before retiring its logical session", () => {
    const { proc, channel } = fixture();

    channel.close(1001, "Server shutting down");

    expect(proc.postMessage.mock.calls).toEqual([
      [
        encodeRpcJson({
          type: "ws:session-closed",
          code: 1001,
          reason: "Server shutting down",
        }),
      ],
      [{ type: "shutdown", reason: "Server shutting down" }],
    ]);
    expect(channel.readyState).not.toBe(channel.OPEN);
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
