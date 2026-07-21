import * as http from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { StreamingRelay } from "./streamingRelay.js";

describe("StreamingRelay HTTP response ownership", () => {
  const servers = new Set<http.Server>();

  afterEach(async () => {
    await Promise.all(
      [...servers].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          })
      )
    );
    servers.clear();
  });

  it("cancels the owned response and releases backpressure when the client disconnects", async () => {
    let cancelled!: () => void;
    const cancelledPromise = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      },
      cancel() {
        cancelled();
      },
    });
    const caller = createVerifiedCaller("shell:test", "shell");
    const dispatcher = {
      // Authority-native services intentionally have no legacy caller-kind
      // policy. Streaming admission must be owned by dispatch(), exactly like
      // unary RPC, or a registered service is misreported as unknown.
      getPolicy: () => undefined,
      getMethodPolicy: () => undefined,
      dispatch: vi.fn(async () => new Response(body)),
    } as unknown as ServiceDispatcher;
    const relay = new StreamingRelay({
      dispatcher,
      authenticateHttp: () => ({
        ok: true,
        caller: { callerId: "shell:test", callerKind: "shell" },
      }),
      verifiedCaller: () => caller,
      authorizeRelay: () => ({ ok: true }),
      createHttpContext: (_authenticated, extras) => ({ caller, ...extras }),
      createWsContext: () => {
        throw new Error("WebSocket context was not expected");
      },
      resolveCausalParent: async () => undefined,
      relayTargetStream: async () => {
        throw new Error("Target relay was not expected");
      },
      sendWs: () => undefined,
    });

    let handled!: () => void;
    const handledPromise = new Promise<void>((resolve) => {
      handled = resolve;
    });
    const server = http.createServer((req, res) => {
      void relay.handleHttpRequest(req, res).finally(handled);
    });
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an IPv4 test server");

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/rpc/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "main",
        message: { method: "events.watch", args: [["panel-tree-updated"]] },
      }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    controller.abort();

    await expect(
      Promise.race([
        cancelledPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("response cancellation timed out")), 1_000)
        ),
      ])
    ).resolves.toBeUndefined();
    await expect(
      Promise.race([
        handledPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("HTTP relay remained blocked after close")), 1_000)
        ),
      ])
    ).resolves.toBeUndefined();
  });
});
