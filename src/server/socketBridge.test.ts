import { once } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { bridgeDuplexSockets, consumeSocketErrorsUntilClose } from "./socketBridge.js";

describe("bridgeDuplexSockets", () => {
  it.each(["client", "upstream"] as const)(
    "drains the peer's final Close frame after a clean %s EOF before releasing socket ownership",
    async (sourceSide) => {
      const closeFrame = Buffer.from([0x88, 0x02, 0x03, 0xe8]);
      const delivered: Buffer[] = [];
      let completeWrite!: () => void;
      const destination = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          completeWrite = () => {
            completeWrite = () => {};
            if (!this.destroyed) delivered.push(Buffer.from(chunk));
            callback();
          };
        },
      });
      const source = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) { callback(); },
      });
      const closes: string[] = [];
      const dispose = bridgeDuplexSockets(
        sourceSide === "client" ? source : destination,
        sourceSide === "client" ? destination : source,
        { onClose: ({ side }) => closes.push(side) },
      );
      const sourceClosed = once(source, "close");
      const destinationClosed = once(destination, "close");
      try {
        source.push(closeFrame);
        source.push(null);
        source.end();
        await sourceClosed;

        expect(source.readableEnded).toBe(true);
        expect(source.writableFinished).toBe(true);
        expect(destination.writableEnded).toBe(true);
        expect(destination.writableFinished).toBe(false);
        expect(destination.writableLength).toBe(closeFrame.length);
        expect(destination.destroyed).toBe(false);
        expect(destination.listenerCount("error")).toBeGreaterThan(0);
        expect(closes).toEqual([sourceSide]);

        const writeFinished = once(destination, "finish");
        completeWrite();
        await writeFinished;
        expect(delivered).toEqual([closeFrame]);
        expect(destination.destroyed).toBe(false);
        // The final write finishing does not invent the peer's readable EOF.
        // That actual lifecycle event closes its remaining half of the socket.
        destination.push(null);
        await destinationClosed;
        expect(closes).toEqual([sourceSide, sourceSide === "client" ? "upstream" : "client"]);
        expect(destination.listenerCount("error")).toBe(0);
        expect(source.listenerCount("error")).toBe(0);
      } finally {
        source.destroy();
        destination.destroy();
        completeWrite?.();
        await Promise.allSettled([sourceClosed, destinationClosed]);
        dispose();
      }
    },
  );

  it("propagates abrupt destruction after readable EOF when the source still owns an unfinished write", async () => {
    let completeWrite!: () => void;
    const upstream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        completeWrite = () => {
          completeWrite = () => {};
          callback();
        };
      },
    });
    const client = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) { callback(); },
    });
    const dispose = bridgeDuplexSockets(client, upstream);
    const upstreamClosed = once(upstream, "close");
    const clientClosed = once(client, "close");
    try {
      const upstreamEnded = once(upstream, "end");
      client.push(Buffer.from("unfinished request"));
      upstream.push(null);
      await upstreamEnded;
      expect(upstream.readableEnded).toBe(true);
      expect(upstream.writableFinished).toBe(false);
      expect(upstream.writableLength).toBeGreaterThan(0);
      upstream.destroy();
      await Promise.all([upstreamClosed, clientClosed]);
      expect(client.destroyed).toBe(true);
    } finally {
      upstream.destroy();
      client.destroy();
      completeWrite?.();
      await Promise.allSettled([upstreamClosed, clientClosed]);
      dispose();
    }
  });

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
