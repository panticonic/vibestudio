import { afterEach, describe, expect, it, vi } from "vitest";
import {
  doRefUrl,
  encodeUniversalKey,
  postEventToDurableObject,
  postToDurableObject,
  releaseDurableObjectRelaySeal,
  sealAndDrainDurableObjectRelays,
  streamFromDurableObject,
} from "./workerdRpcRelay.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
import { DURABLE_WORK_READY_HEADER } from "@vibestudio/shared/durableWork";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workerdRpcRelay", () => {
  it("routes userland DOs through the UniversalDO facet host (/_u/)", () => {
    const ref = {
      source: "workspace/workers/example store",
      className: "EventStore",
      objectKey: "ctx/tree:chat",
    };
    expect(doRefUrl(ref, "__lifecycle/prepare now")).toBe(
      `/_u/${encodeURIComponent(encodeUniversalKey(ref))}/__lifecycle/prepare%20now`
    );
  });

  it("routes internal DOs through their static namespace (/_w/), encoding source segments", () => {
    expect(
      doRefUrl(
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: "ctx/tree:chat" },
        "__lifecycle/prepare now"
      )
    ).toBe(
      `/_w/${INTERNAL_DO_SOURCE.split("/").map(encodeURIComponent).join("/")}/WorkspaceDO/ctx%2Ftree%3Achat/__lifecycle/prepare%20now`
    );
  });

  // Inbound dispatch converged on envelope-via-__rpc: the relay POSTs an
  // RpcEnvelope to the DO's single `__rpc` endpoint and unwraps a response
  // envelope; caller attribution rides in `envelope.delivery.caller`.
  function responseEnvelope(result: unknown): Response {
    return new Response(
      JSON.stringify({
        from: "do",
        target: "main",
        delivery: { caller: { callerId: "do", callerKind: "do" } },
        provenance: [],
        message: { type: "response", requestId: "x", result },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  function errorEnvelope(errorData: unknown): Response {
    return new Response(
      JSON.stringify({
        from: "do",
        target: "main",
        delivery: { caller: { callerId: "do", callerKind: "do" } },
        provenance: [],
        message: {
          type: "response",
          requestId: "x",
          error: "human diagnostic may change",
          errorKind: "service",
          errorCode: "RevisionChanged",
          errorData,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  it("POSTs an envelope to __rpc, stamps the dispatch secret, and unwraps the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseEnvelope({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      postToDurableObject(
        { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" },
        "ping",
        ["arg"],
        {
          workerdUrl: "http://127.0.0.1:8787",
          workerdGatewayToken: "gateway-token",
          workerdDispatchSecret: "dispatch-secret",
          idempotencyKey: "idem-1",
          readOnly: true,
        },
        controller.signal
      )
    ).resolves.toEqual({ ok: true });

    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" };
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8787/_u/${encodeURIComponent(encodeUniversalKey(ref))}/__rpc`,
      expect.objectContaining({
        signal: controller.signal,
        headers: expect.objectContaining({
          Authorization: "Bearer gateway-token",
          "X-Vibestudio-Dispatch-Secret": "dispatch-secret",
        }),
      })
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.delivery).toMatchObject({ idempotencyKey: "idem-1", readOnly: true });
    expect(body.message).toMatchObject({ type: "request", method: "ping", args: ["arg"] });
  });

  it("surfaces durable-work readiness from caller-attributed DO relays", async () => {
    const response = responseEnvelope({ ok: true });
    response.headers.set(DURABLE_WORK_READY_HEADER, "channel-delivery,agent-effect");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const onWorkReady = vi.fn();

    await postToDurableObject(
      { source: "workers/channel", className: "ChannelDO", objectKey: "task-1" },
      "publish",
      [],
      {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
        onWorkReady,
      }
    );

    expect(onWorkReady).toHaveBeenCalledOnce();
    expect(onWorkReady).toHaveBeenCalledWith(["channel-delivery", "agent-effect"]);
  });

  it("preserves structured service failures while unwrapping the DO envelope", async () => {
    const errorData = {
      code: "RevisionChanged",
      message: "exact frontier advanced",
      expectedFrontierId: "frontier:old",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorEnvelope(errorData)));
    await expect(
      postToDurableObject(
        { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" },
        "ping",
        [],
        { workerdUrl: "http://127.0.0.1:8787", workerdGatewayToken: "gateway-token" }
      )
    ).rejects.toMatchObject({
      name: "RemoteRpcError",
      errorKind: "service",
      code: "RevisionChanged",
      errorData,
    });
  });

  it("relays enriched argument-validation issues (parameter names + machine paths) from a DO receiver", async () => {
    // The exact errorData shape the shared argument-validation formatter emits
    // (invalidArgumentsErrorData): both the original numeric path and the
    // author-facing parameter name must reach the caller unchanged.
    const errorData = {
      code: "invalid-arguments",
      method: "WorkspacePresentationDO.indexPanel",
      issues: [
        {
          code: "invalid_type",
          path: [2],
          message: "Expected object, received null",
          expected: "object",
          received: "null",
          parameter: "options",
          parameterPath: ["options"],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorEnvelope(errorData)));
    await expect(
      postToDurableObject(
        { source: "workers/presentation", className: "WorkspacePresentationDO", objectKey: "main" },
        "indexPanel",
        [{ id: "p" }, "e", null],
        { workerdUrl: "http://127.0.0.1:8787", workerdGatewayToken: "gateway-token" }
      )
    ).rejects.toMatchObject({ name: "RemoteRpcError", errorData });
  });

  it("preserves structured non-OK failures and appends the exact DO identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "schema refused",
            errorKind: "service",
            errorCode: "DO_SCHEMA_INCOMPATIBLE",
            errorData: { reason: "shape-drift" },
          }),
          { status: 500 }
        )
      )
    );
    await expect(
      postToDurableObject(
        { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" },
        "ping",
        [],
        { workerdUrl: "http://127.0.0.1:8787", workerdGatewayToken: "gateway-token" }
      )
    ).rejects.toMatchObject({
      name: "RemoteRpcError",
      code: "DO_SCHEMA_INCOMPATIBLE",
      errorKind: "service",
      message: expect.stringContaining("workers/agent:AgentDO/channel-1"),
      errorData: {
        reason: "shape-drift",
        durableObject: {
          source: "workers/agent",
          className: "AgentDO",
          objectKey: "channel-1",
        },
      },
    });
  });

  it("seals retirement admission, drains accepted relays, and reopens after the boundary", async () => {
    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "retiring" };
    const targetId = "do:workers/agent:AgentDO:retiring";
    let releaseFetch!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        await blocked;
        return responseEnvelope({ first: true });
      })
      .mockImplementation(async () => responseEnvelope({ reopened: true }));
    vi.stubGlobal("fetch", fetchMock);

    const admitted = postToDurableObject(ref, "first", [], {
      workerdUrl: "http://127.0.0.1:8787",
      workerdGatewayToken: "gateway-token",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const drained = sealAndDrainDurableObjectRelays(targetId, "test-retirement");

    await expect(
      postToDurableObject(ref, "late", [], {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
      })
    ).rejects.toMatchObject({ code: "DO_NOT_CREATED" });
    let drainSettled = false;
    void drained.then(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    releaseFetch();
    await expect(admitted).resolves.toEqual({ first: true });
    await drained;
    releaseDurableObjectRelaySeal(targetId, "test-retirement");

    await expect(
      postToDurableObject(ref, "after-reactivation", [], {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
      })
    ).resolves.toEqual({ reopened: true });
  });

  it("reports a structured maintenance fence instead of reactivating the target", async () => {
    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "maintained" };
    const targetId = "do:workers/agent:AgentDO:maintained";
    await sealAndDrainDurableObjectRelays(targetId, "op-1", {
      code: "DO_MAINTENANCE_IN_PROGRESS",
      message: "storage reset is in progress",
      errorData: { operationId: "op-1" },
    });
    await expect(
      postToDurableObject(ref, "late", [], {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
      })
    ).rejects.toMatchObject({
      name: "RemoteRpcError",
      code: "DO_MAINTENANCE_IN_PROGRESS",
      errorKind: "service",
      errorData: { operationId: "op-1" },
    });
    releaseDurableObjectRelaySeal(targetId, "op-1");
  });

  it("keeps independent seals until their exact owners release them", async () => {
    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "owned" };
    const targetId = "do:workers/agent:AgentDO:owned";
    await sealAndDrainDurableObjectRelays(targetId, "maintenance");
    await sealAndDrainDurableObjectRelays(targetId, "retirement");
    releaseDurableObjectRelaySeal(targetId, "maintenance");
    await expect(
      postToDurableObject(ref, "still-sealed", [], {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
      })
    ).rejects.toMatchObject({ code: "DO_NOT_CREATED" });
    releaseDurableObjectRelaySeal(targetId, "retirement");
  });

  it("drains admitted events before completing a seal", async () => {
    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "eventful" };
    const targetId = "do:workers/agent:AgentDO:eventful";
    let releaseFetch!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await blocked;
        return new Response("{}", { status: 200 });
      })
    );
    const event = postEventToDurableObject(
      ref,
      "changed",
      {},
      {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
      }
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const drained = sealAndDrainDurableObjectRelays(targetId, "event-test");
    let settled = false;
    void drained.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFetch();
    await event;
    await drained;
    releaseDurableObjectRelaySeal(targetId, "event-test");
  });

  it("keeps a streaming relay admitted until its response body is cancelled", async () => {
    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "streaming" };
    const targetId = "do:workers/agent:AgentDO:streaming";
    let upstreamCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                upstreamCancelled = true;
              },
            }),
            { status: 200 }
          )
      )
    );

    const response = await streamFromDurableObject(
      ref,
      "updates",
      [],
      { workerdUrl: "http://127.0.0.1:8787", workerdGatewayToken: "gateway-token" },
      new AbortController().signal
    );
    const drained = sealAndDrainDurableObjectRelays(targetId, "stream-test");
    let settled = false;
    void drained.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await response.body!.cancel("consumer closed");
    await drained;
    expect(upstreamCancelled).toBe(true);
    releaseDurableObjectRelaySeal(targetId, "stream-test");
  });

  it("preserves structured non-OK failures when opening a stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "schema refused",
            errorKind: "service",
            errorCode: "DO_SCHEMA_INCOMPATIBLE",
            errorData: { reason: "shape-drift" },
          }),
          { status: 500 }
        )
      )
    );

    await expect(
      streamFromDurableObject(
        { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" },
        "updates",
        [],
        { workerdUrl: "http://127.0.0.1:8787", workerdGatewayToken: "gateway-token" },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      name: "RemoteRpcError",
      code: "DO_SCHEMA_INCOMPATIBLE",
      errorKind: "service",
      errorData: {
        reason: "shape-drift",
        durableObject: {
          source: "workers/agent",
          className: "AgentDO",
          objectKey: "channel-1",
        },
      },
    });
  });

  it("annotates fetch failures with the DO relay URL and low-level cause", async () => {
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw fetchError;
      })
    );

    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" };
    const url = `http://127.0.0.1:8787/_u/${encodeURIComponent(encodeUniversalKey(ref))}/__rpc`;

    await expect(
      postToDurableObject(ref, "ping", [], {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
      })
    ).rejects.toThrow(
      `DO RPC fetch to ${url} failed: fetch failed (cause: Error: other side closed code=UND_ERR_SOCKET)`
    );
  });

  it("carries caller identity in the envelope's delivery.caller", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseEnvelope({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await postToDurableObject(
      { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" },
      "ping",
      [],
      {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
        callerId: "panel:parent-entity",
        callerKind: "panel",
        callerPanelId: "parent-slot",
        userId: "usr_alice",
      }
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.delivery.caller).toEqual({
      callerId: "panel:parent-entity",
      callerKind: "panel",
      callerPanelId: "parent-slot",
      userId: "usr_alice",
    });
  });

  it("returns the raw DO stream and keeps delivery lifetime separate from causal provenance", async () => {
    const upstream = new Response("subscription bytes", {
      headers: { "Content-Type": "application/x-ndjson" },
    });
    const fetchMock = vi.fn().mockResolvedValue(upstream);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const causalParent = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:agent-1",
      head: "event:7",
      invocationId: "invocation:subscribe",
    };

    const response = await streamFromDurableObject(
      { source: "workers/channel", className: "ChannelDO", objectKey: "channel-1" },
      "subscribe",
      ["panel:slot-a", {}],
      {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
        callerId: "panel:nav-a",
        callerKind: "panel",
        causalParent,
      },
      controller.signal
    );

    expect(response.status).toBe(upstream.status);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    await expect(response.text()).resolves.toBe("subscription bytes");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    const body = JSON.parse(String(init.body));
    expect(body.message).toMatchObject({
      type: "stream-request",
      method: "subscribe",
      causalParent,
    });
    expect(body.delivery.caller).not.toHaveProperty("causalParent");
  });
});
