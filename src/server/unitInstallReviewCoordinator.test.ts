import { describe, expect, it, vi } from "vitest";

import type { ReviewedUnit } from "@vibestudio/shared/approvals";
import {
  UnitInstallReviewCoordinator,
  type UnitApprovalQueueLike,
} from "./unitInstallReviewCoordinator.js";

function exactApprovalQueue<
  T extends {
    request(
      req: Parameters<UnitApprovalQueueLike["requestWithHandle"]>[0]
    ): Promise<Awaited<ReturnType<UnitApprovalQueueLike["requestWithHandle"]>["decision"]>>;
    listPending?: UnitApprovalQueueLike["listPending"];
    reportInstallLanding?: UnitApprovalQueueLike["reportInstallLanding"];
  },
>(queue: T, approvalId = "install-review"): T & UnitApprovalQueueLike {
  return Object.assign(queue, {
    listPending: queue.listPending ?? (() => []),
    requestWithHandle: (req: Parameters<UnitApprovalQueueLike["requestWithHandle"]>[0]) => ({
      approvalId,
      decision: queue.request(req),
    }),
  });
}

function unit(kind: "extension" | "app" | "panel" | "worker", name: string): ReviewedUnit {
  return {
    unitKind: kind,
    unitName: name,
    displayName: name,
    target: kind === "app" ? "electron" : null,
    source: {
      kind: "workspace-repo",
      repo: `${kind}s/${name}`,
      ref: "main",
    },
    ev: `${name}-ev`,
    capabilities: [],
  };
}

describe("UnitInstallReviewCoordinator", () => {
  it("combines app and extension startup approvals into one install review", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
      delayMs: 1,
    });
    const applyExtension = vi.fn(async () => undefined);
    const applyApp = vi.fn(async () => undefined);

    const first = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("extension", "image-service")],
      applyApproved: applyExtension,
      applyDenied: vi.fn(),
    });
    const second = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("app", "shell")],
      applyApproved: applyApp,
      applyDenied: vi.fn(),
    });

    await Promise.all([first, second]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        callerId: "system:units",
        title: "Start this workspace?",
        units: [
          expect.objectContaining({ unitKind: "extension", unitName: "image-service" }),
          expect.objectContaining({ unitKind: "app", unitName: "shell" }),
        ],
      })
    );
    expect(applyExtension).toHaveBeenCalledOnce();
    expect(applyApp).toHaveBeenCalledOnce();
  });

  it("keeps explicitly partitioned host targets in separate reviews", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
      delayMs: 1,
    });

    await Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        batchKey: "electron",
        entries: [unit("app", "desktop")],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        batchKey: "react-native",
        entries: [{ ...unit("app", "mobile"), target: "react-native" }],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      }),
    ]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ units: [expect.objectContaining({ unitName: "desktop" })] })
    );
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ units: [expect.objectContaining({ unitName: "mobile" })] })
    );
  });

  it("applies approved requests concurrently, starting extensions first", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
      delayMs: 1,
    });
    const order: string[] = [];
    let releaseExtension!: () => void;
    const extensionApplied = new Promise<void>((resolve) => {
      releaseExtension = resolve;
    });
    const applyExtension = vi.fn(async () => {
      order.push("extension:start");
      await extensionApplied;
      order.push("extension:done");
    });
    const applyApp = vi.fn(async () => {
      order.push("app:start");
    });

    const pending = Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("app", "shell")],
        applyApproved: applyApp,
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("extension", "react-native")],
        applyApproved: applyExtension,
        applyDenied: vi.fn(),
      }),
    ]);

    void coordinator.publishPending("startup");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Extensions are kicked off first, but a slow extension must NOT block
    // app applies — the app request runs concurrently.
    expect(order).toEqual(["extension:start", "app:start"]);
    expect(applyApp).toHaveBeenCalledOnce();

    releaseExtension();
    await pending;

    expect(order).toEqual(["extension:start", "app:start", "extension:done"]);
  });

  it("fans out a deny decision to every enqueued host request", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
    };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
      delayMs: 1,
    });
    const denyExtension = vi.fn();
    const denyApp = vi.fn();
    const apply = vi.fn(async () => undefined);

    await Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("extension", "image-service")],
        applyApproved: apply,
        applyDenied: denyExtension,
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("app", "shell")],
        applyApproved: apply,
        applyDenied: denyApp,
      }),
    ]);

    expect(apply).not.toHaveBeenCalled();
    expect(denyExtension).toHaveBeenCalledOnce();
    expect(denyApp).toHaveBeenCalledOnce();
  });

  it("can publish a queued batch before the timer fires", async () => {
    let resolveDecision!: (decision: "once") => void;
    const approvalQueue = {
      request: vi.fn(
        () =>
          new Promise<"once">((resolve) => {
            resolveDecision = resolve;
          })
      ),
    };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
      delayMs: 10_000,
    });
    const applyApp = vi.fn(async () => undefined);

    const pending = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("app", "remote-cli")],
      applyApproved: applyApp,
      applyDenied: vi.fn(),
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    void coordinator.publishPending("startup");
    expect(approvalQueue.request).toHaveBeenCalledOnce();
    expect(applyApp).not.toHaveBeenCalled();

    resolveDecision("once");
    await pending;
    expect(applyApp).toHaveBeenCalledOnce();
  });

  it("holds startup publication until every runtime kind has joined the shared batch", async () => {
    vi.useFakeTimers();
    try {
      const approvalQueue = { request: vi.fn(async () => "once" as const) };
      const coordinator = new UnitInstallReviewCoordinator({
        approvalQueue: exactApprovalQueue(approvalQueue),
        delayMs: 1,
        autoPublishStartup: false,
      });
      const panel = coordinator.enqueue({
        trigger: "startup",
        entries: [unit("panel", "chat")],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      });
      const worker = coordinator.enqueue({
        trigger: "startup",
        entries: [unit("worker", "agent")],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(approvalQueue.request).not.toHaveBeenCalled();

      await coordinator.publishPending("startup");
      await Promise.all([panel, worker]);
      expect(approvalQueue.request).toHaveBeenCalledTimes(1);
      expect(approvalQueue.request).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Start this workspace?",
          units: [
            expect.objectContaining({ unitKind: "panel", unitName: "chat" }),
            expect.objectContaining({ unitKind: "worker", unitName: "agent" }),
          ],
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a startup request that arrives after the barrier was released", async () => {
    // The gate's whole point is that startup has no timer, so one prompt covers
    // every unit. That left anything staged after publication in a fresh batch
    // nothing would ever publish: its `enqueue()` promise never settled, the
    // unit never activated, and no gate appeared — the workspace simply sat at
    // "approved and launching" forever. A released trigger stays open.
    vi.useFakeTimers();
    try {
      const approvalQueue = { request: vi.fn(async () => "once" as const) };
      const coordinator = new UnitInstallReviewCoordinator({
        approvalQueue: exactApprovalQueue(approvalQueue),
        delayMs: 1,
        autoPublishStartup: false,
      });
      const early = coordinator.enqueue({
        trigger: "startup",
        entries: [unit("extension", "react-native")],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      });
      await coordinator.publishPending("startup");
      await early;

      const applyLate = vi.fn(async () => undefined);
      const late = coordinator.enqueue({
        trigger: "startup",
        entries: [unit("app", "shell")],
        applyApproved: applyLate,
        applyDenied: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(late).resolves.toBeUndefined();
      expect(applyLate).toHaveBeenCalledTimes(1);
      expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes approved activation settlement to startup readiness", async () => {
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue({ request: vi.fn(async () => "once" as const) }),
      delayMs: 10_000,
    });
    let releaseApply!: () => void;
    const applyReleased = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const applied = vi.fn(async () => {
      await applyReleased;
    });

    const enqueued = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("extension", "react-native")],
      applyApproved: applied,
      applyDenied: vi.fn(),
    });
    let settled = false;
    const publication = coordinator.publishPending("startup").then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(applied).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    releaseApply();
    await Promise.all([publication, enqueued]);
    expect(settled).toBe(true);
  });

  it("settles only the unit applications selected by a launch gate", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
      delayMs: 10_000,
    });
    let releaseUnrelatedApp!: () => void;
    const unrelatedAppReleased = new Promise<void>((resolve) => {
      releaseUnrelatedApp = resolve;
    });
    const extensionApplied = vi.fn(async () => undefined);
    const appApplied = vi.fn(async () => {
      await unrelatedAppReleased;
    });

    const extension = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("extension", "react-native")],
      applyApproved: extensionApplied,
      applyDenied: vi.fn(),
    });
    const app = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("app", "unrelated-electron-app")],
      applyApproved: appApplied,
      applyDenied: vi.fn(),
    });

    await coordinator.publishPending(
      "startup",
      (entry) => entry.unitKind === "extension" && entry.unitName === "react-native"
    );
    expect(extensionApplied).toHaveBeenCalledOnce();
    expect(appApplied).toHaveBeenCalledOnce();
    await extension;

    releaseUnrelatedApp();
    await app;
  });

  it("reports landed and failed targets separately after concurrent application", async () => {
    const extension = unit("extension", "react-native");
    const app = unit("app", "shell");
    const reportInstallLanding = vi.fn();
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
      listPending: vi.fn(() => [
        {
          approvalId: "install-review",
          kind: "unit-install-review" as const,
          parts: [
            {
              identityKey: `${extension.source.repo}@${extension.ev}`,
              repoPath: extension.source.repo,
              effectiveVersion: extension.ev!,
            },
            {
              identityKey: `${app.source.repo}@${app.ev}`,
              repoPath: app.source.repo,
              effectiveVersion: app.ev!,
            },
          ],
        } as never,
      ]),
      reportInstallLanding,
    };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
      delayMs: 1,
    });
    const failure = new Error("extension activation failed");

    const publication = Promise.allSettled([
      coordinator.enqueue({
        trigger: "startup",
        entries: [extension],
        applyApproved: async () => {
          throw failure;
        },
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [app],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      }),
    ]);

    await Promise.allSettled([coordinator.publishPending("startup"), publication]);

    expect(reportInstallLanding).toHaveBeenCalledWith("install-review", {
      landed: [`${app.source.repo}@${app.ev}`],
      failed: [
        {
          identityKey: `${extension.source.repo}@${extension.ev}`,
          reason: failure.message,
        },
      ],
      workspaceUnchanged: false,
    });
  });

  it("reports landing to the exact queue handle when another review overlaps", async () => {
    const app = unit("app", "shell");
    const part = {
      identityKey: `${app.source.repo}@${app.ev}`,
      repoPath: app.source.repo,
      effectiveVersion: app.ev!,
    };
    const reportInstallLanding = vi.fn();
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: {
        requestWithHandle: vi.fn(() => ({
          approvalId: "current-review",
          decision: Promise.resolve("once" as const),
        })),
        listPending: vi.fn(
          () =>
            [
              { approvalId: "older-review", kind: "unit-install-review", parts: [part] },
              { approvalId: "current-review", kind: "unit-install-review", parts: [part] },
            ] as never
        ),
        reportInstallLanding,
      },
      delayMs: 10_000,
    });

    const applied = coordinator.enqueue({
      trigger: "startup",
      entries: [app],
      applyApproved: vi.fn(async () => undefined),
      applyDenied: vi.fn(),
    });
    await coordinator.publishPending("startup");
    await applied;

    expect(reportInstallLanding).toHaveBeenCalledWith("current-review", {
      landed: [part.identityKey],
    });
  });

  it("lets a failed producer win when duplicate producers apply the same unit", async () => {
    const shared = unit("extension", "shared");
    const part = {
      identityKey: `${shared.source.repo}@${shared.ev}`,
      repoPath: shared.source.repo,
      effectiveVersion: shared.ev!,
    };
    const reportInstallLanding = vi.fn();
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: {
        requestWithHandle: vi.fn(() => ({
          approvalId: "shared-review",
          decision: Promise.resolve("once" as const),
        })),
        listPending: vi.fn(
          () =>
            [{ approvalId: "shared-review", kind: "unit-install-review", parts: [part] }] as never
        ),
        reportInstallLanding,
      },
      delayMs: 10_000,
    });
    const failure = new Error("second target failed");
    const results = Promise.allSettled([
      coordinator.enqueue({
        trigger: "startup",
        entries: [shared],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [shared],
        applyApproved: vi.fn(async () => {
          throw failure;
        }),
        applyDenied: vi.fn(),
      }),
    ]);

    await Promise.allSettled([coordinator.publishPending("startup"), results]);

    expect(reportInstallLanding).toHaveBeenCalledWith("shared-review", {
      landed: [],
      failed: [{ identityKey: part.identityKey, reason: failure.message }],
      workspaceUnchanged: false,
    });
  });

  it("propagates application failures through both publication and enqueue settlement", async () => {
    const failure = new Error("provider activation failed");
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue({ request: vi.fn(async () => "once" as const) }),
      delayMs: 10_000,
    });
    const enqueued = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("extension", "react-native")],
      applyApproved: vi.fn(async () => {
        throw failure;
      }),
      applyDenied: vi.fn(),
    });
    const publication = coordinator.publishPending("startup");

    const [publishedResult, enqueuedResult] = await Promise.allSettled([publication, enqueued]);
    expect(publishedResult).toEqual({ status: "rejected", reason: failure });
    expect(enqueuedResult).toEqual({ status: "rejected", reason: failure });
  });
});
