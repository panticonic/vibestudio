import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { checkBackhaul } from "../scripts/smoke-cloudflare-apex.mjs";

describe("Cloudflare apex smoke backhaul ownership", () => {
  let server: Server;
  let webSockets: WebSocketServer;
  let origin: string;
  let connections: Array<{ relayId: string; frames: Array<Record<string, unknown>> }>;
  let registrations: Map<string, string>;
  let dropFirstRegisterAck: boolean;
  let acceptedRegisterFrames: number;

  beforeEach(async () => {
    connections = [];
    registrations = new Map();
    dropFirstRegisterAck = false;
    acceptedRegisterFrames = 0;
    server = createServer();
    webSockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit("connection", webSocket, request);
      });
    });
    webSockets.on("connection", (webSocket, request) => {
      const relayId = new URL(request.url ?? "/", "http://localhost").searchParams.get("relayId");
      if (!relayId) throw new Error("backhaul request omitted its relay identity");
      const connection = { relayId, frames: [] as Array<Record<string, unknown>> };
      connections.push(connection);
      webSocket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        connection.frames.push(frame);
        if (frame.t === "register-webhook") {
          const id = String(frame.subscriptionId);
          registrations.set(id, relayId);
          acceptedRegisterFrames += 1;
          if (dropFirstRegisterAck && acceptedRegisterFrames === 1) {
            webSocket.close(1011, "persisted registration before ack");
            return;
          }
          webSocket.send(JSON.stringify({ t: "registered", kind: "webhook", id }));
        } else if (frame.t === "unregister-webhook") {
          const id = String(frame.subscriptionId);
          if (registrations.get(id) === relayId) registrations.delete(id);
          webSocket.send(JSON.stringify({ t: "unregistered", kind: "webhook", id }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("backhaul fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const webSocket of webSockets.clients) webSocket.terminate();
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("unregisters the exact probe after normal registration", async () => {
    await checkBackhaul(new URL(origin));

    expect(registrations.size).toBe(0);
    expect(connections).toHaveLength(1);
    expect(connections[0]!.frames.map((frame) => frame.t)).toEqual([
      "register-webhook",
      "unregister-webhook",
    ]);
    expect(connections[0]!.frames[0]!.subscriptionId).toBe(
      connections[0]!.frames[1]!.subscriptionId
    );
  });

  it("reconnects with the same identity to clean a persisted registration whose ack was lost", async () => {
    dropFirstRegisterAck = true;

    await expect(checkBackhaul(new URL(origin))).rejects.toThrow(
      "backhaul closed before registered ack"
    );

    expect(registrations.size).toBe(0);
    expect(connections).toHaveLength(2);
    expect(connections[0]!.relayId).toBe(connections[1]!.relayId);
    expect(connections[0]!.frames[0]!.subscriptionId).toBe(
      connections[1]!.frames[0]!.subscriptionId
    );
    expect(connections[1]!.frames[0]!.t).toBe("unregister-webhook");
  });
});
