import { describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import {
  createApprovalStateController,
  pendingApprovalSignature,
  pendingApprovalsFromEventPayload,
} from "./approvalState.js";

function approval(approvalId: string): PendingApproval {
  return {
    kind: "capability",
    approvalId,
    callerId: "panel:test",
    callerKind: "panel",
    repoPath: "panels/test",
    effectiveVersion: "ev",
    requestedAt: 1,
    capability: "git.publish",
    title: "Write files",
    resource: { type: "git-repo", label: "Repository", value: "panels/test" },
  };
}

describe("approvalState", () => {
  it.each(["event", "stop"] as const)(
    "does not report an obsolete refresh failure after %s supersedes it",
    async (superseding) => {
      let rejectPending!: (error: Error) => void;
      let listener!: (payload: unknown) => void;
      const onError = vi.fn();
      const onChange = vi.fn();
      const controller = createApprovalStateController({
        listPending: () =>
          new Promise((_, reject) => {
            rejectPending = reject;
          }),
        subscribePendingChanged: async () => {},
        onPendingChanged: (next) => {
          listener = next;
          return () => {};
        },
        onChange,
        onError,
      });
      controller.start();
      await vi.waitFor(() => expect(rejectPending).toBeDefined());
      const pending = [approval("current")];
      if (superseding === "event") listener({ pending });
      else controller.stop();
      rejectPending(new Error("Old connection closed"));
      await Promise.resolve();
      expect(onError).not.toHaveBeenCalled();
      if (superseding === "event") expect(onChange).toHaveBeenLastCalledWith(pending, "event");
      else expect(onChange).not.toHaveBeenCalled();
      controller.stop();
    }
  );

  it("reports a current refresh failure without replacing the queue with an empty snapshot", async () => {
    const error = new Error("Approval service unavailable");
    const onError = vi.fn();
    const onChange = vi.fn();
    const controller = createApprovalStateController({
      listPending: async () => {
        throw error;
      },
      subscribePendingChanged: async () => {},
      onPendingChanged: () => () => {},
      onChange,
      onError,
    });
    await controller.refresh();
    expect(onError).toHaveBeenCalledWith(error, "refresh:manual");
    expect(onChange).not.toHaveBeenCalled();
    controller.stop();
  });

  it("parses pending snapshots and signatures", () => {
    const pending = [approval("a1"), approval("a2")];
    expect(pendingApprovalsFromEventPayload({ pending })).toBe(pending);
    expect(pendingApprovalsFromEventPayload({ pending: "nope" })).toBeNull();
    expect(pendingApprovalSignature(pending)).toBe("capability:a1|capability:a2");
  });

  it("subscribes before refresh so pushed snapshots can drive state without polling", async () => {
    const pending = [approval("from-event")];
    let listener: ((payload: unknown) => void) | null = null;
    const listPending = vi.fn(async () => [approval("from-refresh")]);
    const onChange = vi.fn();
    const controller = createApprovalStateController({
      listPending,
      subscribePendingChanged: async () => {
        listener?.({ pending });
      },
      onPendingChanged: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      onChange,
    });

    controller.start();

    expect(onChange).toHaveBeenNthCalledWith(1, pending, "event");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(listPending).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ approvalId: "from-refresh" })],
      "refresh"
    );
  });

  it("falls back to a one-shot refresh when an event has no snapshot payload", async () => {
    const registered: { listener?: (payload: unknown) => void } = {};
    const refreshed = [approval("refreshed")];
    const onChange = vi.fn();
    const controller = createApprovalStateController({
      listPending: vi.fn(async () => refreshed),
      subscribePendingChanged: async () => {},
      onPendingChanged: (next) => {
        registered.listener = next;
        return () => {};
      },
      onChange,
    });

    controller.start();
    expect(registered.listener).toBeDefined();
    registered.listener?.({ changed: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(onChange).toHaveBeenLastCalledWith(refreshed, "refresh");
  });
});
