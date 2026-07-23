import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createProcessAdapter, type ProcessAdapter } from "@vibestudio/process-adapter";

import type { ExtensionHealth, ExtensionProcessState } from "./types.js";

interface RunningExtension {
  state: ExtensionProcessState;
  proc: ProcessAdapter;
  ready: boolean;
  methods: string[];
  hasFetch: boolean;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>;
  lastStartedAt: number;
  stopping: boolean;
  health: ExtensionHealth | null;
  inspectorUrl: string | null;
  stderrTail: string[];
  exitHandler: (code: number | null) => void;
}

interface CrashState {
  attempts: number;
  windowStart: number;
  timer: ReturnType<typeof setTimeout> | null;
  nextAttemptAt: number | null;
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const CRASH_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const CRASH_WINDOW_MS = 60_000;

export interface ExtensionProcessManagerDeps {
  onStatus(name: string, status: "running" | "stopped" | "error", error?: string | null): void;
  onError?(name: string, error: string, attempts: number): void;
  onHealth(name: string, health: ExtensionHealth): void;
  onLog(
    name: string,
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
    source?: "stdout" | "stderr" | "ctx.log" | "console",
  ): void;
  onCrashLimit?(name: string, error: string, attempts: number): void;
  onInspectorUrl?(name: string, inspectorUrl: string | null): void;
}

export class ExtensionProcessManager {
  private running = new Map<string, RunningExtension>();
  private crashes = new Map<string, CrashState>();
  private readyWaiters = new Map<string, Set<ReadyWaiter>>();

  constructor(private readonly deps: ExtensionProcessManagerDeps) {}

  async start(state: ExtensionProcessState): Promise<void> {
    await this.stop(state.name, "restart");
    this.resetCrashState(state.name);
    await this.spawn(state);
  }

  private async spawn(state: ExtensionProcessState): Promise<void> {
    const childRuntime = resolveChildRuntimePath();
    const proc = createProcessAdapter(
      childRuntime,
      {
        ...process.env,
        VIBESTUDIO_EXTENSION_NAME: state.name,
        VIBESTUDIO_EXTENSION_VERSION: state.version,
        VIBESTUDIO_EXTENSION_BUNDLE_PATH: state.bundlePath,
        VIBESTUDIO_EXTENSION_STORAGE_DIR: state.storageDir,
        VIBESTUDIO_EXTENSION_GATEWAY_URL: state.gatewayUrl,
        VIBESTUDIO_EXTENSION_RPC_TOKEN: state.rpcToken,
      },
      {
        execArgv: extensionRuntimeExecArgv(),
        preferNode: true,
      },
    );
    let running!: RunningExtension;
    const exitHandler = (code: number | null) => this.handleExit(running, code);
    running = {
      state,
      proc,
      ready: false,
      methods: [],
      hasFetch: false,
      pending: new Map(),
      lastStartedAt: Date.now(),
      stopping: false,
      health: null,
      inspectorUrl: null,
      stderrTail: [],
      exitHandler,
    };
    this.running.set(state.name, running);

    proc.on("exit", exitHandler);
    proc.stdout?.on("data", (chunk) => this.handleStdout(state.name, "info", chunk));
    proc.stderr?.on("data", (chunk) => this.handleStdout(state.name, "error", chunk));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        running.proc.kill();
        reject(new Error(`Extension ${state.name} did not become ready within 10s`));
      }, 10_000);
      running.pending.set("__ready__", {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout,
      });
    });
  }

  async stop(name: string, reason = "stop"): Promise<void> {
    if (reason !== "crash-restart") {
      this.resetCrashState(name);
    }
    const running = this.running.get(name);
    if (!running) return;
    running.stopping = true;
    running.proc.postMessage({ type: "shutdown" });
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        running.proc.off("exit", waitHandler);
        resolve();
      };
      const waitHandler = () => settle();
      const timeout = setTimeout(() => {
        running.proc.kill();
        // If kill doesn't produce an exit within the grace window we still
        // resolve; the existing spawn-time exit handler will deal with the
        // late exit (it short-circuits respawn via running.stopping).
        setTimeout(settle, 500).unref?.();
      }, 2_000);
      running.proc.on("exit", waitHandler);
    });
    this.running.delete(name);
    if (reason !== "restart") {
      this.rejectReadyWaiters(name, extensionNotReadyError(name, `Extension stopped (${reason})`));
      this.deps.onStatus(name, "stopped", null);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map((name) => this.stop(name)));
  }

  listRunning(): Array<{
    name: string;
    methods: string[];
    hasFetch: boolean;
    health: ExtensionHealth | null;
    inspectorUrl: string | null;
  }> {
    return [...this.running.values()].map((running) => ({
      name: running.state.name,
      methods: running.methods,
      hasFetch: running.hasFetch,
      health: running.health,
      inspectorUrl: running.inspectorUrl,
    }));
  }

  isRunning(name: string): boolean {
    return this.running.get(name)?.ready ?? false;
  }

  /** Wait for an already-starting or crash-restarting extension. Never starts one. */
  whenRunning(name: string, signal?: AbortSignal): Promise<void> {
    if (this.isRunning(name)) return Promise.resolve();
    if (!this.running.has(name) && !this.crashes.has(name)) {
      return Promise.reject(extensionNotReadyError(name, "Extension is not starting"));
    }
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject: (error) => reject(error),
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.onAbort = () => {
          this.removeReadyWaiter(name, waiter);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      const waiters = this.readyWaiters.get(name) ?? new Set<ReadyWaiter>();
      waiters.add(waiter);
      this.readyWaiters.set(name, waiters);
      // Close the race between the initial state check and waiter insertion.
      if (this.isRunning(name)) this.resolveReadyWaiters(name);
    });
  }

  markReady(name: string, readyState: { methods: string[]; hasFetch: boolean }): void {
    const running = this.running.get(name);
    if (!running) return;
    running.ready = true;
    running.methods = readyState.methods;
    running.hasFetch = readyState.hasFetch;
    this.deps.onStatus(name, "running", null);
    if (!running.health) {
      const health: ExtensionHealth = {
        state: "healthy",
        summary: "healthy",
        reportedAt: Date.now(),
      };
      running.health = health;
      this.deps.onHealth(name, health);
    }
    const ready = running.pending.get("__ready__");
    if (ready) {
      running.pending.delete("__ready__");
      ready.resolve(undefined);
    }
    this.resolveReadyWaiters(name);
  }

  private handleExit(running: RunningExtension, code: number | null): void {
    const state = running.state;
    // Exit is a generation-scoped event. A child killed during restart can
    // report its exit after the replacement has occupied the same name; that
    // stale event must never delete or crash-restart the replacement.
    if (this.running.get(state.name) !== running) return;
    this.running.delete(state.name);
    const ready = running.pending.get("__ready__");
    if (ready) {
      ready.reject(new Error(this.exitBeforeReadyMessage(state.name, code, running.stderrTail)));
    }
    for (const [requestId, pending] of running.pending) {
      if (requestId === "__ready__") continue;
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Extension ${state.name} exited`));
    }
    if (running.stopping) return;
    if (code === 0 && running.ready) {
      this.rejectReadyWaiters(state.name, extensionNotReadyError(state.name, "Extension exited"));
      this.deps.onStatus(state.name, "stopped", null);
      return;
    }
    this.scheduleCrashRestart(
      state,
      running.ready
        ? `Exited with code ${code ?? "signal"}`
        : this.exitBeforeReadyMessage(state.name, code, running.stderrTail),
    );
  }

  private handleStdout(name: string, level: "info" | "error", chunk: unknown): void {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const inspectorUrl = parseInspectorUrl(trimmed);
      if (inspectorUrl) {
        const running = this.running.get(name);
        if (running) running.inspectorUrl = inspectorUrl;
        this.deps.onInspectorUrl?.(name, inspectorUrl);
        continue;
      }
      if (isInspectorHelpLine(trimmed)) continue;
      if (level === "error") {
        const running = this.running.get(name);
        if (running) {
          running.stderrTail.push(trimmed);
          if (running.stderrTail.length > 20) {
            running.stderrTail.splice(0, running.stderrTail.length - 20);
          }
        }
      }
      this.deps.onLog(name, level, trimmed, undefined, level === "error" ? "stderr" : "stdout");
    }
  }

  private exitBeforeReadyMessage(name: string, code: number | null, stderrTail: string[]): string {
    const base = `Extension ${name} exited before ready (code ${code ?? "signal"})`;
    if (stderrTail.length === 0) return base;
    return `${base}\nRecent stderr:\n${stderrTail.join("\n")}`;
  }

  getRespawn(name: string): { attempts: number; nextAttemptAt: number | null } | null {
    const crashState = this.crashes.get(name);
    return crashState
      ? { attempts: crashState.attempts, nextAttemptAt: crashState.nextAttemptAt }
      : null;
  }

  private scheduleCrashRestart(state: ExtensionProcessState, error: string): void {
    const now = Date.now();
    const current = this.crashes.get(state.name);
    const crashState: CrashState = current && now - current.windowStart <= CRASH_WINDOW_MS
      ? current
      : { attempts: 0, windowStart: now, timer: null, nextAttemptAt: null };
    crashState.attempts += 1;
    if (crashState.timer) {
      clearTimeout(crashState.timer);
      crashState.timer = null;
    }
    this.crashes.set(state.name, crashState);

    if (crashState.attempts >= CRASH_BACKOFF_MS.length) {
      crashState.nextAttemptAt = null;
      this.deps.onStatus(state.name, "error", error);
      this.rejectReadyWaiters(state.name, extensionNotReadyError(state.name, error));
      this.deps.onError?.(state.name, error, crashState.attempts);
      this.deps.onCrashLimit?.(state.name, error, crashState.attempts);
      return;
    }

    const delay = CRASH_BACKOFF_MS[crashState.attempts - 1]!;
    crashState.nextAttemptAt = Date.now() + delay;
    this.deps.onStatus(state.name, "stopped", `${error}; restarting in ${delay}ms`);
    crashState.timer = setTimeout(() => {
      crashState.timer = null;
      crashState.nextAttemptAt = null;
      this.spawn(state).catch((err) => {
        if (this.running.has(state.name)) return;
        this.scheduleCrashRestart(
          state,
          err instanceof Error ? err.message : String(err),
        );
      });
    }, delay);
  }

  private resetCrashState(name: string): void {
    const crashState = this.crashes.get(name);
    if (crashState?.timer) clearTimeout(crashState.timer);
    this.crashes.delete(name);
  }

  private resolveReadyWaiters(name: string): void {
    const waiters = this.readyWaiters.get(name);
    if (!waiters) return;
    this.readyWaiters.delete(name);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve();
    }
  }

  private rejectReadyWaiters(name: string, error: Error): void {
    const waiters = this.readyWaiters.get(name);
    if (!waiters) return;
    this.readyWaiters.delete(name);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(error);
    }
  }

  private removeReadyWaiter(name: string, waiter: ReadyWaiter): void {
    const waiters = this.readyWaiters.get(name);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.readyWaiters.delete(name);
  }
}

function extensionNotReadyError(name: string, detail: string): Error {
  const error = new Error(`${detail}: ${name}`) as NodeJS.ErrnoException;
  error.code = "ENOTREADY";
  return error;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Aborted") as NodeJS.ErrnoException;
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function resolveChildRuntimePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(here, "childRuntime.js");
  if (fs.existsSync(dist)) return dist;
  const source = path.join(here, "childRuntime.ts");
  if (fs.existsSync(source)) return source;
  return dist;
}

export function extensionRuntimeExecArgv(): string[] | undefined {
  const execArgv = [...process.execArgv];
  if (extensionInspectorEnabled()) execArgv.push("--inspect=0");
  return execArgv.length > 0 ? execArgv : undefined;
}

function extensionInspectorEnabled(): boolean {
  return process.env["VIBESTUDIO_PROD"] !== "1" && process.env["NODE_ENV"] !== "production";
}

function parseInspectorUrl(line: string): string | null {
  const match = line.match(/\bDebugger listening on (ws:\/\/\S+)/);
  return match?.[1] ?? null;
}

function isInspectorHelpLine(line: string): boolean {
  return line.startsWith("For help, see:");
}
