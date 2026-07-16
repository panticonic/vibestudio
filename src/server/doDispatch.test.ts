import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { doRefKey, doRefUrl, encodeUniversalKey, DODispatch } from "./doDispatch.js";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import { EVAL_DO_SOURCE, WORKSPACE_DO_SOURCE } from "./internalDOs/productBootManifest.js";
import { createHostCaller } from "@vibestudio/shared/serviceDispatcher";
import { attestDirectRpc } from "./services/authorityRuntime.js";

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
      source: WORKSPACE_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "ws-1",
    });
    expect(doRefUrl(ref, "lifecycleListLeases")).toBe(
      `/_w/${WORKSPACE_DO_SOURCE.split("/").map(encodeURIComponent).join("/")}/WorkspaceDO/ws-1/lifecycleListLeases`
    );
  });

  it("routes a capability-bearing product seed through its exact static namespace", () => {
    const ref = makeRef({ source: EVAL_DO_SOURCE, className: "EvalDO", objectKey: "eval-1" });
    expect(doRefUrl(ref, "run")).toBe(`/_w/product/eval/EvalDO/eval-1/run`);
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
    dispatch.setAuthorityAttester((ref, method) =>
      attestDirectRpc({
        caller: createHostCaller("main", "server", {
          userId: "system",
          handle: "system",
        }),
        source: ref.source,
        className: ref.className,
        objectKey: ref.objectKey,
        method,
        workspaceId: "test-workspace",
        workspaceMember: true,
        sessionId: "test-session",
      })
    );
  });

  describe("dispatch without token-backed configuration", () => {
    it("fails closed", async () => {
      const ref = makeRef();
      await expect(dispatch.dispatch(ref, "ping")).rejects.toThrow(
        "DODispatch requires token-backed workerd configuration"
      );
      await expect(dispatch.dispatchLifecycle(ref, "prepare", {})).rejects.toThrow(
        "DODispatch requires token-backed workerd configuration"
      );
      await expect(dispatch.dispatchAlarm(ref)).rejects.toThrow(
        "DODispatch requires token-backed workerd configuration"
      );
    });
  });

  describe("dispatch with token-backed workerd URL", () => {
    it("checks exact-object liveness before minting a token or sending a request", async () => {
      const tokenManager = new TokenManager();
      const ensureToken = vi.spyOn(tokenManager, "ensureToken");
      const inactive = new Error("Durable Object runtime entity is not active");
      const ensureDispatchable = vi.fn().mockRejectedValue(inactive);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setEnsureDispatchableDO(ensureDispatchable);

      const ref = makeRef();
      await expect(dispatch.dispatch(ref, "ping")).rejects.toBe(inactive);

      expect(ensureDispatchable).toHaveBeenCalledWith(ref.source, ref.className, ref.objectKey);
      expect(ensureToken).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("retries fetch failures after ensuring the DO and refreshes the workerd URL", async () => {
      const tokenManager = new TokenManager();
      const ensureDO = vi.fn().mockResolvedValue(undefined);
      const getWorkerdUrl = vi
        .fn()
        .mockReturnValueOnce("http://127.0.0.1:10001")
        .mockReturnValueOnce("http://127.0.0.1:10002");
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(getWorkerdUrl);
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setEnsureDispatchableDO(ensureDO);

      const ref = makeRef();
      await expect(dispatch.dispatch(ref, "ping", "arg")).resolves.toEqual({ ok: true });

      expect(ensureDO).toHaveBeenCalledWith(ref.source, ref.className, ref.objectKey);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `http://127.0.0.1:10001${userlandUrl(ref, "ping")}`,
        expect.any(Object)
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `http://127.0.0.1:10002${userlandUrl(ref, "ping")}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer workerd-gateway-token",
            "X-Vibestudio-Dispatch-Secret": "dispatch-secret",
          }),
        })
      );
    });

    it("preserves structured DO error codes across the HTTP dispatch boundary", async () => {
      const tokenManager = new TokenManager();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: "source bundle is too large",
              errorCode: "EVAL_RESOURCE_LIMIT",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          )
        )
      );
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");

      const failure = await dispatch.dispatch(makeRef(), "prepare").catch((error) => error);
      expect(failure).toMatchObject({
        message: "DO dispatch failed (500): source bundle is too large",
        code: "EVAL_RESOURCE_LIMIT",
      });
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
      expect(body["__caller"]).toMatchObject({
        callerId: "main",
        callerKind: "server",
        authorization: {
          method: "__lifecycle/resume",
          context: { host: expect.stringMatching(/^host:/) },
        },
      });
      expect(body["__parentId"]).toBe("main");
    });
  });
});
