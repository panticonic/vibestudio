import { createRpcClient, defineContract, withCausalParent } from "./client.js";
import { createInternalRpcClient } from "./client-core.js";
import { createInProcessNetwork, inProcessTransport } from "./transports/inProcess.js";
import type { EnvelopeRpcTransport, RpcConnectionStatus, RpcEnvelope } from "./types.js";
import type { RecoveryKind } from "./protocol/recoveryCoordinator.js";
import { RpcBoundaryError } from "./errors.js";

/**
 * A fake transport whose status + recovery signals can be driven by the test,
 * and whose `send` never produces a response — so calls stay pending until the
 * pending-call policy (§3.4) settles them. Mirrors the real transport surface:
 * `onStatusChange` lives on the transport; the recovery registration is the
 * separate `onRecovery` option `createRpcClient` accepts (wired from
 * `createPairedConnection`'s recovery fan-out in production).
 */
function controllableTransport(): {
  transport: EnvelopeRpcTransport;
  sent: RpcEnvelope[];
  emitStatus: (status: RpcConnectionStatus) => void;
  onRecovery: (handler: (kind: RecoveryKind) => void) => () => void;
  emitRecovery: (kind: RecoveryKind) => void;
} {
  const sent: RpcEnvelope[] = [];
  let statusHandler: ((status: RpcConnectionStatus) => void) | null = null;
  let recoveryHandler: ((kind: RecoveryKind) => void) | null = null;
  return {
    sent,
    transport: {
      send: async (envelope) => {
        sent.push(envelope);
      },
      onMessage: () => () => {},
      status: () => "connected",
      onStatusChange: (handler) => {
        statusHandler = handler;
        return () => {
          if (statusHandler === handler) statusHandler = null;
        };
      },
    },
    emitStatus: (status) => statusHandler?.(status),
    onRecovery: (handler) => {
      recoveryHandler = handler;
      return () => {
        if (recoveryHandler === handler) recoveryHandler = null;
      };
    },
    emitRecovery: (kind) => recoveryHandler?.(kind),
  };
}

function workspaceNetwork(): {
  transport: (selfId: string, workspaceId: string) => EnvelopeRpcTransport;
  sent: RpcEnvelope[];
} {
  const handlers = new Map<string, Set<(envelope: RpcEnvelope) => void>>();
  const sent: RpcEnvelope[] = [];
  const address = (workspaceId: string, targetId: string) => `${workspaceId}\0${targetId}`;
  return {
    sent,
    transport(selfId, workspaceId) {
      const ownAddress = address(workspaceId, selfId);
      const listeners = new Set<(envelope: RpcEnvelope) => void>();
      handlers.set(ownAddress, listeners);
      return {
        async send(envelope) {
          sent.push(envelope);
          const destinationWorkspaceId =
            (envelope.destination?.kind === "workspace"
              ? envelope.destination.workspaceId
              : undefined) ?? workspaceId;
          const recipients = handlers.get(address(destinationWorkspaceId, envelope.target));
          if (!recipients?.size) {
            throw new Error(
              `No RPC target ${envelope.target} in workspace ${destinationWorkspaceId}`
            );
          }
          queueMicrotask(() => {
            for (const recipient of recipients) recipient(envelope);
          });
        },
        onMessage(handler) {
          listeners.add(handler);
          return () => listeners.delete(handler);
        },
      };
    },
  };
}

/** Snapshot a promise's settlement without awaiting it (for "still pending" checks). */
function track<T>(promise: Promise<T>): { settled: boolean; reason?: unknown; value?: T } {
  const state: { settled: boolean; reason?: unknown; value?: T } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (reason) => {
      state.settled = true;
      state.reason = reason;
    }
  );
  return state;
}

/**
 * Let queued microtasks flush so `track` observes a synchronous rejection. A few
 * ticks are needed because `rpc.call` is an async wrapper: the inner pending
 * rejection is adopted by the outer promise one microtask hop later.
 */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("createRpcClient", () => {
  it("identifies the endpoint for an unexposed method without exposing its method table", async () => {
    const network = createInProcessNetwork();
    const caller = createRpcClient({
      selfId: "caller",
      callerKind: "panel",
      transport: inProcessTransport("caller", network),
    });
    createRpcClient({
      selfId: "panel:nav-target",
      callerKind: "panel",
      transport: inProcessTransport("panel:nav-target", network),
    });

    await expect(caller.call("panel:nav-target", "_agent.snapshot", [])).rejects.toMatchObject({
      message: 'Method "_agent.snapshot" is not exposed by this endpoint',
      errorData: {
        kind: "rpc-endpoint",
        endpointId: "panel:nav-target",
        requestedMethod: "_agent.snapshot",
      },
    });
  });

  it("waits for one structured authority acquisition and retries the exact invocation", async () => {
    const network = createInProcessNetwork();
    const caller = createRpcClient({
      selfId: "code:worker",
      callerKind: "worker",
      transport: inProcessTransport("code:worker", network),
      authorityAcquisition: "wait",
    });
    const server = createRpcClient({
      selfId: "main",
      callerKind: "server",
      transport: inProcessTransport("main", network),
    });
    let approved = false;
    const invocations: unknown[][] = [];
    server.expose("protected.run", async ({ args }) => {
      invocations.push(args);
      if (!approved) {
        throw new RpcBoundaryError("approval required", "access", "EACQUIRE", undefined, {
          acquisition: { acquisitionId: "acq:exact", ownerRuntimeId: "code:worker" },
        });
      }
      return "done";
    });
    server.expose("authority.awaitDecision", async ({ args }) => {
      expect(args).toEqual([{ acquisitionId: "acq:exact" }]);
      approved = true;
      return { state: "decided" };
    });

    await expect(caller.call("main", "protected.run", ["same", 1])).resolves.toBe("done");
    expect(invocations).toEqual([
      ["same", 1],
      ["same", 1],
    ]);
  });

  it("waits at the addressed workspace before retrying an approved operation", async () => {
    const network = workspaceNetwork();
    const caller = createRpcClient({
      selfId: "code:worker",
      callerKind: "worker",
      workspaceId: "workspace:a",
      transport: network.transport("code:worker", "workspace:a"),
      authorityAcquisition: "wait",
    });
    const server = createRpcClient({
      selfId: "main",
      callerKind: "server",
      workspaceId: "workspace:b",
      transport: network.transport("main", "workspace:b"),
    });
    let approved = false;
    const operation = vi.fn(async () => {
      if (!approved)
        throw new RpcBoundaryError("approval required", "access", "EACQUIRE", undefined, {
          acquisition: { acquisitionId: "acq:remote", ownerRuntimeId: "code:worker" },
        });
      return "done";
    });
    server.expose("protected.run", operation);
    server.expose("authority.awaitDecision", async ({ args }) => {
      expect(args).toEqual([{ acquisitionId: "acq:remote" }]);
      approved = true;
      return { state: "decided" };
    });
    await expect(
      caller.call("main", "protected.run", [], {
        destination: { kind: "workspace", workspaceId: "workspace:b" },
      })
    ).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(
      network.sent
        .filter((envelope) => envelope.message.type === "request")
        .map((envelope) => envelope.destination)
    ).toEqual([
      { kind: "workspace", workspaceId: "workspace:b" },
      { kind: "workspace", workspaceId: "workspace:b" },
      { kind: "workspace", workspaceId: "workspace:b" },
    ]);
  });

  it("lets a durable effect override a waiting client and journal EACQUIRE itself", async () => {
    const network = createInProcessNetwork();
    const caller = createRpcClient({
      selfId: "code:worker",
      callerKind: "worker",
      transport: inProcessTransport("code:worker", network),
      authorityAcquisition: "wait",
    });
    const server = createRpcClient({
      selfId: "main",
      callerKind: "server",
      transport: inProcessTransport("main", network),
    });
    const wait = vi.fn();
    server.expose("protected.run", async () => {
      throw new RpcBoundaryError("approval required", "access", "EACQUIRE", undefined, {
        acquisition: { acquisitionId: "acq:durable", ownerRuntimeId: "code:worker" },
      });
    });
    server.expose("authority.awaitDecision", wait);

    await expect(
      caller.call("main", "protected.run", ["exact"], { authorityAcquisition: "return" })
    ).rejects.toMatchObject({
      code: "EACQUIRE",
      errorData: {
        acquisition: {
          acquisitionId: "acq:durable",
          ownerRuntimeId: "code:worker",
        },
      },
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not attach an operation timeout to the human authority wait", async () => {
    const network = createInProcessNetwork();
    const caller = createRpcClient({
      selfId: "code:worker",
      callerKind: "worker",
      transport: inProcessTransport("code:worker", network),
      authorityAcquisition: "wait",
    });
    const server = createRpcClient({
      selfId: "main",
      callerKind: "server",
      transport: inProcessTransport("main", network),
    });
    let release!: () => void;
    const decision = new Promise<void>((resolve) => {
      release = resolve;
    });
    let approved = false;
    server.expose("protected.run", async () => {
      if (!approved) {
        throw new RpcBoundaryError("approval required", "access", "EACQUIRE", undefined, {
          acquisition: { acquisitionId: "acq:slow", ownerRuntimeId: "code:worker" },
        });
      }
      return "done";
    });
    server.expose("authority.awaitDecision", async () => {
      await decision;
      approved = true;
      return { state: "decided" };
    });

    const pending = caller.call("main", "protected.run", [], { timeoutMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await expect(pending).resolves.toBe("done");
  });

  it("does not acquire a nested invocation owned by another runtime", async () => {
    const network = createInProcessNetwork();
    const caller = createRpcClient({
      selfId: "code:outer",
      callerKind: "worker",
      transport: inProcessTransport("code:outer", network),
      authorityAcquisition: "wait",
    });
    const server = createRpcClient({
      selfId: "main",
      callerKind: "server",
      transport: inProcessTransport("main", network),
    });
    const wait = vi.fn();
    server.expose("protected.run", async () => {
      throw new RpcBoundaryError("inner approval required", "access", "EACQUIRE", undefined, {
        acquisition: { acquisitionId: "acq:inner", ownerRuntimeId: "code:inner" },
      });
    });
    server.expose("authority.awaitDecision", wait);

    await expect(caller.call("main", "protected.run", [])).rejects.toMatchObject({
      code: "EACQUIRE",
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it("binds a caller signal to the original transport request", async () => {
    let requestSignal: AbortSignal | undefined;
    const transport: EnvelopeRpcTransport = {
      async send(envelope, signal) {
        if (envelope.message.type === "request") requestSignal = signal;
      },
      onMessage: () => () => {},
    };
    const rpc = createRpcClient({ selfId: "caller", callerKind: "worker", transport });
    const controller = new AbortController();
    const pending = rpc.call("server", "wait", [], { signal: controller.signal });
    await flushMicrotasks();

    expect(requestSignal).toBe(controller.signal);

    controller.abort(new Error("activation released"));
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("automatically seals one exact causal parent onto scoped calls", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "do:agent",
      callerKind: "do",
      transport: fake.transport,
    });
    const causalParent = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:bound",
      head: "main",
      invocationId: "invocation:tool",
    };
    const controller = new AbortController();
    const pending = withCausalParent(rpc, causalParent).call("main", "vcs.edit", [], {
      signal: controller.signal,
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:forged",
        head: "main",
        invocationId: "invocation:forged",
      },
    });
    await flushMicrotasks();

    expect(fake.sent[0]?.message).toMatchObject({ causalParent });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("does local dispatch without using the transport", async () => {
    const network = createInProcessNetwork();
    const transport = inProcessTransport("self", network);
    const send = vi.spyOn(transport, "send");
    const rpc = createRpcClient({ selfId: "self", callerKind: "worker", transport });

    rpc.expose("add", (req) => {
      const [a, b] = req.args as [number, number];
      expect(req.caller).toEqual({ callerId: "self", callerKind: "worker" });
      expect(req.origin).toEqual({ callerId: "self", callerKind: "worker" });
      return a + b;
    });

    await expect(rpc.call("self", "add", [2, 5])).resolves.toBe(7);
    expect(send).not.toHaveBeenCalled();
  });

  it("routes calls, streams, and events to the same target name in exact workspaces", async () => {
    const network = workspaceNetwork();
    const caller = createRpcClient({
      selfId: "caller",
      workspaceId: "workspace:a",
      callerKind: "worker",
      transport: network.transport("caller", "workspace:a"),
    });
    const services = ["workspace:a", "workspace:b", "workspace:c"].map((workspaceId) => {
      const rpc = createRpcClient({
        selfId: "service",
        workspaceId,
        callerKind: "worker",
        transport: network.transport("service", workspaceId),
      });
      const events: unknown[] = [];
      rpc.expose("identify", ({ caller: inboundCaller }) => ({
        workspaceId,
        callerWorkspaceId: inboundCaller.workspaceId,
      }));
      rpc.exposeStreaming("identify-stream", async ({ caller: inboundCaller }, sink) => {
        const bytes = new TextEncoder().encode(`${workspaceId}<-${inboundCaller.workspaceId}`);
        await sink({
          kind: "head",
          status: 200,
          statusText: "OK",
          headerPairs: [],
          finalUrl: "",
        });
        await sink({ kind: "chunk", bytes });
        await sink({ kind: "end", bytesIn: bytes.byteLength });
      });
      rpc.on("notice", ({ payload }) => events.push(payload));
      return { workspaceId, rpc, events };
    });

    await expect(caller.call("service", "identify", [])).resolves.toEqual({
      workspaceId: "workspace:a",
      callerWorkspaceId: "workspace:a",
    });
    const workspaceB = caller.peer<
      { identify: () => unknown },
      { reply: string },
      { notice: string }
    >("service", { destination: { kind: "workspace", workspaceId: "workspace:b" } });
    await expect(workspaceB.call.identify()).resolves.toEqual({
      workspaceId: "workspace:b",
      callerWorkspaceId: "workspace:a",
    });
    await expect(
      caller.call("service", "identify", [], {
        destination: { kind: "workspace", workspaceId: "workspace:c" },
      })
    ).resolves.toEqual({
      workspaceId: "workspace:c",
      callerWorkspaceId: "workspace:a",
    });

    const [streamB, streamC] = await Promise.all([
      caller.stream("service", "identify-stream", [], {
        destination: { kind: "workspace", workspaceId: "workspace:b" },
      }),
      caller.stream("service", "identify-stream", [], {
        destination: { kind: "workspace", workspaceId: "workspace:c" },
      }),
    ]);
    await expect(streamB.text()).resolves.toBe("workspace:b<-workspace:a");
    await expect(streamC.text()).resolves.toBe("workspace:c<-workspace:a");

    await workspaceB.emit("notice", "for-b");
    await caller.emit("service", "notice", "for-c", {
      destination: { kind: "workspace", workspaceId: "workspace:c" },
    });
    await flushMicrotasks();
    expect(services.map(({ events }) => events)).toEqual([[], ["for-b"], ["for-c"]]);

    const peerEvents: string[] = [];
    workspaceB.on("reply", ({ payload }) => peerEvents.push(payload));
    await services[1]!.rpc.emit("caller", "reply", "from-b", {
      destination: { kind: "workspace", workspaceId: "workspace:a" },
    });
    await services[2]!.rpc.emit("caller", "reply", "from-c", {
      destination: { kind: "workspace", workspaceId: "workspace:a" },
    });
    await flushMicrotasks();
    expect(peerEvents).toEqual(["from-b"]);

    const boundedReturns = network.sent.filter(
      (envelope) =>
        envelope.target === "caller" &&
        envelope.delivery.caller.workspaceId !== "workspace:a" &&
        (envelope.message.type === "response" || envelope.message.type === "stream-frame")
    );
    expect(boundedReturns.length).toBeGreaterThan(0);
    expect(
      boundedReturns.every(
        (envelope) =>
          envelope.destination?.kind === "workspace" &&
          envelope.destination.workspaceId === "workspace:a"
      )
    ).toBe(true);
  });

  it("preserves an exact workspace route on unary and stream cancellation", async () => {
    const network = workspaceNetwork();
    const caller = createRpcClient({
      selfId: "caller",
      workspaceId: "workspace:a",
      transport: network.transport("caller", "workspace:a"),
    });
    const callee = createRpcClient({
      selfId: "service",
      workspaceId: "workspace:b",
      transport: network.transport("service", "workspace:b"),
    });
    let unaryAbort = false;
    let unaryEntered!: () => void;
    const unaryStarted = new Promise<void>((resolve) => {
      unaryEntered = resolve;
    });
    callee.expose("wait", async ({ signal }) => {
      unaryEntered();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            unaryAbort = true;
            resolve();
          },
          { once: true }
        )
      );
      return null;
    });

    const unaryController = new AbortController();
    const unary = caller.call("service", "wait", [], {
      destination: { kind: "workspace", workspaceId: "workspace:b" },
      signal: unaryController.signal,
    });
    await unaryStarted;
    unaryController.abort();
    await expect(unary).rejects.toThrow(/aborted/);
    await vi.waitFor(() => expect(unaryAbort).toBe(true));

    let streamAbort = false;
    callee.exposeStreaming("wait-stream", async ({ signal }, sink) => {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [],
        finalUrl: "",
      });
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            streamAbort = true;
            resolve();
          },
          { once: true }
        )
      );
    });
    const streamed = await caller.stream("service", "wait-stream", [], {
      destination: { kind: "workspace", workspaceId: "workspace:b" },
    });
    await streamed.body?.cancel();
    await vi.waitFor(() => expect(streamAbort).toBe(true));

    const cancellations = network.sent.filter(
      (envelope) =>
        envelope.message.type === "request-cancel" || envelope.message.type === "stream-cancel"
    );
    expect(cancellations.map((envelope) => envelope.destination)).toEqual([
      { kind: "workspace", workspaceId: "workspace:b" },
      { kind: "workspace", workspaceId: "workspace:b" },
    ]);
    expect(cancellations.map((envelope) => envelope.delivery.caller.workspaceId)).toEqual([
      "workspace:a",
      "workspace:a",
    ]);
  });

  it("matches bounded responses and stream frames to the authenticated workspace", async () => {
    const sent: RpcEnvelope[] = [];
    let receive!: (envelope: RpcEnvelope) => void;
    const rpc = createRpcClient({
      selfId: "caller",
      workspaceId: "workspace:a",
      transport: {
        send: async (envelope) => {
          sent.push(envelope);
        },
        onMessage(handler) {
          receive = handler;
          return () => {};
        },
      },
    });
    const responseEnvelope = (
      request: RpcEnvelope,
      workspaceId: string,
      message: RpcEnvelope["message"]
    ): RpcEnvelope => ({
      from: "service",
      target: "caller",
      destination: { kind: "workspace", workspaceId: "workspace:a" },
      delivery: { caller: { callerId: "service", callerKind: "worker", workspaceId } },
      provenance: request.provenance,
      message,
    });

    const wrongRoute = vi.fn();
    rpc.on("wrong-route", wrongRoute);
    receive({
      from: "service",
      target: "caller",
      destination: { kind: "workspace", workspaceId: "workspace:other" },
      delivery: {
        caller: {
          callerId: "service",
          callerKind: "worker",
          workspaceId: "workspace:b",
        },
      },
      provenance: [],
      message: {
        type: "event",
        fromId: "service",
        event: "wrong-route",
        payload: null,
      },
    });
    await flushMicrotasks();
    expect(wrongRoute).not.toHaveBeenCalled();

    const unary = rpc.call("service", "identify", [], {
      destination: { kind: "workspace", workspaceId: "workspace:b" },
    });
    await flushMicrotasks();
    const request = sent.find((envelope) => envelope.message.type === "request")!;
    const requestId = request.message.type === "request" ? request.message.requestId : "";
    receive(
      responseEnvelope(request, "workspace:c", {
        type: "response",
        requestId,
        result: "wrong",
      })
    );
    const unaryState = track(unary);
    await flushMicrotasks();
    expect(unaryState.settled).toBe(false);
    receive(
      responseEnvelope(request, "workspace:b", {
        type: "response",
        requestId,
        result: "right",
      })
    );
    await expect(unary).resolves.toBe("right");

    const streaming = rpc.stream("service", "download", [], {
      destination: { kind: "workspace", workspaceId: "workspace:b" },
    });
    await flushMicrotasks();
    const streamRequest = sent.find((envelope) => envelope.message.type === "stream-request")!;
    const streamId =
      streamRequest.message.type === "stream-request" ? streamRequest.message.requestId : "";
    const head = {
      type: "stream-frame" as const,
      requestId: streamId,
      fromId: "service",
      frameType: 1,
      payload: JSON.stringify({
        status: 200,
        statusText: "OK",
        headerPairs: [],
        finalUrl: "",
      }),
    };
    receive(responseEnvelope(streamRequest, "workspace:c", head));
    const streamState = track(streaming);
    await flushMicrotasks();
    expect(streamState.settled).toBe(false);
    receive(responseEnvelope(streamRequest, "workspace:b", head));
    const response = await streaming;
    receive(
      responseEnvelope(streamRequest, "workspace:b", {
        type: "stream-frame",
        requestId: streamId,
        fromId: "service",
        frameType: 3,
        payload: JSON.stringify({ bytesIn: 0 }),
      })
    );
    await expect(response.text()).resolves.toBe("");
  });

  it("removes host attestations from handler identity and forwarded provenance", async () => {
    const sent: RpcEnvelope[] = [];
    let receive!: (envelope: RpcEnvelope) => void;
    const rpc = createRpcClient({
      selfId: "worker:receiver",
      callerKind: "worker",
      transport: {
        send: async (envelope) => {
          sent.push(envelope);
        },
        onMessage: (handler) => {
          receive = handler;
          return () => {};
        },
      },
    });
    let seenCaller: unknown;
    let seenOrigin: unknown;
    rpc.expose("inspect", (request) => {
      seenCaller = request.caller;
      seenOrigin = request.origin;
      request.rpc.emit("worker:next", "observed", null);
      return "ok";
    });

    const attested = {
      callerId: "do:source:Example:key",
      callerKind: "do" as const,
      userId: "user:1",
      authorization: {
        nonce: "must-not-reach-user-code",
        context: { authorizingOrigin: { kind: "session" } },
      },
    };
    receive({
      from: attested.callerId,
      target: "worker:receiver",
      delivery: { caller: attested },
      provenance: [attested],
      message: {
        type: "request",
        requestId: "request:attested",
        fromId: attested.callerId,
        method: "inspect",
        args: [],
      },
    } as RpcEnvelope);
    await flushMicrotasks();

    expect(seenCaller).toEqual({
      callerId: attested.callerId,
      callerKind: "do",
      userId: "user:1",
    });
    expect(seenOrigin).toEqual(seenCaller);
    const forwarded = sent.find((envelope) => envelope.target === "worker:next");
    expect(forwarded?.provenance).toEqual([
      {
        callerId: attested.callerId,
        callerKind: "do",
        userId: "user:1",
      },
      { callerId: "worker:receiver", callerKind: "worker" },
    ]);
    expect(JSON.stringify(forwarded)).not.toContain("must-not-reach-user-code");
  });

  it("propagates unary call cancellation to the callee request signal", async () => {
    const network = createInProcessNetwork();
    const caller = createRpcClient({
      selfId: "caller",
      transport: inProcessTransport("caller", network),
    });
    const callee = createRpcClient({
      selfId: "callee",
      transport: inProcessTransport("callee", network),
    });
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let observedAbort = false;
    callee.expose("wait", async (request) => {
      entered();
      await new Promise<void>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true }
        );
      });
      return null;
    });

    const controller = new AbortController();
    const pending = caller.call("callee", "wait", [], { signal: controller.signal });
    await handlerEntered;
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/);
    await vi.waitFor(() => expect(observedAbort).toBe(true));
  });

  it("preserves structured error categories across unary and streaming calls", async () => {
    const network = createInProcessNetwork();
    const a = createRpcClient({ selfId: "a", transport: inProcessTransport("a", network) });
    const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });

    b.expose("deny", () => {
      throw new RpcBoundaryError("not allowed", "access", "EACCES", undefined, {
        code: "Unauthorized",
        operation: "test",
        message: "not allowed",
      });
    });
    b.exposeStreaming("deny-stream", async (_request, sink) => {
      await sink({
        kind: "error",
        status: 403,
        message: "not allowed",
        code: "EACCES",
        errorKind: "access",
        errorData: { code: "Unauthorized", operation: "test", message: "not allowed" },
      });
    });

    await expect(a.call("b", "deny", [])).rejects.toMatchObject({
      name: "RemoteRpcError",
      message: "not allowed",
      errorKind: "access",
      code: "EACCES",
      errorData: { code: "Unauthorized", operation: "test", message: "not allowed" },
    });
    await expect(a.stream("b", "deny-stream", [])).rejects.toMatchObject({
      name: "RemoteRpcError",
      message: "not allowed",
      errorKind: "access",
      code: "EACCES",
      errorData: { code: "Unauthorized", operation: "test", message: "not allowed" },
    });
  });

  it("passes caller, origin, args, and provenance-scoped req.rpc through a chain", async () => {
    const network = createInProcessNetwork();
    const panel = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: inProcessTransport("panel:1", network),
    });
    const worker = createRpcClient({
      selfId: "worker:1",
      callerKind: "worker",
      transport: inProcessTransport("worker:1", network),
    });
    const durableObject = createRpcClient({
      selfId: "do:notes:Bucket:key",
      callerKind: "do",
      transport: inProcessTransport("do:notes:Bucket:key", network),
    });

    let seenWorkerCaller: unknown;
    let seenDoCaller: unknown;
    let seenDoOrigin: unknown;

    durableObject.expose("save", (req) => {
      seenDoCaller = req.caller;
      seenDoOrigin = req.origin;
      return req.args[0];
    });

    worker.expose("forward", async (req) => {
      seenWorkerCaller = req.caller;
      return req.rpc.call("do:notes:Bucket:key", "save", req.args);
    });

    await expect(panel.call("worker:1", "forward", [{ ok: true }])).resolves.toEqual({ ok: true });
    expect(seenWorkerCaller).toEqual({ callerId: "panel:1", callerKind: "panel" });
    expect(seenDoCaller).toEqual({ callerId: "worker:1", callerKind: "worker" });
    expect(seenDoOrigin).toEqual({ callerId: "panel:1", callerKind: "panel" });
  });

  it("scopes peer.on to events from that peer", async () => {
    const network = createInProcessNetwork();
    const a = createRpcClient({
      selfId: "a",
      callerKind: "panel",
      transport: inProcessTransport("a", network),
    });
    const b = createRpcClient({
      selfId: "b",
      callerKind: "worker",
      transport: inProcessTransport("b", network),
    });
    const c = createRpcClient({
      selfId: "c",
      callerKind: "worker",
      transport: inProcessTransport("c", network),
    });
    const listener = vi.fn();

    a.peer("b").on("ready", listener);
    await c.emit("a", "ready", { from: "c" });
    await b.emit("a", "ready", { from: "b" });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0]?.[0].payload).toEqual({ from: "b" });
  });

  it("supports typed peer call proxy and withContract at runtime", async () => {
    const network = createInProcessNetwork();
    const a = createRpcClient({
      selfId: "a",
      callerKind: "panel",
      transport: inProcessTransport("a", network),
    });
    const b = createRpcClient({
      selfId: "b",
      callerKind: "worker",
      transport: inProcessTransport("b", network),
    });
    const contract = defineContract({
      caller: {
        methods: {} as {
          sum(a: number, b: number): number;
        },
        events: {} as { done: { ok: boolean } },
        emits: {} as { start: { id: string } },
      },
    });

    b.expose("sum", (req) => {
      const [x, y] = req.args as [number, number];
      return x + y;
    });

    const peer = a.peer("b").withContract(contract, "caller");
    await expect(peer.call.sum(10, 32)).resolves.toBe(42);
  });

  it("observes outbound operations through direct, peer, and scoped clients", async () => {
    const network = createInProcessNetwork();
    const observed: Promise<unknown>[] = [];
    const a = createRpcClient({
      selfId: "a",
      callerKind: "panel",
      transport: inProcessTransport("a", network),
    });
    const b = createInternalRpcClient({
      selfId: "b",
      callerKind: "worker",
      transport: inProcessTransport("b", network),
      onOutboundOperation: (operation) => observed.push(operation),
    });
    const c = createRpcClient({
      selfId: "c",
      callerKind: "worker",
      transport: inProcessTransport("c", network),
    });
    c.expose("ping", () => "pong");
    b.expose("forward", (request) => request.rpc.call("c", "ping", []));

    await expect(b.peer("c").call["ping"]!()).resolves.toBe("pong");
    await expect(a.call("b", "forward", [])).resolves.toBe("pong");

    expect(observed).toHaveLength(2);
    await expect(Promise.all(observed)).resolves.toEqual(["pong", "pong"]);
  });

  it("generates request ids when crypto.randomUUID is unavailable", async () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    try {
      const network = createInProcessNetwork();
      const a = createRpcClient({ selfId: "a", transport: inProcessTransport("a", network) });
      const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });

      b.expose("ping", () => "pong");

      await expect(a.call("b", "ping", [])).resolves.toBe("pong");
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "crypto");
      }
    }
  });

  it("carries call delivery metadata on envelopes", async () => {
    const sent: unknown[] = [];
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: {
        send: async (envelope) => {
          sent.push(envelope);
        },
        onMessage: () => () => {},
      },
    });

    void rpc.call("main", "fs.writeFile", ["/tmp/x", "y"], {
      idempotencyKey: "idem-1",
      readOnly: true,
    });
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      delivery: { idempotencyKey: "idem-1", readOnly: true },
      message: {
        type: "request",
        method: "fs.writeFile",
      },
    });
    expect((sent[0] as { message: unknown }).message).not.toHaveProperty("idempotencyKey");
    expect((sent[0] as { message: unknown }).message).not.toHaveProperty("readOnly");
  });

  it("round-trips streaming responses", async () => {
    const network = createInProcessNetwork();
    const a = createRpcClient({ selfId: "a", transport: inProcessTransport("a", network) });
    const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });

    b.exposeStreaming("download", async (_req, sink) => {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [["content-type", "text/plain"]],
        finalUrl: "https://example.test/file",
      });
      await sink({ kind: "chunk", bytes: new TextEncoder().encode("hello") });
      await sink({ kind: "end", bytesIn: 5 });
    });

    const response = await a.stream("b", "download", []);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("hello");
  });

  it("unwraps the ordinary Response path when raw transport streaming is unavailable", async () => {
    const network = createInProcessNetwork();
    const a = createRpcClient({ selfId: "a", transport: inProcessTransport("a", network) });
    const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });

    b.exposeStreaming("download", async (_req, sink) => {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [["content-type", "text/plain"]],
        finalUrl: "https://example.test/file",
      });
      await sink({ kind: "chunk", bytes: new TextEncoder().encode("hello") });
      await sink({ kind: "end", bytesIn: 5 });
    });

    const response = await a.streamReadable("b", "download", []);
    expect(response).toMatchObject({
      status: 200,
      statusText: "OK",
      headers: [["content-type", "text/plain"]],
      finalUrl: "https://example.test/file",
    });
    await expect(new Response(response.body).text()).resolves.toBe("hello");
  });

  it.each([204, 205, 304])(
    "preserves bodyless status %s across framed and raw reads",
    async (status) => {
      const network = createInProcessNetwork();
      const a = createRpcClient({ selfId: "a", transport: inProcessTransport("a", network) });
      const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });
      b.exposeStreaming("empty", async (_request, sink) => {
        await sink({
          kind: "head",
          status,
          statusText: "",
          headerPairs: [],
          finalUrl: "https://example.test/empty",
        });
        await sink({ kind: "end", bytesIn: 0 });
      });
      const response = await a.stream("b", "empty", []);
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.url).toBe("https://example.test/empty");
      const raw = await a.streamReadable("b", "empty", []);
      expect(raw.status).toBe(status);
      await expect(raw.body.getReader().read()).resolves.toEqual({ done: true, value: undefined });
    }
  );

  it("allows a response body to remain idle after HEAD when explicitly unbounded", async () => {
    vi.useFakeTimers();
    try {
      const network = createInProcessNetwork();
      const a = createRpcClient({
        selfId: "a",
        transport: inProcessTransport("a", network),
        streamIdleTimeoutMs: 10,
      });
      const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });

      b.exposeStreaming("subscription", async (_req, sink) => {
        await sink({
          kind: "head",
          status: 200,
          statusText: "OK",
          headerPairs: [],
          finalUrl: "",
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await sink({ kind: "chunk", bytes: new TextEncoder().encode("later") });
        await sink({ kind: "end", bytesIn: 5 });
      });

      const response = await a.stream("b", "subscription", [], { bodyIdleTimeoutMs: null });
      const body = response.text();
      await vi.advanceTimersByTimeAsync(100);
      await expect(body).resolves.toBe("later");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves streaming HEAD and body waits unbounded by default", async () => {
    vi.useFakeTimers();
    try {
      const network = createInProcessNetwork();
      const a = createRpcClient({ selfId: "a", transport: inProcessTransport("a", network) });
      const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });

      b.exposeStreaming("slow", async (_req, sink) => {
        await new Promise((resolve) => setTimeout(resolve, 100_000));
        await sink({ kind: "head", status: 200, statusText: "OK", headerPairs: [], finalUrl: "" });
        await new Promise((resolve) => setTimeout(resolve, 100_000));
        await sink({ kind: "chunk", bytes: new TextEncoder().encode("eventually") });
        await sink({ kind: "end", bytesIn: 10 });
      });

      const responsePromise = a.stream("b", "slow", []);
      await vi.advanceTimersByTimeAsync(100_000);
      const response = await responsePromise;
      const body = response.text();
      await vi.advanceTimersByTimeAsync(100_000);
      await expect(body).resolves.toBe("eventually");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails an ordinary response body that exceeds its idle deadline", async () => {
    vi.useFakeTimers();
    let handlerAborted = false;
    try {
      const network = createInProcessNetwork();
      const a = createRpcClient({
        selfId: "a",
        transport: inProcessTransport("a", network),
        streamIdleTimeoutMs: 10,
      });
      const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });

      b.exposeStreaming("stalled", async (req, sink) => {
        await sink({ kind: "head", status: 200, statusText: "OK", headerPairs: [], finalUrl: "" });
        await new Promise<void>((resolve) => {
          req.signal.addEventListener(
            "abort",
            () => {
              handlerAborted = true;
              resolve();
            },
            { once: true }
          );
        });
      });

      const response = await a.stream("b", "stalled", []);
      const read = response.body!.getReader().read();
      const rejected = expect(read).rejects.toThrow("response body timed out while idle");
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      await vi.waitFor(() => expect(handlerAborted).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });

  it("delegates stream() to the transport's stream hook when present (connectionless path)", async () => {
    const streamCalls: Array<{ target: string; delivery: unknown; message: unknown }> = [];
    const transport = {
      send: async () => {},
      onMessage: () => () => {},
      stream: async (envelope: { target: string; delivery: unknown; message: unknown }) => {
        streamCalls.push({
          target: envelope.target,
          delivery: envelope.delivery,
          message: envelope.message,
        });
        return new Response("streamed-bytes", { status: 206 });
      },
    };
    const rpc = createRpcClient({ selfId: "do:x", transport });

    const response = await rpc.stream("main", "credentials.proxyFetch", [{ url: "u" }], {
      readOnly: true,
    });
    // The transport hook is used (not the duplex frame path), with a stream-request envelope.
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]!.target).toBe("main");
    expect(streamCalls[0]!.delivery).toMatchObject({ readOnly: true });
    expect(streamCalls[0]!.message).toMatchObject({
      type: "stream-request",
      method: "credentials.proxyFetch",
    });
    expect(streamCalls[0]!.message).not.toHaveProperty("readOnly");
    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe("streamed-bytes");
  });

  it("unwraps native transport streaming for raw reads without switching to framed delivery", async () => {
    const send = vi.fn(async () => {
      throw new Error("This transport delivers streams through its native hook");
    });
    const stream = vi.fn(async () => new Response("native-body", { status: 206 }));
    const rpc = createRpcClient({
      selfId: "panel:raw-reader",
      transport: { send, onMessage: () => () => {}, stream },
    });
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    const result = await rpc.streamReadable("main", "upload", [], {
      signal: abort.signal,
      body,
      headTimeoutMs: 500,
    });
    expect(send).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "main",
        message: expect.objectContaining({ method: "upload" }),
      }),
      abort.signal,
      body,
      500,
      undefined
    );
    expect(result.status).toBe(206);
    await expect(new Response(result.body).text()).resolves.toBe("native-body");
  });

  it("preserves the bridge upload hook when requesting a raw response body", async () => {
    const send = vi.fn(async () => {
      throw new Error("Upload bodies must use the bridge upload hook");
    });
    const streamBody = vi.fn(async () => new Response("uploaded"));
    const rpc = createRpcClient({
      selfId: "panel:uploader",
      transport: { send, onMessage: () => () => {}, streamBody },
    });
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    const abort = new AbortController();
    const result = await rpc.streamReadable("main", "upload", [], { body, signal: abort.signal });
    expect(streamBody).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ type: "stream-request" }) }),
      abort.signal,
      body
    );
    expect(send).not.toHaveBeenCalled();
    await expect(new Response(result.body).text()).resolves.toBe("uploaded");
  });
});

describe("createRpcClient — pending-call policy (§3.4)", () => {
  it("rejects direct-server pendings with CONNECTION_LOST when the transport disconnects", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: fake.transport,
    });

    const call = rpc.call("main", "fs.readFile", ["/x"]);
    const state = track(call);
    await flushMicrotasks();
    expect(state.settled).toBe(false); // still in flight before the drop

    fake.emitStatus("disconnected");

    const err = (await call.catch((e) => e)) as NodeJS.ErrnoException;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Connection lost before the response arrived");
    expect(err.code).toBe("CONNECTION_LOST");
    expect(err).toMatchObject({ errorKind: "transport" });
  });

  it("rejects direct-server pendings as soon as a reconnecting transport leaves connected", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: fake.transport,
    });

    const call = rpc.call("main", "model.getSettings", []);
    fake.emitStatus("connecting");

    await expect(call).rejects.toMatchObject({ code: "CONNECTION_LOST" });
  });

  it("also treats target 'server' as a direct-server call", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: fake.transport,
    });

    const call = rpc.call("server", "ping", []);
    fake.emitStatus("disconnected");

    const err = (await call.catch((e) => e)) as NodeJS.ErrnoException;
    expect(err.code).toBe("CONNECTION_LOST");
  });

  it("treats an explicitly workspace-addressed main target as routed", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "panel:1",
      workspaceId: "workspace:a",
      callerKind: "panel",
      transport: fake.transport,
      onRecovery: fake.onRecovery,
    });

    const call = rpc.call("main", "workspace.operation", [], {
      destination: { kind: "workspace", workspaceId: "workspace:b" },
    });
    const state = track(call);
    fake.emitStatus("disconnected");
    await flushMicrotasks();
    expect(state.settled).toBe(false);

    fake.emitRecovery("cold-recover");
    await expect(call).rejects.toMatchObject({ code: "CONNECTION_LOST" });
  });

  it("leaves routed pendings alive on disconnect, then rejects them on cold-recover", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: fake.transport,
      onRecovery: fake.onRecovery,
    });

    const directCall = rpc.call("main", "fs.readFile", ["/x"]);
    const routedCall = rpc.call("panel:2", "peerMethod", []);
    const directState = track(directCall);
    const routedState = track(routedCall);

    fake.emitStatus("disconnected");
    await flushMicrotasks();

    // Direct-server call is unrecoverable → rejected; routed call survives the flip.
    expect(directState.settled).toBe(true);
    expect((directState.reason as NodeJS.ErrnoException).code).toBe("CONNECTION_LOST");
    expect(routedState.settled).toBe(false);

    fake.emitRecovery("cold-recover");

    const routedErr = (await routedCall.catch((e) => e)) as NodeJS.ErrnoException;
    expect(routedErr.message).toBe("Connection lost before the response arrived");
    expect(routedErr.code).toBe("CONNECTION_LOST");

    // Silence the already-rejected direct promise for the runner.
    await directCall.catch(() => undefined);
  });

  it("does NOT reject routed pendings on resubscribe (inbox replay settles them)", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: fake.transport,
      onRecovery: fake.onRecovery,
    });

    const routedCall = rpc.call("panel:2", "peerMethod", []);
    const routedState = track(routedCall);

    fake.emitRecovery("resubscribe");
    await flushMicrotasks();

    expect(routedState.settled).toBe(false);
  });
});

describe("createRpcClient — explicit call deadlines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not arm an implicit deadline when timeoutMs is omitted", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: fake.transport,
    });

    const call = rpc.call("main", "slow", []);
    const state = track(call);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(state.settled).toBe(false);
  });

  it("respects an explicit timeoutMs", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: fake.transport,
    });

    const call = rpc.call("main", "slow", [], { timeoutMs: 5_000 });
    const state = track(call);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = (await call.catch((e) => e)) as Error;
    expect(err.message).toBe("RPC call timed out after 5000ms");
    await flushMicrotasks();
    const requestId = (fake.sent[0]?.message as { requestId?: string } | undefined)?.requestId;
    expect(fake.sent).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          type: "request-cancel",
          requestId,
        }),
      })
    );
  });

  it("never fires when timeoutMs is 0 (opt out)", async () => {
    const fake = controllableTransport();
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: fake.transport,
    });

    const call = rpc.call("main", "forever", [], { timeoutMs: 0 });
    const state = track(call);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(state.settled).toBe(false);
  });
});

describe("stream() request bodies (§1.6 uploads)", () => {
  it("THROWS when a body is passed over a transport with no body-capable stream path", async () => {
    // The in-process transport (like panel postMessage bridges) has no
    // first-class `stream()` — the duplex envelope fallback cannot carry a
    // request body, and it must never silently drop or base64 it.
    const network = createInProcessNetwork();
    const rpc = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: inProcessTransport("panel:1", network),
    });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    await expect(rpc.stream("main", "gateway.fetch", [{ path: "/x" }], { body })).rejects.toThrow(
      /cannot stream a request body/
    );
  });

  it("passes the body through to a body-capable transport's stream hook", async () => {
    const network = createInProcessNetwork();
    const base = inProcessTransport("panel:1", network);
    const seen: unknown[] = [];
    const transport: EnvelopeRpcTransport = {
      ...base,
      stream: async (_envelope, _signal, body) => {
        seen.push(body);
        return new Response("ok", { status: 200 });
      },
    };
    const rpc = createRpcClient({ selfId: "panel:1", callerKind: "panel", transport });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const resp = await rpc.stream("main", "gateway.fetch", [{ path: "/x" }], { body });
    expect(resp.status).toBe(200);
    expect(seen).toEqual([body]);
  });
});
