import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcCaller } from "@vibestudio/rpc";
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
  const stream = vi.fn(
    async (
      _target: string,
      _method: string,
      args: unknown[],
      options?: { signal?: AbortSignal }
    ) => {
      const requested = (args[0] ?? []) as EventName[];
      const watchId = String(args[1]);
      const signal = options?.signal ?? new AbortController().signal;
      signals.push(signal);
      return new Response(
        new ReadableStream<Uint8Array>({
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
        })
      );
    }
  );
  return {
    rpc: { stream } as Pick<RpcCaller, "stream">,
    stream,
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

  it("creates a cryptographic watch id when randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0x2a);
        return bytes;
      },
    });
    const portableClient = new EventsClient(fixture.rpc);

    await portableClient.subscribe("panel-tree-updated");

    expect(fixture.stream.mock.calls.at(-1)?.[2]).toEqual([
      ["panel-tree-updated"],
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
    const mobileClient = new EventsClient({ stream, streamReadable } as never);

    await mobileClient.subscribe("panel-tree-updated");

    expect(streamReadable).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
    await mobileClient.unsubscribeAll();
  });

  it("opens one response-owned watch and dispatches its records", async () => {
    const listener = vi.fn();
    client.on("panel-tree-updated", listener);

    await client.subscribe("panel-tree-updated");
    expect(fixture.stream).toHaveBeenCalledWith(
      "main",
      "events.watch",
      [["panel-tree-updated"], expect.any(String)],
      expect.objectContaining({ signal: expect.any(AbortSignal), bodyIdleTimeoutMs: null })
    );

    fixture.emit(0, {
      kind: "event",
      event: "panel-tree-updated",
      payload: { revision: 1, forest: [] },
      sequence: 1,
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ revision: 1, forest: [] }));
    await client.unsubscribeAll();
  });

  it("can bind the same watch contract to an explicit event domain", async () => {
    const desktopEvents = new EventsClient(fixture.rpc, undefined, "desktopEvents");

    await desktopEvents.subscribe("system-theme-changed");

    expect(fixture.stream).toHaveBeenCalledWith(
      "main",
      "desktopEvents.watch",
      [["system-theme-changed"], expect.any(String)],
      expect.anything()
    );
    await desktopEvents.unsubscribeAll();
  });

  it("replaces the exact response with the complete sorted topic set", async () => {
    await client.subscribe("system-theme-changed");
    await client.subscribe("panel-tree-updated");

    expect(fixture.signals[0]!.aborted).toBe(false);
    expect(fixture.stream).toHaveBeenNthCalledWith(
      2,
      "main",
      "events.watch",
      [["panel-tree-updated", "system-theme-changed"], expect.any(String)],
      expect.anything()
    );

    await client.unsubscribe("system-theme-changed");
    expect(fixture.signals[1]!.aborted).toBe(false);
    expect(fixture.stream).toHaveBeenNthCalledWith(
      3,
      "main",
      "events.watch",
      [["panel-tree-updated"], expect.any(String)],
      expect.anything()
    );
    await client.unsubscribeAll();
  });

  it("unsubscribes only by aborting the owned response", async () => {
    await client.subscribe("panel-tree-updated");
    await client.unsubscribeAll();

    expect(fixture.signals[0]!.aborted).toBe(true);
    expect(fixture.stream).toHaveBeenCalledTimes(1);
  });

  it("reopens the desired topic set on transport recovery", async () => {
    await client.subscribeAll(["system-theme-changed", "panel-tree-updated"]);
    await client.recover();

    expect(fixture.signals[0]!.aborted).toBe(false);
    expect(fixture.stream).toHaveBeenCalledTimes(2);
    expect(fixture.stream.mock.calls[1]?.[2]).toEqual([
      ["panel-tree-updated", "system-theme-changed"],
      expect.any(String),
    ]);
    await client.unsubscribeAll();
  });

  it("keeps desired topics discoverable after an opening failure", async () => {
    fixture.stream.mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(client.subscribe("panel-tree-updated")).rejects.toThrow("transport unavailable");

    await client.recover();
    expect(fixture.stream).toHaveBeenCalledTimes(2);
    expect(fixture.stream.mock.calls[1]?.[2]).toEqual([["panel-tree-updated"], expect.any(String)]);
    await client.unsubscribeAll();
  });

  it("reopens desired topics after an unexpected terminal close", async () => {
    await client.subscribe("panel-tree-updated");
    fixture.close(0);

    await vi.waitFor(() => expect(fixture.stream).toHaveBeenCalledTimes(2));
    expect(fixture.stream.mock.calls[1]?.[2]).toEqual([["panel-tree-updated"], expect.any(String)]);
    await client.unsubscribeAll();
  });

  it("isolates listener failures without terminating the watch", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    client.on("panel-tree-updated", () => {
      throw new Error("broken listener");
    });
    client.on("panel-tree-updated", healthy);
    await client.subscribe("panel-tree-updated");

    fixture.emit(0, {
      kind: "event",
      event: "panel-tree-updated",
      payload: { revision: 1 },
      sequence: 1,
    });
    fixture.emit(0, {
      kind: "event",
      event: "panel-tree-updated",
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
    client.on("panel-tree-updated", listener);
    await client.subscribe("panel-tree-updated");

    const record = {
      kind: "event" as const,
      event: "panel-tree-updated" as const,
      payload: { revision: 1, forest: [] },
      sequence: 7,
    };
    fixture.emit(0, record);
    fixture.emit(0, record);
    fixture.emit(0, {
      kind: "snapshot",
      event: "panel-tree-updated",
      payload: { revision: 0, forest: [] },
      sequence: 6,
    });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    await client.unsubscribeAll();
  });

  it("accepts a fresh sequence namespace after the event server restarts", async () => {
    const listener = vi.fn();
    client.on("panel-tree-updated", listener);
    await client.subscribe("panel-tree-updated");

    fixture.emit(0, {
      kind: "event",
      event: "panel-tree-updated",
      payload: { revision: 10, forest: [] },
      sequence: 10,
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

    fixture.restartServer();
    await client.recover();
    fixture.emit(1, {
      kind: "snapshot",
      event: "panel-tree-updated",
      payload: { revision: 0, forest: [] },
      sequence: 0,
    });
    fixture.emit(1, {
      kind: "event",
      event: "panel-tree-updated",
      payload: { revision: 1, forest: [] },
      sequence: 1,
    });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3));
    expect(listener.mock.calls.map(([payload]) => payload.revision)).toEqual([10, 0, 1]);
    await client.unsubscribeAll();
  });
});
