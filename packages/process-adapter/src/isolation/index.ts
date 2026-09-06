import { createHash } from "node:crypto";
import path from "node:path";
import type { ContainerConfig } from "@microsoft/mxc-sdk";
import {
  executionEnvironment,
  IsolationError,
  validateExecutionPolicy,
  type ExecutionPolicy,
} from "./policy.js";

export { IsolationError, validateExecutionPolicy, type ExecutionPolicy } from "./policy.js";

export interface IsolationInstallation {
  platform: "linux" | "darwin" | "win32";
  /** Absolute path to the pinned, installed MXC executable, never guest PATH. */
  launcher: string;
}

export interface CompiledExecution {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  mechanism: "mxc-process";
}

/** MXC accepts a command line rather than argv. Unix uses shell words; Windows
 * uses the CreateProcess/CRT quoting contract. Never interpolate command data. */
function quoteArgument(value: string, platform: IsolationInstallation["platform"]): string {
  if (platform !== "win32") return "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return '\"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1") + '\"';
}

/** Translate application-owned resource admission into MXC's public policy.
 * MXC owns OS layout discovery, policy enforcement and native lifecycle. */
export function compileExecution(
  policy: ExecutionPolicy,
  installation: IsolationInstallation
): CompiledExecution {
  validateExecutionPolicy(policy, installation.platform);
  const paths = installation.platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(installation.launcher) || installation.launcher.includes("\0")) {
    throw new IsolationError("The MXC launcher must be an installed absolute path");
  }
  if (policy.sockets.length) {
    throw new IsolationError(
      "MXC socket admission is not implemented; use the workspace control channel"
    );
  }
  const environment = executionEnvironment(policy, installation.platform);
  const config: ContainerConfig = {
    version: "0.8.0-alpha",
    containment:
      installation.platform === "linux"
        ? "bubblewrap"
        : installation.platform === "darwin"
          ? "seatbelt"
          : "processcontainer",
    containerId:
      "vibestudio-" +
      createHash("sha256").update(JSON.stringify(policy.owner)).digest("hex").slice(0, 32),
    process: {
      commandLine: [policy.executable, ...policy.args]
        .map((arg) => quoteArgument(arg, installation.platform))
        .join(" "),
      cwd: policy.cwd,
      env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      timeout: 0,
    },
    filesystem: { readonlyPaths: [...policy.read], readwritePaths: [...policy.write] },
    network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    ui: { disable: true, clipboard: "none", injection: false },
    ...(installation.platform === "win32"
      ? { processContainer: { leastPrivilege: false, capabilities: [] } }
      : {}),
    ...(installation.platform === "darwin"
      ? { seatbelt: { nestedPty: true, keychainAccess: false } }
      : {}),
  };
  return {
    command: installation.launcher,
    args: ["--config-base64", Buffer.from(JSON.stringify(config)).toString("base64")],
    cwd: policy.cwd,
    // MXC's Windows ACL lifecycle journal is host-owned. These coordinates
    // belong only to its launcher; process.env above stays workspace-scoped.
    environment:
      installation.platform === "win32"
        ? Object.fromEntries(
            ["SystemRoot", "USERPROFILE", "LOCALAPPDATA"].flatMap((key) => {
              const value = process.env[key];
              return value === undefined ? [] : [[key, value]];
            })
          )
        : { PATH: "/usr/bin:/bin" },
    mechanism: "mxc-process",
  };
}
