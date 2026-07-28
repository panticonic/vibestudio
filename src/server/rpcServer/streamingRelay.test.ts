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

  it("keeps the per-request evaluated caller through HTTP stream authority and egress", async () => {
    const resident = createVerifiedCaller("do:vibestudio/internal:EvalDO:owner", "do");
    const evaluated = {
      ...resident,
      executionSession: {
        nonce: "exact-live-eval-session",
      } as import("@vibestudio/rpc").AgentExecutionSessionFact,
    };
    const assertAuthority = vi.fn(async () => undefined);
    const forwardProxyFetchStream = vi.fn(
      async (
        _params: { caller: unknown },
        sink: (frame: { kind: string; status?: number; bytesIn?: number }) => Promise<void>
      ) => {
        await sink({ kind: "head", status: 200 });
        await sink({ kind: "end", bytesIn: 0 });
        return { status: 200, bytesIn: 0 };
      }
    );
    const relay = new StreamingRelay({
      dispatcher: { assertAuthority } as unknown as ServiceDispatcher,
      egressProxy: { forwardProxyFetchStream },
      authenticateHttp: () => ({
        ok: true,
        caller: {
          callerId: "do:vibestudio/internal:EvalDO:owner",
          callerKind: "do",
        },
      }),
      verifiedCaller: () => evaluated,
      authorizeRelay: () => ({ ok: true }),
      createWsContext: () => {
        throw new Error("WebSocket context was not expected");
      },
      resolveCausalParent: async () => undefined,
      relayTargetStream: async () => {
        throw new Error("Target relay was not expected");
      },
      sendWs: () => undefined,
    });

    const server = http.createServer((req, res) => {
      void relay.handleHttpRequest(req, res);
    });
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an IPv4 test server");

    const response = await fetch(`http://127.0.0.1:${address.port}/rpc/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "main",
        delivery: {},
        message: {
          type: "stream-request",
          requestId: "evaluated-proxy-fetch",
          fromId: resident.runtime.id,
          method: "credentials.proxyFetch",
          args: [{ url: "https://example.com", method: "GET" }],
        },
      }),
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();

    expect(assertAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ caller: evaluated }),
      "credentials",
      "proxyFetch",
      [{ url: "https://example.com", method: "GET" }]
    );
    expect(forwardProxyFetchStream).toHaveBeenCalledWith(
      expect.objectContaining({ caller: evaluated }),
      expect.any(Function),
      expect.any(AbortSignal)
    );
  });
});
