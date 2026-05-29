import { describe, expect, it, vi } from "vitest";
import { createEventsServiceDefinition, EventService } from "./eventsService.js";
import { createVerifiedCaller, type CallerKind, type ServiceContext } from "./serviceDispatcher.js";
import type { PanelTreeSnapshot } from "./types.js";

const emptyPanelTreeSnapshot: PanelTreeSnapshot = { revision: 1, rootPanels: [] };

function makeWsClient(callerId: string, callerKind: CallerKind, connectionId: string) {
  const ws = {
    readyState: 1,
    send: vi.fn(),
    on: vi.fn(),
  };
  const caller = createVerifiedCaller(callerId, callerKind);
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
          effectiveVersion: "ev",
          requestedAt: 1,
          capability: "internal-git-write",
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
});
