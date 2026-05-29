import {
  BACKGROUND_ACTION_QUEUE_TTL_MS,
  clearAction,
  enqueueAction,
  enqueueDeepLink,
  loadDeepLink,
  loadPendingActions,
  serializeDeepLink,
  serializePendingActions,
} from "./backgroundActionQueueCore";

describe("backgroundActionQueueCore", () => {
  it("enqueues, loads, and clears pending actions", () => {
    const now = 1_000;
    const queued = enqueueAction([], {
      approvalId: "approval-1",
      decision: "deny",
      queuedAt: now,
    }, now);

    expect(loadPendingActions(serializePendingActions(queued), now)).toEqual([
      { approvalId: "approval-1", decision: "deny", queuedAt: now },
    ]);
    expect(clearAction(queued, "approval-1")).toEqual([]);
  });

  it("replaces duplicate approval actions with the latest decision", () => {
    const queued = enqueueAction([
      { approvalId: "approval-1", decision: "once", queuedAt: 1 },
    ], {
      approvalId: "approval-1",
      decision: "repo",
      queuedAt: 2,
    }, 2);

    expect(queued).toEqual([
      { approvalId: "approval-1", decision: "repo", queuedAt: 2 },
    ]);
  });

  it("drops stale actions older than 24 hours", () => {
    const now = BACKGROUND_ACTION_QUEUE_TTL_MS + 10;
    const loaded = loadPendingActions(serializePendingActions([
      { approvalId: "stale", decision: "deny", queuedAt: 0 },
      { approvalId: "fresh", decision: "session", queuedAt: now },
    ]), now);

    expect(loaded).toEqual([
      { approvalId: "fresh", decision: "session", queuedAt: now },
    ]);
  });

  it("keeps only the latest deep link approval id", () => {
    const first = enqueueDeepLink(null, "approval-1");
    const second = enqueueDeepLink(first, "approval-2");

    expect(loadDeepLink(serializeDeepLink(second))).toBe("approval-2");
  });
});
