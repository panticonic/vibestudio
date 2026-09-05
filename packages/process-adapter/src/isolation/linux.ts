import type { ExecutionPolicy } from "./policy.js";
import { executionEnvironment } from "./policy.js";

/** No host root, network namespace, home, bus or device inheritance. */
export function linuxArguments(policy: ExecutionPolicy): string[] {
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  // Runtime ABI paths on supported usr-merged Linux systems. The targets are
  // visible only when their backing runtime directories were admitted.
  for (const [target, link] of [
    ["usr/bin", "/bin"],
    ["usr/sbin", "/sbin"],
    ["usr/lib", "/lib"],
    ["usr/lib64", "/lib64"],
  ]) {
    if (!policy.read.includes(link!) && !policy.write.includes(link!))
      args.push("--symlink", target!, link!);
  }
  for (const resource of policy.read) args.push("--ro-bind", resource, resource);
  for (const resource of policy.write) args.push("--bind", resource, resource);
  for (const resource of policy.sockets) args.push("--ro-bind", resource, resource);
  for (const [key, value] of Object.entries(executionEnvironment(policy, "linux")))
    args.push("--setenv", key, value);
  args.push("--chdir", policy.cwd, "--", policy.executable, ...policy.args);
  return args;
}
