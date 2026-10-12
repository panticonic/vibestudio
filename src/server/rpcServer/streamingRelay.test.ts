import * as http from "node:http";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { RpcEnvelope, RpcStreamRequest } from "@vibestudio/rpc";
import { createVerifiedCaller, type ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { WsClientState } from "./connectionRegistry.js";
import { WebSocketSessionChannel } from "./sessionChannel.js";
import { StreamingRelay } from "./streamingRelay.js";

describe("StreamingRelay HTTP response ownership", () => {
  const servers = new Set<http.Server>();
  const webSocketServers = new Set<WebSocketServer>();

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
    await Promise.all(
      [...webSocketServers].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            for (const client of server.clients) client.terminate();
          })
      )
    );
    webSocketServers.clear();
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
      createHttpContext: (caller, _request, extras) => ({ caller, ...extras }),
      createSessionContext: () => {
        throw new Error("WebSocket context was not expected");
      },
      resolveCausalInvocation: async (resolved) => ({ caller: resolved, parent: undefined }),
      relayTargetStream: async () => {
        throw new Error("Target relay was not expected");
      },
    });

    let handled!: (error?: unknown) => void;
    const handledPromise = new Promise<unknown>((resolve) => {
      handled = resolve;
    });
    const server = http.createServer((req, res) => {
      void relay.handleHttpRequest(req, res).then(() => handled(), handled);
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
        message: {
          type: "stream-request",
          requestId: "events-1",
          fromId: "shell:test",
          method: "events.watch",
          args: [["panel-tree-invalidated"]],
        },
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
    const handlingFailure = await handledPromise;
    if (handlingFailure !== undefined) {
      const failures =
        handlingFailure instanceof AggregateError ? handlingFailure.errors : [handlingFailure];
      expect(failures).toContainEqual(expect.objectContaining({ code: "ECONNRESET" }));
    }
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      "events",
      "watch",
      [["panel-tree-invalidated"]]
    );
  });

  it("keeps the per-request evaluated caller through HTTP stream authority and egress", async () => {
    const resident = createVerifiedCaller("do:vibestudio/internal:EvalDO:owner", "do");
    const evaluated = {
      ...resident,
      executionSession: {
        nonce: "exact-live-eval-session",
      } as import("@vibestudio/rpc").ExecutionAdmissionFact,
    };
    const causallyAttributed = {
      ...evaluated,
      taskAuthority: "task:streaming-turn" as const,
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
      createHttpContext: (caller, _request, extras) => ({ caller, ...extras }),
      createSessionContext: () => {
        throw new Error("WebSocket context was not expected");
      },
      resolveCausalInvocation: async () => ({ caller: causallyAttributed, parent: undefined }),
      relayTargetStream: async () => {
        throw new Error("Target relay was not expected");
      },
    });

    let handled!: (error?: unknown) => void;
    const handledPromise = new Promise<unknown>((resolve) => {
      handled = resolve;
    });
    const server = http.createServer((req, res) => {
      void relay.handleHttpRequest(req, res).then(() => handled(), handled);
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
    expect(await handledPromise).toBeUndefined();

    expect(assertAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ caller: causallyAttributed }),
      "credentials",
      "proxyFetch",
      [{ url: "https://example.com", method: "GET" }]
    );
    expect(forwardProxyFetchStream).toHaveBeenCalledWith(
      expect.objectContaining({ caller: causallyAttributed }),
      expect.any(Function),
      expect.any(AbortSignal)
    );
  });

  it("joins HTTP identity resolution after the real client disconnects before relay admission", async () => {
    let verificationStarted!: () => void;
    let completeVerification!: (value: ReturnType<typeof createVerifiedCaller>) => void;
    let responseClosed!: () => void;
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    const pendingCaller = new Promise<ReturnType<typeof createVerifiedCaller>>((resolve) => {
      completeVerification = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const caller = createVerifiedCaller("shell:disconnect", "shell");
    const resolveCausalInvocation = vi.fn(async (verified: typeof caller) => ({
      caller: verified,
      parent: undefined,
    }));
    const relay = new StreamingRelay({
      dispatcher: {} as ServiceDispatcher,
      authenticateHttp: () => ({
        ok: true,
        caller: { callerId: caller.runtime.id, callerKind: caller.runtime.kind },
      }),
      verifiedCaller: () => {
        verificationStarted();
        return pendingCaller;
      },
      authorizeRelay: () => ({ ok: true }),
      createHttpContext: (verified, _request, extras) => ({ caller: verified, ...extras }),
      createSessionContext: () => {
        throw new Error("WebSocket context was not expected");
      },
      resolveCausalInvocation,
      relayTargetStream: async () => {
        throw new Error("A disconnected client must not enter relay work");
      },
    });
    let handled!: Promise<void>;
    const server = http.createServer((req, res) => {
      res.once("close", responseClosed);
      handled = relay.handleHttpRequest(req, res);
    });
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an IPv4 test server");

    const controller = new AbortController();
    const fetchPromise = fetch(`http://127.0.0.1:${address.port}/rpc/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "worker:echo",
        message: {
          type: "stream-request",
          requestId: "disconnect-before-relay",
          fromId: caller.runtime.id,
          method: "events.watch",
          args: [["panel-tree-invalidated"]],
        },
      }),
      signal: controller.signal,
    });
    const clientClosed = expect(fetchPromise).rejects.toThrow();
    await started;
    controller.abort();
    await clientClosed;
    await closed;
    expect(resolveCausalInvocation).not.toHaveBeenCalled();
    relay.stop();
    let drained = false;
    const draining = relay.drain().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);

    completeVerification(caller);
    await Promise.all([handled, draining]);
    expect(drained).toBe(true);
    expect(resolveCausalInvocation).not.toHaveBeenCalled();
  });

  it("does not dispatch a stream when its real WebSocket closes during identity lookup", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    webSocketServers.add(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an IPv4 test socket");
    const accepted = once(server, "connection").then(([socket]) => socket as WebSocket);
    const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(peer, "open");
    const socket = await accepted;
    const channel = new WebSocketSessionChannel(socket);
    const caller = createVerifiedCaller("shell:ws-close", "shell");
    const client = {
      ws: channel,
      caller,
      connectionId: "connection:ws-close",
      authenticated: true,
      authenticatedAt: Date.now(),
      userId: "user:ws-close",
    } as WsClientState;
    let verificationStarted!: () => void;
    let completeVerification!: (value: ReturnType<typeof createVerifiedCaller>) => void;
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    const pendingCaller = new Promise<ReturnType<typeof createVerifiedCaller>>((resolve) => {
      completeVerification = resolve;
    });
    const resolveCausalInvocation = vi.fn(async (verified: typeof caller) => ({
      caller: verified,
      parent: undefined,
    }));
    const dispatch = vi.fn();
    const relay = new StreamingRelay({
      dispatcher: { dispatch } as unknown as ServiceDispatcher,
      authenticateHttp: () => ({
        ok: true,
        caller: { callerId: caller.runtime.id, callerKind: caller.runtime.kind },
      }),
      verifiedCaller: () => {
        verificationStarted();
        return pendingCaller;
      },
      authorizeRelay: () => ({ ok: true }),
      createHttpContext: (verified, _request, extras) => ({ caller: verified, ...extras }),
      createSessionContext: (verifiedClient, _request, verified, extras) => ({
        caller: verified,
        connectionId: verifiedClient.connectionId,
        wsClient: verifiedClient,
        ...extras,
      }),
      resolveCausalInvocation,
      relayTargetStream: async () => {
        throw new Error("Unexpected relayed request");
      },
    });
    channel.onClose(() => relay.abortConnection(client));
    const request = {
      type: "stream-request",
      requestId: "ws-close-during-identity",
      fromId: caller.runtime.id,
      method: "events.watch",
      args: [["panel-tree-invalidated"]],
    } satisfies RpcStreamRequest;
    const envelope = {
      target: "main",
      message: request,
      delivery: {},
    } as RpcEnvelope;
    const handling = relay.handleSessionRequest(client, request, envelope);
    await started;
    peer.close();
    await once(socket, "close");
    relay.stop();
    let drained = false;
    const draining = relay.drain().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);
    completeVerification(caller);

    await Promise.all([handling, draining]);
    expect(drained).toBe(true);
    expect(resolveCausalInvocation).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retains admitted failures for shutdown drain without replacing the caller failure", async () => {
    let rejectAdmission!: (error: Error) => void;
    let admissionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    const pendingAdmission = new Promise<never>((_resolve, reject) => {
      rejectAdmission = reject;
    });
    const relay = new StreamingRelay({
      dispatcher: {} as ServiceDispatcher,
      authenticateHttp: () => {
        admissionStarted();
        return pendingAdmission;
      },
      verifiedCaller: () => {
        throw new Error("Caller verification must not run");
      },
      authorizeRelay: () => ({ ok: true }),
      createHttpContext: () => {
        throw new Error("HTTP context must not be created");
      },
      createSessionContext: () => {
        throw new Error("WebSocket context must not be created");
      },
      resolveCausalInvocation: async () => {
        throw new Error("Causal resolution must not run");
      },
      relayTargetStream: async () => {
        throw new Error("Target relay must not run");
      },
    });
    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.complete = true;
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    }) as http.ServerResponse;
    const handling = relay.handleHttpRequest(req, res);
    const handlingResult = handling.then(
      () => undefined,
      (error: unknown) => error
    );
    const original = new Error("admission lookup failed");
    try {
      await started;
      relay.stop();
      rejectAdmission(original);
      expect(await handlingResult).toBe(original);
      await expect(relay.drain()).rejects.toBe(original);
    } finally {
      relay.stop();
      rejectAdmission(original);
      socket.destroy();
      await Promise.allSettled([handlingResult, relay.drain()]);
    }
  });
});
