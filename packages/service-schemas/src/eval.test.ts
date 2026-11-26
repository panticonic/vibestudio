import { describe, expect, it, vi } from "vitest";
import { deserializeRpcFailure, serializeRpcFailure, type RpcCaller } from "@vibestudio/rpc";
import { AmbiguousDoDispatchError } from "@vibestudio/shared/doDispatcher";
import {
  createEvalExecutor,
  createDeferredEvalExecutor,
  evalAuthorityInputSchema,
  evalLifecycleFailureCodes,
  evalMethods,
  evalOwnerCallbackMethods,
  evalOwnerCallbackRpcMethods,
  evalStartInputSchema,
  captureEvalRpcFingerprint,
  fingerprintEvalRpcValue,
  evalRpcCallObservationSchema,
  evalWorkerLifecycleObservationSchema,
  type EvalCall,
} from "./eval.js";

const SUCCESS = { success: true, console: "", returnValue: 42 };

describe("eval owner callback RPC contracts", () => {
  it("shares namesless descriptors with strict completion and progress payload schemas", async () => {
    expect(evalOwnerCallbackRpcMethods.onEvalComplete.name).toBe("onEvalComplete");
    expect(evalOwnerCallbackRpcMethods.onEvalProgress.name).toBe("onEvalProgress");

    const completionArgs = [{ runId: "run:1" }];
    expect(evalOwnerCallbackMethods.onEvalComplete.args.safeParse(completionArgs).success).toBe(
      true
    );
    expect(
      evalOwnerCallbackMethods.onEvalComplete.args.safeParse([
        { ...completionArgs[0], result: SUCCESS },
      ]).success
    ).toBe(false);
    expect(
      evalOwnerCallbackMethods.onEvalComplete.returns.safeParse({ accepted: true }).success
    ).toBe(true);
    expect(
      evalOwnerCallbackMethods.onEvalComplete.returns.safeParse({ accepted: "yes" }).success
    ).toBe(false);

    const progress = {
      runId: "run:1",
      agentInvocationId: "invocation:1",
      channelId: "channel:1",
      activity: { kind: "authority-requested", detail: { capability: "browser.read" } },
    };
    expect(evalOwnerCallbackMethods.onEvalProgress.args.safeParse([progress]).success).toBe(true);
    expect(
      evalOwnerCallbackMethods.onEvalProgress.args.safeParse([
        { ...progress, activity: { ...progress.activity, kind: "arbitrary" } },
      ]).success
    ).toBe(false);
    expect(
      evalOwnerCallbackMethods.onEvalProgress.args.safeParse([{ ...progress, unexpected: true }])
        .success
    ).toBe(false);
    expect(evalOwnerCallbackMethods.onEvalProgress.returns.safeParse(undefined).success).toBe(true);
  });

  it("validates callback arguments before dispatch and validates receiver results", async () => {
    const completion = evalOwnerCallbackRpcMethods.onEvalComplete;
    const completionDispatch = vi.fn(async () => ({ accepted: true }));
    await expect(
      completion.invoke(
        [
          {
            runId: "run:1",
            // @ts-expect-error completion callbacks receive only their owner run id
            result: SUCCESS,
          },
        ],
        completionDispatch
      )
    ).rejects.toThrow();
    expect(completionDispatch).not.toHaveBeenCalled();

    await expect(
      completion.invoke([{ runId: "run:1" }], async () => ({ accepted: "yes" }))
    ).rejects.toThrow();

    const progress = evalOwnerCallbackRpcMethods.onEvalProgress;
    const progressDispatch = vi.fn(async () => undefined);
    await expect(
      progress.invoke(
        [
          {
            runId: "run:1",
            agentInvocationId: "invocation:1",
            channelId: "channel:1",
            activity: {
              // @ts-expect-error progress activity is restricted to the owner protocol
              kind: "not-an-authority-event",
            },
          },
        ],
        progressDispatch
      )
    ).rejects.toThrow();
    expect(progressDispatch).not.toHaveBeenCalled();
    await expect(
      progress.invoke(
        [{ runId: "run:1", agentInvocationId: "invocation:1", channelId: "channel:1" }],
        async () => undefined
      )
    ).resolves.toBeUndefined();
  });

  it("keeps compile-time callback result types exact", () => {
    void callbackRpcTypecheck;
  });
});

function callbackRpcTypecheck(caller: Pick<RpcCaller, "call">): void {
  // @ts-expect-error a caller cannot substitute its own completion result type
  const wrongCompletionResult: Promise<{ accepted: "yes" }> = caller.call(
    "do:agent:owner",
    evalOwnerCallbackRpcMethods.onEvalComplete,
    [{ runId: "run:1" }]
  );
  void wrongCompletionResult;
}

describe("eval RPC observation fingerprints", () => {
  it("sorts canonical object keys while preserving exact Unicode code points", () => {
    const left = fingerprintEvalRpcValue({ z: 2, label: "e\u0301", rows: [{ b: 1, a: true }] });
    const right = fingerprintEvalRpcValue({ rows: [{ a: true, b: 1 }], label: "é", z: 2 });
    expect(left).not.toEqual(right);
    expect(fingerprintEvalRpcValue({ label: "e\u0301", rows: [{ b: 1, a: true }], z: 2 })).toEqual(
      left
    );
    expect(fingerprintEvalRpcValue({ "e\u0301": 1 })).not.toEqual(
      fingerprintEvalRpcValue({ é: 1 })
    );
    expect(captureEvalRpcFingerprint({ b: 2, a: 1 })).toEqual({
      available: true,
      encoding: '{"a":1,"b":2}',
    });
    expect(fingerprintEvalRpcValue({ "\ud800": 1, "\ud801": 2 })).toEqual(
      fingerprintEvalRpcValue({ "\ud801": 2, "\ud800": 1 })
    );
    expect(fingerprintEvalRpcValue({ "\ud800": 1 })).not.toEqual(
      fingerprintEvalRpcValue({ "\ud801": 1 })
    );
  });

  it("marks unsupported, cyclic, accessor, and oversized receiver results unavailable without running getters", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    let getterRuns = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return "private";
      },
    });
    expect(fingerprintEvalRpcValue(cyclic)).toEqual({ available: false, reason: "unsupported" });
    expect(fingerprintEvalRpcValue(accessor)).toEqual({ available: false, reason: "unreadable" });
    expect(fingerprintEvalRpcValue("x".repeat(65 * 1024))).toEqual({
      available: false,
      reason: "too-large",
    });
    expect(getterRuns).toBe(0);
  });

  it("validates fulfilled result commitments and preserves lifecycle target identity fields", () => {
    expect(
      evalRpcCallObservationSchema.parse({
        protocol: "rpc-call-observation.v1",
        ownerId: "owner:example",
        ownerGeneration: "00000000-0000-4000-8000-000000000001",
        callId: 2,
        admissionOrder: 0,
        settlementOrder: 1,
        targetId: "do:example:NotesDO:key-1",
        method: "notes.readRows",
        outcome: "fulfilled",
        result: fingerprintEvalRpcValue([{ id: 1 }]),
      }).result
    ).toEqual(fingerprintEvalRpcValue([{ id: 1 }]));
    expect(
      evalRpcCallObservationSchema.safeParse({
        protocol: "rpc-call-observation.v1",
        ownerId: "owner:example",
        ownerGeneration: "00000000-0000-4000-8000-000000000001",
        callId: 3,
        admissionOrder: 3,
        settlementOrder: 1,
        targetId: "main",
        method: "runtime.createEntity",
        outcome: "rejected",
        result: { available: true, fingerprint: "0".repeat(64) },
      }).success
    ).toBe(false);
    expect(
      evalRpcCallObservationSchema.safeParse({
        protocol: "rpc-call-observation.v1",
        callId: 4,
        admissionOrder: 0,
        settlementOrder: 1,
        targetId: "main",
        method: "runtime.createEntity",
        outcome: "fulfilled",
      }).success
    ).toBe(false);
    expect(
      evalWorkerLifecycleObservationSchema.parse({
        protocol: "worker-lifecycle-observation.v1",
        callId: 2,
        operation: "create",
        entityId: "do:workers/test:NotesDO:key-1",
        targetId: "do:workers/test:NotesDO:key-1",
        kind: "do",
        source: "workers/test",
        className: "NotesDO",
        objectKey: "key-1",
      })
    ).toMatchObject({ targetId: "do:workers/test:NotesDO:key-1" });
  });
});

describe("eval lifecycle contract", () => {
  it("requires a caller-owned runId and rejects relationship facts", () => {
    const base = { runId: "run:1", source: { kind: "inline", code: "return 42" } };
    expect(evalStartInputSchema.safeParse(base).success).toBe(true);
    expect(evalStartInputSchema.safeParse({ source: base.source }).success).toBe(false);
    expect(evalStartInputSchema.safeParse({ ...base, channelId: "channel:other" }).success).toBe(
      false
    );
    expect(evalStartInputSchema.safeParse({ ...base, ownerId: "agent:other" }).success).toBe(false);
    expect(evalStartInputSchema.safeParse({ ...base, contextId: "context:other" }).success).toBe(
      false
    );
  });

  it("accepts only a single verified owner-session selector", () => {
    expect(
      evalStartInputSchema.safeParse({
        runId: "run:1",
        source: { kind: "inline", code: "return 42" },
        target: { kind: "owner-session", sessionId: "agent:session" },
      }).success
    ).toBe(true);
    expect(
      evalStartInputSchema.safeParse({
        runId: "run:1",
        source: { kind: "inline", code: "return 42" },
        target: {
          kind: "owner-session",
          sessionId: "agent:session",
          contextId: "context:untrusted",
        },
      }).success
    ).toBe(false);
    expect(
      evalStartInputSchema.safeParse({
        runId: "run:1",
        source: { kind: "inline", code: "return 1" },
        authority: { approvals: "pregranted-only", preauthorize: [] },
      }).success
    ).toBe(true);
  });

  it("uses request presence as the exact-allowlist boundary and rejects combinations that could prompt unexpectedly", () => {
    expect(evalAuthorityInputSchema.parse({})).toEqual({});
    const preauthorize = [{ service: "permissions", method: "list", args: [] }];
    expect(evalAuthorityInputSchema.parse({ preauthorize })).toEqual({ preauthorize });
    expect(
      evalStartInputSchema.parse({
        runId: "run:default-prompt",
        source: { kind: "inline", code: "return 1" },
        authority: { preauthorize },
      }).authority
    ).toEqual({ preauthorize });
    expect(evalAuthorityInputSchema.parse({ effects: "read-write" })).toEqual({
      effects: "read-write",
    });
    expect(evalAuthorityInputSchema.safeParse({ effects: "mutable" }).success).toBe(false);
    expect(
      evalStartInputSchema.parse({
        runId: "run:1",
        source: { kind: "inline", code: "return 1" },
        authority: {},
      }).authority
    ).toEqual({});
    expect(
      evalStartInputSchema.safeParse({
        runId: "run:1",
        source: { kind: "inline", code: "return 1" },
        authority: {
          requests: [{ capability: "fs.read", resource: { kind: "exact", key: "a" } }],
        },
      }).success
    ).toBe(true);
    expect(
      evalStartInputSchema.safeParse({
        runId: "run:1",
        source: { kind: "inline", code: "return 1" },
        authority: { mode: "strict" },
      }).success
    ).toBe(false);
    expect(
      evalStartInputSchema.safeParse({
        runId: "run:1",
        source: { kind: "inline", code: "return 1" },
        authority: {
          approvals: "pregranted-only",
          preauthorize: [{ service: "fs", method: "readFile", args: ["a", "utf8"] }],
        },
      }).success
    ).toBe(false);
    expect(
      evalStartInputSchema.safeParse({
        runId: "run:1",
        source: { kind: "inline", code: "return 1" },
        readOnly: true,
      }).success
    ).toBe(false);
  });

  it("settles a terminal start without a backstop read", async () => {
    const call = vi.fn(async (method: string) => {
      expect(method).toBe("eval.start");
      return {
        runId: "run:1",
        status: "terminal",
        snapshot: { status: "done", result: SUCCESS },
      };
    });
    const execute = createEvalExecutor(call as unknown as EvalCall);

    await expect(
      execute({ runId: "run:1", source: { kind: "inline", code: "return 42" } })
    ).resolves.toEqual(SUCCESS);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("uses get only as the accepted run's settlement backstop", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run:1", status: "accepted" })
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "done", result: SUCCESS });
    const execute = createEvalExecutor(call, { pollDelay: async () => undefined });

    await expect(
      execute({ runId: "run:1", source: { kind: "inline", code: "return 42" } })
    ).resolves.toEqual(SUCCESS);
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "eval.start",
      "eval.get",
      "eval.get",
    ]);
    expect(call.mock.calls[1]?.[1]).toEqual([{ runId: "run:1" }]);
  });

  it("reconciles a lost status response against the same accepted run", async () => {
    const lost = new AmbiguousDoDispatchError("workerd response lost");
    const wrapped = new Error("eval.get failed", { cause: lost });
    const wireFailure = deserializeRpcFailure(serializeRpcFailure(wrapped));
    const call = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run:1", status: "accepted" })
      .mockRejectedValueOnce(wireFailure)
      .mockResolvedValueOnce({ status: "done", result: SUCCESS });
    const execute = createEvalExecutor(call);
    await expect(
      execute({ runId: "run:1", source: { kind: "inline", code: "return 42" } })
    ).resolves.toEqual(SUCCESS);
    expect(call.mock.calls.slice(1)).toEqual([
      ["eval.get", [{ runId: "run:1" }]],
      ["eval.get", [{ runId: "run:1" }]],
    ]);
  });

  it("retains both failures when a lost status response cannot be reconciled", async () => {
    const lost = new AmbiguousDoDispatchError("workerd response lost");
    const failed = new Error("durable owner unreachable");
    const call = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run:1", status: "accepted" })
      .mockRejectedValueOnce(lost)
      .mockRejectedValueOnce(failed);
    const execute = createEvalExecutor(call);
    await expect(
      execute({ runId: "run:1", source: { kind: "inline", code: "return 42" } })
    ).rejects.toMatchObject({ cause: lost, errors: [lost, failed] });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("does not reconcile semantic status rejections", async () => {
    const refused = new Error("status read denied");
    const call = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run:1", status: "accepted" })
      .mockRejectedValueOnce(refused);
    const execute = createEvalExecutor(call);
    await expect(
      execute({ runId: "run:1", source: { kind: "inline", code: "return 42" } })
    ).rejects.toBe(refused);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("preserves a pre-start abort without manufacturing an external run or cancellation", async () => {
    const abort = new AbortController();
    const reason = new Error("stop before admission");
    abort.abort(reason);
    const call = vi.fn();
    const execute = createEvalExecutor(call, { signal: abort.signal });
    await expect(
      execute({
        runId: "run:unstarted",
        source: { kind: "inline", code: "return 42" },
      })
    ).rejects.toBe(reason);
    expect(call).not.toHaveBeenCalled();
  });

  it("uses the installed AbortSignal default without a DOMException global", async () => {
    const signal = AbortSignal.abort("stop before admission");
    const call = vi.fn();
    vi.stubGlobal("DOMException", undefined);
    try {
      const execute = createEvalExecutor(call, { signal });
      await expect(
        execute({ runId: "run:unstarted", source: { kind: "inline", code: "return 42" } })
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(call).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels the same caller-owned run when aborted", async () => {
    const abort = new AbortController();
    const call = vi.fn(async (method: string) => {
      if (method === "eval.start") {
        abort.abort(new Error("stop"));
        return { runId: "run:1", status: "accepted" };
      }
      if (method === "eval.cancel") return { ok: true, forcedReset: false };
      throw new Error(`unexpected ${method}`);
    });
    const execute = createEvalExecutor(call as unknown as EvalCall, { signal: abort.signal });

    await expect(
      execute({ runId: "run:1", source: { kind: "inline", code: "return 42" } })
    ).rejects.toThrow("stop");
    expect(call.mock.calls.map(([method]) => method)).toEqual(["eval.start", "eval.cancel"]);
  });

  it("registers a caller receiver and lets its terminal push win the polling race", async () => {
    let resolveReceiver!: (result: typeof SUCCESS) => void;
    let releasePollDelay!: () => void;
    const call = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run:1", status: "accepted" })
      .mockResolvedValueOnce({ status: "running" });
    const execute = createEvalExecutor(call, {
      receiver: { kind: "caller" },
      waitForReceiver: async () =>
        new Promise((resolve) => {
          resolveReceiver = resolve;
        }),
      pollDelay: async () =>
        new Promise((resolve) => {
          releasePollDelay = resolve;
        }),
    });

    const result = execute({
      runId: "run:1",
      source: { kind: "inline", code: "return 42" },
    });
    await vi.waitFor(() => expect(releasePollDelay).toBeTypeOf("function"));
    resolveReceiver(SUCCESS);
    await expect(result).resolves.toEqual(SUCCESS);
    releasePollDelay();
    await Promise.resolve();

    expect(call.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ resultReceiver: { kind: "caller" } }),
    ]);
    expect(call.mock.calls.map(([method]) => method)).toEqual(["eval.start", "eval.get"]);
  });

  it("composes push-primary agent deferral over a bare call function", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run:1", status: "accepted" })
      .mockResolvedValueOnce({ status: "running" });
    const execute = createDeferredEvalExecutor(call);

    await expect(
      execute({
        runId: "run:1",
        source: { kind: "inline", code: "return 42" },
        scope: { key: "channel:1" },
      })
    ).resolves.toEqual({ deferred: true });
    expect(call.mock.calls).toEqual([
      [
        "eval.start",
        [
          expect.objectContaining({
            resultReceiver: { kind: "caller" },
            scope: { key: "channel:1" },
          }),
        ],
      ],
      ["eval.get", [{ runId: "run:1", scopeKey: "channel:1" }]],
    ]);
  });

  it("exposes no retired public lifecycle methods", () => {
    expect(Object.keys(evalMethods)).not.toEqual(
      expect.arrayContaining(["run", "startRun", "getRun"])
    );
  });

  it("declares the typed lifecycle failure codes drivers branch on", () => {
    // Driver code references these literals; the spellings are load-bearing.
    expect(evalLifecycleFailureCodes.runtimeGenerationLost).toBe("runtime_generation_lost");
    expect(evalLifecycleFailureCodes.runtimeRestarted).toBe("eval_runtime_restarted");
    expect(evalLifecycleFailureCodes.cancelled).toBe("eval_cancelled");
    expect(evalLifecycleFailureCodes.deadlineExceeded).toBe("eval_deadline_exceeded");
  });

  it("carries a lifecycle-stamped result through a cancelled settlement, defaulting to user cancel", async () => {
    const generationLost = {
      success: false,
      console: "",
      error: {
        message: "eval runtime generation was retired by a planned lifecycle transition",
        errorKind: "application",
      },
      failureKind: "infrastructure",
      failureCode: evalLifecycleFailureCodes.runtimeGenerationLost,
    };
    const stamped = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run:1", status: "accepted" })
      .mockResolvedValueOnce({ status: "cancelled", result: generationLost });
    await expect(
      createEvalExecutor(stamped, { pollDelay: async () => undefined })({
        runId: "run:1",
        source: { kind: "inline", code: "return 1" },
      })
    ).resolves.toEqual(generationLost);

    const bare = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run:2", status: "accepted" })
      .mockResolvedValueOnce({ status: "cancelled" });
    await expect(
      createEvalExecutor(bare, { pollDelay: async () => undefined })({
        runId: "run:2",
        source: { kind: "inline", code: "return 1" },
      })
    ).resolves.toMatchObject({
      failureKind: "cancelled",
      failureCode: evalLifecycleFailureCodes.cancelled,
    });
  });
});

describe("explicit execution budget", () => {
  const input = {
    runId: "guest-budget",
    source: { kind: "inline" as const, syntax: "javascript" as const, code: "return 1" },
  };
  it("requires a sufficient whole-run watchdog while preserving existing unbounded/whole-only inputs", () => {
    expect(evalStartInputSchema.safeParse(input).success).toBe(true);
    expect(evalStartInputSchema.safeParse({ ...input, timeoutMs: 3000 }).success).toBe(true);
    expect(evalStartInputSchema.safeParse({ ...input, executionTimeoutMs: 3000 }).success).toBe(
      false
    );
    expect(
      evalStartInputSchema.safeParse({ ...input, timeoutMs: 2000, executionTimeoutMs: 3000 })
        .success
    ).toBe(false);
    expect(
      evalStartInputSchema.parse({ ...input, timeoutMs: 30000, executionTimeoutMs: 3000 })
        .executionTimeoutMs
    ).toBe(3000);
  });
  it("captures only independently read bounded phases bound to the exact source and preserves original failure data", async () => {
    const error = serializeRpcFailure(
      Object.assign(new Error("guest deadline"), {
        code: "eval_execution_deadline_exceeded",
        errorKind: "application",
        errorData: { reason: "original" },
      })
    );
    const { sha256HexSyncText } = await import("@vibestudio/content-addressing");
    const sourceDigest = sha256HexSyncText(input.source.code);
    const calls: string[] = [];
    const call: EvalCall = async (method, args) => {
      calls.push(method);
      if (method === "eval.start")
        return {
          runId: input.runId,
          status: "terminal",
          runDigest: "digest",
          authorityManifestDigest: "authority",
          snapshot: {
            runId: input.runId,
            status: "done",
            result: { success: false, console: "", error },
          },
        } as never;
      if (method === "eval.events") {
        expect(args[0]).toMatchObject({ runId: input.runId, scopeKey: "owned", limit: 32 });
        return {
          next: 3,
          hasMore: false,
          events: [
            {
              sequence: 1,
              at: 1,
              kind: "diagnostic",
              payload: { kind: "eval-phase", phase: "prepare", sourceDigest },
            },
            {
              sequence: 2,
              at: 2,
              kind: "diagnostic",
              payload: { kind: "eval-phase", phase: "execute", sourceDigest: "forged" },
            },
            { sequence: 3, at: 3, kind: "console", payload: { text: "must not be copied" } },
          ],
        } as never;
      }
      throw Error(method);
    };
    const result = await createEvalExecutor(call, { captureFailureEvents: true })({
      ...input,
      scope: { key: "owned", lifecycle: "finite" },
      timeoutMs: 30000,
      executionTimeoutMs: 3000,
    });
    expect(calls).toEqual(["eval.start", "eval.events"]);
    expect(result.error?.errorData).toMatchObject({
      reason: "original",
      nativeEvalDiagnostic: {
        runId: input.runId,
        sourceSha256: sourceDigest,
        events: [{ sequence: 1, phase: "prepare" }],
        truncated: false,
        unavailable: null,
      },
    });
    expect(JSON.stringify(result.error?.errorData)).not.toContain("must not be copied");
  });
  it("does not replace a primary failure when diagnostics are unavailable", async () => {
    const error = serializeRpcFailure(new Error("original failure"));
    const call: EvalCall = async (method) => {
      if (method === "eval.start")
        return {
          runId: input.runId,
          status: "terminal",
          runDigest: "digest",
          authorityManifestDigest: "authority",
          snapshot: {
            runId: input.runId,
            status: "done",
            result: { success: false, console: "", error },
          },
        } as never;
      throw new TypeError("event read unavailable");
    };
    const result = await createEvalExecutor(call, { captureFailureEvents: true })(input);
    expect(result.error?.message).toBe("original failure");
    expect(result.error?.errorData).toMatchObject({
      nativeEvalDiagnostic: { unavailable: "TypeError" },
    });
  });
});
