import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { bridgeDuplexSockets, consumeSocketErrorsUntilClose } from "./socketBridge.js";

describe("bridgeDuplexSockets", () => {
  it("owns late raw-socket errors until the socket closes", async () => {
    const socket = new PassThrough();
    const release = consumeSocketErrorsUntilClose(socket);

    expect(() => socket.emit("error", Object.assign(new Error("read ECONNRESET")))).not.toThrow();
    expect(socket.listenerCount("error")).toBe(1);

    socket.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.listenerCount("error")).toBe(0);
    release();
  });

  it("consumes post-bridge upstream socket errors and tears down the client", () => {
    const clientSocket = new PassThrough();
    const upstreamSocket = new PassThrough();
    const errors: Array<{ side: string; error: unknown }> = [];
    bridgeDuplexSockets(clientSocket, upstreamSocket, {
      onError: (event) => errors.push(event),
    });

    const tlsError = Object.assign(new Error("SSLV3_ALERT_BAD_RECORD_MAC"), {
      code: "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC",
    });

    expect(() => upstreamSocket.emit("error", tlsError)).not.toThrow();
    expect(clientSocket.destroyed).toBe(true);
    expect(errors).toEqual([{ side: "upstream", error: tlsError }]);

    upstreamSocket.destroy();
    clientSocket.destroy();
  });

  it("tears down the upstream socket when the client closes", async () => {
    const clientSocket = new PassThrough();
    const upstreamSocket = new PassThrough();
    bridgeDuplexSockets(clientSocket, upstreamSocket);

    clientSocket.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(upstreamSocket.destroyed).toBe(true);
  });
});
