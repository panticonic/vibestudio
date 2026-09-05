/** Installed entry point inside ONE workspace sandbox. All commands inherit its
 * OS policy. This process holds no broker/authority credentials of its own. */
import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { readControl, writeControl } from "./control.js";

const children = new Map<string, ChildProcess>();
let stopping = false;

function send(message: unknown): void {
  try {
    writeControl(process.stdout, message);
  } catch {
    stop();
  }
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill("SIGTERM");
  const deadline = setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(0);
  }, 2_000);
  deadline.unref();
  if (!children.size) process.exit(0);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function receive(message: Record<string, unknown>): void {
  if (message["type"] === "shutdown") return stop();
  if (stopping) return;
  if (typeof message["id"] !== "string" || message["id"].length > 256) {
    throw new Error("Invalid command identity");
  }
  const id = message["id"];
  if (message["type"] === "fork") {
    if (children.has(id) || children.size >= 256) throw new Error("Command admission limit");
    if (
      typeof message["entry"] !== "string" ||
      typeof message["cwd"] !== "string" ||
      !stringArray(message["execArgv"]) ||
      !message["env"] ||
      typeof message["env"] !== "object" ||
      Array.isArray(message["env"]) ||
      !Object.values(message["env"]).every((value) => typeof value === "string")
    )
      throw new Error("Invalid command launch");
    // Command environment is explicit. process.execArgv is deliberately NOT
    // inherited: a command must not accidentally load the supervisor's hooks.
    const child = fork(message["entry"], [], {
      cwd: message["cwd"],
      env: message["env"] as Record<string, string>,
      execArgv: message["execArgv"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.set(id, child);
    let reportedExit = false;
    let drainDeadline: ReturnType<typeof setTimeout> | undefined;
    const reportExit = (code: number | null) => {
      if (reportedExit) return;
      reportedExit = true;
      children.delete(id);
      send({ type: "exit", id, code });
      // A detached descendant may retain the command's output pipes. Direct
      // command completion does not await it; drain final output for at most
      // one second, then release the inherited pipes without claiming it died.
      drainDeadline = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 1_000);
      if (stopping && !children.size) process.exit(0);
    };
    child.on("spawn", () => send({ type: "spawn", id, pid: child.pid }));
    child.on("message", (value) => send({ type: "message", id, value }));
    child.on("disconnect", () => send({ type: "disconnect", id }));
    child.on("error", (error) => {
      send({ type: "failure", id, message: error.message });
      if (child.pid === undefined) reportExit(null);
    });
    for (const [type, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      stream?.on("data", (data: Buffer) => {
        for (let offset = 0; offset < data.length; offset += 16_384) {
          send({ type, id, data: data.subarray(offset, offset + 16_384).toString("base64") });
        }
      });
    }
    child.on("exit", reportExit);
    child.on("close", () => {
      clearTimeout(drainDeadline);
      send({ type: "close", id });
    });
    return;
  }
  const child = children.get(id);
  if (!child) return;
  if (message["type"] === "kill") {
    // Never signal a PID supplied by the parent or another workspace. Direct
    // child cancellation is best effort; detached descendants stay sandboxed.
    child.kill("SIGTERM");
  } else if (message["type"] === "message") {
    if (child.connected) child.send(message["value"] as Serializable, () => {});
  } else {
    throw new Error("Unknown workspace control operation");
  }
}

process.stdout.on("error", stop);
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
readControl(process.stdin, receive, (error) => {
  process.stderr.write(`${error.message}\n`);
  stop();
});
send({ type: "ready" });
