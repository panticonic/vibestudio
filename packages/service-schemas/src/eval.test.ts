import { describe, expect, it, vi } from "vitest";
import {
  createEvalExecutor,
  createDeferredEvalExecutor,
  evalAuthorityInputSchema,
  evalMethods,
  evalStartInputSchema,
  type EvalCall,
} from "./eval.js";

const SUCCESS = { success: true, console: "", returnValue: 42 };

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
  });

  it("uses request presence as the exact-allowlist boundary and rejects combinations that could prompt unexpectedly", () => {
    expect(evalAuthorityInputSchema.parse({})).toEqual({});
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
});
