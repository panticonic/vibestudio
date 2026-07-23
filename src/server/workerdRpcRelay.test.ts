import { afterEach, describe, expect, it, vi } from "vitest";
import {
  doRefUrl,
  encodeUniversalKey,
  postToDurableObject,
  releaseDurableObjectRelaySeal,
  sealAndDrainDurableObjectRelays,
  streamFromDurableObject,
} from "./workerdRpcRelay.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";

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
        }
      )
    ).resolves.toEqual({ ok: true });

    const ref = { source: "workers/agent", className: "AgentDO", objectKey: "channel-1" };
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8787/_u/${encodeURIComponent(encodeUniversalKey(ref))}/__rpc`,
      expect.objectContaining({
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
    const drained = sealAndDrainDurableObjectRelays(targetId);

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
    releaseDurableObjectRelaySeal(targetId);

    await expect(
      postToDurableObject(ref, "after-reactivation", [], {
        workerdUrl: "http://127.0.0.1:8787",
        workerdGatewayToken: "gateway-token",
      })
    ).resolves.toEqual({ reopened: true });
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

    expect(response).toBe(upstream);
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
