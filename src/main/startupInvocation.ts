export const DEV_WEBRTC_REMOTE_ARG = "--dev-webrtc-remote";
export const PAIR_CONFIRMED_ARG = "--pair-confirmed";
export const SKIP_REMOTE_PAIRING_ARG = "--skip-remote-pairing";
export const HEADLESS_HOST_ARG = "--headless-host";

const RECOVERED_LOCAL_SERVER_CRASH_PREFIX = "--recovered-local-server-crash=";
const LOCAL_SERVER_CRASH_LOOP_PREFIX = "--local-server-crash-loop=";
const LOCAL_SERVER_CRASH_WORKSPACE_PREFIX = "--local-server-crash-workspace=";

export interface LocalServerCrashRecoveryInvocation {
  recoveredExitCode: string | null;
  crashLoopExitCode: string | null;
  crashLoopWorkspaceName: string | null;
  /** Clear persisted relaunch history only for an ordinary, non-recovery launch. */
  shouldClearRelaunchState: boolean;
}

export interface MainStartupInvocation {
  /** argv with one-shot crash-recovery markers consumed. */
  argv: string[];
  isHeadlessHost: boolean;
  pendingPairConfirmed: boolean;
  skipRemotePairing: boolean;
  devWebRtcRemote: boolean;
  crashRecovery: LocalServerCrashRecoveryInvocation;
}

interface ConsumedArgument {
  argv: string[];
  value: string | null;
}

function consumePrefixedArgument(
  argv: readonly string[],
  prefix: string,
  missingValue: string | null
): ConsumedArgument {
  const index = argv.findIndex((arg) => arg.startsWith(prefix));
  if (index < 0) return { argv: [...argv], value: null };

  const rawValue = argv[index]?.split("=")[1];
  return {
    argv: [...argv.slice(0, index), ...argv.slice(index + 1)],
    value: rawValue ?? missingValue,
  };
}

/**
 * Parse process inputs before Electron startup begins.
 *
 * The parser is deliberately pure: the caller decides whether to replace the
 * live `process.argv` and clear persisted recovery state. This keeps one-shot
 * marker consumption testable without importing Electron or mutating globals.
 */
export function parseMainStartupInvocation(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): MainStartupInvocation {
  const recovered = consumePrefixedArgument(argv, RECOVERED_LOCAL_SERVER_CRASH_PREFIX, "unknown");
  const crashLoop = consumePrefixedArgument(
    recovered.argv,
    LOCAL_SERVER_CRASH_LOOP_PREFIX,
    "unknown"
  );
  const crashWorkspace = consumePrefixedArgument(
    crashLoop.argv,
    LOCAL_SERVER_CRASH_WORKSPACE_PREFIX,
    null
  );

  return {
    argv: crashWorkspace.argv,
    isHeadlessHost: env["VIBESTUDIO_HEADLESS_HOST"] === "1" || argv.includes(HEADLESS_HOST_ARG),
    pendingPairConfirmed: argv.includes(PAIR_CONFIRMED_ARG),
    skipRemotePairing: argv.includes(SKIP_REMOTE_PAIRING_ARG),
    devWebRtcRemote: argv.includes(DEV_WEBRTC_REMOTE_ARG),
    crashRecovery: {
      recoveredExitCode: recovered.value,
      crashLoopExitCode: crashLoop.value,
      crashLoopWorkspaceName: crashWorkspace.value,
      shouldClearRelaunchState: recovered.value === null && crashLoop.value === null,
    },
  };
}
