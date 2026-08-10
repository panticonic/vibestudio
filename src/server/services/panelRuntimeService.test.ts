import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { PanelRuntimeCoordinator } from "../panelRuntimeCoordinator.js";
import { createPanelRuntimeService } from "./panelRuntimeService.js";
import type { PanelBootProbeResult } from "@vibestudio/shared/panel/observation";

const desktopCtx = { caller: createVerifiedCaller("shell:desktop", "shell") };
const rendererCtx = {
  caller: createVerifiedCaller("panel:nav-a", "panel"),
  connectionId: "route-a",
};

function setup(
  input: {
    observeHostSlot?: () => Promise<{
      url: string;
      loading: boolean;
      boot: PanelBootProbeResult;
    } | null>;
    browserSource?: string | null;
  } = {}
) {
  const coordinator = new PanelRuntimeCoordinator();
  coordinator.registerClient({
    clientSessionId: "desktop",
    hostConnectionId: "desktop-host",
    label: "Desktop",
    platform: "desktop",
    supportsCdp: true,
    loadOnLeaseAssignment: true,
  });
  coordinator.acquire("panel:nav-a", {
    slotId: "panel:tree/a",
    clientSessionId: "desktop",
    connectionId: "route-a",
  });
  const observeHostSlot = vi.fn(input.observeHostSlot ?? (async () => null));
  const ensureExecutable = vi.fn(async () => undefined);
  const service = createPanelRuntimeService({
    coordinator,
    ensureExecutable,
    currentEntityForSlot: async () => "panel:nav-a",
    observeHostSlot,
    browserSourceForSlot: async () => input.browserSource ?? null,
  });
  return {
    coordinator,
    service,
    observeHostSlot,
    ensureExecutable,
    attempt: coordinator.currentAttemptForSlot("panel:tree/a")!,
  };
}

afterEach(() => vi.useRealTimers());

describe("panelRuntimeService attempt waits", () => {
  it("joins execution convergence before granting a runtime lease", async () => {
    const { service, ensureExecutable } = setup();
    await expect(
      service.handler(desktopCtx, "acquire", [
        "panel:nav-a",
        {
          slotId: "panel:tree/a",
          clientSessionId: "desktop",
          connectionId: "route-a",
        },
      ])
    ).resolves.toMatchObject({ acquired: true });
    expect(ensureExecutable).toHaveBeenCalledWith("panel:tree/a", "panel:nav-a");
  });

  it("observes the canonical composite without polling the host", async () => {
    const { service, observeHostSlot, attempt } = setup();
    await expect(
      service.handler(desktopCtx, "observeSlot", ["panel:tree/a"])
    ).resolves.toMatchObject({
      attempt: { attemptId: attempt.attemptId, phase: "pending" },
      route: { reachable: false, connectionId: "route-a" },
    });
    expect(observeHostSlot).not.toHaveBeenCalled();
  });

  it("returns the exact snapshot from awaitAttempt with no re-observe round trip", async () => {
    const { coordinator, service, attempt } = setup();
    const waiting = service.handler(desktopCtx, "awaitAttempt", [
      { epoch: attempt.epoch, attemptId: attempt.attemptId },
      attempt.revision,
    ]);
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/",
      loading: true,
      boot: { kind: "observed", observation: { phase: "booting" } },
    });
    await expect(waiting).resolves.toMatchObject({
      kind: "report",
      attempt: { attemptId: attempt.attemptId, phase: "booting", revision: 1 },
    });
  });

  it("does not wake an attempt waiter for route churn", async () => {
    const { coordinator, service, attempt } = setup();
    let settled = false;
    const waiting = service
      .handler(desktopCtx, "awaitAttempt", [
        { epoch: attempt.epoch, attemptId: attempt.attemptId },
        attempt.revision,
      ])
      .then(() => {
        settled = true;
      });
    coordinator.markConnected("panel:nav-a", "route-a");
    await Promise.resolve();
    expect(settled).toBe(false);
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/",
      loading: false,
      boot: { kind: "observed", observation: { phase: "ready" } },
    });
    await waiting;
  });

  it("wakes slot waiters on both route flips", async () => {
    const { coordinator, service } = setup();
    const first = coordinator.observeSlotLifecycle("panel:tree/a");
    const connected = service.handler(desktopCtx, "awaitSlot", ["panel:tree/a", first.version]);
    coordinator.markConnected("panel:nav-a", "route-a");
    await expect(connected).resolves.toMatchObject({ route: { reachable: true } });

    const second = coordinator.observeSlotLifecycle("panel:tree/a");
    const disconnected = service.handler(desktopCtx, "awaitSlot", ["panel:tree/a", second.version]);
    coordinator.markDisconnected("panel:nav-a", "route-a");
    await expect(disconnected).resolves.toMatchObject({
      attempt: { phase: "pending" },
      route: { reachable: false },
    });
  });

  it("returns unknown-attempt immediately for stale epochs", async () => {
    const { service } = setup();
    await expect(
      service.handler(desktopCtx, "awaitAttempt", [
        { epoch: "previous-process", attemptId: "attempt" },
        0,
      ])
    ).resolves.toEqual({
      kind: "unknown-attempt",
      ref: { epoch: "previous-process", attemptId: "attempt" },
    });
  });

  it("returns an already-terminal attempt even at its current revision", async () => {
    const { coordinator, service, attempt } = setup();
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/",
      loading: false,
      boot: { kind: "observed", observation: { phase: "ready" } },
    });
    const terminal = coordinator.currentAttemptForSlot("panel:tree/a")!;

    await expect(
      service.handler(desktopCtx, "awaitAttempt", [
        { epoch: attempt.epoch, attemptId: attempt.attemptId },
        terminal.revision,
      ])
    ).resolves.toMatchObject({
      kind: "report",
      attempt: { phase: "ready", revision: terminal.revision },
    });
  });

  it("resolves a parked waiter with its own stopped record when the slot is superseded", async () => {
    const { coordinator, service, attempt } = setup();
    const waiting = service.handler(desktopCtx, "awaitAttempt", [
      { epoch: attempt.epoch, attemptId: attempt.attemptId },
      attempt.revision,
    ]);
    coordinator.commitAttempt("panel:tree/a", {
      runtimeEntityId: "panel:nav-b",
      connectionId: "route-b",
      hostConnectionId: "desktop-host",
    });
    await expect(waiting).resolves.toMatchObject({
      kind: "report",
      attempt: {
        attemptId: attempt.attemptId,
        phase: "stopped",
        stopReason: "superseded",
      },
    });
  });

  it("propagates cancellation and removes the coordinator listener", async () => {
    const { service, attempt } = setup();
    const controller = new AbortController();
    const waiting = service.handler({ ...desktopCtx, signal: controller.signal }, "awaitAttempt", [
      { epoch: attempt.epoch, attemptId: attempt.attemptId },
      attempt.revision,
    ]);
    controller.abort(new Error("cancelled by eval"));
    await expect(waiting).rejects.toThrow("cancelled by eval");
  });

  it("ensureSlot returns the coordinator-minted attempt", async () => {
    const { service, attempt } = setup();
    await expect(
      service.handler(desktopCtx, "ensureSlot", ["panel:tree/a", "panel:nav-a"])
    ).resolves.toMatchObject({
      status: "already-held",
      attempt: { attemptId: attempt.attemptId, runtimeEntityId: "panel:nav-a" },
    });
  });

  it("publishes browser readiness as a host-owned lifecycle fact", async () => {
    const { coordinator, service, attempt } = setup({
      browserSource: "browser:https://example.com/path",
    });
    await service.handler(desktopCtx, "reportView", [
      "panel:nav-a",
      "route-a",
      {
        url: "https://example.com/redirected",
        loading: false,
        boot: { kind: "unavailable" },
      },
    ]);
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: { phase: "ready", reporter: "host" },
    });
  });

  it("accepts renderer evidence only from the exact lease connection", async () => {
    const { coordinator, service, attempt } = setup();
    const report = {
      url: "http://panel/",
      loading: false,
      boot: { kind: "observed" as const, observation: { phase: "ready" as const } },
    };

    await expect(
      service.handler({ ...rendererCtx, connectionId: "old-route" }, "reportOwnView", [report])
    ).resolves.toBe("stale");
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({ kind: "report", attempt: { phase: "pending" } });

    await expect(service.handler(rendererCtx, "reportOwnView", [report])).resolves.toBe("reported");
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({ kind: "report", attempt: { phase: "ready", reporter: "renderer" } });
  });

  it("forwards typed host failures without synthesizing a renderer boot failure", async () => {
    const { coordinator, service, attempt } = setup();
    await expect(
      service.handler(desktopCtx, "reportView", [
        "panel:nav-a",
        "route-a",
        {
          url: "",
          loading: false,
          boot: { kind: "unavailable" },
          failure: {
            reporter: "host",
            failure: {
              stage: "renderer-crash",
              code: "render_crashed",
              message: "renderer exited",
            },
          },
        },
      ])
    ).resolves.toBe("reported");
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: {
        phase: "failed",
        reporter: "host",
        failure: {
          stage: "renderer-crash",
          code: "render_crashed",
          message: "renderer exited",
        },
      },
    });
  });
});
