import { describe, expect, it, vi } from "vitest";
import { DoPushSubscriber, EventService } from "@vibestudio/shared/eventsService";
import { createEventsServiceDefinition } from "./eventsServiceDefinition.js";
import {
  createVerifiedCaller,
  type CallerKind,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import type { PanelTreeSnapshot } from "@vibestudio/shared/types";

const emptyPanelTreeSnapshot: PanelTreeSnapshot = { revision: 1, forest: [] };

function makeWsClient(
  callerId: string,
  callerKind: CallerKind,
  connectionId: string,
  userId?: string
) {
  const ws = {
    readyState: 1,
    send: vi.fn(),
    on: vi.fn(),
  };
  const caller = createVerifiedCaller(
    callerId,
    callerKind,
    null,
    null,
    userId ? { userId, handle: userId } : null
  );
  return {
    ws,
    ctx: {
      caller,
      connectionId,
      wsClient: {
        ws,
        caller,
        connectionId,
        authenticated: true,
      },
    } satisfies ServiceContext,
  };
}

describe("EventService", () => {
  it("unsubscribeAll removes only the current connection's event subscriptions", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    const conn1 = makeWsClient("panel-one", "panel", "conn-1");
    const conn2 = makeWsClient("panel-one", "panel", "conn-2");

    await service.handler(conn1.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn2.ctx, "subscribe", ["panel-tree-updated"]);

    await service.handler(conn1.ctx, "unsubscribeAll", []);

    eventService.emit("panel-tree-updated", emptyPanelTreeSnapshot);

    expect(conn1.ws.send).not.toHaveBeenCalled();
    expect(conn2.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:panel-tree-updated",
        payload: emptyPanelTreeSnapshot,
      })
    );
  });

  it("unsubscribeAll does not remove direct-address reachability", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    const conn1 = makeWsClient("panel-one", "panel", "conn-1");
    const conn2 = makeWsClient("panel-one", "panel", "conn-2");

    await service.handler(conn1.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn2.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn1.ctx, "unsubscribeAll", []);

    const delivered = eventService.emitToCaller("panel-one", "focus-address-bar");

    expect(delivered).toBe(true);
    expect(conn1.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:focus-address-bar",
      })
    );
    expect(conn2.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:focus-address-bar",
      })
    );
  });

  it("can direct-address exactly one live connection", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    const conn1 = makeWsClient("panel-one", "panel", "conn-1");
    const conn2 = makeWsClient("panel-one", "panel", "conn-2");

    await service.handler(conn1.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn2.ctx, "subscribe", ["panel-tree-updated"]);

    const delivered = eventService.emitToConnection("panel-one", "conn-2", "focus-address-bar");

    expect(delivered).toBe(true);
    expect(conn1.ws.send).not.toHaveBeenCalled();
    expect(conn2.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:focus-address-bar",
      })
    );
  });

  it("direct-addresses every live runtime for one verified account without leaking cross-user", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    const aliceDesktop = makeWsClient("shell:alice-desktop", "shell", "conn-a1", "usr_alice");
    const alicePanel = makeWsClient("panel:alice-chat", "panel", "conn-a2", "usr_alice");
    const bobDesktop = makeWsClient("shell:bob-desktop", "shell", "conn-b1", "usr_bob");

    await service.handler(aliceDesktop.ctx, "subscribe", ["user-notifications-changed"]);
    await service.handler(alicePanel.ctx, "subscribe", ["user-notifications-changed"]);
    await service.handler(bobDesktop.ctx, "subscribe", ["user-notifications-changed"]);
    aliceDesktop.ws.send.mockClear();
    alicePanel.ws.send.mockClear();
    bobDesktop.ws.send.mockClear();

    const delivered = eventService.emitToUser("usr_alice", "user-notifications-changed", {
      changedAt: 42,
    });

    expect(delivered).toBe(true);
    expect(aliceDesktop.ws.send).toHaveBeenCalledTimes(1);
    expect(alicePanel.ws.send).toHaveBeenCalledTimes(1);
    expect(bobDesktop.ws.send).not.toHaveBeenCalled();
  });

  it("still delivers to a live sibling when an earlier subscriber is dead (no mid-iteration skip)", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    // Two connections for the SAME caller under one event bucket: if the first
    // is dead, reaping it mid-iteration must not skip the second.
    const dead = makeWsClient("panel-one", "panel", "conn-dead");
    const live = makeWsClient("panel-one", "panel", "conn-live");

    await service.handler(dead.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(live.ctx, "subscribe", ["panel-tree-updated"]);

    // Kill the first subscriber's socket before the emit.
    dead.ws.readyState = 3; // CLOSED

    eventService.emit("panel-tree-updated", emptyPanelTreeSnapshot);

    expect(dead.ws.send).not.toHaveBeenCalled();
    expect(live.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:panel-tree-updated",
        payload: emptyPanelTreeSnapshot,
      })
    );

    // The dead subscriber was reaped: a second emit reaches only the live one.
    live.ws.send.mockClear();
    eventService.emit("panel-tree-updated", emptyPanelTreeSnapshot);
    expect(live.ws.send).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing subscriber send and keeps fanning out", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    const boom = makeWsClient("panel-one", "panel", "conn-boom");
    const ok = makeWsClient("panel-one", "panel", "conn-ok");
    boom.ws.send.mockImplementation(() => {
      throw new Error("socket write failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await service.handler(boom.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(ok.ctx, "subscribe", ["panel-tree-updated"]);

    expect(() => eventService.emit("panel-tree-updated", emptyPanelTreeSnapshot)).not.toThrow();
    expect(ok.ws.send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sends a snapshot immediately when subscribing to a stateful event", async () => {
    const eventService = new EventService();
    const snapshot = {
      pending: [
        {
          kind: "capability" as const,
          approvalId: "approval-1",
          callerId: "panel-one",
          callerKind: "panel" as const,
          repoPath: "panels/test",
          executionDigest: "ev",
          delegations: [],
          requested: [
            { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
            { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
          ],
          requestedAt: 1,
          decisionDeadlineAt: 60_001,
          capability: "workspace-repo-write",
          title: "Write project files",
          resource: { type: "git-repo", label: "Repository", value: "panels/test" },
        },
      ],
    };
    const service = createEventsServiceDefinition(eventService, {
      snapshots: {
        "shell-approval:pending-changed": () => snapshot,
      },
    });
    const conn = makeWsClient("shell", "shell", "conn-1");

    await service.handler(conn.ctx, "subscribe", ["shell-approval:pending-changed"]);

    expect(conn.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:shell-approval:pending-changed",
        payload: snapshot,
      })
    );
  });

  // ── Server→DO event push (connectionless subscribers) ──────────────────────

  describe("DO push-subscriber", () => {
    const EVENT = "panel-tree-updated" as const;
    const doCtx = (callerId: string, connectionId = "c1"): ServiceContext => ({
      caller: createVerifiedCaller(callerId, "do"),
      connectionId,
    });

    it("mints a push-subscriber for a no-WS do caller and routes emit through it", async () => {
      const eventService = new EventService();
      const delivered: Array<[string, string, unknown]> = [];
      eventService.setDoPushDelivery(async (callerId, channel, payload) => {
        delivered.push([callerId, channel, payload]);
      });
      const service = createEventsServiceDefinition(eventService);

      await service.handler(doCtx("do:test:EvalDO:k1"), "subscribe", [EVENT]);
      eventService.emit(EVENT, emptyPanelTreeSnapshot);
      // Delivery is now chained (ordered retries), so it lands on a microtask.
      await Promise.resolve();
      await Promise.resolve();

      expect(delivered).toEqual([
        ["do:test:EvalDO:k1", "event:panel-tree-updated", emptyPanelTreeSnapshot],
      ]);
    });

    it("reaps the push-subscriber once the caller's last topic unsubscribes", async () => {
      const eventService = new EventService();
      const deliver = vi.fn(async () => {});
      eventService.setDoPushDelivery(deliver);
      const service = createEventsServiceDefinition(eventService);
      const ctx = doCtx("do:test:EvalDO:k2");

      await service.handler(ctx, "subscribe", [EVENT]);
      await service.handler(ctx, "unsubscribe", [EVENT]);
      eventService.emit(EVENT, emptyPanelTreeSnapshot);

      expect(deliver).not.toHaveBeenCalled();
    });

    it("reaps the push-subscriber on unsubscribeAll (idle EvalDO eviction path)", async () => {
      const eventService = new EventService();
      const deliver = vi.fn(async () => {});
      eventService.setDoPushDelivery(deliver);
      const service = createEventsServiceDefinition(eventService);
      const ctx = doCtx("do:test:EvalDO:k5");

      await service.handler(ctx, "subscribe", [EVENT]);
      await service.handler(ctx, "unsubscribeAll", []);
      eventService.emit(EVENT, emptyPanelTreeSnapshot);

      expect(deliver).not.toHaveBeenCalled();
    });

    it("self-reaps a push-subscriber on a TERMINAL delivery error (DO gone)", async () => {
      const eventService = new EventService();
      const deliver = vi.fn(async () => {
        throw Object.assign(new Error("DO not created"), { code: "DO_NOT_CREATED" });
      });
      eventService.setDoPushDelivery(deliver);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = createEventsServiceDefinition(eventService);

      await service.handler(doCtx("do:test:EvalDO:k3"), "subscribe", [EVENT]);
      eventService.emit(EVENT, emptyPanelTreeSnapshot); // terminal error → subscriber destroyed
      await Promise.resolve();
      await Promise.resolve();
      eventService.emit(EVENT, emptyPanelTreeSnapshot); // gone — no second delivery

      expect(deliver).toHaveBeenCalledTimes(1);
      // Teardown was logged with callerId + channel (not a silent reap).
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("do:test:EvalDO:k3");
      expect(logged).toContain("event:panel-tree-updated");
      warn.mockRestore();
    });

    it("does NOT reap on a TRANSIENT delivery failure — retries and keeps the subscription", async () => {
      let attempts = 0;
      const deliver = vi.fn(async () => {
        attempts++;
        if (attempts < 3) throw new Error("network blip"); // no terminal code → transient
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const sub = new DoPushSubscriber("do:test:EvalDO:transient", "do", deliver, {
        sleep: async () => {}, // collapse backoff
      });

      sub.send("event:panel-tree-updated", emptyPanelTreeSnapshot);
      // Drain the chained retry loop.
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(attempts).toBe(3); // retried twice then succeeded
      expect(sub.isAlive).toBe(true); // still subscribed, NOT silently deaf
      expect(warn).not.toHaveBeenCalled(); // no teardown logged on recovery
      warn.mockRestore();
    });

    it("reaps (loudly) only after exhausting retries on a persistent transient failure", async () => {
      const deliver = vi.fn(async () => {
        throw new Error("still unreachable");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const sub = new DoPushSubscriber("do:test:EvalDO:dead", "do", deliver, {
        maxAttempts: 3,
        sleep: async () => {},
      });

      sub.send("event:panel-tree-updated", emptyPanelTreeSnapshot);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(deliver).toHaveBeenCalledTimes(3); // all attempts used
      expect(sub.isAlive).toBe(false); // finally reaped
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("after 3 attempts");
      expect(logged).toContain("do:test:EvalDO:dead");
      warn.mockRestore();
    });

    it("still requires a WS or push delivery — bare do caller with no delivery wired throws", async () => {
      const eventService = new EventService(); // no setDoPushDelivery
      const service = createEventsServiceDefinition(eventService);

      await expect(
        service.handler(doCtx("do:test:EvalDO:k4"), "subscribe", [EVENT])
      ).rejects.toThrow(/WS connection or pre-registered subscriber/);
    });
  });
});
