import { spawn } from "node:child_process";
import { bindProcessLifetimeToParent } from "./owned-process-tree.mjs";

// Non-Node executables cannot consume the parent's native IPC lease. This
// group leader consumes it before launching them into the same owned group.
const releaseLease = bindProcessLifetimeToParent();
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("A parent-owned command requires an executable");
const child = spawn(command, args, { stdio: "inherit", env: process.env });
const outcome = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
process.exitCode = outcome.code ?? 1;
releaseLease();
if (process.connected) process.disconnect();
