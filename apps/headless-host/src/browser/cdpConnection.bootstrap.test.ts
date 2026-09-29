import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const sockets: Array<EventEmitter & { terminate: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
vi.mock("ws", () => ({
  WebSocket: class extends EventEmitter {
    terminate = vi.fn();
    send = vi.fn((_data: string, callback: (error?: Error) => void) => callback());
    close = vi.fn();
    constructor() {
      super();
      sockets.push(this);
    }
  },
}));
import { CdpConnection } from "./cdpConnection.js";
describe("CDP bootstrap lifecycle", () => {
  it("rejects a transport close before opening without waiting for a deadline", async () => {
    const connecting = CdpConnection.connect("ws://owned");
    const failed = expect(connecting).rejects.toThrow("CDP connection closed before opening");
    const socket = sockets.at(-1)!;
    socket.emit("close");
    await failed;
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.listenerCount("open")).toBe(0);
  });
  it("retains the native handshake error and removes startup listeners", async () => {
    const connecting = CdpConnection.connect("ws://owned");
    const failure = new Error("native handshake failed");
    const failed = expect(connecting).rejects.toBe(failure);
    const socket = sockets.at(-1)!;
    socket.emit("error", failure);
    await failed;
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("open")).toBe(0);
  });
  it.each([
    ["Inspector.targetCrashed", "CDP_TARGET_CRASHED", true],
    ["Inspector.detached", "CDP_TARGET_DETACHED", true],
    ["Target.detachedFromTarget", "CDP_TARGET_DETACHED", false],
  ] as const)("settles native commands immediately on %s, isolating another session", async (method, code, flatEvent) => {
    const connecting = CdpConnection.connect("ws://owned");
    const socket = sockets.at(-1)!;
    socket.emit("open");
    const connection = await connecting;
    connection.claimSession("lost", "slot-lost");
    const pending = connection.send("Runtime.evaluate", { expression: "pending" }, "lost");
    const rejected = expect(pending).rejects.toMatchObject({ code, sessionId: "lost", operation: "Runtime.evaluate" });
    const other = connection.send("Runtime.evaluate", { expression: "other" }, "other");
    socket.emit("message", JSON.stringify({ method, ...(flatEvent ? { sessionId: "lost" } : {}), params: { sessionId: "lost" } }));
    await rejected;
    socket.emit("message", JSON.stringify({ id: 2, result: { value: "other alive" } }));
    await expect(other).resolves.toEqual({ value: "other alive" });
    connection.close();
  });

  it("releases commands with their session owner and rejects use after transport closure", async () => {
    const connecting = CdpConnection.connect("ws://owned");
    const socket = sockets.at(-1)!;
    socket.emit("open");
    const connection = await connecting;
    connection.claimSession("owned", "slot");
    const pending = connection.send("Runtime.evaluate", {}, "owned");
    const rejected = expect(pending).rejects.toMatchObject({ code: "CDP_SESSION_RELEASED" });
    expect(connection.releaseSlotSessions("slot")).toEqual(["owned"]);
    await rejected;
    const closing = connection.send("Runtime.evaluate", {}, "another");
    const closed = expect(closing).rejects.toMatchObject({ code: "CDP_CONNECTION_CLOSED" });
    connection.close();
    await closed;
    await expect(connection.send("Browser.getVersion")).rejects.toMatchObject({ code: "CDP_CONNECTION_CLOSED" });
    expect(socket.send).toHaveBeenCalledTimes(2);
  });

});
