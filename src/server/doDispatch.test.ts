import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { doRefKey, doRefUrl, encodeUniversalKey, DODispatch } from "./doDispatch.js";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
import { getWorkerdConnectionDispatcher } from "./workerdRpcRelay.js";

/** Expected workerd path for a userland DO ref (UniversalDO facet host). */
function userlandUrl(ref: DORef, methodPath: string): string {
  return `/_u/${encodeURIComponent(encodeUniversalKey(ref))}/${methodPath}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRef(overrides: Partial<DORef> = {}): DORef {
  return {
    source: "workers/agent-worker",
    className: "AiChatWorker",
    objectKey: "ch-123",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("doRefKey", () => {
  it("produces the canonical source:className/objectKey string", () => {
    const ref = makeRef();
    expect(doRefKey(ref)).toBe("workers/agent-worker:AiChatWorker/ch-123");
  });

  it("preserves slashes in source path", () => {
    const ref = makeRef({ source: "workspace/workers/deep" });
    expect(doRefKey(ref)).toBe("workspace/workers/deep:AiChatWorker/ch-123");
  });
});

describe("doRefUrl", () => {
  it("routes a userland DO through the UniversalDO facet host (/_u/)", () => {
    const ref = makeRef();
    expect(doRefUrl(ref, "onChannelEvent")).toBe(userlandUrl(ref, "onChannelEvent"));
    // The packed key round-trips source|className|objectKey.
    expect(encodeUniversalKey(ref)).toBe("workers%2Fagent-worker|AiChatWorker|ch-123");
  });

  it("routes an internal DO through its static namespace (/_w/)", () => {
    const ref = makeRef({
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "ws-1",
    });
    expect(doRefUrl(ref, "lifecycleListLeases")).toBe(
      `/_w/${INTERNAL_DO_SOURCE.split("/").map(encodeURIComponent).join("/")}/WorkspaceDO/ws-1/lifecycleListLeases`
    );
  });

  it("escapes special characters in the packed userland key", () => {
    const ref = makeRef({ className: "My Worker", objectKey: "key/with:special chars" });
    const url = doRefUrl(ref, "method");
    expect(url).toBe(userlandUrl(ref, "method"));
    // The packed key is opaque-encoded; decoding the segment recovers it.
    expect(decodeURIComponent(url.split("/")[2]!)).toBe(encodeUniversalKey(ref));
  });

  it("encodes method path segments while preserving method slashes", () => {
    const ref = makeRef();
    const url = doRefUrl(ref, "__lifecycle/some method");
    expect(url).toBe(userlandUrl(ref, "__lifecycle/some%20method"));
  });
});

describe("DODispatch", () => {
  let dispatch: DODispatch;

  beforeEach(() => {
    vi.unstubAllGlobals();
    dispatch = new DODispatch();
    dispatch.setAuthorityAttester(() => ({}) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("dispatch without token-backed configuration", () => {
    it("fails closed", async () => {
      const ref = makeRef();
      await expect(dispatch.dispatch(ref, "ping")).rejects.toThrow(
        "DODispatch requires token-backed workerd configuration"
      );
      await expect(
        dispatch.dispatchLifecycle(ref, "prepare", {
          epoch: "test",
          mode: "suspend",
          reason: "test",
          deadlineMs: 1,
        })
      ).rejects.toThrow("DODispatch requires token-backed workerd configuration");
      await expect(dispatch.dispatchAlarm(ref)).rejects.toThrow(
        "DODispatch requires token-backed workerd configuration"
      );
    });
  });

  describe("dispatch with token-backed workerd URL", () => {
    it("does not impose Undici response deadlines on DO method lifetimes", async () => {
      const tokenManager = new TokenManager();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ nextAlarm: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");

      await expect(dispatch.dispatchAlarm(makeRef())).resolves.toEqual({ nextAlarm: null });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        dispatcher: getWorkerdConnectionDispatcher(),
      });
    });

    it("reports a long-running agent alarm as healthy work and then completion", async () => {
      vi.useFakeTimers();
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let finish!: (response: Response) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            })
        )
      );
      dispatch.setTokenManager(new TokenManager());
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");

      const pending = dispatch.dispatchAlarm(makeRef());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(info).toHaveBeenCalledWith(expect.stringContaining("state=working"));
      expect(warn).not.toHaveBeenCalled();

      finish(
        new Response(JSON.stringify({ nextAlarm: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      await pending;
      expect(info).toHaveBeenCalledWith(expect.stringContaining("state=completed"));
    });

    it("forwards scheduler cancellation to exactly the owned alarm transport", async () => {
      const tokenManager = new TokenManager();
      const controller = new AbortController();
      const transportAborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      });
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        expect(init.signal).toBe(controller.signal);
        return transportAborted;
      });

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");

      const pending = dispatch.dispatchAlarm(makeRef(), controller.signal);
      const rejected = expect(pending).rejects.toBeInstanceOf(Error);
      const reason = new Error("alarm scheduler quiesced");
      controller.abort(reason);

      await rejected;
      await expect(pending).rejects.toBe(reason);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("keeps test-scoped alarm authority active for the complete durable invocation", async () => {
      const tokenManager = new TokenManager();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ nextAlarm: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      const authorization = {
        nonce: "alarm-parent-nonce",
        context: {},
      } as never;
      const policy = {
        policyId: "system-test:permissions-list",
        kind: "orchestrator" as const,
      };
      const scopeCalls: Array<{
        receiverRuntimeId: string;
        authorization: unknown;
      }> = [];

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setAuthorityAttester(() => authorization);
      dispatch.setAuthorityParentRunner(async (receiverRuntimeId, scopedAuthorization, invoke) => {
        scopeCalls.push({ receiverRuntimeId, authorization: scopedAuthorization });
        return await invoke();
      });

      await expect(dispatch.dispatchAlarm(makeRef(), undefined, policy)).resolves.toEqual({
        nextAlarm: null,
      });

      expect(scopeCalls).toEqual([
        {
          receiverRuntimeId: "do:workers/agent-worker:AiChatWorker:ch-123",
          authorization: expect.objectContaining({
            nonce: "alarm-parent-nonce",
            context: { testPolicy: policy },
          }),
        },
      ]);
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
        __caller: { authorization: unknown };
      };
      expect(body.__caller.authorization).toEqual(scopeCalls[0]!.authorization);
    });

    it("does not replay a semantic call after connection refusal", async () => {
      const tokenManager = new TokenManager();
      const getWorkerdUrl = vi.fn().mockReturnValue("http://127.0.0.1:10001");
      const fetchFailure = Object.assign(new TypeError("fetch failed"), {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:10001"),
      });
      const fetchMock = vi.fn().mockRejectedValue(fetchFailure);

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(getWorkerdUrl);
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");

      const ref = makeRef();
      const failure = dispatch.dispatch(ref, "ping", "arg");
      await expect(failure).rejects.toThrow(
        `DO dispatch fetch to http://127.0.0.1:10001${userlandUrl(ref, "ping")} failed: ` +
          "fetch failed (cause: Error: connect ECONNREFUSED 127.0.0.1:10001)"
      );
      await expect(failure).rejects.toMatchObject({ cause: fetchFailure });

      expect(getWorkerdUrl).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `http://127.0.0.1:10001${userlandUrl(ref, "ping")}`,
        expect.any(Object)
      );
    });

    it("does not duplicate an ambiguous fetch failure", async () => {
      const tokenManager = new TokenManager();
      const fetchFailure = new TypeError("fetch failed");
      const fetchMock = vi.fn().mockRejectedValue(fetchFailure);

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");

      const ref = makeRef();
      const failure = dispatch.dispatch(ref, "getRun");
      await expect(failure).rejects.toThrow(
        `DO dispatch fetch to http://127.0.0.1:10001${userlandUrl(ref, "getRun")} failed: fetch failed`
      );
      await expect(failure).rejects.toMatchObject({ cause: fetchFailure });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stamps verified server caller identity for lifecycle dispatch", async () => {
      const tokenManager = new TokenManager();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");

      const ref = makeRef();
      await expect(
        dispatch.dispatchLifecycle(ref, "resume", {
          epoch: "epoch-1",
          previousGeneration: 1,
          currentGeneration: 2,
          reason: "planned",
        })
      ).resolves.toEqual({ ok: true });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `http://127.0.0.1:10001${userlandUrl(ref, "__lifecycle/resume")}`
      );
      expect(body["__caller"]).toMatchObject({ callerId: "main", callerKind: "server" });
      expect((body["__caller"] as { authorization?: unknown }).authorization).toEqual({});
      expect(body["__parentId"]).toBe("main");
    });

    it("reconstructs structured DO application failures without parsing prose", async () => {
      const tokenManager = new TokenManager();
      const errorData = {
        code: "InvalidReference",
        message: "revision does not resolve",
        referenceKind: "head",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: "revision does not resolve",
              errorKind: "application",
              errorData,
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          )
        )
      );
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");

      await expect(dispatch.dispatch(makeRef(), "resolve")).rejects.toMatchObject({
        name: "RemoteRpcError",
        message: "revision does not resolve",
        errorKind: "application",
        errorData,
      });
    });
  });
});
