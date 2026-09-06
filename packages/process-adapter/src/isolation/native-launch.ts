import path from "node:path";
import { compileMxcLaunch } from "./mxc.js";
export { windowsEnvironmentValue } from "./windowsEnvironment.js";
export { assertNativePrerequisites, formatNativeStartupError } from "./prerequisites.js";

export type NativeInstallation =
  | { platform: "win32"; mechanism: "host-process" }
  | { platform: "linux" | "darwin"; mechanism: "mxc-process"; launcher: string };
export interface NativeLaunchInput {
  installation: NativeInstallation;
  containerId: string;
  argv: readonly string[];
  cwd: string;
  guestEnvironment: Readonly<Record<string, string>>;
  readPaths: readonly string[];
  writePaths: readonly string[];
  /** Enforced by MXC on Unix; Windows host execution has normal host networking. */
  network: "allow" | "deny";
}
export function compileNativeLaunch(input: NativeLaunchInput, hostEnvironment = process.env) {
  const { installation } = input;
  if (installation.mechanism === "mxc-process") {
    return {
      ...compileMxcLaunch(
        { ...input, platform: installation.platform, launcher: installation.launcher },
        hostEnvironment
      ),
      mechanism: installation.mechanism,
    };
  }
  // Windows deliberately executes as the app's normal user. Resource lists are
  // owner bookkeeping, not kernel restrictions. No failed sandbox fallback exists.
  const [command, ...args] = input.argv;
  if (!command || !path.win32.isAbsolute(command) || /\.(?:cmd|bat)$/iu.test(command))
    throw new Error("Windows native execution requires an absolute executable path");
  if (!path.win32.isAbsolute(input.cwd))
    throw new Error("Windows native execution requires an absolute working directory");
  if ([command, ...args, input.cwd].some((value) => value.includes("\0")))
    throw new Error("Native launch argument contains NUL");
  for (const [key, value] of Object.entries(input.guestEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes("\0"))
      throw new Error("Invalid native process environment");
  }
  return {
    command,
    args,
    cwd: input.cwd,
    environment: { ...input.guestEnvironment },
    mechanism: installation.mechanism,
  };
}
