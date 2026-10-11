import { describe, expect, it, vi } from "vitest";
import {
  createEvalExecutor,
  createDeferredEvalExecutor,
  evalAuthorityInputSchema,
  evalLifecycleFailureCodes,
  evalMethods,
  evalStartInputSchema,
  captureEvalRpcFingerprint,
  fingerprintEvalRpcValue,
  evalRpcCallObservationSchema,
  evalWorkerLifecycleObservationSchema,
  type EvalCall,
} from "./eval.js";

const SUCCESS = { success: true, console: "", returnValue: 42 };

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
