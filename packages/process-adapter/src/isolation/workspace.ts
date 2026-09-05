import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { open, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import path from "node:path";
import type { ProcessAdapter, ProcessAdapterOptions } from "../index.js";
import { compileExecution, type IsolationInstallation } from "./index.js";
import {
  containsPath,
  executionEnvironment,
  IsolationError,
  type ExecutionPolicy,
} from "./policy.js";
import { readControl, writeControl } from "./control.js";

export interface WorkspaceSandboxInstallation extends IsolationInstallation {
  /** Installed workspaceChild.js and its adjacent control.js, visible read-only. */
  workspaceEntry: string;
}

export interface WorkspaceStopResult {
  launcherExited: boolean;
  /** Root exit is not proof that all hostile descendants have terminated. */
  descendantCleanup: "unverified";
}

class WorkspaceCommand extends EventEmitter implements ProcessAdapter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined;
  private exited = false;
  private drainDeadline: ReturnType<typeof setTimeout> | undefined;

  get hasExited(): boolean {
    return this.exited;
  }

  constructor(
    readonly id: string,
    private readonly send: (message: unknown) => boolean,
    private readonly pendingBytes: () => number
  ) {
    super();
  }

  get bufferedAmount(): number {
    return this.pendingBytes();
  }

  postMessage(value: unknown): void {
    if (!this.exited) this.send({ type: "message", id: this.id, value });
  }

  kill(): boolean {
    return !this.exited && this.send({ type: "kill", id: this.id });
  }

  output(channel: "stdout" | "stderr", data: Buffer | string): void {
    const stream = this[channel];
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    if (stream.readableLength + stream.writableLength + size > 1024 * 1024) {
      throw new IsolationError("Unconsumed command output limit");
    }
    stream.write(data);
  }

  finish(code: number | null, drained?: () => void): void {
    if (this.exited) return;
    this.exited = true;
    // Guest close timing is not authoritative. Bound retained streams and
    // command state in the host even if a compromised supervisor omits close.
    if (drained) this.drainDeadline = setTimeout(drained, 1_000);
    this.emit("exit", code);
  }

  closeStreams(): void {
    clearTimeout(this.drainDeadline);
    this.stdout.end();
    this.stderr.end();
  }
}

/** One resident native command host per workspace incarnation. The installed
 * owner supplies sealed resources and authorization; guest messages never admit
 * resources, create host processes, select a host PID, or report kernel proof.
 * Broker revocation is separately owned and must precede workspace retirement. */
export class WorkspaceSandbox {
  /** Final ownership retirement, after stop; never used for an ordinary restart. */
  static async retireStorage(
    privateRoot: string,
    installation: IsolationInstallation
  ): Promise<void> {
    if (installation.platform !== "win32") return;
    const root = await realpath(privateRoot);
    await new Promise<void>((resolve, reject) => {
      execFile(
        installation.launcher,
        ["--retire-storage", root],
        {
          env: { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" },
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        },
        (error) => (error ? reject(error) : resolve())
      );
    });
  }

  private readonly commands = new Map<string, WorkspaceCommand>();
  private readonly environment: Record<string, string>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private running = false;
  private sessionRetired = false;
  private stopping: Promise<WorkspaceStopResult> | undefined;
  private launcherExited = false;
  private stderrTail = "";
  readonly ready: Promise<void>;
  /** Resolves on logical control-session retirement, independently of whether
   * all processes have exited. Owners use this to revoke broker authority. */
  readonly retired: Promise<void>;
  private retireSession!: () => void;

  private constructor(
    private readonly policy: ExecutionPolicy,
    installation: WorkspaceSandboxInstallation,
    private readonly launch: ReturnType<typeof compileExecution>
  ) {
    this.environment = executionEnvironment(policy, installation.platform);
    this.retired = new Promise((resolve) => {
      this.retireSession = resolve;
    });
    this.child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.once("exit", () => {
      this.launcherExited = true;
      this.endSession();
    });
    this.closed = new Promise((resolve) => {
      this.child.once("close", () => {
        this.launcherExited = true;
        this.endSession();
        resolve();
      });
    });
    this.ready = new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(
        () => fail(new IsolationError("Workspace sandbox startup timed out")),
        10_000
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.endSession();
        reject(
          this.stderrTail ? new IsolationError(`${error.message}: ${this.stderrTail}`) : error
        );
        this.child.kill("SIGKILL");
      };
      this.child.on("error", fail);
      this.child.stdin.on("error", fail);
      this.child.stderr.on("data", (chunk) => {
        this.stderrTail = (this.stderrTail + String(chunk)).slice(-16_384);
      });
      this.child.once("close", () => {
        clearTimeout(timer);
        if (!ready)
          reject(new IsolationError(`Workspace sandbox exited before ready: ${this.stderrTail}`));
      });
      readControl(
        this.child.stdout,
        (message) => {
          if (message["type"] === "ready") {
            if (this.sessionRetired) throw new IsolationError("Workspace session is retired");
            if (ready) throw new IsolationError("Duplicate workspace readiness");
            ready = true;
            this.running = true;
            clearTimeout(timer);
            resolve();
          } else {
            if (!ready) throw new IsolationError("Workspace command event before readiness");
            this.receive(message);
          }
        },
        fail
      );
    });
  }

  static async start(
    policy: ExecutionPolicy,
    installation: WorkspaceSandboxInstallation
  ): Promise<WorkspaceSandbox> {
    if (installation.platform !== process.platform) {
      throw new IsolationError("Cannot execute a different platform's confinement backend");
    }
    if (policy.owner.contextId !== null) {
      throw new IsolationError("A shared workspace sandbox cannot be owned by one context");
    }
    const paths = installation.platform === "win32" ? path.win32 : path.posix;
    if (
      !paths.isAbsolute(installation.workspaceEntry) ||
      !policy.read.some((root) =>
        containsPath(root, installation.workspaceEntry, installation.platform)
      )
    )
      throw new IsolationError("Workspace bootstrap must be in the admitted read-only runtime");
    const resolved = { ...policy, args: [installation.workspaceEntry] };
    const launch = compileExecution(resolved, installation);
    // Resources must already exist and be anchored/sealed by the installed
    // owner. Reject path aliases here; this check alone is not race protection.
    for (const resource of [
      policy.privateRoot,
      installation.workspaceEntry,
      installation.launcher,
    ]) {
      if ((await realpath(resource)) !== resource) {
        throw new IsolationError(`Workspace admission requires a canonical resource: ${resource}`);
      }
    }
    const created: string[] = [];
    try {
      for (const file of launch.controlFiles) {
        const handle = await open(file.path, "wx", file.mode);
        created.push(file.path);
        try {
          await handle.writeFile(file.contents);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      await Promise.all(created.map((file) => unlink(file)));
      throw error;
    }
    const sandbox = new WorkspaceSandbox(resolved, installation, launch);
    try {
      await sandbox.ready;
      return sandbox;
    } catch (error) {
      await sandbox.stop();
      throw error;
    }
  }

  /** Commands share the sandbox's resource ceiling and private home. This is
   * a ProcessAdapter factory, not a new per-command security admission. */
  fork(
    entry: string,
    env: Record<string, string | undefined>,
    options: ProcessAdapterOptions = {}
  ): ProcessAdapter {
    if (!this.running || this.stopping)
      throw new IsolationError("Workspace sandbox is not running");
    if (options.stdio === "inherit") {
      throw new IsolationError("Interactive TTYs must be opened inside the workspace sandbox");
    }
    if (this.commands.size >= 256) {
      throw new IsolationError("Workspace command admission limit");
    }
    const id = randomUUID();
    const command = new WorkspaceCommand(
      id,
      (message) => this.send(message),
      () => this.child.stdin.writableLength
    );
    this.commands.set(id, command);
    // The base environment is closed. Caller-supplied values are command data
    // inside this already-confined workspace, never launcher environment.
    const environment = { ...this.environment };
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) environment[key] = value;
    }
    if (
      !this.send({
        type: "fork",
        id,
        entry,
        cwd: this.policy.cwd,
        env: environment,
        execArgv: options.execArgv ?? [],
      })
    ) {
      this.commands.delete(id);
      throw new IsolationError("Workspace command launch failed");
    }
    return command;
  }

  private send(message: unknown): boolean {
    if (this.launcherExited) return false;
    try {
      writeControl(this.child.stdin, message);
      return true;
    } catch {
      this.endSession();
      this.child.kill("SIGKILL");
      return false;
    }
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message["id"] !== "string")
      throw new IsolationError("Missing command event identity");
    const command = this.commands.get(message["id"]);
    if (!command) return; // A late event cannot resurrect an exited command.
    if (
      command.hasExited &&
      message["type"] !== "stdout" &&
      message["type"] !== "stderr" &&
      message["type"] !== "close"
    )
      return;
    switch (message["type"]) {
      case "spawn":
        if (!Number.isSafeInteger(message["pid"]) || (message["pid"] as number) <= 0) {
          throw new IsolationError("Invalid command process observation");
        }
        command.pid = message["pid"] as number; // Diagnostic only; never used for host signalling.
        command.emit("spawn");
        break;
      case "message":
        command.emit("message", message["value"]);
        break;
      case "disconnect":
        command.emit("disconnect");
        break;
      case "stdout":
      case "stderr": {
        if (typeof message["data"] !== "string" || message["data"].length > 32_768) {
          throw new IsolationError("Invalid command output");
        }
        command.output(message["type"], Buffer.from(message["data"], "base64"));
        break;
      }
      case "failure":
        command.output("stderr", `${String(message["message"]).slice(0, 16_384)}\n`);
        break;
      case "exit":
        if (message["code"] !== null && !Number.isSafeInteger(message["code"])) {
          throw new IsolationError("Invalid command exit observation");
        }
        command.finish(message["code"] as number | null, () => {
          this.commands.delete(command.id);
          command.closeStreams();
        });
        break;
      case "close":
        this.commands.delete(message["id"]);
        command.finish(null);
        command.closeStreams();
        break;
      default:
        throw new IsolationError("Unknown workspace command event");
    }
  }

  stop(): Promise<WorkspaceStopResult> {
    this.stopping ??= this.stopOnce();
    return this.stopping;
  }

  private endSession(): void {
    this.sessionRetired = true;
    this.running = false;
    this.retireSession();
    for (const command of this.commands.values()) {
      command.finish(null);
      command.closeStreams();
    }
    this.commands.clear();
  }

  private async stopOnce(): Promise<WorkspaceStopResult> {
    this.endSession();
    if (!this.launcherExited) this.send({ type: "shutdown" });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        deadline = setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 3_000);
      }),
    ]);
    clearTimeout(deadline);
    // Do not delete resources or claim descendant retirement if a launcher or
    // inherited pipe remains live. The owner records/quarantines this outcome.
    let finalDeadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        finalDeadline = setTimeout(resolve, 1_000);
      }),
    ]);
    clearTimeout(finalDeadline);
    // A descendant can retain a pipe after the trusted launcher has exited.
    // Always release the host's endpoints after the bounded close wait.
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (!this.launcherExited) this.child.unref();
    else
      for (const file of this.launch.controlFiles)
        await unlink(file.path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
    return { launcherExited: this.launcherExited, descendantCleanup: "unverified" };
  }
}
