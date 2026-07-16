import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { doRefKey, doRefUrl, encodeUniversalKey, DODispatch } from "./doDispatch.js";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";

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
      await expect(dispatch.dispatch(ref, "ping", "arg")).rejects.toBe(fetchFailure);

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

      await expect(dispatch.dispatch(makeRef(), "getRun")).rejects.toBe(fetchFailure);
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
      expect(body["__caller"]).toEqual({ callerId: "main", callerKind: "server" });
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
