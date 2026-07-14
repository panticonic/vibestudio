import { describe, expect, it } from "vitest";
import {
  HEADLESS_HOST_ARG,
  PAIR_CONFIRMED_ARG,
  SKIP_REMOTE_PAIRING_ARG,
  parseMainStartupInvocation,
} from "./startupInvocation.js";

describe("parseMainStartupInvocation", () => {
  it("consumes crash-recovery markers without mutating the caller's argv", () => {
    const argv = [
      "/electron",
      "/app/main.js",
      "--workspace",
      "demo",
      "--recovered-local-server-crash=17",
      "--local-server-crash-loop=23",
      "--local-server-crash-workspace=demo",
    ];
    const originalArgv = [...argv];

    const parsed = parseMainStartupInvocation(argv, {});

    expect(argv).toEqual(originalArgv);
    expect(parsed.argv).toEqual(["/electron", "/app/main.js", "--workspace", "demo"]);
    expect(parsed.crashRecovery).toEqual({
      recoveredExitCode: "17",
      crashLoopExitCode: "23",
      crashLoopWorkspaceName: "demo",
      shouldClearRelaunchState: false,
    });
  });

  it("preserves explicitly empty exit-code marker values", () => {
    const parsed = parseMainStartupInvocation(
      ["/electron", "--recovered-local-server-crash=", "--local-server-crash-loop="],
      {}
    );

    expect(parsed.crashRecovery.recoveredExitCode).toBe("");
    expect(parsed.crashRecovery.crashLoopExitCode).toBe("");
    expect(parsed.crashRecovery.shouldClearRelaunchState).toBe(false);
  });

  it("recognizes launch policy flags from explicit inputs", () => {
    const parsed = parseMainStartupInvocation(
      ["/electron", HEADLESS_HOST_ARG, PAIR_CONFIRMED_ARG, SKIP_REMOTE_PAIRING_ARG],
      {}
    );

    expect(parsed).toMatchObject({
      isHeadlessHost: true,
      pendingPairConfirmed: true,
      skipRemotePairing: true,
    });
  });

  it("recognizes env-selected headless startup and clears stale relaunch state normally", () => {
    const parsed = parseMainStartupInvocation(["/electron"], {
      VIBESTUDIO_HEADLESS_HOST: "1",
    });

    expect(parsed.isHeadlessHost).toBe(true);
    expect(parsed.crashRecovery).toEqual({
      recoveredExitCode: null,
      crashLoopExitCode: null,
      crashLoopWorkspaceName: null,
      shouldClearRelaunchState: true,
    });
  });

  it("requires and returns the complete managed-development profile contract", () => {
    const parsed = parseMainStartupInvocation(["/electron"], {
      VIBESTUDIO_MANAGED_DEV: "1",
      VIBESTUDIO_MANAGED_DEV_LAUNCH_ID: "dev_1",
      VIBESTUDIO_MANAGED_DEV_CLIENT_BUILD_ID: "a".repeat(64),
      VIBESTUDIO_MANAGED_DEV_PROFILE_DIR: "/private/profile",
      VIBESTUDIO_MANAGED_DEV_PAIRING_FILE: "/private/pairing.json",
      VIBESTUDIO_MANAGED_DEV_READY_FILE: "/private/ready.json",
      VIBESTUDIO_MANAGED_DEV_EXPECTED_SERVER_ID: "srv_1",
      VIBESTUDIO_MANAGED_DEV_EXPECTED_WORKSPACE_ID: "ws_1",
    });

    expect(parsed.managedDev).toEqual({
      launchId: "dev_1",
      clientBuildId: "a".repeat(64),
      profileDir: "/private/profile",
      pairingFile: "/private/pairing.json",
      readyFile: "/private/ready.json",
      expectedServerId: "srv_1",
      expectedWorkspaceId: "ws_1",
    });
  });

  it("fails closed on a partial managed-development environment", () => {
    expect(() =>
      parseMainStartupInvocation(["/electron"], {
        VIBESTUDIO_MANAGED_DEV: "1",
        VIBESTUDIO_MANAGED_DEV_LAUNCH_ID: "dev_1",
      })
    ).toThrow(/missing clientBuildId/);
  });
});
