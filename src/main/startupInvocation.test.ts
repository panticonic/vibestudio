import { describe, expect, it } from "vitest";
import {
  DEV_WEBRTC_REMOTE_ARG,
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
      [
        "/electron",
        HEADLESS_HOST_ARG,
        PAIR_CONFIRMED_ARG,
        SKIP_REMOTE_PAIRING_ARG,
        DEV_WEBRTC_REMOTE_ARG,
      ],
      {}
    );

    expect(parsed).toMatchObject({
      isHeadlessHost: true,
      pendingPairConfirmed: true,
      skipRemotePairing: true,
      devWebRtcRemote: true,
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
});
