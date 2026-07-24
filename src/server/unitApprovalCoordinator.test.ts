import { describe, expect, it, vi } from "vitest";

import type { UnitBatchEntry } from "@vibestudio/shared/approvals";
import { ServerUnitApprovalCoordinator } from "./unitApprovalCoordinator.js";

function unit(kind: "extension" | "app" | "panel" | "worker", name: string): UnitBatchEntry {
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

describe("ServerUnitApprovalCoordinator", () => {
  it("combines app and extension startup approvals into one unit batch", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({ approvalQueue, delayMs: 1 });
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
        kind: "unit-batch",
        callerId: "system:units",
        title: "Approve workspace units",
        units: [
          expect.objectContaining({ unitKind: "extension", unitName: "image-service" }),
          expect.objectContaining({ unitKind: "app", unitName: "shell" }),
        ],
      })
    );
    expect(applyExtension).toHaveBeenCalledOnce();
    expect(applyApp).toHaveBeenCalledOnce();
  });

  it("applies approved requests concurrently, starting extensions first", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({ approvalQueue, delayMs: 1 });
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
    const coordinator = new ServerUnitApprovalCoordinator({ approvalQueue, delayMs: 1 });
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
    const coordinator = new ServerUnitApprovalCoordinator({ approvalQueue, delayMs: 10_000 });
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
      const coordinator = new ServerUnitApprovalCoordinator({
        approvalQueue,
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
          title: "Approve workspace units",
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

  it("exposes approved activation settlement to startup readiness", async () => {
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue: { request: vi.fn(async () => "once" as const) },
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
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue,
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

  it("propagates application failures through both publication and enqueue settlement", async () => {
    const failure = new Error("provider activation failed");
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue: { request: vi.fn(async () => "once" as const) },
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
