import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { decodeRpcJson, encodeRpcJson, RemoteRpcError, type RpcEnvelope } from "@vibestudio/rpc";
import { doRefKey, doRefUrl, encodeUniversalKey, DODispatch } from "./doDispatch.js";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
import {
  getWorkerdConnectionDispatcher,
  releaseDurableObjectRelaySeal,
  sealAndDrainDurableObjectRelays,
} from "./workerdRpcRelay.js";
import type { AuthorizationContext } from "@vibestudio/rpc";
import type { AttestedCaller, DirectAuthorityAttestation } from "@vibestudio/rpc/internal";

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

const testCode = `code:workers/agent-worker@${"a".repeat(64)}` as const;
const testAuthorizationContext: AuthorizationContext = {
  authorizingOrigin: { kind: "code", principal: testCode },
  host: null,
  actingUser: "user:test",
  entity: null,
  incarnation: null,
  executingCode: {
    principal: testCode,
    requested: [],
    sourceLineage: { class: "internal", externalKeys: [] },
  },
  initiatorChain: [testCode],
  ownerChain: ["user:test"],
  agentBinding: null,
  executionSession: null,
  testPolicy: null,
  workspace: { workspaceId: "ws", member: true, role: "member", revision: "1" },
  session: { id: "s", audience: "do:x", version: "1", expiresAt: 10_000 },
};

function testAttestation(
  overrides: Partial<DirectAuthorityAttestation> = {}
): DirectAuthorityAttestation {
  return {
    audience: "do:workers/agent-worker:AiChatWorker:ch-123",
    method: "test",
    effect: { kind: "open" },
    capability: "rpc:test",
    resourceKey: "do:workers/agent-worker:AiChatWorker:ch-123",
    issuedAt: 10,
    expiresAt: 1_000,
    nonce: "12345678-1234-4123-8123-123456789abc",
    context: testAuthorizationContext,
    grants: [],
    capabilityDefinitionDigest: "-",
    resourceType: "rpc:test",
    provider: "-",
    providerExecutionDigest: "-",
    ...overrides,
  };
}

function rpcSuccessResponse(
  init: RequestInit | undefined,
  result: unknown,
  metadata?: Record<string, unknown>
): Response {
  const request = decodeRpcJson(String(init?.body)) as RpcEnvelope;
  if (request.message.type !== "request") throw new Error("expected an RPC request envelope");
  return new Response(
    encodeRpcJson({
      from: request.target,
      target: request.from,
      delivery: { caller: request.delivery.caller },
      provenance: request.provenance,
      message: {
        type: "response",
        requestId: request.message.requestId,
        result,
        ...(metadata ? { metadata } : {}),
      },
    } satisfies RpcEnvelope),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
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
    dispatch = new DODispatch(async () => undefined);
    dispatch.setExecutableAdmissionResolver(() => ({
      executableVersion: "test-executable",
      incarnationVersion: "test-executable",
      props: { stateArgs: null, image: null },
    }));
    dispatch.setAuthorityAttester(() => testAttestation());
    dispatch.setAuthorityParentRunner(async (_receiverRuntimeId, _authorization, invoke) =>
      invoke()
    );
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
          phase: "release",
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
    it("uses exact preparing admission and normal host attestation for clone initialization", async () => {
      const ordinary = vi.fn(async () => {});
      const prepared = vi.fn(async () => {});
      const guarded = new DODispatch(ordinary);
      guarded.setPreparingTargetReady(prepared);
      const attest = vi.fn(() => testAttestation({ method: "__lifecycle/initializeClone" }));
      guarded.setAuthorityAttester(attest);
      guarded.setAuthorityParentRunner(async (_id, _authorization, invoke) => invoke());
      guarded.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));
      guarded.setTokenManager(new TokenManager());
      guarded.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      guarded.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      const transport = vi.fn(async () => new Response('{"value":null}', { status: 200 }));
      vi.stubGlobal("fetch", transport);
      const ref = makeRef();
      const witness = {
        provenance: {
          storage: "snapshot" as const,
          operationContextId: "target-context",
          sourceEntityId: `do:${ref.source}:${ref.className}:source`,
          sourceContextId: "source-context",
          sourceAuthoritySessionId: "source-session",
          sourceBuildKey: "b".repeat(64),
          sourceExecutionDigest: "e".repeat(64),
        },
        source: { ...ref, objectKey: "source" },
        sourceContextId: "source-context",
        target: ref,
        targetContextId: "target-context",
        authoritySessionId: "clone-session",
        buildKey: "b".repeat(64),
        executionDigest: "e".repeat(64),
      };
      await guarded.dispatchLifecycle(ref, "initializeClone", witness);
      expect(prepared).toHaveBeenCalledWith(ref, witness);
      expect(ordinary).not.toHaveBeenCalled();
      expect(attest).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledOnce();
      prepared.mockRejectedValueOnce(new Error("preparation witness mismatch"));
      await expect(guarded.dispatchLifecycle(ref, "initializeClone", witness)).rejects.toThrow(
        "preparation witness mismatch"
      );
      expect(transport).toHaveBeenCalledOnce();
    });

    it("fails closed before authority or transport when no userland readiness barrier exists", async () => {
      expect(() => new DODispatch(undefined as never)).toThrow(
        /requires a userland Durable Object readiness barrier/
      );
    });

    it("establishes exact readiness before authority resolution and invokes only after success", async () => {
      const events: string[] = [];
      let readinessAttempts = 0;
      dispatch = new DODispatch(async () => {
        events.push("ready");
        readinessAttempts += 1;
        if (readinessAttempts === 1) throw new Error("sealed image unavailable");
      });
      dispatch.setAuthorityParentRunner(async (_receiverRuntimeId, _authorization, invoke) =>
        invoke()
      );
      dispatch.setAuthorityAttester(() => {
        events.push("attest");
        return testAttestation();
      });
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        events.push("invoke");
        return rpcSuccessResponse(init, { ok: true });
      });
      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(new TokenManager());
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      await expect(dispatch.dispatch(makeRef(), "ping")).rejects.toThrow(
        "sealed image unavailable"
      );
      expect(events).toEqual(["ready"]);
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(dispatch.dispatch(makeRef(), "ping")).resolves.toEqual({ ok: true });
      expect(events).toEqual(["ready", "ready", "attest", "invoke"]);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("guards ordinary, held, lifecycle, and alarm dispatch through the same barrier", async () => {
      const ensureReady = vi.fn(async (_ref: DORef) => undefined);
      const guarded = new DODispatch(ensureReady);
      guarded.setAuthorityAttester(() => testAttestation());
      guarded.setAuthorityParentRunner(async (_id, _authorization, invoke) => invoke());
      guarded.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));
      guarded.setTokenManager(new TokenManager());
      guarded.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      guarded.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (!url.endsWith("/__rpc")) {
            return new Response(JSON.stringify({ value: null }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          const envelope = decodeRpcJson(String(init?.body)) as RpcEnvelope;
          if (envelope.message.type !== "request") throw new Error("Expected RPC request");
          return rpcSuccessResponse(
            init,
            envelope.message.method === "__alarm" ? { nextAlarm: null } : null
          );
        })
      );
      const ref = makeRef();

      await guarded.dispatch(ref, "ordinary");
      await guarded.dispatchHeld(ref, "held");
      await guarded.dispatchHeldWithSignal(ref, new AbortController().signal, "heldSignal");
      await guarded.dispatchLifecycle(ref, "prepare", {
        epoch: "test",
        phase: "release",
        mode: "suspend",
        reason: "test",
        deadlineMs: 1,
      });
      await guarded.dispatchAlarm(ref);

      expect(ensureReady).toHaveBeenCalledTimes(5);
      expect(ensureReady.mock.calls.every(([candidate]) => candidate === ref)).toBe(true);
    });

    it("refuses server dispatch and alarms while exact-target maintenance is sealed", async () => {
      dispatch.setTokenManager(new TokenManager());
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));
      const ref = makeRef();
      const targetId = `do:${ref.source}:${ref.className}:${ref.objectKey}`;
      await sealAndDrainDurableObjectRelays(targetId, "maintenance-test", {
        code: "DO_MAINTENANCE_IN_PROGRESS",
        message: "maintenance",
      });
      await expect(dispatch.dispatch(ref, "ping")).rejects.toMatchObject({
        code: "DO_MAINTENANCE_IN_PROGRESS",
      });
      await expect(dispatch.dispatchAlarm(ref)).rejects.toMatchObject({
        code: "DO_MAINTENANCE_IN_PROGRESS",
      });
      releaseDurableObjectRelaySeal(targetId, "maintenance-test");
    });

    it("strips a work-ready receipt from the result and notifies its owner", async () => {
      const ref = makeRef();
      const observer = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) =>
          Promise.resolve(
            rpcSuccessResponse(
              init,
              { committed: true },
              {
                durableWorkReady: [
                  "workspace-publication",
                  "channel-delivery",
                  "workspace-publication",
                ],
              }
            )
          )
        )
      );
      dispatch.setTokenManager(new TokenManager());
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));
      dispatch.setWorkReadyObserver(observer);

      await expect(dispatch.dispatch(ref, "enqueue")).resolves.toEqual({ committed: true });
      expect(observer).toHaveBeenCalledWith({
        owner: ref,
        queues: ["channel-delivery", "workspace-publication"],
      });
    });

    it("keeps the authority parent until a cancelled RPC reaches its terminal response", async () => {
      const controller = new AbortController();
      let initialStarted!: () => void;
      let cancelSent!: () => void;
      const started = new Promise<void>((resolve) => {
        initialStarted = resolve;
      });
      const cancellationSent = new Promise<void>((resolve) => {
        cancelSent = resolve;
      });
      let releaseTerminal!: () => void;
      let terminalReleased = false;
      let parentReleased = false;
      const ref = makeRef();
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const envelope = decodeRpcJson(String(init?.body)) as RpcEnvelope;
        if (envelope.message.type === "request-cancel") {
          expect(parentReleased).toBe(false);
          cancelSent();
          return new Response(encodeRpcJson({}), { status: 200 });
        }
        if (envelope.message.type !== "request") throw new Error("expected unary RPC request");
        expect(init?.signal).toBeUndefined();
        initialStarted();
        const terminalEnvelope: RpcEnvelope = {
          from: envelope.target,
          target: envelope.from,
          delivery: { caller: envelope.delivery.caller },
          provenance: envelope.provenance,
          message: {
            type: "response",
            requestId: envelope.message.requestId,
            result: { completed: true },
          },
        };
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              releaseTerminal = () => {
                if (terminalReleased) return;
                terminalReleased = true;
                stream.enqueue(new TextEncoder().encode(encodeRpcJson(terminalEnvelope)));
                stream.close();
              };
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      dispatch.setAuthorityParentRunner(async (_id, _authorization, invoke) => {
        try {
          return await invoke();
        } finally {
          parentReleased = true;
        }
      });
      dispatch.setTokenManager(new TokenManager());
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      let settled = false;
      const operation = dispatch
        .dispatchHeldWithSignal(ref, controller.signal, "held")
        .finally(() => {
          settled = true;
        });
      await started;
      const reason = new Error("driver quiesced");
      controller.abort(reason);
      await cancellationSent;
      expect(settled).toBe(false);
      expect(parentReleased).toBe(false);

      releaseTerminal();
      await expect(operation).rejects.toBe(reason);
      expect(parentReleased).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("joins a failed cancellation delivery and preserves the terminal cleanup failure", async () => {
      const controller = new AbortController();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let markAdmitted!: () => void;
      const admitted = new Promise<void>((resolve) => {
        markAdmitted = resolve;
      });
      let markCancelFailed!: () => void;
      const cancelFailed = new Promise<void>((resolve) => {
        markCancelFailed = resolve;
      });
      let releaseTerminal!: () => void;
      let terminalReleased = false;
      const cancellationFailure = new Error("cancel endpoint unavailable");
      let parentReleased = false;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const envelope = decodeRpcJson(String(init?.body)) as RpcEnvelope;
        if (envelope.message.type === "request-cancel") {
          markCancelFailed();
          throw cancellationFailure;
        }
        if (envelope.message.type !== "request") throw new Error("expected unary RPC request");
        markStarted();
        const terminalEnvelope: RpcEnvelope = {
          from: envelope.target,
          target: envelope.from,
          delivery: { caller: envelope.delivery.caller },
          provenance: envelope.provenance,
          message: {
            type: "response",
            requestId: envelope.message.requestId,
            error: {
              message: "remote cleanup failed",
              errorKind: "internal",
              code: "CLEANUP_FAILED",
              errorData: { owner: "receiver" },
            },
          },
        };
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              releaseTerminal = () => {
                if (terminalReleased) return;
                terminalReleased = true;
                stream.enqueue(new TextEncoder().encode(encodeRpcJson(terminalEnvelope)));
                stream.close();
              };
            },
            pull() {
              markAdmitted();
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      dispatch.setAuthorityParentRunner(async (_id, _authorization, invoke) => {
        try {
          return await invoke();
        } finally {
          parentReleased = true;
        }
      });
      dispatch.setTokenManager(new TokenManager());
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      let settled = false;
      const operation = dispatch
        .dispatchHeldWithSignal(makeRef(), controller.signal, "held")
        .finally(() => {
          settled = true;
        });
      try {
        await started;
        await admitted;
        controller.abort(new Error("driver quiesced"));
        await cancelFailed;
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(parentReleased).toBe(false);

        releaseTerminal();
        await expect(operation).rejects.toSatisfy((error: unknown) => {
          if (!(error instanceof AggregateError)) return false;
          const [terminal, cancellation] = error.errors;
          const errorData = terminal instanceof RemoteRpcError ? terminal.errorData : undefined;
          return (
            terminal instanceof RemoteRpcError &&
            terminal.message === "remote cleanup failed" &&
            terminal.code === "CLEANUP_FAILED" &&
            errorData !== null &&
            typeof errorData === "object" &&
            "owner" in errorData &&
            errorData.owner === "receiver" &&
            cancellation === cancellationFailure
          );
        });
        expect(parentReleased).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        releaseTerminal?.();
        await operation.catch(() => {});
      }
    });

    it("rejects malformed alarm replies at the transport boundary", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) =>
          rpcSuccessResponse(init, { nextAlarm: { wakeAt: "tomorrow" } })
        )
      );
      dispatch.setTokenManager(new TokenManager());
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      await expect(dispatch.dispatchAlarm(makeRef())).rejects.toThrow("Invalid __alarm result");
    });

    it("does not impose Undici response deadlines on DO method lifetimes", async () => {
      const tokenManager = new TokenManager();
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
        rpcSuccessResponse(init, { nextAlarm: null })
      );

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      await expect(dispatch.dispatchAlarm(makeRef())).resolves.toEqual({ nextAlarm: null });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        dispatcher: getWorkerdConnectionDispatcher("http://127.0.0.1:10001"),
      });
    });

    it("reports a long-running agent alarm as healthy work and then completion", async () => {
      vi.useFakeTimers();
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let finish!: () => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((resolve) => {
              finish = () => resolve(rpcSuccessResponse(init, { nextAlarm: null }));
            })
        )
      );
      dispatch.setTokenManager(new TokenManager());
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      const pending = dispatch.dispatchAlarm(makeRef());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(info).toHaveBeenCalledWith(expect.stringContaining("state=working"));
      expect(warn).not.toHaveBeenCalled();

      finish();
      await pending;
      expect(info).toHaveBeenCalledWith(expect.stringContaining("state=completed"));
    });

    it("cancels and joins alarm work before releasing its authority parent", async () => {
      const controller = new AbortController();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let markCancelSent!: () => void;
      const cancelSent = new Promise<void>((resolve) => {
        markCancelSent = resolve;
      });
      let finishTerminal!: () => void;
      let parentReleased = false;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const request = decodeRpcJson(String(init?.body)) as RpcEnvelope;
        if (request.message.type === "request-cancel") {
          expect(parentReleased).toBe(false);
          markCancelSent();
          return new Response(encodeRpcJson({}), { status: 200 });
        }
        if (request.message.type !== "request") {
          throw new Error("expected canonical alarm request");
        }
        expect(request.message.method).toBe("__alarm");
        expect(init?.signal).toBeUndefined();
        markStarted();
        const terminal: RpcEnvelope = {
          from: request.target,
          target: request.from,
          delivery: { caller: request.delivery.caller },
          provenance: request.provenance,
          message: {
            type: "response",
            requestId: request.message.requestId,
            result: { nextAlarm: null },
          },
        };
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              finishTerminal = () => {
                stream.enqueue(new TextEncoder().encode(encodeRpcJson(terminal)));
                stream.close();
              };
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setAuthorityParentRunner(async (_id, _authorization, invoke) => {
        try {
          return await invoke();
        } finally {
          parentReleased = true;
        }
      });
      dispatch.setTokenManager(new TokenManager());
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      const pending = dispatch.dispatchAlarm(makeRef(), controller.signal);
      await started;
      const reason = new Error("alarm scheduler quiesced");
      controller.abort(reason);
      await cancelSent;
      expect(parentReleased).toBe(false);
      finishTerminal();
      await expect(pending).rejects.toBe(reason);
      expect(parentReleased).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps test-scoped alarm authority active for the complete durable invocation", async () => {
      const tokenManager = new TokenManager();
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
        rpcSuccessResponse(init, { nextAlarm: null })
      );
      const authorization = testAttestation({
        nonce: "alarm-parent-nonce",
      });
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
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));
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
            context: expect.objectContaining({ testPolicy: policy }),
          }),
        },
      ]);
      const body = decodeRpcJson(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)
      ) as RpcEnvelope;
      expect(body.message.type).toBe("request");
      if (body.message.type !== "request") {
        throw new Error("expected canonical alarm request");
      }
      expect(body.message.method).toBe("__alarm");
      expect((body.delivery.caller as AttestedCaller).authorization).toEqual(
        scopeCalls[0]!.authorization
      );
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
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      const ref = makeRef();
      const failure = dispatch.dispatch(ref, "ping", "DO_NOT_INCLUDE_THIS_ARGUMENT");
      const error = await failure.catch((caught: unknown) => caught);
      const request = decodeRpcJson(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)
      ) as RpcEnvelope;
      if (request.message.type !== "request") throw new Error("expected RPC request");
      expect(error).toMatchObject({ cause: fetchFailure });
      expect(error).toMatchObject({
        message:
          `DO RPC ${doRefKey(ref)}.ping requestId=${request.message.requestId} fetch to ` +
          `http://127.0.0.1:10001${userlandUrl(ref, "__rpc")} failed: ` +
          "fetch failed (cause: Error: connect ECONNREFUSED 127.0.0.1:10001)",
      });
      expect((error as Error).message).not.toContain("DO_NOT_INCLUDE_THIS_ARGUMENT");

      expect(getWorkerdUrl).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `http://127.0.0.1:10001${userlandUrl(ref, "__rpc")}`,
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
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      const ref = makeRef();
      const failure = dispatch.dispatch(ref, "getRun");
      const error = await failure.catch((caught: unknown) => caught);
      const request = decodeRpcJson(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)
      ) as RpcEnvelope;
      if (request.message.type !== "request") throw new Error("expected RPC request");
      expect(error).toMatchObject({
        cause: fetchFailure,
        message:
          `DO RPC ${doRefKey(ref)}.getRun requestId=${request.message.requestId} fetch to ` +
          `http://127.0.0.1:10001${userlandUrl(ref, "__rpc")} failed: fetch failed`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stamps verified server caller identity for lifecycle dispatch", async () => {
      const tokenManager = new TokenManager();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ value: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

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
      expect((body["__caller"] as { authorization?: unknown }).authorization).toEqual(
        testAttestation()
      );
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
        vi.fn(async (_url: string, init?: RequestInit) => {
          const request = decodeRpcJson(String(init?.body)) as RpcEnvelope;
          if (request.message.type !== "request") throw new Error("expected RPC request");
          return new Response(
            encodeRpcJson({
              from: request.target,
              target: request.from,
              delivery: { caller: request.delivery.caller },
              provenance: request.provenance,
              message: {
                type: "response",
                requestId: request.message.requestId,
                error: {
                  message: "revision does not resolve",
                  errorKind: "application",
                  errorData,
                },
              },
            } satisfies RpcEnvelope),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      );
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setExecutableAdmissionResolver(() => ({
        executableVersion: "test-executable",
        incarnationVersion: "test-executable",
        props: { stateArgs: null, image: null },
      }));

      await expect(dispatch.dispatch(makeRef(), "resolve")).rejects.toMatchObject({
        name: "RemoteRpcError",
        message: "revision does not resolve",
        errorKind: "application",
        errorData,
      });
    });
  });
});
