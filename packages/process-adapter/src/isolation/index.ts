import { createHash } from "node:crypto";
import { compileNativeLaunch, type NativeInstallation } from "./native-launch.js";
export type { NativeInstallation } from "./native-launch.js";
import {
  executionEnvironment,
  IsolationError,
  validateExecutionPolicy,
  type ExecutionPolicy,
} from "./policy.js";

export { IsolationError, validateExecutionPolicy, type ExecutionPolicy } from "./policy.js";

export interface CompiledExecution {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  mechanism: "mxc-process" | "host-process";
}

/** Compile the explicit platform execution mechanism. Unix uses MXC policy;
 * Windows executes directly with a closed environment and normal user access. */
export function compileExecution(
  policy: ExecutionPolicy,
  installation: NativeInstallation
): CompiledExecution {
  validateExecutionPolicy(policy, installation.platform);
  if (policy.sockets.length) {
    throw new IsolationError(
      "MXC socket admission is not implemented; use the workspace control channel"
    );
  }
  return {
    ...compileNativeLaunch({
      network: "allow",
      installation,
      containerId:
        "vibestudio-" +
        createHash("sha256").update(JSON.stringify(policy.owner)).digest("hex").slice(0, 32),
      argv: [policy.executable, ...policy.args],
      cwd: policy.cwd,
      guestEnvironment: executionEnvironment(policy, installation.platform),
      readPaths: policy.read,
      writePaths: policy.write,
    }),
  };
}
