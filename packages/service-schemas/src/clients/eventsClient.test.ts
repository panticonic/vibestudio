import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import {
  encodeEventWatchRecord,
  type EventName,
  type EventWatchRecord,
} from "@vibestudio/shared/events";
import { EventsClient } from "./eventsClient.js";

function makeRpc() {
  let epoch = "server-epoch-1";
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const watchControllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const streamReadable = vi.fn(
    async (
      _target: string,
      _method: string,
      args: unknown[],
      options?: { signal?: AbortSignal }
    ): Promise<import("@vibestudio/rpc").DecodedFramedStream> => {
      const requested = (args[0] ?? []) as EventName[];
      const watchId = String(args[1]);
      const signal = options?.signal ?? new AbortController().signal;
      signals.push(signal);
      return {
        status: 200,
        statusText: "OK",
        headers: [],
        finalUrl: "",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            const previous = watchControllers.get(watchId);
            watchControllers.set(watchId, controller);
            if (previous) {
              try {
                previous.close();
              } catch {
                // The previous response already terminated.
              }
            }
            controller.enqueue(
              encodeEventWatchRecord({ kind: "watching", events: requested, epoch })
            );
            signal.addEventListener("abort", () => {
              try {
                controller.close();
              } catch {
                // The reader already cancelled the response.
              }
            });
          },
        }),
      };
    }
  );
  return {
    rpc: schemaRpcCaller({
      streamReadable,
    }),
    streamReadable,
    controllers,
    signals,
    restartServer() {
      epoch = `server-epoch-${Number(epoch.split("-").at(-1)) + 1}`;
    },
    emit(index: number, record: EventWatchRecord) {
      controllers[index]!.enqueue(encodeEventWatchRecord(record));
    },
    close(index: number) {
      controllers[index]!.close();
    },
  };
}

describe("EventsClient", () => {
  let fixture: ReturnType<typeof makeRpc>;
  let client: EventsClient;

  beforeEach(() => {
    fixture = makeRpc();
    client = new EventsClient(fixture.rpc);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("joins the same admission failure for concurrent subscribers", async () => {
    const failure = new Error("upstream event admission failed");
    let rejectAdmission!: (error: Error) => void;
    const opening = new Promise<import("@vibestudio/rpc").DecodedFramedStream>(
      (_resolve, reject) => {
        rejectAdmission = reject;
      }
    );
    const rpc = { streamReadable: vi.fn(() => opening) };
    const events = new EventsClient(rpc);
    const first = events.subscribe("panel-tree-invalidated");
    const second = events.subscribe("panel-tree-invalidated");
    const checks = [expect(first).rejects.toBe(failure), expect(second).rejects.toBe(failure)];
    await vi.waitFor(() => expect(rpc.streamReadable).toHaveBeenCalledOnce());
    rejectAdmission(failure);
    await Promise.all(checks);
    await events.unsubscribeAll();
  });

  it("keeps a replacement owner admitted while the previous owner retires", async () => {
    const first = client.subscribe("panel-tree-invalidated");
    const replacement = client.subscribe("panel-tree-invalidated");
    await Promise.all([first, replacement]);

    expect(fixture.streamReadable).toHaveBeenCalledTimes(1);
    await client.unsubscribe("panel-tree-invalidated");
    expect(fixture.signals[0]!.aborted).toBe(false);
    expect(fixture.streamReadable).toHaveBeenCalledTimes(1);

    await client.unsubscribe("panel-tree-invalidated");
    expect(fixture.signals[0]!.aborted).toBe(true);
  });

  it("cancels and joins a watch that is still waiting for its acknowledgement", async () => {
    let signal!: AbortSignal;
    let response!: ReadableStreamDefaultController<Uint8Array>;
    let responseClosed = false;
    const closeResponse = () => {
      if (responseClosed) return;
      responseClosed = true;
      response.close();
    };
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const pendingClient = new EventsClient({
      streamReadable: async (_target, _method, _args, options) => {
        signal = options!.signal!;
        return {
          status: 200,
          statusText: "OK",
          headers: [],
          finalUrl: "",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              response = controller;
              signal.addEventListener("abort", closeResponse, { once: true });
              admitted();
            },
          }),
        };
      },
    });
    const opening = pendingClient.subscribe("panel-tree-invalidated");
    const rejected = expect(opening).rejects.toThrow("before its ACK");
    await admission;
    try {
      const closing = pendingClient.unsubscribeAll();
      expect(signal.aborted).toBe(true);
      await closing;
      await rejected;
    } finally {
      closeResponse();
      await rejected;
      await pendingClient.unsubscribeAll();
    }
  });

  it("creates a cryptographic watch id when randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0x2a);
        return bytes;
      },
    });
    const portableClient = new EventsClient(fixture.rpc);

    await portableClient.subscribe("panel-tree-invalidated");

    expect(fixture.streamReadable.mock.calls.at(-1)?.[2]).toEqual([
      ["panel-tree-invalidated"],
      "2a".repeat(16),
    ]);
    await portableClient.unsubscribeAll();
  });

  it("reads the raw stream without constructing a React Native Response", async () => {
    const stream = vi.fn();
    const streamReadable = vi.fn(
      async (
        _target: string,
        _method: string,
        args: unknown[],
        options?: { signal?: AbortSignal }
      ) => ({
        status: 200,
        statusText: "OK",
        headers: [] as [string, string][],
        finalUrl: "",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encodeEventWatchRecord({
                kind: "watching",
                events: args[0] as EventName[],
                epoch: "mobile-epoch",
              })
            );
            options?.signal?.addEventListener("abort", () => controller.close());
          },
        }),
      })
    );
    const mobileClient = new EventsClient(schemaRpcCaller({ streamReadable }));

    await mobileClient.subscribe("panel-tree-invalidated");

    expect(streamReadable).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
    await mobileClient.unsubscribeAll();
  });

  it("opens one response-owned watch and dispatches its records", async () => {
    const listener = vi.fn();
    client.on("panel-tree-invalidated", listener);

    await client.subscribe("panel-tree-invalidated");
    expect(fixture.streamReadable).toHaveBeenCalledWith(
      "main",
      "events.watch",
      [["panel-tree-invalidated"], expect.any(String)],
      expect.objectContaining({ signal: expect.any(AbortSignal), bodyIdleTimeoutMs: null })
    );

    fixture.emit(0, {
      kind: "event",
      event: "panel-tree-invalidated",
      payload: { revision: 1, forest: [] },
      sequence: 1,
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ revision: 1, forest: [] }));
    await client.unsubscribeAll();
  });

  it("applies the starting snapshot before a newer event from its read", async () => {
    const listener = vi.fn();
    client.on("panel-tree-invalidated", listener);
    await client.subscribe("panel-tree-invalidated");

    fixture.emit(0, {
      kind: "snapshot",
      event: "panel-tree-invalidated",
      payload: { revision: 1, reset: true, groups: [], changedSlotIds: [], removedSlotIds: [] },
      sequence: 0,
    });
    fixture.emit(0, {
      kind: "event",
      event: "panel-tree-invalidated",
      payload: { revision: 2, reset: true, groups: [], changedSlotIds: [], removedSlotIds: [] },
      sequence: 1,
    });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener.mock.calls.map(([payload]) => payload.revision)).toEqual([1, 2]);
    await client.unsubscribeAll();
  });

  it("can bind the same watch contract to an explicit event domain", async () => {
    const desktopEvents = new EventsClient(fixture.rpc, undefined, "desktopEvents");

    await desktopEvents.subscribe("system-theme-changed");

    expect(fixture.streamReadable).toHaveBeenCalledWith(
      "main",
      "desktopEvents.watch",
      [["system-theme-changed"], expect.any(String)],
      expect.anything()
    );
    await desktopEvents.unsubscribeAll();
  });

  it("replaces the exact response with the complete sorted topic set", async () => {
    await client.subscribe("system-theme-changed");
    await client.subscribe("panel-tree-invalidated");

    expect(fixture.signals[0]!.aborted).toBe(false);
    expect(fixture.streamReadable).toHaveBeenNthCalledWith(
      2,
      "main",
      "events.watch",
      [["panel-tree-invalidated", "system-theme-changed"], expect.any(String)],
      expect.anything()
    );

    await client.unsubscribe("system-theme-changed");
    expect(fixture.signals[1]!.aborted).toBe(false);
    expect(fixture.streamReadable).toHaveBeenNthCalledWith(
      3,
      "main",
      "events.watch",
      [["panel-tree-invalidated"], expect.any(String)],
      expect.anything()
    );
    await client.unsubscribeAll();
  });

  it("unsubscribes only by aborting the owned response", async () => {
    await client.subscribe("panel-tree-invalidated");
    await client.unsubscribeAll();

    expect(fixture.signals[0]!.aborted).toBe(true);
    expect(fixture.streamReadable).toHaveBeenCalledTimes(1);
  });

  it("reopens the desired topic set on transport recovery", async () => {
    await client.subscribeAll(["system-theme-changed", "panel-tree-invalidated"]);
    await client.recover();

    expect(fixture.signals[0]!.aborted).toBe(false);
    expect(fixture.streamReadable).toHaveBeenCalledTimes(2);
    expect(fixture.streamReadable.mock.calls[1]?.[2]).toEqual([
      ["panel-tree-invalidated", "system-theme-changed"],
      expect.any(String),
    ]);
    await client.unsubscribeAll();
  });

  it("owns RpcClient recovery observation only while topics are subscribed", async () => {
    const recoveries = new Set<(kind: "resubscribe" | "cold-recover") => void>();
    const events = new EventsClient({
      ...fixture.rpc,
      onRecovery(listener) {
        recoveries.add(listener);
        return () => recoveries.delete(listener);
      },
    });

    expect(recoveries.size).toBe(0);
    await events.subscribe("panel-tree-invalidated");
    expect(recoveries.size).toBe(1);

    for (const listener of recoveries) listener("resubscribe");
    await vi.waitFor(() => expect(fixture.streamReadable).toHaveBeenCalledTimes(2));
    expect(fixture.streamReadable.mock.calls[1]?.[2]).toEqual([
      ["panel-tree-invalidated"],
      expect.any(String),
    ]);

    await events.unsubscribeAll();
    expect(recoveries.size).toBe(0);
  });

  it("keeps desired topics discoverable after an opening failure", async () => {
    fixture.streamReadable.mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(client.subscribe("panel-tree-invalidated")).rejects.toThrow(
      "transport unavailable"
    );

    await client.recover();
    expect(fixture.streamReadable).toHaveBeenCalledTimes(2);
    expect(fixture.streamReadable.mock.calls[1]?.[2]).toEqual([
      ["panel-tree-invalidated"],
      expect.any(String),
    ]);
    await client.unsubscribeAll();
  });

  it("waits for authoritative recovery after an unexpected terminal close", async () => {
    await client.subscribe("panel-tree-invalidated");
    fixture.close(0);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fixture.streamReadable).toHaveBeenCalledTimes(1);

    await client.recover();
    expect(fixture.streamReadable.mock.calls[1]?.[2]).toEqual([
      ["panel-tree-invalidated"],
      expect.any(String),
    ]);
    await client.unsubscribeAll();
  });

  it("preserves terminal and replacement failures across recovery", async () => {
    const replacementFailure = new Error("replacement admission failed");
    await client.subscribe("panel-tree-invalidated");
    fixture.streamReadable.mockRejectedValueOnce(replacementFailure);
    fixture.close(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const failure = await client.recover().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "Event watch closed unexpectedly" }),
      replacementFailure,
    ]);
    await client.unsubscribeAll();
  });

  it("preserves an active watch failure when its pending replacement also fails", async () => {
    const activeFailure = new Error("active watch failed");
    const replacementFailure = new Error("replacement admission failed");
    let rejectReplacement!: (error: Error) => void;
    const replacement = new Promise<import("@vibestudio/rpc").DecodedFramedStream>(
      (_resolve, reject) => {
        rejectReplacement = reject;
      }
    );
    await client.subscribe("panel-tree-invalidated");
    fixture.streamReadable.mockImplementationOnce(() => replacement);

    const replacing = client.subscribe("system-theme-changed");
    await vi.waitFor(() => expect(fixture.streamReadable).toHaveBeenCalledTimes(2));
    fixture.controllers[0]!.error(activeFailure);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rejectReplacement(replacementFailure);

    const failure = await replacing.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([activeFailure, replacementFailure]);
    await client.unsubscribeAll();
  });

  it("runs every recovery disposer and preserves all cleanup failures", async () => {
    const first = new Error("resubscribe disposer failed");
    const second = new Error("cold recovery disposer failed");
    const releases = [
      vi.fn(() => {
        throw first;
      }),
      vi.fn(() => {
        throw second;
      }),
    ];
    const coordinator = {
      registerResubscribeHandler: vi.fn(() => releases[0]!),
      registerColdRecoverHandler: vi.fn(() => releases[1]!),
    };
    const events = new EventsClient(fixture.rpc, coordinator);
    await events.subscribe("panel-tree-invalidated");

    const failure = await events.unsubscribeAll().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([first, second]);
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
  });

  it("retires an admitted recovery registration when later registration fails", async () => {
    const registrationFailure = new Error("cold recovery registration failed");
    const cleanupFailure = new Error("resubscribe disposer failed");
    const release = vi.fn(() => {
      throw cleanupFailure;
    });
    const coordinator = {
      registerResubscribeHandler: vi.fn(() => release),
      registerColdRecoverHandler: vi.fn(() => {
        throw registrationFailure;
      }),
    };
    const events = new EventsClient(fixture.rpc, coordinator);

    const failure = await events
      .subscribe("panel-tree-invalidated")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([registrationFailure, cleanupFailure]);
    expect(release).toHaveBeenCalledOnce();
    expect(fixture.streamReadable).not.toHaveBeenCalled();
    await events.unsubscribeAll();
  });

  it("isolates listener failures without terminating the watch", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    client.on("panel-tree-invalidated", () => {
      throw new Error("broken listener");
    });
    client.on("panel-tree-invalidated", healthy);
    await client.subscribe("panel-tree-invalidated");

    fixture.emit(0, {
      kind: "event",
      event: "panel-tree-invalidated",
      payload: { revision: 1 },
      sequence: 1,
    });
    fixture.emit(0, {
      kind: "event",
      event: "panel-tree-invalidated",
      payload: { revision: 2 },
      sequence: 2,
    });
    await vi.waitFor(() => expect(healthy).toHaveBeenCalledTimes(2));
    expect(error).toHaveBeenCalledTimes(2);

    error.mockRestore();
    await client.unsubscribeAll();
  });

  it("deduplicates sequenced broadcast records while draining a replacement", async () => {
    const listener = vi.fn();
    client.on("panel-tree-invalidated", listener);
    await client.subscribe("panel-tree-invalidated");

    const record = {
      kind: "event" as const,
      event: "panel-tree-invalidated" as const,
      payload: { revision: 1, forest: [] },
      sequence: 7,
    };
    fixture.emit(0, record);
    fixture.emit(0, record);
    fixture.emit(0, {
      kind: "snapshot",
      event: "panel-tree-invalidated",
      payload: { revision: 0, forest: [] },
      sequence: 6,
    });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    await client.unsubscribeAll();
  });

  it("replays multiple held panel outcomes on the same topic after recovery", async () => {
    const listener = vi.fn();
    client.on("panel-local-presentation-changed", listener);
    await client.subscribe("panel-local-presentation-changed");
    for (const index of [0, 1]) {
      if (index) await client.recover();
      for (const slotId of ["panel:tree/a", "panel:tree/b"]) {
        fixture.emit(index, {
          kind: "snapshot",
          event: "panel-local-presentation-changed",
          sequence: 5,
          payload: { revision: 5, presentation: { state: "idle", slotId } },
        });
      }
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes((index + 1) * 2));
    }
    expect(listener.mock.calls.map(([payload]) => payload.presentation.slotId)).toEqual([
      "panel:tree/a",
      "panel:tree/b",
      "panel:tree/a",
      "panel:tree/b",
    ]);
    await client.unsubscribeAll();
  });

  it("accepts a fresh sequence namespace after the event server restarts", async () => {
    const listener = vi.fn();
    client.on("panel-tree-invalidated", listener);
    await client.subscribe("panel-tree-invalidated");

    fixture.emit(0, {
      kind: "event",
      event: "panel-tree-invalidated",
      payload: { revision: 10, forest: [] },
      sequence: 10,
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

    fixture.restartServer();
    await client.recover();
    fixture.emit(1, {
      kind: "snapshot",
      event: "panel-tree-invalidated",
      payload: { revision: 0, forest: [] },
      sequence: 0,
    });
    fixture.emit(1, {
      kind: "event",
      event: "panel-tree-invalidated",
      payload: { revision: 1, forest: [] },
      sequence: 1,
    });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3));
    expect(listener.mock.calls.map(([payload]) => payload.revision)).toEqual([10, 0, 1]);
    await client.unsubscribeAll();
  });
});
