import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { bridgeDuplexSockets } from "./socketBridge.js";

describe("bridgeDuplexSockets", () => {
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
