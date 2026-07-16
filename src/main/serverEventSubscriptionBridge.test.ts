import { describe, expect, it, vi } from "vitest";
import { encodeEventWatchRecord, type EventName } from "@vibestudio/shared/events";
import { createServerEventSubscriptionBridge } from "./serverEventSubscriptionBridge.js";

function makeFixture() {
  const signals: AbortSignal[] = [];
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const watches = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const stream = vi.fn(
    async (
      _service: string,
      _method: string,
      args: unknown[],
      options?: { signal?: AbortSignal }
    ) => {
      const requested = args[0] as EventName[];
      const watchId = String(args[1]);
      const signal = options?.signal ?? new AbortController().signal;
      signals.push(signal);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            const previous = watches.get(watchId);
            watches.set(watchId, controller);
            previous?.close();
            controller.enqueue(
              encodeEventWatchRecord({ kind: "watching", events: requested, epoch: "test-epoch" })
            );
            signal.addEventListener("abort", () => {
              try {
                controller.close();
              } catch {
                // Already terminal.
              }
            });
          },
        })
      );
    }
  );
  const onEvent = vi.fn();
  const bridge = createServerEventSubscriptionBridge({
    getServerClient: () => ({ stream }) as never,
    onEvent,
    log: { warn: vi.fn() },
  });
  return { bridge, stream, signals, controllers, onEvent };
}

describe("createServerEventSubscriptionBridge", () => {
  it("folds a batch of retained topics into one response watch", async () => {
    const fixture = makeFixture();
    const release = await fixture.bridge.retainAll([
      "shell-approval:pending-changed",
      "panel-tree-updated",
    ]);

    expect(fixture.stream).toHaveBeenCalledTimes(1);
    expect(fixture.stream).toHaveBeenCalledWith(
      "events",
      "watch",
      [["panel-tree-updated", "shell-approval:pending-changed"], expect.any(String)],
      expect.objectContaining({ bodyIdleTimeoutMs: null })
    );
    release();
    await fixture.bridge.close();
  });

  it("reference-counts a topic and releases it with the last local watch", async () => {
    const fixture = makeFixture();
    const releaseOne = fixture.bridge.retain("panel-tree-updated");
    const releaseTwo = fixture.bridge.retain("panel-tree-updated");
    await vi.waitFor(() => expect(fixture.stream).toHaveBeenCalledTimes(1));

    releaseOne();
    expect(fixture.signals[0]!.aborted).toBe(false);
    releaseTwo();
    await vi.waitFor(() => expect(fixture.signals[0]!.aborted).toBe(true));
    expect(fixture.stream).toHaveBeenCalledTimes(1);
  });

  it("delivers response records through the bridge callback", async () => {
    const fixture = makeFixture();
    await fixture.bridge.retainAll(["panel-tree-updated"]);
    const payload = { revision: 1, forest: [] };
    fixture.controllers[0]!.enqueue(
      encodeEventWatchRecord({
        kind: "event",
        event: "panel-tree-updated",
        payload,
        sequence: 1,
      })
    );

    await vi.waitFor(() =>
      expect(fixture.onEvent).toHaveBeenCalledWith("panel-tree-updated", payload)
    );
    await fixture.bridge.close();
  });

  it("reopens the same desired set after transport recovery", async () => {
    const fixture = makeFixture();
    await fixture.bridge.retainAll(["panel-tree-updated"]);
    await fixture.bridge.recover();

    expect(fixture.signals[0]!.aborted).toBe(false);
    expect(fixture.stream).toHaveBeenCalledTimes(2);
    expect(fixture.stream.mock.calls[1]?.[2]).toEqual([["panel-tree-updated"], expect.any(String)]);
    await fixture.bridge.close();
  });
});
