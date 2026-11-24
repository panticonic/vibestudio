import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RELAY_ORIGIN,
  createRelayBackhaulClient,
  buildBackhaulUrl,
  getRelayOrigin,
  ensureRelayBackhaulIdentity,
  loadRelayBackhaulIdentity,
} from "./relayBackhaulClient.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function identityFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibestudio-relay-identity-"));
  tempDirs.push(dir);
  const file = join(dir, "identity.pem");
  ensureRelayBackhaulIdentity(file);
  return file;
}

describe("relay backhaul bootstrap", () => {
  it("uses the Vibestudio apex unless a relay deployment override is supplied", () => {
    expect(getRelayOrigin({})).toBe(DEFAULT_RELAY_ORIGIN);
    expect(getRelayOrigin({ VIBESTUDIO_RELAY_URL: "https://relay.test///" })).toBe(
      "https://relay.test"
    );
  });

  it("builds a verifiable proof from the persistent workspace identity", () => {
    const first = loadRelayBackhaulIdentity(identityFile());
    const now = Date.now();
    const url = new URL(buildBackhaulUrl(DEFAULT_RELAY_ORIGIN, first, now));
    const publicKeyDer = Buffer.from(url.searchParams.get("key")!, "base64url");
    const timestamp = url.searchParams.get("ts")!;

    expect(url.origin).toBe("wss://vibestudio.app");
    expect(url.pathname).toBe("/backhaul");
    expect(url.searchParams.get("relayId")).toBe(first.relayId);
    expect(first.relayId).toBe(`rly_${createHash("sha256").update(publicKeyDer).digest("hex")}`);
    expect(
      verify(
        "sha256",
        Buffer.from(`${first.relayId}\n${timestamp}`),
        {
          key: createPublicKey({ key: publicKeyDer, type: "spki", format: "der" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(url.searchParams.get("sig")!, "base64url")
      )
    ).toBe(true);
  });

  it("derives the same relay id whenever the persistent identity is reloaded", () => {
    const file = identityFile();
    expect(loadRelayBackhaulIdentity(file).relayId).toBe(loadRelayBackhaulIdentity(file).relayId);
  });
});

describe("relay backhaul socket lifetime", () => {
  it("survives actual ws termination of a pending upgrade and reconnects", async () => {
    const server = createServer();
    const upgrades = new WebSocketServer({ noServer: true });
    const sockets = new Set<Socket>();
    let attempts = 0;
    let connected!: () => void;
    const ready = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const errors: string[] = [];
    server.on("upgrade", (request, socket, head) => {
      const owned = socket as Socket;
      sockets.add(owned);
      owned.on("error", () => undefined);
      owned.once("close", () => sockets.delete(owned));
      // The first peer accepts TCP but never acknowledges the WebSocket upgrade.
      // This exercises ws's real asynchronous error after terminate(CONNECTING).
      if (++attempts === 1) return;
      upgrades.handleUpgrade(request, socket, head, (ws) => {
        upgrades.emit("connection", ws, request);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No owned HTTP listener");
    const client = createRelayBackhaulClient({
      relayOrigin: `http://127.0.0.1:${address.port}`,
      identity: loadRelayBackhaulIdentity(identityFile()),
      handshakeTimeoutMs: 100,
      minBackoffMs: 5,
      maxBackoffMs: 5,
      onWebhook: async () => ({ ok: true }),
      onOAuthCallback: async () => undefined,
      logger: {
        info: (message) => {
          if (message === "backhaul connected") connected();
        },
        warn: () => undefined,
        error: (message) => {
          errors.push(message);
        },
      },
    });
    try {
      client.start();
      await ready;
      expect(attempts).toBe(2);
      expect(errors).toContain("backhaul handshake timed out");
      expect(errors).toContain("backhaul socket error");
      expect(client.connected).toBe(true);
      await client.stop();
      expect(client.connected).toBe(false);
    } finally {
      await client.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => upgrades.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("joins socket close and refuses retired socket messages during stop", async () => {
    const sockets: DelayedCloseSocket[] = [];
    class DelayedCloseSocket extends EventEmitter {
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = DelayedCloseSocket.CONNECTING;
      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => {
          this.readyState = DelayedCloseSocket.OPEN;
          this.emit("open");
        });
      }
      send() {}
      close() {
        this.readyState = 2;
      }
      terminate() {
        this.close();
      }
      finishClose() {
        this.readyState = 3;
        this.emit("close", 1000, Buffer.from("closed"));
      }
    }
    const onOAuthCallback = vi.fn(async () => undefined);
    const client = createRelayBackhaulClient({
      relayOrigin: "https://owned.test",
      identity: loadRelayBackhaulIdentity(identityFile()),
      WebSocketCtor: DelayedCloseSocket as unknown as typeof WebSocket,
      onWebhook: async () => ({ ok: true }),
      onOAuthCallback,
      logger: { info() {}, warn() {}, error() {} },
    });
    client.start();
    await Promise.resolve();
    const socket = sockets[0]!;
    let stopped = false;
    const stopping = client.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      socket.emit("error", new Error("late terminal transport error"));
      socket.emit("message", JSON.stringify({ t: "oauth-callback", transactionId: "retired" }));
      expect(onOAuthCallback).not.toHaveBeenCalled();
    } finally {
      socket.finishClose();
      await stopping;
    }
    expect(stopped).toBe(true);
  });
});
