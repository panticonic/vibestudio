import path from "node:path";
import type { ContainerConfig } from "@microsoft/mxc-sdk";
import { windowsEnvironmentValue } from "./windowsEnvironment.js";
export { windowsEnvironmentValue } from "./windowsEnvironment.js";

export type MxcPlatform = "linux" | "darwin" | "win32";

export interface MxcLaunchInput {
  platform: MxcPlatform;
  launcher: string;
  containerId: string;
  argv: readonly string[];
  cwd: string;
  guestEnvironment: Readonly<Record<string, string>>;
  readPaths: readonly string[];
  writePaths: readonly string[];
  /** Developer commands use normal networking; internal file cleanup is offline. */
  network: "allow" | "deny";
}

/** The installed executor is trusted host infrastructure. MXC clears the
 * environment at the guest boundary; host runtime/profile requirements belong
 * to the owner here, never to guest-selected coordinates. */
export function mxcLauncherEnvironment(
  ambient: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ambient).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

/** MXC's Unix command is interpreted by a shell; Windows uses CreateProcess/CRT. */
function quoteArgument(value: string, platform: MxcPlatform): string {
  if (value.includes("\0")) throw new Error("MXC command argument contains NUL");
  if (platform !== "win32") return "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1") + '"';
}

/** One stock MXC adapter. Callers own resource admission and guest authority;
 * this function only translates those decisions to the installed executor. */
export function compileMxcLaunch(
  input: MxcLaunchInput,
  hostEnvironment: NodeJS.ProcessEnv = process.env
): {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
} {
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(input.launcher) || input.launcher.includes("\0")) {
    throw new Error("The MXC launcher must be an installed absolute path");
  }
  if (!input.argv.length || !input.argv[0]) throw new Error("MXC launch has no executable");
  if (input.platform === "win32" && /\.(?:cmd|bat)$/iu.test(input.argv[0])) {
    throw new Error(
      "MXC requires a native Windows executable; command-script shims are unsupported"
    );
  }
  const environment = Object.entries(input.guestEnvironment).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes("\0"))
      throw new Error("Invalid MXC guest environment");
    return `${key}=${value}`;
  });
  // AppContainer creation needs a local profile coordinate. Requiring it also
  // prevents legacy SBOX's empty-environment inheritance behavior.
  if (input.platform === "win32") {
    const localData = windowsEnvironmentValue(input.guestEnvironment, "LOCALAPPDATA");
    if (!localData || !path.win32.isAbsolute(localData))
      throw new Error(
        "MXC Windows guests require an absolute private LOCALAPPDATA environment coordinate"
      );
  }
  const config: ContainerConfig = {
    version: "0.8.0-alpha",
    containment:
      input.platform === "linux"
        ? "bubblewrap"
        : input.platform === "darwin"
          ? "seatbelt"
          : "processcontainer",
    containerId: input.containerId,
    process: {
      commandLine: input.argv.map((arg) => quoteArgument(arg, input.platform)).join(" "),
      cwd: input.cwd,
      env: environment,
      timeout: 0,
    },
    filesystem: {
      // macOS ttyname() enumerates /dev to attach a controlling terminal.
      // Stock MXC expresses this as a recursive read grant. Device reads remain
      // subject to the owner's OS permissions; no additional writes are granted.
      readonlyPaths: [
        ...new Set([...input.readPaths, ...(input.platform === "darwin" ? ["/dev"] : [])]),
      ],
      readwritePaths: [...input.writePaths],
    },
    // The supported stock open-network shape shares Linux's host network.
    // Directional ingress fields select filtered namespaces and cannot express
    // unrestricted ingress on that backend. We impose no application network
    // policy; Windows AppContainer can retain intrinsic loopback limitations.
    network:
      input.network === "allow"
        ? { defaultPolicy: "allow", allowLocalNetwork: true }
        : { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    // Windows console runtimes (including Node) import USER32 during startup.
    // Disabling win32k prevents DLL initialization; MXC still applies its job
    // restrictions to clipboard, external UI objects and desktop control.
    ui: { disable: input.platform !== "win32", clipboard: "none", injection: false },
    ...(input.platform === "win32"
      ? {
          processContainer: {
            leastPrivilege: false,
            capabilities:
              input.network === "allow"
                ? ["internetClient", "internetClientServer", "privateNetworkClientServer"]
                : [],
          },
        }
      : {}),
    ...(input.platform === "darwin"
      ? {
          seatbelt: {
            nestedPty: true,
            keychainAccess: false,
            // libc account lookup is used by CoreFoundation while starting
            // the installed Electron runtime, even in ELECTRON_RUN_AS_NODE.
            extraMachLookups: ["com.apple.system.opendirectoryd.libinfo"],
          },
        }
      : {}),
  };
  return {
    command: input.launcher,
    args: ["--config-base64", Buffer.from(JSON.stringify(config)).toString("base64")],
    cwd: input.cwd,
    environment: mxcLauncherEnvironment(hostEnvironment),
  };
}

export { assertMxcPrerequisites, formatMxcStartupError } from "./prerequisites.js";
