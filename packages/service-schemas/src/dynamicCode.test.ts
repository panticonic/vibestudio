import { describe, expect, it, vi } from "vitest";
import {
  createDynamicCodeExecutor,
  createDynamicCodeRunObserver,
  startDynamicCodeRun,
} from "./dynamicCode.js";

const HOST_ID = "do:workers/session:SessionDO:abc";

function fakeRpc(
  options: {
    awaits?: Array<Record<string, unknown>>;
    events?: unknown[];
    startError?: Error;
  } = {}
) {
  const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
  let awaited = 0;
  const call = vi.fn(
    async (target: string, method: { name: string }, args: unknown[]): Promise<unknown> => {
      calls.push({ target, method: method.name, args });
      switch (method.name) {
        case "dynamicCode.admit": {
          const runId = (args[0] as { runId: string }).runId;
          return {
            runId,
            runDigest: "a".repeat(64),
            authorityManifestDigest: "b".repeat(64),
            host: { source: "workers/session", className: "SessionDO", objectKey: "abc" },
            hostId: HOST_ID,
            nonce: "n1",
            start: { runId },
          };
        }
        case "start":
          if (options.startError) throw options.startError;
          return { runId: (args[0] as { runId: string }).runId, status: "pending" };
        case "await": {
          const next = options.awaits?.[Math.min(awaited++, options.awaits.length - 1)];
          // A blocked `await` takes real time; a hot loop would never let a signal fire.
          if (next?.["status"] === "running")
            await new Promise((resolve) => setTimeout(resolve, 2));
          return next ?? { status: "done", result: { success: true, console: "" } };
        }
        case "events":
          return {
            events: options.events ?? [],
            next: options.events?.length ?? 0,
            hasMore: false,
          };
        case "get":
          return { status: "done", result: { success: true, console: "" } };
        case "cancel":
          return { ok: true, forcedReset: false };
        case "dynamicCode.release":
          return { released: true };
        default:
          throw new Error(`unexpected ${method.name}`);
      }
    }
  );
  return { rpc: { call } as never, calls };
}

const input = { runId: "run-1", source: { kind: "inline" as const, code: "return 1" } };

describe("createDynamicCodeExecutor", () => {
  it("admits, starts on the hosting entity, pulls until terminal, hands over events, and releases", async () => {
    const { rpc, calls } = fakeRpc({
      awaits: [{ status: "running" }, { status: "done", result: { success: true, console: "x" } }],
      events: [{ sequence: 1, at: 1, kind: "console", payload: { text: "x" } }],
    });
    const seen: unknown[] = [];
    const result = await createDynamicCodeExecutor(rpc, { onEvents: (e) => seen.push(...e) })(
      input
    );
    expect(result).toMatchObject({ success: true, console: "x" });
    expect(calls.map((c) => c.method)).toEqual([
      "dynamicCode.admit",
      "start",
      "await",
      "events",
      "await",
      "events",
      "dynamicCode.release",
    ]);
    expect(calls[1]).toMatchObject({ target: HOST_ID, args: [{ runId: "run-1" }, "n1"] });
    expect(calls.at(-1)!.args[0]).toEqual({ runId: "run-1", hostId: HOST_ID });
    expect(seen).toHaveLength(2);
  });

  it("releases a run it could not start, and a run that ended in failure", async () => {
    const refused = fakeRpc({ startError: new Error("refused") });
    await expect(createDynamicCodeExecutor(refused.rpc)(input)).rejects.toThrow("refused");
    expect(refused.calls.at(-1)!.method).toBe("dynamicCode.release");
    const failed = fakeRpc({
      awaits: [
        { status: "done", result: { success: false, console: "", error: { message: "boom" } } },
      ],
    });
    await expect(createDynamicCodeExecutor(failed.rpc)(input)).resolves.toMatchObject({
      success: false,
    });
    expect(failed.calls.at(-1)!.method).toBe("dynamicCode.release");
  });

  it("cancels on the hosting entity when its signal aborts, and releases", async () => {
    const controller = new AbortController();
    const { rpc, calls } = fakeRpc({ awaits: [{ status: "running" }] });
    const reason = new Error("stop");
    const execute = createDynamicCodeExecutor(rpc, { signal: controller.signal, waitMs: 1 });
    const running = execute(input);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "await")).toBe(true));
    controller.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(calls.map((c) => c.method)).toContain("cancel");
    expect(calls.at(-1)!.method).toBe("dynamicCode.release");
  });

  it("does not admit when the signal is already aborted", async () => {
    const { rpc, calls } = fakeRpc();
    const controller = new AbortController();
    controller.abort(new Error("early"));
    await expect(
      createDynamicCodeExecutor(rpc, { signal: controller.signal })(input)
    ).rejects.toThrow("early");
    expect(calls).toEqual([]);
  });
});

describe("startDynamicCodeRun and the run observer", () => {
  it("starts without waiting and lets a later activation pull, cancel and release by id", async () => {
    const { rpc, calls } = fakeRpc({ awaits: [{ status: "running" }] });
    const { admission, observer } = await startDynamicCodeRun(rpc, input);
    expect(calls.map((c) => c.method)).toEqual(["dynamicCode.admit", "start"]);
    // A caller that comes back needs only the entity id and the run id.
    const later = createDynamicCodeRunObserver(rpc, {
      hostId: admission.hostId,
      runId: admission.runId,
    });
    await expect(later.get()).resolves.toMatchObject({ status: "done" });
    await expect(observer.cancel()).resolves.toEqual({ ok: true, forcedReset: false });
    await expect(later.release()).resolves.toEqual({ released: true });
  });
});
