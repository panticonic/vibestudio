import path from "node:path";
import { darwinProfile } from "./darwin.js";
import { linuxArguments } from "./linux.js";
import {
  executionEnvironment,
  IsolationError,
  validateExecutionPolicy,
  type ExecutionPolicy,
} from "./policy.js";

export { IsolationError, validateExecutionPolicy, type ExecutionPolicy } from "./policy.js";

export interface IsolationInstallation {
  platform: "linux" | "darwin" | "win32";
  /** Absolute path from the installed product, never from guest PATH. */
  launcher: string;
}

export interface CompiledExecution {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  /** The installed owner seals these outside all guest-readable/writable roots. */
  controlFiles: readonly { path: string; contents: string; mode: 0o600 }[];
  /** Mechanism facts, not a claim that a process has been admitted or started. */
  mechanism: "linux-namespaces" | "macos-seatbelt" | "windows-lpac-job";
}

/** Compile already-resolved resources. The caller remains responsible for
 * protected admission, anchored filesystem resources and an owned lifetime.
 * In particular, the macOS profile by itself does not own daemonized children. */
export function compileExecution(
  policy: ExecutionPolicy,
  installation: IsolationInstallation
): CompiledExecution {
  validateExecutionPolicy(policy, installation.platform);
  const paths = installation.platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(installation.launcher) || installation.launcher.includes("\0")) {
    throw new IsolationError("The confinement launcher must be an installed absolute path");
  }
  const environment = executionEnvironment(policy, installation.platform);
  if (installation.platform === "linux") {
    return {
      command: installation.launcher,
      args: linuxArguments(policy),
      cwd: policy.cwd,
      environment: {},
      controlFiles: [],
      mechanism: "linux-namespaces",
    };
  }
  if (installation.platform === "darwin") {
    return {
      command: installation.launcher,
      args: ["-p", darwinProfile(policy), policy.executable, ...policy.args],
      cwd: policy.cwd,
      environment,
      controlFiles: [],
      mechanism: "macos-seatbelt",
    };
  }
  if (policy.sockets.length)
    throw new IsolationError("Unix socket resources cannot be passed to Windows admission");
  const policyPath = paths.join(policy.privateRoot, ".isolation-policy.json");
  return {
    command: installation.launcher,
    args: [policyPath],
    cwd: policy.cwd,
    environment: {},
    controlFiles: [
      { path: policyPath, contents: JSON.stringify({ ...policy, environment }), mode: 0o600 },
    ],
    mechanism: "windows-lpac-job",
  };
}
