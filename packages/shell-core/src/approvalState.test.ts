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
      const starting = controller.start();
      await vi.waitFor(() => expect(rejectPending).toBeDefined());
      const pending = [approval("current")];
      if (superseding === "event") listener({ pending });
      else controller.stop();
      rejectPending(new Error("Old connection closed"));
      if (superseding === "event") await expect(starting).resolves.toEqual(pending);
      else await expect(starting).rejects.toThrow("Old connection closed");
      expect(onError).not.toHaveBeenCalled();
      if (superseding === "event") expect(onChange).toHaveBeenLastCalledWith(pending, "event");
      else expect(onChange).not.toHaveBeenCalled();
      await controller.stop();
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
    await expect(controller.refresh()).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(error, "refresh:manual");
    expect(onChange).not.toHaveBeenCalled();
    await controller.stop();
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

    const ready = controller.start();

    expect(onChange).toHaveBeenNthCalledWith(1, pending, "event");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(listPending).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ approvalId: "from-refresh" })],
      "refresh"
    );
    await expect(ready).resolves.toEqual([expect.objectContaining({ approvalId: "from-refresh" })]);
    await controller.stop();
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

    await controller.start();
    expect(registered.listener).toBeDefined();
    registered.listener?.({ changed: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(onChange).toHaveBeenLastCalledWith(refreshed, "refresh");
    await controller.stop();
  });

  it("does not report readiness before subscription admission and the first authoritative read", async () => {
    let admit!: () => void;
    let finishRead!: (pending: PendingApproval[]) => void;
    const controller = createApprovalStateController({
      listPending: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      subscribePendingChanged: () =>
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
      onPendingChanged: () => () => {},
      onChange: vi.fn(),
    });

    const ready = controller.start();
    let settled = false;
    void ready.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(finishRead).toBeUndefined();

    admit();
    await vi.waitFor(() => expect(finishRead).toBeDefined());
    expect(settled).toBe(false);
    finishRead([approval("initial")]);
    await expect(ready).resolves.toEqual([approval("initial")]);
    await controller.stop();
  });

  it.each([
    ["subscription admission", "subscribe" as const],
    ["initial authoritative read", "refresh:initial" as const],
  ])("rejects readiness with the original %s failure", async (_label, phase) => {
    const failure = new Error(`${phase} unavailable`);
    const onError = vi.fn();
    const controller = createApprovalStateController({
      listPending: async () => {
        if (phase === "refresh:initial") throw failure;
        return [];
      },
      subscribePendingChanged: async () => {
        if (phase === "subscribe") throw failure;
      },
      onPendingChanged: () => () => {},
      onChange: vi.fn(),
      onError,
    });

    await expect(controller.start()).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith(failure, phase);
    if (phase === "subscribe") await expect(controller.stop()).rejects.toBe(failure);
    else await controller.stop();
  });

  it("retires a subscription whose admission response rejected", async () => {
    const admissionFailure = new Error("Subscription response lost");
    const unsubscribePendingChanged = vi.fn(async () => undefined);
    const controller = createApprovalStateController({
      listPending: vi.fn(async () => []),
      subscribePendingChanged: async () => {
        throw admissionFailure;
      },
      unsubscribePendingChanged,
      onPendingChanged: () => () => {},
      onChange: vi.fn(),
    });

    await expect(controller.start()).rejects.toBe(admissionFailure);
    await expect(controller.stop()).rejects.toBe(admissionFailure);
    expect(unsubscribePendingChanged).toHaveBeenCalledTimes(1);
    await expect(controller.stop()).rejects.toBe(admissionFailure);
    expect(unsubscribePendingChanged).toHaveBeenCalledTimes(1);
  });

  it("does not publish a read as ready after event admission failed", async () => {
    const admissionFailure = new Error("Subscription response lost");
    const listPending = vi.fn(async () => [approval("late")]);
    const onChange = vi.fn();
    const controller = createApprovalStateController({
      listPending,
      subscribePendingChanged: async () => {
        throw admissionFailure;
      },
      unsubscribePendingChanged: vi.fn(async () => undefined),
      onPendingChanged: () => () => {},
      onChange,
    });

    await expect(controller.start()).rejects.toBe(admissionFailure);
    await expect(controller.refresh("manual")).rejects.toBe(admissionFailure);
    expect(listPending).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    await expect(controller.stop()).rejects.toBe(admissionFailure);
  });

  it("preserves admission and retirement failures in one causal aggregate", async () => {
    const admissionFailure = new Error("Subscription response lost");
    const retirementFailure = new Error("Subscription retirement failed");
    const onError = vi.fn();
    const controller = createApprovalStateController({
      listPending: vi.fn(async () => []),
      subscribePendingChanged: async () => {
        throw admissionFailure;
      },
      unsubscribePendingChanged: async () => {
        throw retirementFailure;
      },
      onPendingChanged: () => () => {},
      onChange: vi.fn(),
      onError,
    });

    await expect(controller.start()).rejects.toBe(admissionFailure);
    const retirement = controller.stop();
    await expect(retirement).rejects.toMatchObject({
      message: "Approval observation admission and retirement failed",
      cause: admissionFailure,
      errors: [admissionFailure, retirementFailure],
    });
    expect(onError).toHaveBeenCalledWith(retirementFailure, "unsubscribe");
  });

  it("joins delayed admission, remote retirement, and an owned read when stopped", async () => {
    let admit!: () => void;
    let finishRetirement!: () => void;
    const unsubscribePendingChanged = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRetirement = resolve;
        })
    );
    const controller = createApprovalStateController({
      listPending: vi.fn(async () => []),
      subscribePendingChanged: () =>
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
      unsubscribePendingChanged,
      onPendingChanged: () => () => {},
      onChange: vi.fn(),
    });

    const ready = controller.start();
    const stopped = controller.stop();
    let retired = false;
    void stopped.then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    expect(unsubscribePendingChanged).not.toHaveBeenCalled();

    admit();
    await vi.waitFor(() => expect(unsubscribePendingChanged).toHaveBeenCalledTimes(1));
    finishRetirement();
    await expect(ready).rejects.toThrow("stopped");
    await stopped;
    expect(retired).toBe(true);
  });
});
