import { createHash } from "node:crypto";
import { compileMxcLaunch } from "./mxc.js";
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

/** Translate application-owned resource admission into MXC's public policy.
 * MXC owns OS layout discovery, policy enforcement and native lifecycle. */
export function compileExecution(
  policy: ExecutionPolicy,
  installation: IsolationInstallation
): CompiledExecution {
  validateExecutionPolicy(policy, installation.platform);
  if (policy.sockets.length) {
    throw new IsolationError(
      "MXC socket admission is not implemented; use the workspace control channel"
    );
  }
  return {
    ...compileMxcLaunch({
      network: "allow",
      platform: installation.platform,
      launcher: installation.launcher,
      containerId:
        "vibestudio-" +
        createHash("sha256").update(JSON.stringify(policy.owner)).digest("hex").slice(0, 32),
      argv: [policy.executable, ...policy.args],
      cwd: policy.cwd,
      guestEnvironment: executionEnvironment(policy, installation.platform),
      readPaths: policy.read,
      writePaths: policy.write,
    }),
    mechanism: "mxc-process",
  };
}
