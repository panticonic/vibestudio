import { describe, expect, it } from "vitest";
import {
  evalAuthorityInputSchema,
  evalLifecycleFailureCodes,
  evalStartInputSchema,
  settledResult,
  captureEvalRpcFingerprint,
  fingerprintEvalRpcValue,
  evalRpcCallObservationSchema,
  evalWorkerLifecycleObservationSchema,
} from "./eval.js";

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

  it("declares the typed lifecycle failure codes drivers branch on", () => {
    // Driver code references these literals; the spellings are load-bearing.
    expect(evalLifecycleFailureCodes.runtimeGenerationLost).toBe("runtime_generation_lost");
    expect(evalLifecycleFailureCodes.runtimeRestarted).toBe("eval_runtime_restarted");
    expect(evalLifecycleFailureCodes.cancelled).toBe("eval_cancelled");
    expect(evalLifecycleFailureCodes.deadlineExceeded).toBe("eval_deadline_exceeded");
  });

  it("carries a lifecycle-stamped result through a cancelled settlement, defaulting to user cancel", () => {
    const generationLost = {
      success: false,
      console: "",
      error: {
        message: "eval runtime generation was retired by a planned lifecycle transition",
        errorKind: "application",
      },
      failureKind: "infrastructure",
      failureCode: evalLifecycleFailureCodes.runtimeGenerationLost,
    } as const;
    expect(settledResult({ status: "cancelled", result: generationLost })).toEqual(generationLost);
    expect(settledResult({ status: "cancelled" })).toMatchObject({
      failureKind: "cancelled",
      failureCode: evalLifecycleFailureCodes.cancelled,
    });
    expect(settledResult({ status: "running" })).toBeUndefined();
    expect(() => settledResult({ status: "done" })).toThrow(/no result/);
  });

  it("has no result receiver: a result is pulled by run id", () => {
    const base = { runId: "run:1", source: { kind: "inline", code: "return 42" } };
    expect(
      evalStartInputSchema.safeParse({ ...base, resultReceiver: { kind: "caller" } }).success
    ).toBe(false);
  });
});
