import { describe, expect, it, vi, afterEach } from "vitest";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type {
  AttemptPhase,
  AttemptReporter,
  PanelAttemptFailure,
} from "@vibestudio/shared/panel/observation";

function resident() {
  const onError = vi.fn();
  const coordinator = new PanelRuntimeCoordinator({ onError });
  coordinator.registerClient({
    clientSessionId: "desktop",
    hostConnectionId: "desktop-host",
    label: "Desktop",
    platform: "desktop",
    supportsCdp: true,
    loadOnLeaseAssignment: true,
  });
  const lease = coordinator.acquire("panel:nav-a", {
    slotId: "panel:tree/a",
    clientSessionId: "desktop",
    connectionId: "route-a",
  }).lease;
  return {
    coordinator,
    lease,
    onError,
    attempt: coordinator.currentAttemptForSlot("panel:tree/a")!,
  };
}

function reportFor(phase: AttemptPhase): {
  phase: AttemptPhase;
  reporter: AttemptReporter;
  failure?: PanelAttemptFailure;
} {
  if (phase === "stopped") return { phase, reporter: "coordinator" };
  if (phase === "failed") {
    return {
      phase,
      reporter: "renderer",
      failure: { stage: "bundle-load", code: "entry_threw" },
    };
  }
  return { phase, reporter: "renderer" };
}

afterEach(() => vi.useRealTimers());

describe("PanelRuntimeCoordinator attempt state machine", () => {
  it.each([
    ["pending", "loading", true],
    ["pending", "booting", true],
    ["pending", "ready", true],
    ["loading", "pending", false],
    ["loading", "loading", false],
    ["loading", "booting", true],
    ["booting", "loading", false],
    ["booting", "ready", true],
    ["ready", "failed", false],
    ["ready", "stopped", true],
  ] as const)("accepts %s → %s iff monotonic (%s)", (from, to, accepted) => {
    const { coordinator, attempt } = resident();
    if (from !== "pending") {
      expect(coordinator.reportAttemptPhase(attempt.attemptId, reportFor(from))).toBe(true);
    }
    expect(coordinator.reportAttemptPhase(attempt.attemptId, reportFor(to))).toBe(accepted);
  });

  it.each([
    ["renderer", "loading", undefined, true],
    ["renderer", "ready", undefined, true],
    ["renderer", "failed", "bundle-load", true],
    ["renderer", "failed", "navigation", false],
    ["host", "ready", undefined, true],
    ["host", "failed", "renderer-crash", true],
    ["build", "failed", "build", true],
    ["materialization", "failed", "materialization", true],
    ["coordinator", "failed", "boot-stall", true],
    ["coordinator", "ready", undefined, false],
  ] as const)("authorizes reporter %s for %s/%s (%s)", (reporter, phase, stage, accepted) => {
    const { coordinator, attempt } = resident();
    expect(
      coordinator.reportAttemptPhase(attempt.attemptId, {
        phase,
        reporter,
        ...(stage
          ? {
              failure: {
                stage,
                code:
                  stage === "boot-stall" || stage === "materialization"
                    ? "boot_stalled"
                    : stage === "build"
                      ? "compile_failed"
                      : stage === "renderer-crash"
                        ? "render_crashed"
                        : "entry_threw",
              },
            }
          : {}),
      })
    ).toBe(accepted);
  });

  it("rejects unknown refs and reports from unknown attempts", () => {
    const { coordinator, onError } = resident();
    const ref = { epoch: coordinator.epochId, attemptId: "missing" };
    expect(coordinator.getAttempt(ref)).toEqual({ kind: "unknown-attempt", ref });
    expect(coordinator.reportAttemptPhase("missing", { phase: "ready", reporter: "host" })).toBe(
      false
    );
    expect(onError).toHaveBeenCalled();
  });

  it("returns unknown-attempt immediately for a foreign process epoch", () => {
    const { coordinator, attempt } = resident();
    const ref = { epoch: "old-epoch", attemptId: attempt.attemptId };
    expect(coordinator.getAttempt(ref)).toEqual({ kind: "unknown-attempt", ref });
  });

  it("retains only the bounded terminal history for each slot", () => {
    const { coordinator, attempt: first } = resident();
    for (let index = 0; index < 9; index += 1) {
      coordinator.commitAttempt("panel:tree/a", {
        runtimeEntityId: `panel:nav-${index}`,
      });
    }

    const firstRef = { epoch: first.epoch, attemptId: first.attemptId };
    expect(coordinator.getAttempt(firstRef)).toEqual({ kind: "unknown-attempt", ref: firstRef });
    const current = coordinator.currentAttemptForSlot("panel:tree/a")!;
    expect(coordinator.getAttempt({ epoch: current.epoch, attemptId: current.attemptId })).toEqual({
      kind: "report",
      attempt: current,
    });
  });

  it("freezes failed and stopped attempts", () => {
    const first = resident();
    expect(first.coordinator.reportAttemptPhase(first.attempt.attemptId, reportFor("failed"))).toBe(
      true
    );
    expect(first.coordinator.reportAttemptPhase(first.attempt.attemptId, reportFor("ready"))).toBe(
      false
    );

    const second = resident();
    expect(second.coordinator.stopAttempt(second.attempt.attemptId, "retired")?.phase).toBe(
      "stopped"
    );
    expect(
      second.coordinator.reportAttemptPhase(second.attempt.attemptId, reportFor("ready"))
    ).toBe(false);
  });

  it("supersedes atomically and severs stale route attribution", () => {
    const { coordinator, attempt } = resident();
    const next = coordinator.commitAttempt("panel:tree/a", {
      runtimeEntityId: "panel:nav-b",
      connectionId: "route-b",
      hostConnectionId: "desktop-host",
    });
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: { phase: "stopped", stopReason: "superseded" },
    });
    expect(
      coordinator.reportView("panel:nav-a", "route-a", {
        url: "http://stale/",
        loading: false,
        boot: { kind: "observed" as const, observation: { phase: "ready" } },
      })
    ).toBe(false);
    expect(coordinator.currentAttemptForSlot("panel:tree/a")?.attemptId).toBe(next.attemptId);
    expect(next.phase).toBe("pending");
  });

  it("keeps ready boot state durable while route reachability flips", () => {
    const { coordinator } = resident();
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/",
      loading: false,
      boot: { kind: "observed" as const, observation: { phase: "ready" } },
    });
    coordinator.markDisconnected("panel:nav-a", "route-a");
    expect(coordinator.observeSlotLifecycle("panel:tree/a")).toMatchObject({
      attempt: { phase: "ready" },
      route: { reachable: false, view: { url: "http://panel/" } },
    });
    coordinator.markConnected("panel:nav-a", "route-a");
    expect(coordinator.observeSlotLifecycle("panel:tree/a")).toMatchObject({
      attempt: { phase: "ready" },
      route: { reachable: true },
    });
  });

  it("does not publish a slot transition for an identical report", () => {
    const { coordinator } = resident();
    const changed = vi.fn();
    coordinator.onSlotObservationChanged(changed);
    const report = {
      url: "http://panel/",
      loading: true,
      boot: { kind: "observed" as const, observation: { phase: "booting" as const } },
    };
    coordinator.reportView("panel:nav-a", "route-a", report);
    changed.mockClear();
    coordinator.reportView("panel:nav-a", "route-a", report);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not classify pending build or host assignment time as a boot stall", async () => {
    vi.useFakeTimers();
    const { coordinator, attempt } = resident();
    coordinator.setBuildState("panel:tree/a", { state: "building" });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({ kind: "report", attempt: { phase: "pending" } });
  });

  it("terminates a materialized pending attempt when its first boot report is missing", async () => {
    vi.useFakeTimers();
    const { coordinator, attempt } = resident();
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/?buildKey=ready-build",
      loading: false,
      boot: { kind: "unavailable" },
    });
    coordinator.setAttemptProbe(async () => ({
      url: "http://panel/?buildKey=ready-build",
      loading: false,
      boot: { kind: "unavailable" as const },
    }));

    await vi.advanceTimersByTimeAsync(12_100);

    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: {
        phase: "failed",
        failure: {
          stage: "boot-stall",
          code: "boot_stalled",
          detail: "unobservable",
        },
      },
    });
  });

  it("terminates a connected pending attempt even when every initial view report is missing", async () => {
    vi.useFakeTimers();
    const { coordinator, attempt } = resident();
    coordinator.setAttemptProbe(async () => ({
      url: "http://panel/?buildKey=ready-build",
      loading: false,
      boot: { kind: "unavailable" as const },
    }));

    coordinator.markConnected("panel:nav-a", "route-a");
    await vi.advanceTimersByTimeAsync(12_100);

    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: { phase: "failed", failure: { code: "boot_stalled", detail: "unobservable" } },
    });
  });

  it("does not reset pending supervision for identical host observations", async () => {
    vi.useFakeTimers();
    const { coordinator, attempt } = resident();
    const unavailableView = {
      url: "http://panel/?buildKey=ready-build",
      loading: false,
      boot: { kind: "unavailable" as const },
    };
    coordinator.reportView("panel:nav-a", "route-a", unavailableView);
    coordinator.setAttemptProbe(async () => unavailableView);

    for (let round = 0; round < 12; round += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      coordinator.reportView("panel:nav-a", "route-a", unavailableView);
    }

    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: { phase: "failed", failure: { code: "boot_stalled" } },
    });
  });

  it("discards a pending probe result after the renderer makes the attempt ready", async () => {
    vi.useFakeTimers();
    const { coordinator, attempt, onError } = resident();
    let finishProbe!: (report: {
      url: string;
      loading: boolean;
      boot: { kind: "observed"; observation: { phase: "failed"; message: string } };
    }) => void;
    coordinator.setAttemptProbe(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        })
    );
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/",
      loading: true,
      boot: { kind: "observed", observation: { phase: "booting" } },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/",
      loading: false,
      boot: { kind: "observed", observation: { phase: "ready" } },
    });
    finishProbe({
      url: "http://panel/",
      loading: false,
      boot: {
        kind: "observed",
        observation: { phase: "failed", message: "stale host observation" },
      },
    });
    await vi.runAllTimersAsync();

    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({ kind: "report", attempt: { phase: "ready" } });
    expect(coordinator.reportedViewForSlot("panel:tree/a")?.observation.boot).toMatchObject({
      kind: "observed",
      observation: { phase: "ready" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops a released materialization and mints a fresh attempt on reacquisition", () => {
    const { coordinator, attempt } = resident();
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/",
      loading: false,
      boot: { kind: "observed" as const, observation: { phase: "ready" } },
    });

    coordinator.release("panel:nav-a", "route-a");
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: { phase: "stopped", stopReason: "unloaded" },
    });

    const acquired = coordinator.acquire("panel:nav-a", {
      slotId: "panel:tree/a",
      clientSessionId: "desktop",
      connectionId: "route-b",
    });
    const replacement = coordinator.currentAttemptForSlot("panel:tree/a")!;
    expect(acquired.acquired).toBe(true);
    expect(replacement.attemptId).not.toBe(attempt.attemptId);
    expect(replacement.phase).toBe("pending");
  });

  it("keeps acquire idempotent when the same host already owns a healthy route", () => {
    const { coordinator, attempt } = resident();

    const acquired = coordinator.acquire("panel:nav-a", {
      slotId: "panel:tree/a",
      clientSessionId: "desktop",
      connectionId: "route-that-must-not-replace-the-owner",
    });

    expect(acquired).toMatchObject({
      acquired: true,
      lease: { connectionId: "route-a", clientSessionId: "desktop" },
    });
    expect(coordinator.currentAttemptForSlot("panel:tree/a")?.attemptId).toBe(attempt.attemptId);
    expect(
      coordinator.authorizePanelConnection("panel:nav-a", "route-that-must-not-replace-the-owner")
    ).toMatchObject({ ok: false });
    expect(coordinator.authorizePanelConnection("panel:nav-a", "route-a")).toEqual({ ok: true });
  });

  it("terminates lease-less attempts on unload and entity retirement", () => {
    const unloadedCoordinator = new PanelRuntimeCoordinator();
    const unloaded = unloadedCoordinator.ensureAttemptForSlot("panel:tree/u", "panel:nav-u");
    expect(unloadedCoordinator.unloadSlot("panel:tree/u")).toBeNull();
    expect(
      unloadedCoordinator.getAttempt({ epoch: unloaded.epoch, attemptId: unloaded.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: { phase: "stopped", stopReason: "unloaded" },
    });

    const retiredCoordinator = new PanelRuntimeCoordinator();
    const retired = retiredCoordinator.ensureAttemptForSlot("panel:tree/r", "panel:nav-r");
    retiredCoordinator.retireRuntimeEntity("panel:nav-r");
    expect(
      retiredCoordinator.getAttempt({ epoch: retired.epoch, attemptId: retired.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: { phase: "stopped", stopReason: "retired" },
    });
  });

  it("uses one no-progress counter across alternating probe outcomes", async () => {
    vi.useFakeTimers();
    const { coordinator, attempt } = resident();
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/",
      loading: false,
      boot: { kind: "observed" as const, observation: { phase: "booting" } },
    });
    let round = 0;
    coordinator.setAttemptProbe(async () => {
      round += 1;
      return round % 2
        ? {
            url: "http://panel/",
            loading: false,
            boot: { kind: "observed" as const, observation: { phase: "booting" as const } },
          }
        : null;
    });
    await vi.advanceTimersByTimeAsync(12_100);
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: { phase: "failed", failure: { code: "boot_stalled" } },
    });
  });

  it("maps typed stop reasons to one central wire close vocabulary", () => {
    const close = vi.fn();
    const { coordinator } = resident();
    coordinator.setCloseConnection(close);
    coordinator.unloadSlot("panel:tree/a");
    expect(close).toHaveBeenCalledWith("panel:nav-a", "route-a", 4094, "Panel runtime unloaded");
  });

  it("never closes the connection a same-route recovery re-acquire hands to its successor", () => {
    const close = vi.fn();
    const { coordinator } = resident();
    coordinator.setCloseConnection(close);
    coordinator.reportView("panel:nav-a", "route-a", {
      url: "http://panel/",
      loading: false,
      boot: { kind: "observed" as const, observation: { phase: "failed", message: "entry threw" } },
    });
    const recovered = coordinator.acquire("panel:nav-a", {
      slotId: "panel:tree/a",
      clientSessionId: "desktop",
      connectionId: "route-a",
    });
    expect(recovered.lease?.connectionId).toBe("route-a");
    expect(close).not.toHaveBeenCalledWith("panel:nav-a", "route-a", 4091, expect.anything());
    expect(coordinator.currentAttemptForSlot("panel:tree/a")?.phase).toBe("pending");
    expect(
      coordinator.reportView("panel:nav-a", "route-a", {
        url: "http://panel/",
        loading: true,
        boot: { kind: "observed" as const, observation: { phase: "loading" } },
      })
    ).toBe(true);
  });

  it("preserves the loader's failure taxonomy instead of flattening stages", () => {
    const { coordinator, attempt } = resident();
    coordinator.reportView(
      "panel:nav-a",
      "route-a",
      {
        url: "http://panel/",
        loading: false,
        boot: {
          kind: "observed" as const,
          observation: { phase: "failed", message: "no cfg", failureStage: "config" },
        },
      },
      "renderer"
    );
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: {
        phase: "failed",
        failure: { stage: "config", message: "no cfg" },
      },
    });
  });

  it("accepts a host-originated typed failure on the push channel", () => {
    const { coordinator, attempt } = resident();
    expect(
      coordinator.reportView(
        "panel:nav-a",
        "route-a",
        {
          url: "",
          loading: false,
          boot: { kind: "unavailable" },
          failure: {
            reporter: "host",
            failure: { stage: "navigation", code: "navigation_failed", message: "load failed" },
          },
        },
        "host"
      )
    ).toBe(true);
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({
      kind: "report",
      attempt: {
        phase: "failed",
        reporter: "host",
        failure: { stage: "navigation", code: "navigation_failed" },
      },
    });
  });

  it("ignores an origination-only failure from the renderer principal", () => {
    const { coordinator, attempt } = resident();
    coordinator.reportView(
      "panel:nav-a",
      "route-a",
      {
        url: "http://panel/",
        loading: true,
        boot: { kind: "observed" as const, observation: { phase: "loading" } },
        failure: {
          reporter: "host",
          failure: { stage: "renderer-crash", code: "render_crashed" },
        },
      },
      "renderer"
    );
    expect(
      coordinator.getAttempt({ epoch: attempt.epoch, attemptId: attempt.attemptId })
    ).toMatchObject({ kind: "report", attempt: { phase: "loading" } });
  });

  it("clears the predecessor's build axis on supersession", () => {
    const { coordinator } = resident();
    coordinator.setBuildState("panel:tree/a", { state: "ready", buildKey: "bk-old" });
    coordinator.commitAttempt("panel:tree/a", {
      runtimeEntityId: "panel:nav-b",
      connectionId: "route-b",
      hostConnectionId: "desktop-host",
    });
    expect(coordinator.observeSlotLifecycle("panel:tree/a").build).toBeUndefined();
  });
});
