import { createProcessAdapter, type ProcessAdapter } from "@vibestudio/process-adapter";
import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import { createNativeChildEnvironment } from "@vibestudio/shared/nativeProcessEnvironment";

export interface TerminalAppLaunch {
  appId: string;
  source: string;
  buildKey: string;
  executionDigest: string;
  gatewayUrl: string;
  entryPath: string;
  /**
   * Interactive (TUI) apps get the server's real terminal via stdio "inherit"
   * (stdin/stdout/stderr) instead of piped capture. Required for apps that
   * render a full-screen UI and read raw keystrokes (e.g. terminal-browser).
   * Only yields a usable TTY when the server runs attached to a terminal.
   */
  interactive?: boolean;
}

export interface TerminalAppRunnerDeps {
  connectionGrants: Pick<ConnectionGrantService, "grant" | "revokeForPrincipal">;
  onStatus(appId: string, status: "running" | "stopped" | "error", error?: string | null): void;
  onLog(
    appId: string,
    level: "info" | "error",
    message: string,
    source: "stdout" | "stderr" | "runner"
  ): void;
}

interface RunningTerminalApp {
  launch: TerminalAppLaunch;
  proc: ProcessAdapter;
  stopping: boolean;
  exitHandler: (code: number | null) => void;
}

const TERMINAL_APP_CONNECTION_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export class TerminalAppRunner {
  private readonly running = new Map<string, RunningTerminalApp>();
  private readonly starts = new Map<string, { buildKey: string; promise: Promise<void> }>();

  constructor(private readonly deps: TerminalAppRunnerDeps) {}

  isRunning(appId: string): boolean {
    return this.running.has(appId);
  }

  isRunningBuild(appId: string, buildKey: string): boolean {
    const running = this.running.get(appId);
    return !!running && !running.stopping && running.launch.buildKey === buildKey;
  }

  async start(launch: TerminalAppLaunch, options: { forceRestart?: boolean } = {}): Promise<void> {
    if (!options.forceRestart && this.isRunningBuild(launch.appId, launch.buildKey)) return;
    const inFlight = this.starts.get(launch.appId);
    if (!options.forceRestart && inFlight?.buildKey === launch.buildKey) {
      await inFlight.promise;
      return;
    }
    if (inFlight) await inFlight.promise.catch(() => undefined);
    const promise = this.startOnce(launch);
    const tracked = { buildKey: launch.buildKey, promise };
    this.starts.set(launch.appId, tracked);
    try {
      await promise;
    } finally {
      if (this.starts.get(launch.appId) === tracked) this.starts.delete(launch.appId);
    }
  }

  private async startOnce(launch: TerminalAppLaunch): Promise<void> {
    await this.stop(launch.appId, "restart");
    const rpcGrant = this.deps.connectionGrants.grant(
      launch.appId,
      "server",
      TERMINAL_APP_CONNECTION_GRANT_TTL_MS
    );
    const connectionId = `terminal:${launch.appId}:${launch.buildKey}`;
    const childEnvironment = createNativeChildEnvironment({
      purpose: "terminal",
      declared: {
        VIBESTUDIO_TERMINAL_APP_ID: launch.appId,
        VIBESTUDIO_TERMINAL_APP_SOURCE: launch.source,
        VIBESTUDIO_TERMINAL_APP_BUILD_KEY: launch.buildKey,
        VIBESTUDIO_TERMINAL_APP_EXECUTION_DIGEST: launch.executionDigest,
        VIBESTUDIO_TERMINAL_APP_GATEWAY_URL: launch.gatewayUrl,
        VIBESTUDIO_TERMINAL_APP_CONNECTION_ID: connectionId,
      },
      purposeCredential: {
        name: "VIBESTUDIO_TERMINAL_APP_RPC_TOKEN",
        value: rpcGrant.token,
      },
    });
    const proc = createProcessAdapter(launch.entryPath, childEnvironment.env, {
      preferNode: true,
      stdio: launch.interactive ? "inherit" : "pipe",
    });
    const exitHandler = (code: number | null) => this.handleExit(launch.appId, code);
    this.running.set(launch.appId, { launch, proc, stopping: false, exitHandler });
    proc.on("exit", exitHandler);
    // In interactive (inherit) mode the child writes straight to the user's
    // terminal, so stdout/stderr are null here — nothing to capture.
    proc.stdout?.on("data", (chunk) => this.handleOutput(launch.appId, "info", "stdout", chunk));
    proc.stderr?.on("data", (chunk) => this.handleOutput(launch.appId, "error", "stderr", chunk));
    this.deps.onStatus(launch.appId, "running", null);
    this.deps.onLog(launch.appId, "info", `started ${launch.entryPath}`, "runner");
  }

  async stop(appId: string, reason = "stop"): Promise<void> {
    const running = this.running.get(appId);
    this.deps.connectionGrants.revokeForPrincipal(appId);
    if (!running) return;
    running.stopping = true;
    running.proc.postMessage({ type: "shutdown", reason });
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        running.proc.kill();
        settle();
      }, 2_000);
      const onExit = () => settle();
      running.proc.on("exit", onExit);
    });
    running.proc.off("exit", running.exitHandler);
    this.running.delete(appId);
    this.deps.onStatus(appId, "stopped", null);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((appId) => this.stop(appId, "shutdown")));
  }

  private handleExit(appId: string, code: number | null): void {
    const running = this.running.get(appId);
    if (!running) return;
    this.running.delete(appId);
    this.deps.connectionGrants.revokeForPrincipal(appId);
    if (running.stopping) {
      this.deps.onStatus(appId, "stopped", null);
      return;
    }
    const message = `Terminal app exited${code === null ? "" : ` with code ${code}`}`;
    this.deps.onLog(appId, "error", message, "runner");
    this.deps.onStatus(appId, "error", message);
  }

  private handleOutput(
    appId: string,
    level: "info" | "error",
    source: "stdout" | "stderr",
    chunk: unknown
  ): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (const line of text.split(/\r?\n/)) {
      const message = line.trimEnd();
      if (message) this.deps.onLog(appId, level, message, source);
    }
  }
}
