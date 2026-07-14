import { describe, expect, it, vi } from "vitest";
import type { PendingUnitBatchApproval } from "@vibestudio/shared/approvals";
import type { HostTargetLaunchResult } from "@vibestudio/shared/hostTargets";
import { HostTargetLaunchCoordinator } from "./hostTargetLaunchCoordinator.js";
import type { AppHost } from "./appHost.js";

const mobileApproval: PendingUnitBatchApproval = {
  approvalId: "approval-mobile",
  kind: "unit-batch",
  callerId: "system:units",
  callerKind: "system",
  repoPath: "meta",
  executionDigest: "",
  trigger: "startup",
  title: "Approve workspace units",
  description: "Approve before launch",
  units: [
    {
      unitKind: "app",
      unitName: "@workspace-apps/mobile",
      displayName: "Mobile",
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      sourceDigest: "sourceDigest-mobile",
      capabilities: [],
      dependencySourceDigests: {},
      externalDeps: {},
    },
  ],
  configWrite: null,
  requestedAt: 1,
};

function makeCoordinator(opts: {
  pending?: PendingUnitBatchApproval[];
  launch?: HostTargetLaunchResult;
  trustedUnits?: Array<{ kind: string; name: string; source: string; status: string }>;
  awaitStartupUnitReconcile?: () => Promise<void> | void;
  requiredExtensionSources?: string[];
  /** The app source the AppHost resolves for react-native (manifest-driven
   *  selection); null mimics a workspace with no declared/selectable app. */
  rnAppSource?: string | null;
}) {
  const emit = vi.fn();
  const publishPending = vi.fn();
  let pending = opts.pending ?? [];
  const resolve = vi.fn((approvalId: string) => {
    pending = pending.filter((approval) => approval.approvalId !== approvalId);
  });
  const launchHostTarget = vi.fn(async () =>
    opts.launch
      ? opts.launch
      : ({
          status: "unavailable",
          launched: false,
          target: "electron",
          reason: "No app",
          details: [],
        } satisfies HostTargetLaunchResult)
  );
  const coordinator = new HostTargetLaunchCoordinator({
    approvalQueue: {
      listPending: () => pending,
      resolve,
    },
    eventService: { emit },
    startupApprovals: { publishPending },
    awaitStartupUnitReconcile: opts.awaitStartupUnitReconcile,
    getRequiredExtensionSources: () => opts.requiredExtensionSources ?? [],
    getAppHost: () =>
      ({
        launchHostTarget,
        selectedHostTargetAppSource: (target: string) =>
          target === "react-native"
            ? opts.rnAppSource !== undefined
              ? opts.rnAppSource
              : "apps/mobile"
            : target === "terminal"
              ? "apps/terminal"
              : null,
      }) as unknown as AppHost,
    getTrustedUnitHosts: () => [
      {
        listWorkspaceUnits: () => opts.trustedUnits ?? [],
      },
    ],
  });
  return { coordinator, emit, publishPending, launchHostTarget, resolve };
}

describe("HostTargetLaunchCoordinator", () => {
  it("returns pending startup approvals before touching the app host without self-notifying", async () => {
    const { coordinator, emit, launchHostTarget } = makeCoordinator({
      pending: [mobileApproval],
    });

    const result = await coordinator.launch("react-native");

    expect(result.status).toBe("approval-required");
    expect(launchHostTarget).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("waits for initial startup unit reconcile before deciding approvals are absent", async () => {
    let releaseReconcile!: () => void;
    const reconciled = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    const pending: PendingUnitBatchApproval[] = [];
    const { coordinator, publishPending, launchHostTarget } = makeCoordinator({
      pending,
      awaitStartupUnitReconcile: async () => {
        await reconciled;
        pending.push(mobileApproval);
      },
    });

    const resultPromise = coordinator.launch("react-native");
    await Promise.resolve();

    expect(publishPending).not.toHaveBeenCalled();
    expect(launchHostTarget).not.toHaveBeenCalled();

    releaseReconcile();
    const result = await resultPromise;

    expect(result.status).toBe("approval-required");
    expect(publishPending).not.toHaveBeenCalled();
    expect(launchHostTarget).not.toHaveBeenCalled();
  });

  it("turns provider-inactive React Native startup into preparing while trusted units build without self-notifying", async () => {
    const { coordinator, emit, publishPending } = makeCoordinator({
      launch: {
        status: "unavailable",
        launched: false,
        target: "react-native",
        reason: "React Native build provider is not active",
        details: ["Last failure phase: build"],
      },
      trustedUnits: [
        {
          kind: "extension",
          name: "@workspace-extensions/react-native",
          source: "extensions/react-native",
          status: "building",
        },
      ],
    });

    const result = await coordinator.launch("react-native");

    expect(result).toEqual({
      status: "preparing",
      launched: false,
      target: "react-native",
      reason: "React Native workspace startup is preparing",
      details: [
        "Last failure phase: build",
        "@workspace-extensions/react-native (extensions/react-native) status: building",
      ],
    });
    expect(publishPending).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps React Native preparing while a required running extension registers its provider", async () => {
    const { coordinator } = makeCoordinator({
      launch: {
        status: "unavailable",
        launched: false,
        target: "react-native",
        reason: "React Native build provider is not active",
        details: [],
      },
      requiredExtensionSources: ["extensions/react-native"],
      trustedUnits: [
        {
          kind: "extension",
          name: "@workspace-extensions/react-native",
          source: "extensions/react-native",
          status: "running",
        },
      ],
    });

    expect(await coordinator.launch("react-native")).toMatchObject({
      status: "preparing",
      details: ["@workspace-extensions/react-native (extensions/react-native) status: running"],
    });
  });

  it("recognizes the building react-native app via the AppHost-resolved source, not a hardcoded name", async () => {
    const launch: HostTargetLaunchResult = {
      status: "unavailable",
      launched: false,
      target: "react-native",
      reason: "React Native build provider is not active",
      details: [],
    };
    // A workspace whose manifest declares a DIFFERENT react-native app: its
    // building app unit counts as preparing…
    const custom = makeCoordinator({
      launch,
      rnAppSource: "apps/field-mobile",
      trustedUnits: [
        {
          kind: "app",
          name: "@workspace-apps/field-mobile",
          source: "apps/field-mobile",
          status: "building",
        },
      ],
    });
    expect((await custom.coordinator.launch("react-native")).status).toBe("preparing");

    // …while the historically hardcoded apps/mobile gets NO special treatment
    // when the resolved app is a different unit.
    const stale = makeCoordinator({
      launch,
      rnAppSource: "apps/field-mobile",
      trustedUnits: [
        {
          kind: "app",
          name: "@workspace-apps/mobile",
          source: "apps/mobile",
          status: "building",
        },
      ],
    });
    expect((await stale.coordinator.launch("react-native")).status).toBe("unavailable");
  });

  it("returns ready launch state without self-notifying", async () => {
    const { coordinator, emit } = makeCoordinator({
      launch: {
        status: "ready",
        launched: true,
        target: "terminal",
        source: "apps/terminal",
        appId: "@workspace-apps/terminal",
        buildKey: "build-1",
      },
    });

    const result = await coordinator.launch("terminal");

    expect(result.status).toBe("ready");
    expect(emit).not.toHaveBeenCalled();
  });

  it("shows extension build progress while a terminal app waits for startup units", async () => {
    const { coordinator } = makeCoordinator({
      launch: {
        status: "preparing",
        launched: false,
        target: "terminal",
        reason: "Selected Terminal app does not have an active build",
        details: ["apps/terminal: pending-approval"],
      },
      trustedUnits: [
        {
          kind: "extension",
          name: "@workspace-extensions/claude-code",
          source: "extensions/claude-code",
          status: "building",
        },
      ],
    });

    await expect(coordinator.launch("terminal")).resolves.toMatchObject({
      status: "preparing",
      details: [
        "apps/terminal: pending-approval",
        "@workspace-extensions/claude-code (extensions/claude-code) status: building",
      ],
    });
  });

  it("returns a starting session promptly while launch resolution continues", async () => {
    const { coordinator, emit, launchHostTarget } = makeCoordinator({});
    let resolveLaunch!: (value: HostTargetLaunchResult) => void;
    const launch = new Promise<HostTargetLaunchResult>((resolve) => {
      resolveLaunch = resolve;
    });
    launchHostTarget.mockImplementationOnce(async () => await launch);
    vi.useFakeTimers();
    try {
      const pending = coordinator.beginLaunch("react-native");

      await vi.advanceTimersByTimeAsync(300);
      const session = await pending;

      expect(session).toMatchObject({
        target: "react-native",
        status: "starting",
        settled: false,
      });
      expect(emit).not.toHaveBeenCalled();

      resolveLaunch({
        status: "ready",
        launched: true,
        target: "react-native",
        source: "apps/mobile",
        appId: "@workspace-apps/mobile",
        buildKey: "build-mobile",
      });
      await vi.runAllTimersAsync();

      expect(await coordinator.getLaunchSession(session.sessionId)).toMatchObject({
        status: "ready",
        settled: true,
        launch: expect.objectContaining({
          status: "ready",
          appId: "@workspace-apps/mobile",
        }),
      });
      expect(emit).toHaveBeenCalledWith(
        "host-target-launch:session-changed",
        expect.objectContaining({
          sessionId: session.sessionId,
          target: "react-native",
          status: "ready",
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("single-flights repeated refreshes of an unresolved launch session", async () => {
    const { coordinator, launchHostTarget } = makeCoordinator({});
    let resolveLaunch!: (value: HostTargetLaunchResult) => void;
    const launch = new Promise<HostTargetLaunchResult>((resolve) => {
      resolveLaunch = resolve;
    });
    launchHostTarget.mockImplementation(async () => await launch);
    vi.useFakeTimers();
    try {
      const firstPending = coordinator.beginLaunch("electron");
      await vi.advanceTimersByTimeAsync(300);
      const first = await firstPending;

      const secondPending = coordinator.beginLaunch("electron");
      const thirdPending = coordinator.beginLaunch("electron");
      await vi.advanceTimersByTimeAsync(300);
      const [second, third] = await Promise.all([secondPending, thirdPending]);

      expect(second.sessionId).toBe(first.sessionId);
      expect(third.sessionId).toBe(first.sessionId);
      expect(launchHostTarget).toHaveBeenCalledTimes(1);

      resolveLaunch({
        status: "ready",
        launched: true,
        target: "electron",
        source: "apps/shell",
        appId: "@workspace-apps/shell",
        buildKey: "build-shell",
      });
      await vi.runAllTimersAsync();

      expect(await coordinator.getLaunchSession(first.sessionId)).toMatchObject({
        status: "ready",
        settled: true,
      });
      expect(launchHostTarget).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits explicit target change notifications for underlying state changes", () => {
    const { coordinator, emit } = makeCoordinator({});

    coordinator.notifyTargetChanged("terminal", "app-status");

    expect(emit).toHaveBeenCalledWith(
      "host-targets:changed",
      expect.objectContaining({
        target: "terminal",
        status: "unknown",
        reason: "app-status",
        revision: 1,
      })
    );
  });

  it("begins a launch session and emits approval-required session state", async () => {
    const { coordinator, emit, launchHostTarget } = makeCoordinator({
      pending: [mobileApproval],
    });

    const session = await coordinator.beginLaunch("react-native");

    expect(session).toMatchObject({
      target: "react-native",
      status: "approval-required",
      currentPhase: "review-trust",
      approvals: [mobileApproval],
      approvalViews: [
        expect.objectContaining({
          approvalId: "approval-mobile",
          title: expect.any(String),
        }),
      ],
      settled: false,
    });
    expect(launchHostTarget).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "host-target-launch:session-changed",
      expect.objectContaining({
        sessionId: session.sessionId,
        target: "react-native",
        status: "approval-required",
      })
    );
  });

  it("reuses an unresolved launch session for the same target", async () => {
    const { coordinator } = makeCoordinator({
      pending: [mobileApproval],
    });

    const first = await coordinator.beginLaunch("react-native");
    const second = await coordinator.beginLaunch("react-native");

    expect(second.sessionId).toBe(first.sessionId);
  });

  it("resolves session approvals and advances to the ready launch", async () => {
    const { coordinator, resolve } = makeCoordinator({
      pending: [mobileApproval],
      launch: {
        status: "ready",
        launched: true,
        target: "react-native",
        source: "apps/mobile",
        appId: "@workspace-apps/mobile",
        buildKey: "build-mobile",
      },
    });
    const session = await coordinator.beginLaunch("react-native");

    const ready = await coordinator.resolveLaunchSessionApproval(session.sessionId, "once");

    expect(resolve).toHaveBeenCalledWith("approval-mobile", "once");
    expect(ready).toMatchObject({
      sessionId: session.sessionId,
      status: "ready",
      approvalsResolved: 1,
      settled: true,
      launch: expect.objectContaining({
        status: "ready",
        appId: "@workspace-apps/mobile",
      }),
    });
  });
});
