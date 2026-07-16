import { describe, expect, it, vi } from "vitest";
import type { EvalRunEvent, EvalRunSnapshot } from "../eval.js";
import { executeEval, type EvalClientTransport } from "./evalClient.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function client(overrides: Partial<EvalClientTransport> = {}): EvalClientTransport {
  return {
    start: vi.fn(async () => ({ runId: "run-1" })),
    events: vi.fn(async () => ({ events: [], next: 0 })),
    get: vi.fn(
      async () =>
        ({
          runId: "run-1",
          status: "succeeded",
          result: { success: true, console: "" },
        }) as EvalRunSnapshot
    ),
    cancel: vi.fn(async () => ({ status: "requested" as const })),
    ...overrides,
  };
}

describe("executeEval", () => {
  it("does not start work for an already-aborted caller", async () => {
    const transport = client();
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeEval(
        transport,
        { source: { kind: "inline", code: "return 1" } },
        {
          signal: controller.signal,
        }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.start).not.toHaveBeenCalled();
  });

  it("returns promptly when observation and cancellation RPCs are both stalled", async () => {
    const never = new Promise<never>(() => undefined);
    const transport = client({
      events: vi.fn(() => never),
      cancel: vi.fn(() => never),
    });
    const controller = new AbortController();
    const execution = executeEval(
      transport,
      { source: { kind: "inline", code: "return 1" } },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(transport.events).toHaveBeenCalledOnce());

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.cancel).toHaveBeenCalledOnce();
  });

  it("cancels a handle that arrives after aborting the start RPC", async () => {
    const start = deferred<{ runId: string }>();
    const transport = client({ start: vi.fn(() => start.promise) });
    const controller = new AbortController();
    const execution = executeEval(
      transport,
      { source: { kind: "inline", code: "return 1" } },
      { signal: controller.signal }
    );

    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    start.resolve({ runId: "late-run" });
    await vi.waitFor(() => expect(transport.cancel).toHaveBeenCalledWith({ runId: "late-run" }));
  });

  it("aborts a stalled event observer callback", async () => {
    const never = new Promise<void>(() => undefined);
    const event = { seq: 1, type: "accepted" } as EvalRunEvent;
    const transport = client({
      events: vi.fn(async () => ({ events: [event], next: 1 })),
    });
    const controller = new AbortController();
    const execution = executeEval(
      transport,
      { source: { kind: "inline", code: "return 1" } },
      { signal: controller.signal, onEvent: () => never }
    );
    await vi.waitFor(() => expect(transport.events).toHaveBeenCalledOnce());

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.cancel).toHaveBeenCalledOnce();
  });

  it("cancels the accepted run when observation fails", async () => {
    const observerError = new Error("event stream disconnected");
    const transport = client({
      events: vi.fn(async () => {
        throw observerError;
      }),
    });

    await expect(
      executeEval(transport, { source: { kind: "inline", code: "return 1" } })
    ).rejects.toBe(observerError);
    expect(transport.cancel).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("cancels the accepted run when the event callback fails", async () => {
    const callbackError = new Error("event sink failed");
    const event = { seq: 1, type: "accepted" } as EvalRunEvent;
    const transport = client({
      events: vi.fn(async () => ({ events: [event], next: 1 })),
    });

    await expect(
      executeEval(
        transport,
        { source: { kind: "inline", code: "return 1" } },
        {
          onEvent: () => {
            throw callbackError;
          },
        }
      )
    ).rejects.toBe(callbackError);
    expect(transport.cancel).toHaveBeenCalledWith({ runId: "run-1" });
  });
});
