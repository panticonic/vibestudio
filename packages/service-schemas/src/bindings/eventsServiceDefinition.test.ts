import { describe, expect, it, vi } from "vitest";
import { EventService } from "@vibestudio/shared/eventsService";
import { readEventWatchRecords } from "@vibestudio/shared/events";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { PanelTreeSnapshot } from "@vibestudio/shared/types";
import { createEventsServiceDefinition } from "./eventsServiceDefinition.js";

const EVENT = "panel-tree-updated" as const;
const snapshot: PanelTreeSnapshot = { revision: 1, forest: [] };

function context(
  callerId: string,
  requestId: string,
  options: { ws?: boolean; userId?: string } = {}
): ServiceContext {
  const caller = createVerifiedCaller(
    callerId,
    options.ws ? "panel" : "do",
    null,
    null,
    options.userId ? { userId: options.userId, handle: options.userId } : null
  );
  const ws = options.ws ? { readyState: 1, send: vi.fn(), on: vi.fn() } : undefined;
  return {
    caller,
    requestId,
    connectionId: options.ws ? `connection:${callerId}` : undefined,
    ...(ws
      ? {
          wsClient: {
            ws,
            caller,
            connectionId: `connection:${callerId}`,
            authenticated: true,
          },
        }
      : {}),
  } as ServiceContext;
}

async function open(
  service: ReturnType<typeof createEventsServiceDefinition>,
  ctx: ServiceContext,
  events = [EVENT],
  watchId = ctx.requestId ?? "watch"
) {
  const response = (await service.handler(ctx, "watch", [events, watchId])) as Response;
  const records = readEventWatchRecords(response);
  return { response, records };
}

describe("events.watch", () => {
  it("acknowledges the exact topic set before delivering events", async () => {
    const events = new EventService();
    const service = createEventsServiceDefinition(events);
    const watch = await open(service, context("do:test:one", "request:one"));

    await expect(watch.records.next()).resolves.toEqual({
      done: false,
      value: { kind: "watching", events: [EVENT], epoch: expect.any(String) },
    });
    events.emit(EVENT, snapshot);
    await expect(watch.records.next()).resolves.toEqual({
      done: false,
      value: { kind: "event", event: EVENT, payload: snapshot, sequence: 1 },
    });

    await watch.records.return();
    expect(events.getSubscriberCount(EVENT)).toBe(0);
  });

  it("cancelling one response removes only that concrete watch", async () => {
    const events = new EventService();
    const service = createEventsServiceDefinition(events);
    const first = await open(service, context("do:test:same", "request:first"));
    const second = await open(service, context("do:test:same", "request:second"));
    await first.records.next();
    await second.records.next();
    expect(events.getSubscriberCount(EVENT)).toBe(2);

    await first.records.return();
    expect(events.getSubscriberCount(EVENT)).toBe(1);
    events.emit(EVENT, snapshot);
    await expect(second.records.next()).resolves.toMatchObject({
      value: { kind: "event", event: EVENT, payload: snapshot, sequence: 1 },
    });

    await second.records.return();
    expect(events.getSubscriberCount(EVENT)).toBe(0);
  });

  it("atomically replaces the same logical watch without a delivery gap", async () => {
    const events = new EventService();
    const service = createEventsServiceDefinition(events);
    const ctx = context("do:test:replace", "request:first");
    const first = await open(service, ctx, [EVENT], "logical-watch");
    await first.records.next();

    const second = await open(service, ctx, [EVENT], "logical-watch");
    await second.records.next();
    expect(events.getSubscriberCount(EVENT)).toBe(1);
    events.emit(EVENT, snapshot);

    await expect(first.records.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(second.records.next()).resolves.toEqual({
      done: false,
      value: { kind: "event", event: EVENT, payload: snapshot, sequence: 1 },
    });
    await second.records.return();
  });

  it("emits state snapshots after the watch ACK", async () => {
    const events = new EventService();
    const service = createEventsServiceDefinition(events, {
      snapshots: { [EVENT]: () => snapshot },
    });
    const watch = await open(service, context("do:test:snapshot", "request:snapshot"));

    await expect(watch.records.next()).resolves.toMatchObject({ value: { kind: "watching" } });
    await expect(watch.records.next()).resolves.toEqual({
      done: false,
      value: { kind: "snapshot", event: EVENT, payload: snapshot, sequence: 0 },
    });
    await watch.records.return();
  });

  it("registers the watch before evaluating its snapshot provider", async () => {
    const events = new EventService();
    const duringSnapshot = { revision: 2, forest: [] } satisfies PanelTreeSnapshot;
    const service = createEventsServiceDefinition(events, {
      snapshots: {
        [EVENT]: () => {
          events.emit(EVENT, duringSnapshot);
          return snapshot;
        },
      },
    });
    const watch = await open(service, context("do:test:snapshot-order", "request:snapshot-order"));

    await expect(watch.records.next()).resolves.toMatchObject({ value: { kind: "watching" } });
    await expect(watch.records.next()).resolves.toEqual({
      done: false,
      value: { kind: "event", event: EVENT, payload: duringSnapshot, sequence: 1 },
    });
    await expect(watch.records.next()).resolves.toEqual({
      done: false,
      value: { kind: "snapshot", event: EVENT, payload: snapshot, sequence: 1 },
    });
    await watch.records.return();
  });

  it("ties bridge retention to the response terminal", async () => {
    const events = new EventService();
    const release = vi.fn();
    const opened = vi.fn(() => release);
    const service = createEventsServiceDefinition(events, { onWatchOpened: opened });
    const ctx = context("do:test:retained", "request:retained");
    const watch = await open(service, ctx);
    await watch.records.next();

    expect(opened).toHaveBeenCalledWith([EVENT], ctx);
    expect(release).not.toHaveBeenCalled();
    await watch.records.return();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps direct delivery independent of connectionless watch responses", async () => {
    const events = new EventService();
    const service = createEventsServiceDefinition(events);
    const watch = await open(service, context("do:test:direct", "request:direct"));
    await watch.records.next();

    expect(events.emitToCaller("do:test:direct", "focus-address-bar")).toBe(false);
    const send = vi.fn();
    const release = events.registerTransportSession({
      callerId: "do:test:direct",
      callerKind: "do",
      connectionId: EventService.DEFAULT_CONNECTION_ID,
      send,
    });
    expect(events.emitToCaller("do:test:direct", "focus-address-bar")).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    await watch.records.return();
    expect(events.emitToCaller("do:test:direct", "focus-address-bar")).toBe(true);
    release();
    expect(events.emitToCaller("do:test:direct", "focus-address-bar")).toBe(false);
  });

  it("delivers once per authenticated transport for a verified account", () => {
    const events = new EventService();
    const first = vi.fn();
    const second = vi.fn();
    events.registerTransportSession({
      callerId: "panel:one",
      callerKind: "panel",
      connectionId: "connection:one",
      userId: "user:one",
      send: first,
    });
    events.registerTransportSession({
      callerId: "panel:two",
      callerKind: "panel",
      connectionId: "connection:two",
      userId: "user:one",
      send: second,
    });
    expect(events.emitToUser("user:one", "focus-address-bar")).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("direct-addresses exactly one transport and replacement cleanup is identity-safe", () => {
    const events = new EventService();
    const oldSend = vi.fn();
    const newSend = vi.fn();
    const releaseOld = events.registerTransportSession({
      callerId: "shell:shared",
      callerKind: "shell",
      connectionId: "connection:first",
      send: oldSend,
    });
    events.registerTransportSession({
      callerId: "shell:shared",
      callerKind: "shell",
      connectionId: "connection:first",
      send: newSend,
    });
    releaseOld();
    expect(events.emitToConnection("shell:shared", "connection:first", "focus-address-bar")).toBe(
      true
    );
    expect(oldSend).not.toHaveBeenCalled();
    expect(newSend).toHaveBeenCalledOnce();
    expect(events.emitToConnection("shell:shared", "connection:missing", "focus-address-bar")).toBe(
      false
    );
  });

  it("terminates and unregisters a watch whose bounded buffer overflows", async () => {
    const events = new EventService();
    const service = createEventsServiceDefinition(events);
    const watch = await open(service, context("do:test:slow", "request:slow"));
    const oversized = "x".repeat(EventService.MAX_WATCH_BUFFER_BYTES);

    events.emit(EVENT, { revision: 1, forest: [], oversized } as never);

    expect(events.getSubscriberCount(EVENT)).toBe(0);
    await expect(watch.records.next()).rejects.toThrow("buffer capacity exceeded");
  });

  it("rejects unknown topics before allocating a response", async () => {
    const events = new EventService();
    const service = createEventsServiceDefinition(events);
    await expect(
      service.handler(context("do:test:invalid", "request:invalid"), "watch", [
        ["not-an-event"],
        "watch:invalid",
      ])
    ).rejects.toThrow("Unknown event: not-an-event");
  });
});
