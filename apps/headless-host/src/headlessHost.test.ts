import { describe, expect, it, vi } from "vitest";
import { HeadlessHost } from "./headlessHost.js";
import type { HeadlessHostConfig } from "./config.js";
import { LeaseTracker } from "@natstack/shared/panel/leaseTracker";
import type { PanelRuntimeLease } from "@natstack/shared/panel/panelLease";

function config(): HeadlessHostConfig {
  return {
    serverUrl: "http://127.0.0.1:3030",
    auth: { kind: "token", token: "token" },
    label: "Headless Test",
    clientSessionId: "headless-test",
    maxPanels: 8,
    idleUnloadMs: 60_000,
    cacheDir: "/tmp/natstack-test-cache",
    profileDir: "/tmp/natstack-test-profile",
  };
}

describe("HeadlessHost lifecycle guards", () => {
  it("coalesces duplicate browser-gone signals for the active generation", async () => {
    const host = new HeadlessHost(config());
    let resolveRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const recoverBrowser = vi.fn(() => recovery);
    Object.assign(host as unknown as { browserGeneration: number; recoverBrowser: () => void }, {
      browserGeneration: 1,
      recoverBrowser,
    });

    const first = (host as unknown as { handleBrowserGone(generation: number): Promise<void> })
      .handleBrowserGone(1);
    const second = (host as unknown as { handleBrowserGone(generation: number): Promise<void> })
      .handleBrowserGone(1);

    expect(recoverBrowser).toHaveBeenCalledTimes(1);
    resolveRecovery();
    await Promise.all([first, second]);
  });

  it("ignores stale browser-gone signals from an older generation", async () => {
    const host = new HeadlessHost(config());
    const recoverBrowser = vi.fn();
    Object.assign(host as unknown as { browserGeneration: number; recoverBrowser: () => void }, {
      browserGeneration: 2,
      recoverBrowser,
    });

    await (host as unknown as { handleBrowserGone(generation: number): Promise<void> })
      .handleBrowserGone(1);

    expect(recoverBrowser).not.toHaveBeenCalled();
  });

  it("releases and unloads a panel when a load intent fails", async () => {
    const host = new HeadlessHost(config());
    const processIntent = vi.fn(async () => {
      throw new Error("load failed");
    });
    const releaseAndUnload = vi.fn(async () => undefined);
    Object.assign(
      host as unknown as {
        processIntent: typeof processIntent;
        releaseAndUnload: typeof releaseAndUnload;
        intentQueue: Promise<void>;
      },
      {
        processIntent,
        releaseAndUnload,
        intentQueue: Promise.resolve(),
      }
    );

    (host as unknown as { enqueueIntents(produce: () => unknown[]): void }).enqueueIntents(() => [
      {
        kind: "load",
        slotId: "panel-1",
        runtimeEntityId: "panel:entry-1",
        connectionId: "lease-1",
      },
    ]);
    await (host as unknown as { intentQueue: Promise<void> }).intentQueue;

    expect(releaseAndUnload).toHaveBeenCalledWith("panel-1", "load failed");
  });

  it("never capacity-evicts a panel pinned by an active CDP client", async () => {
    const host = new HeadlessHost({ ...config(), maxPanels: 2 });
    const tracker = new LeaseTracker("headless-test");
    // Two slots loaded; the OLDEST one (pinned) must be skipped, evicting the next.
    const makeLease = (slotId: string, keepLoaded: boolean, acquiredAt: number) =>
      ({
        slotId,
        runtimeEntityId: `panel:${slotId}`,
        clientSessionId: "headless-test",
        hostConnectionId: "headless-test",
        connectionId: `c-${slotId}`,
        holderLabel: "Headless",
        platform: "headless",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
        keepLoaded,
        acquiredAt,
      }) as unknown as PanelRuntimeLease;
    tracker.reconcile({
      version: { epoch: "e1", counter: 1 },
      leases: [makeLease("pinned-old", true, 1), makeLease("free-new", false, 2)],
    });

    const lastUsed = new Map<string, number>([
      ["pinned-old", 100],
      ["free-new", 200],
    ]);
    const releaseAndUnload = vi.fn(async () => undefined);
    Object.assign(
      host as unknown as {
        tracker: LeaseTracker;
        pages: unknown;
        releaseAndUnload: typeof releaseAndUnload;
      },
      {
        tracker,
        pages: {
          slots: () => ["pinned-old", "free-new"],
          lastUsedAt: (slotId: string) => lastUsed.get(slotId),
        },
        releaseAndUnload,
      }
    );

    await (host as unknown as { enforcePanelCap(): Promise<void> }).enforcePanelCap();

    // Oldest (pinned) was skipped; the next-oldest free panel is evicted instead.
    expect(releaseAndUnload).toHaveBeenCalledWith("free-new", "panel cap");
  });
});
