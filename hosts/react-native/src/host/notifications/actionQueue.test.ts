import { describe, expect, it } from "vitest";
import {
  BACKGROUND_ACTION_QUEUE_TTL_MS,
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
    const queued = enqueueAction([], action, 1000);
    expect(loadPendingActions(serializePendingActions(queued), 1000)).toEqual([action]);
  });

  it("keeps colliding approval ids in different workspaces independent, and a later decision replaces an earlier one", () => {
    const original = { ...target, decision: "once" as const, queuedAt: 1 };
    const other = { ...original, workspaceId: "other", decision: "deny" as const };
    const queued = enqueueAction(
      enqueueAction([original], other, 2),
      { ...original, decision: "version", queuedAt: 3 },
      3
    );
    expect(queued).toEqual([other, { ...original, decision: "version", queuedAt: 3 }]);
  });

  it("does not guess the destination of unscoped actions or opens", () => {
    expect(
      loadPendingActions(
        JSON.stringify({
          version: 1,
          actions: [{ approvalId: "approval-1", decision: "deny", queuedAt: 1 }],
        }),
        2
      )
    ).toEqual([]);
    expect(loadOpen(JSON.stringify({ kind: "approval", target: { approvalId: "a" } }))).toBeNull();
  });

  it("drops expired decisions and round-trips an open", () => {
    expect(
      loadPendingActions(
        serializePendingActions([{ ...target, decision: "deny", queuedAt: 0 }]),
        BACKGROUND_ACTION_QUEUE_TTL_MS + 10
      )
    ).toEqual([]);
    const open = { kind: "approval" as const, target };
    expect(loadOpen(serializeOpen(open))).toEqual(open);
  });
});
