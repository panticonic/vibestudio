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
    holdForUnitReview?: UnitApprovalQueueLike["holdForUnitReview"];
    reportInstallLanding?: UnitApprovalQueueLike["reportInstallLanding"];
  },
>(queue: T, approvalId = "install-review"): T & UnitApprovalQueueLike {
  return Object.assign(queue, {
    listPending: queue.listPending ?? (() => []),
    holdForUnitReview: queue.holdForUnitReview ?? (() => () => {}),
    requestWithHandle: (req: Parameters<UnitApprovalQueueLike["requestWithHandle"]>[0]) => ({
      approvalId,
      decision: queue.request(req),
    }),
  });
}

const WAITER = {
  callerId: "do:agent",
  callerKind: "do" as const,
  repoPath: "workers/agent",
  effectiveVersion: "agent-ev",
  requesterCategory: "agent" as const,
};

function unit(kind: "extension" | "client" | "panel" | "worker", name: string): ReviewedUnit {
  return {
    unitKind: kind,
    unitName: name,
    displayName: name,
    runtime: kind === "client" ? "web" : null,
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
  it("joins the exact review before staging and waits for application without another prompt", async () => {
    let apply!: () => void;
    const applying = new Promise<void>((resolve) => {
      apply = resolve;
    });
    const entry = unit("worker", "agent");
    const queue = { request: vi.fn(async () => "accepted" as const) };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(queue),
      autoPublishStartup: false,
    });
    const joined = coordinator.whenUnitReviewSettled(
      { repoPath: entry.source.repo, effectiveVersion: entry.ev! },
      new AbortController().signal,
      WAITER
    );
    const settled = vi.fn();
    void joined.then(settled, settled);
    const enqueued = coordinator.enqueue({
      entries: [entry],
      trigger: "startup",
      applyApproved: () => applying,
      applyDenied: vi.fn(),
    });
    coordinator.finishStartupReviewStaging();
    const publishing = coordinator.publishPending("startup");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(queue.request).toHaveBeenCalledOnce();
    apply();
    await expect(joined).resolves.toBe("accepted");
    await Promise.all([enqueued, publishing]);
  });

  it("a later exact review replaces its earlier denied application", async () => {
    const entry = unit("worker", "agent");
    let answer: "accepted" | "deny" = "deny";
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue({ request: vi.fn(async () => answer) }),
      autoPublishStartup: false,
    });
    const enqueue = () =>
      coordinator.enqueue({
        entries: [entry],
        trigger: "startup",
        applyApproved: vi.fn(async () => {}),
        applyDenied: vi.fn(),
      });
    const first = enqueue();
    await coordinator.publishPending("startup");
    await first;
    await expect(
      coordinator.whenUnitReviewSettled(
        { repoPath: entry.source.repo, effectiveVersion: entry.ev! },
        new AbortController().signal,
        WAITER
      )
    ).resolves.toBe("deny");
    answer = "accepted";
    const second = enqueue();
    const joined = coordinator.whenUnitReviewSettled(
      { repoPath: entry.source.repo, effectiveVersion: entry.ev! },
      new AbortController().signal,
      WAITER
    );
    await coordinator.publishPending("startup");
    await second;
    await expect(joined).resolves.toBe("accepted");
  });

  it("observer cancellation leaves the shared review intact and staging failure propagates", async () => {
    const queue = { request: vi.fn(async () => "accepted" as const) };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(queue),
      autoPublishStartup: false,
    });
    const controller = new AbortController();
    const cancelled = coordinator.whenUnitReviewSettled(
      { repoPath: "workers/old", effectiveVersion: "ev-old" },
      controller.signal,
      WAITER
    );
    const reason = new Error("invocation cancelled");
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    expect(queue.request).not.toHaveBeenCalled();
    const unstaged = coordinator.whenUnitReviewSettled(
      { repoPath: "workers/missing", effectiveVersion: "ev-missing" },
      new AbortController().signal,
      WAITER
    );
    const failure = new Error("review source preparation failed");
    coordinator.finishStartupReviewStaging(failure);
    await expect(unstaged).rejects.toBe(failure);
  });

  it("lists the joined work on the review while it waits, and only while it waits", async () => {
    const entry = unit("worker", "agent");
    const released = vi.fn();
    const holdForUnitReview = vi.fn(() => released);
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue({
        request: vi.fn(async () => "accepted" as const),
        holdForUnitReview,
      }),
      autoPublishStartup: false,
    });
    const enqueued = coordinator.enqueue({
      entries: [entry],
      trigger: "startup",
      applyApproved: async () => {},
      applyDenied: vi.fn(),
    });
    const controller = new AbortController();
    const joined = coordinator.whenUnitReviewSettled(
      { repoPath: entry.source.repo, effectiveVersion: entry.ev! },
      controller.signal,
      WAITER
    );
    expect(holdForUnitReview).toHaveBeenCalledWith(
      { repoPath: entry.source.repo, effectiveVersion: entry.ev! },
      WAITER,
      controller.signal
    );
    expect(released).not.toHaveBeenCalled();
    await coordinator.publishPending("startup");
    await enqueued;
    await expect(joined).resolves.toBe("accepted");
    expect(released).toHaveBeenCalled();
  });

  it("propagates application failure to the exact review join", async () => {
    const entry = unit("worker", "agent");
    const failure = new Error("original application failure");
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue({ request: vi.fn(async () => "accepted" as const) }),
      autoPublishStartup: false,
    });
    const enqueued = coordinator.enqueue({
      entries: [entry],
      trigger: "startup",
      applyApproved: async () => {
        throw failure;
      },
      applyDenied: vi.fn(),
    });
    const joined = coordinator.whenUnitReviewSettled(
      { repoPath: entry.source.repo, effectiveVersion: entry.ev! },
      new AbortController().signal,
      WAITER
    );
    const publishing = coordinator.publishPending("startup");
    await Promise.all([
      expect(enqueued).rejects.toBe(failure),
      expect(joined).rejects.toBe(failure),
      expect(publishing).rejects.toBe(failure),
    ]);
  });

  it("refuses to offer a review without an exact effective version", () => {
    const approvalQueue = { request: vi.fn(async () => "accepted" as const) };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
    });

    expect(() =>
      coordinator.enqueue({
        trigger: "startup",
        entries: [{ ...unit("client", "shell"), ev: null }],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      })
    ).toThrow(/without an effective version/);
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("combines app and extension startup approvals into one install review", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "accepted" as const),
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
      entries: [unit("client", "shell")],
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
          expect.objectContaining({ unitKind: "client", unitName: "shell" }),
        ],
      })
    );
    expect(applyExtension).toHaveBeenCalledOnce();
    expect(applyApp).toHaveBeenCalledOnce();
  });

  it("shows an exact unit only once when multiple activation paths join the review", async () => {
    const approvalQueue = { request: vi.fn(async () => "accepted" as const) };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
      delayMs: 1,
    });
    const extension = unit("extension", "image-service");

    await Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        entries: [extension],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [{ ...extension }],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      }),
    ]);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Vibestudio needs to run 1 program on this computer.",
        units: [expect.objectContaining({ unitName: "image-service" })],
      })
    );
  });

  it("keeps every host target in the workspace-wide review", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "accepted" as const),
    };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue),
      delayMs: 1,
    });

    await Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("client", "desktop")],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [{ ...unit("client", "mobile"), runtime: "react-native" }],
        applyApproved: vi.fn(async () => undefined),
        applyDenied: vi.fn(),
      }),
    ]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        units: [
          expect.objectContaining({ unitName: "desktop" }),
          expect.objectContaining({ unitName: "mobile" }),
        ],
      })
    );
  });

  it("uses the creation presentation for one review containing every unit kind", async () => {
    const onPublished = vi.fn();
    const identityKeys = new Map([["panels/chat", "workspace-unit:chat"]]);
    const approvalQueue = {
      request: vi.fn(async () => "accepted" as const),
      listPending: vi.fn(() => [
        {
          approvalId: "workspace-review",
          kind: "unit-install-review" as const,
          parts: [
            { identityKey: "workspace-unit:chat" },
            { identityKey: "extensions/files@files-ev" },
          ],
        } as never,
      ]),
    };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(approvalQueue, "workspace-review"),
      delayMs: 10_000,
      autoPublishStartup: false,
    });

    const creation = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("panel", "chat")],
      identityKeys,
      presentation: {
        callerId: "system:workspace-creation",
        dedupKey: "workspace-creation-review",
        title: "Welcome — here's what's in your workspace",
        description: "This workspace is built from one source.",
        onPublished,
      },
      applyApproved: vi.fn(async () => undefined),
      applyDenied: vi.fn(),
    });
    const extension = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("extension", "files")],
      applyApproved: vi.fn(async () => undefined),
      applyDenied: vi.fn(),
    });

    await coordinator.publishPending("startup");
    await Promise.all([creation, extension]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: "system:workspace-creation",
        dedupKey: "workspace-creation-review",
        title: "Welcome — here's what's in your workspace",
        identityKeys,
        units: [
          expect.objectContaining({ unitKind: "panel" }),
          expect.objectContaining({ unitKind: "extension" }),
        ],
      })
    );
    expect(onPublished).toHaveBeenCalledWith({ approvalId: "workspace-review", partCount: 2 });
  });

  it("applies approved requests concurrently, starting extensions first", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "accepted" as const),
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
        entries: [unit("client", "shell")],
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
        entries: [unit("client", "shell")],
        applyApproved: apply,
        applyDenied: denyApp,
      }),
    ]);

    expect(apply).not.toHaveBeenCalled();
    expect(denyExtension).toHaveBeenCalledOnce();
    expect(denyApp).toHaveBeenCalledOnce();
  });

  it("can publish a queued batch before the timer fires", async () => {
    let resolveDecision!: (decision: "accepted") => void;
    const approvalQueue = {
      request: vi.fn(
        () =>
          new Promise<"accepted">((resolve) => {
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
      entries: [unit("client", "terminal-browser")],
      applyApproved: applyApp,
      applyDenied: vi.fn(),
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    void coordinator.publishPending("startup");
    expect(approvalQueue.request).toHaveBeenCalledOnce();
    expect(applyApp).not.toHaveBeenCalled();

    resolveDecision("accepted");
    await pending;
    expect(applyApp).toHaveBeenCalledOnce();
  });

  it("holds startup publication until every runtime kind has joined the shared batch", async () => {
    vi.useFakeTimers();
    try {
      const approvalQueue = { request: vi.fn(async () => "accepted" as const) };
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
      const approvalQueue = { request: vi.fn(async () => "accepted" as const) };
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
        entries: [unit("client", "shell")],
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
      approvalQueue: exactApprovalQueue({ request: vi.fn(async () => "accepted" as const) }),
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
      request: vi.fn(async () => "accepted" as const),
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
      entries: [unit("client", "unrelated-electron-app")],
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
    const app = unit("client", "shell");
    const reportInstallLanding = vi.fn();
    const approvalQueue = {
      request: vi.fn(async () => "accepted" as const),
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
    const app = unit("client", "shell");
    const part = {
      identityKey: `${app.source.repo}@${app.ev}`,
      repoPath: app.source.repo,
      effectiveVersion: app.ev!,
    };
    const reportInstallLanding = vi.fn();
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: {
        holdForUnitReview: vi.fn(() => () => {}),
        requestWithHandle: vi.fn(() => ({
          approvalId: "current-review",
          decision: Promise.resolve("accepted" as const),
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
        holdForUnitReview: vi.fn(() => () => {}),
        requestWithHandle: vi.fn(() => ({
          approvalId: "shared-review",
          decision: Promise.resolve("accepted" as const),
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
      approvalQueue: exactApprovalQueue({ request: vi.fn(async () => "accepted" as const) }),
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

  it("accepts a startup review of only host-build units without asking, as an approval would", async () => {
    const queue = { request: vi.fn(async () => "deny" as const) };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(queue),
      autoPublishStartup: false,
      isHostBuildUnit: (repoPath) => repoPath !== "workers/custom",
    });
    const opened: boolean[] = [];
    const applied: string[] = [];
    const participant = (entry: ReviewedUnit) =>
      coordinator.enqueue({
        entries: [entry],
        trigger: "startup",
        opened: (asked) => opened.push(asked),
        applyApproved: async () => void applied.push(entry.source.repo),
        applyDenied: vi.fn(),
      });
    const shell = participant(unit("client", "shell"));
    const runtime = participant(unit("extension", "runtime"));
    await coordinator.publishPending("startup");
    await Promise.all([shell, runtime]);
    expect(queue.request).not.toHaveBeenCalled();
    expect(opened).toEqual([false, false]);
    expect(applied.sort()).toEqual(["clients/shell", "extensions/runtime"]);

    // Anything else in the review puts all of it in front of the person.
    const mixed = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(queue),
      autoPublishStartup: false,
      isHostBuildUnit: (repoPath) => repoPath !== "workers/custom",
    });
    const asked: boolean[] = [];
    const denied = vi.fn();
    const enqueued = mixed.enqueue({
      entries: [unit("client", "shell"), unit("worker", "custom")],
      trigger: "startup",
      opened: (value) => asked.push(value),
      applyApproved: vi.fn(async () => {}),
      applyDenied: denied,
    });
    await mixed.publishPending("startup");
    await enqueued;
    expect(queue.request).toHaveBeenCalledOnce();
    expect(asked).toEqual([true]);
    expect(denied).toHaveBeenCalledOnce();
  });

  it("asks only about startup this way: a later review of host-build units still asks", async () => {
    const queue = { request: vi.fn(async () => "accepted" as const) };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(queue),
      autoPublishStartup: false,
      isHostBuildUnit: () => true,
    });
    await coordinator.publishPending("startup");
    const asked: boolean[] = [];
    const enqueued = coordinator.enqueue({
      entries: [unit("client", "shell")],
      trigger: "meta-change",
      opened: (value) => asked.push(value),
      applyApproved: vi.fn(async () => {}),
      applyDenied: vi.fn(),
    });
    await coordinator.publishPending("meta-change");
    await enqueued;
    expect(queue.request).toHaveBeenCalledWith(expect.objectContaining({ mode: "install" }));
    expect(asked).toEqual([true]);
  });

  it("folds a review raised while startup stages into the one startup review", async () => {
    const queue = { request: vi.fn(async () => "accepted" as const) };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(queue),
      autoPublishStartup: false,
    });
    const opened = vi.fn();
    const launch = coordinator.enqueue({
      entries: [unit("client", "shell")],
      trigger: "meta-change",
      opened,
      applyApproved: vi.fn(async () => {}),
      applyDenied: vi.fn(),
    });
    await coordinator.publishPending("meta-change");
    expect(queue.request).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();

    const participant = coordinator.enqueue({
      entries: [unit("client", "shell"), unit("extension", "runtime")],
      trigger: "startup",
      applyApproved: vi.fn(async () => {}),
      applyDenied: vi.fn(),
    });
    await coordinator.publishPending("startup");
    await Promise.all([launch, participant]);
    expect(queue.request).toHaveBeenCalledOnce();
    expect(queue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "adopt-root",
        units: [unit("client", "shell"), unit("extension", "runtime")],
      })
    );
    expect(opened).toHaveBeenCalledWith(true);
  });

  it("fails what joined the startup review when staging fails, and publishes later reviews alone", async () => {
    const queue = { request: vi.fn(async () => "accepted" as const) };
    const coordinator = new UnitInstallReviewCoordinator({
      approvalQueue: exactApprovalQueue(queue),
      autoPublishStartup: false,
      delayMs: 0,
    });
    const launch = coordinator.enqueue({
      entries: [unit("client", "shell")],
      trigger: "meta-change",
      applyApproved: vi.fn(async () => {}),
      applyDenied: vi.fn(),
    });
    const failure = new Error("startup reconcile failed");
    coordinator.abandonStartupReview(failure);
    await expect(launch).rejects.toBe(failure);
    expect(queue.request).not.toHaveBeenCalled();

    await coordinator.enqueue({
      entries: [unit("client", "shell")],
      trigger: "startup",
      applyApproved: vi.fn(async () => {}),
      applyDenied: vi.fn(),
    });
    expect(queue.request).toHaveBeenCalledOnce();
  });
});
