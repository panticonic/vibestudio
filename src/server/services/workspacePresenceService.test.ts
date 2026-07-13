/**
 * WP8 §4 workspace-USER presence tests. Everything here is driven from pure
 * session facts (a fake connection registry) + a fake identity DB — no channel
 * concept anywhere, mirroring the host/userland separation the service enforces.
 */

import { describe, expect, it } from "vitest";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import type { ResolvedUser } from "@vibestudio/identity/identityDb";
import {
  createWorkspacePresenceService,
  type PresenceConnection,
  type WorkspacePresenceEntry,
} from "./workspacePresenceService.js";

function conn(
  userId: string,
  kind: CallerKind,
  options: { id?: string; authorizedBy?: string; clientSessionId?: string } = {}
): PresenceConnection {
  return {
    userId,
    caller: { runtime: { id: options.id ?? `${kind}:${userId}`, kind } },
    ...(options.authorizedBy ? { authorizedBy: options.authorizedBy } : {}),
    ...(options.clientSessionId ? { clientSessionId: options.clientSessionId } : {}),
  };
}

/** Controllable fake of the host connection registry (WP4). */
function makeRegistry() {
  const byUser = new Map<string, PresenceConnection[]>();
  let listener: (() => void) | null = null;
  return {
    /** Set (or clear, with []) a user's live connections, then fire the change. */
    set(userId: string, connections: PresenceConnection[]): void {
      if (connections.length > 0) byUser.set(userId, connections);
      else byUser.delete(userId);
    },
    fire(): void {
      listener?.();
    },
    listUsersWithLiveConnections: () => [...byUser.keys()],
    getUserConnections: (userId: string) => byUser.get(userId) ?? [],
    onConnectionsChanged: (l: () => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
}

function makeIdentityDb() {
  return {
    resolveUsers(userIds: readonly string[]): Map<string, ResolvedUser> {
      const out = new Map<string, ResolvedUser>();
      for (const id of userIds) {
        out.set(id, {
          handle: `${id}-handle`,
          displayName: `${id} Display`,
          color: `#0000${id.length}0`,
          role: "member",
        });
      }
      return out;
    },
  };
}

function harness() {
  const registry = makeRegistry();
  const identityDb = makeIdentityDb();
  const emitted: WorkspacePresenceEntry[][] = [];
  const hubReports: Array<Array<{ userId: string; endpoints: number }>> = [];
  let clock = 1_000;
  const svc = createWorkspacePresenceService({
    connectionRegistry: registry,
    identityDb,
    eventService: { emit: (_event, data) => emitted.push(data) },
    onOnlineChanged: (users) => hubReports.push(users),
    now: () => clock,
  });
  return {
    registry,
    svc,
    emitted,
    hubReports,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("workspacePresenceService (WP8 §4)", () => {
  it("lists each connected user once, online, with live identity", () => {
    const h = harness();
    h.registry.set("u1", [conn("u1", "shell")]);
    h.registry.set("u2", [conn("u2", "panel")]);

    const list = h.svc.list();
    expect(list.map((e) => e.userId).sort()).toEqual(["u1", "u2"]);
    expect(list.every((e) => e.online)).toBe(true);
    // Handle/displayName/color come LIVE from the identity DB (never frozen).
    const u1 = list.find((e) => e.userId === "u1");
    expect(u1?.handle).toBe("u1-handle");
    expect(u1?.displayName).toBe("u1 Display");
    expect(u1?.color).toBe("#000020"); // fake tint = `#0000${"u1".length}0`
  });

  it("collapses panels into their device endpoint while preserving multiple devices", () => {
    const h = harness();
    h.registry.set("u1", [
      conn("u1", "shell", { id: "shell:device-a" }),
      conn("u1", "panel", { id: "panel:one", authorizedBy: "shell:device-a" }),
      conn("u1", "shell", { id: "shell:device-b" }),
    ]);
    h.registry.fire();
    expect(h.svc.list().filter((e) => e.userId === "u1")).toHaveLength(1);
    expect(h.svc.list().find((e) => e.userId === "u1")?.endpoints).toBe(2);
    expect(h.hubReports.at(-1)).toEqual([{ userId: "u1", endpoints: 2 }]);

    // Dropping ONE device keeps the user online (offline only when the last drops).
    h.registry.set("u1", [
      conn("u1", "shell", { id: "shell:device-a" }),
      conn("u1", "panel", { id: "panel:one", authorizedBy: "shell:device-a" }),
    ]);
    h.registry.fire();
    const still = h.svc.list().find((e) => e.userId === "u1");
    expect(still?.online).toBe(true);
    expect(still?.endpoints).toBe(1);
  });

  it("excludes agent/worker/do deputies and the system subject", () => {
    const h = harness();
    h.registry.set("system", [conn("system", "shell")]); // synthetic subject
    h.registry.set("bot", [conn("bot", "worker"), conn("bot", "do"), conn("bot", "agent")]);
    h.registry.set("u1", [conn("u1", "shell")]);
    h.registry.fire();
    expect(h.svc.list().map((e) => e.userId)).toEqual(["u1"]);
  });

  it("goes offline with a frozen last-seen when the last connection drops, and emits", () => {
    const h = harness();
    h.registry.set("u1", [conn("u1", "app")]);
    h.registry.fire();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.[0]?.online).toBe(true);

    h.advance(5_000);
    h.registry.set("u1", []); // last endpoint drops at t = 6_000
    h.registry.fire();

    const off = h.svc.list().find((e) => e.userId === "u1");
    expect(off?.online).toBe(false);
    expect(off?.lastSeen).toBe(6_000);
    expect(off?.endpoints).toBeUndefined();
    // The drop broadcast carries the now-offline row.
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1]?.[0]?.online).toBe(false);
  });

  it("does not emit when the presence shape is unchanged (no storm)", () => {
    const h = harness();
    h.registry.set("u1", [conn("u1", "shell")]);
    h.registry.fire();
    const after = h.emitted.length;
    h.registry.fire(); // identical registry state
    h.registry.fire();
    expect(h.emitted.length).toBe(after);
  });

  it("drops a departed user from the surface after the last-seen window", () => {
    const h = harness();
    h.registry.set("u1", [conn("u1", "shell")]);
    h.registry.fire();
    h.registry.set("u1", []);
    h.registry.fire();
    expect(h.svc.list().some((e) => e.userId === "u1")).toBe(true); // still within window

    h.advance(6 * 60_000); // beyond the retention window
    expect(h.svc.list().some((e) => e.userId === "u1")).toBe(false);
  });
});
