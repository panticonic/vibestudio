import { describe, expect, it } from "vitest";
import {
  enqueueAction,
  loadOpen,
  loadPendingActions,
  serializeOpen,
  serializePendingActions,
} from "./actionQueue";

const scope = { serverId: "srv_aaaaaaaaaaaaaaaaaaaaaaaa", workspaceId: "project", userId: "alice" };
const target = { ...scope, approvalId: "approval-1" };

describe("workspace-scoped background approval actions", () => {
  it("persists the captured workspace and account", () => {
    const action = { ...target, decision: "deny" as const, queuedAt: 1000 };
    const queued = enqueueAction([], action);
    expect(loadPendingActions(serializePendingActions(queued))).toEqual([action]);
  });

  it("keeps colliding approval ids in different workspaces independent, and a later decision replaces an earlier one", () => {
    const original = { ...target, decision: "once" as const, queuedAt: 1 };
    const other = { ...original, workspaceId: "other", decision: "deny" as const };
    const queued = enqueueAction(enqueueAction([original], other), {
      ...original,
      decision: "version",
      queuedAt: 3,
    });
    expect(queued).toEqual([other, { ...original, decision: "version", queuedAt: 3 }]);
  });

  it("does not guess the destination of unscoped actions or opens", () => {
    expect(
      loadPendingActions(
        JSON.stringify({
          version: 1,
          actions: [{ approvalId: "approval-1", decision: "deny", queuedAt: 1 }],
        })
      )
    ).toEqual([]);
    expect(loadOpen(JSON.stringify({ kind: "approval", target: { approvalId: "a" } }))).toBeNull();
  });

  it("keeps old decisions queued and round-trips an open", () => {
    const old = { ...target, decision: "deny" as const, queuedAt: 0 };
    expect(loadPendingActions(serializePendingActions([old]))).toEqual([old]);
    const open = { kind: "approval" as const, target };
    expect(loadOpen(serializeOpen(open))).toEqual(open);
  });
});
