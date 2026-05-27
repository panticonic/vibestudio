import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { webContents } from "electron";
import { createDevLogger } from "@natstack/dev-log";
import type { ViewManager } from "./viewManager.js";

const log = createDevLogger("CdpHostProvider");

export interface CdpHostProviderSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open" | "close", listener: () => void): this;
  on(event: "message", listener: (data: Buffer | string) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  off?(event: "open" | "close", listener: () => void): this;
  off?(event: "message", listener: (data: Buffer | string) => void): this;
  off?(event: "error", listener: (error: unknown) => void): this;
}

export interface CdpHostProviderTarget {
  targetId: string;
  webContentsId: number;
}

export interface CdpHostProviderOptions {
  serverUrl: string;
  authToken: string | (() => string);
  hostConnectionId: string;
  getViewManager: () => ViewManager | null;
  socketFactory?: (url: string) => CdpHostProviderSocket;
  reconnectDelayMs?: number;
  onHostCommand?: (targetId: string, action: string, args: unknown[]) => unknown | Promise<unknown>;
}

interface ProviderMessage {
  type?: string;
  targetId?: string;
  requestId?: string;
  reason?: string;
  action?: string;
  args?: unknown[];
  url?: string;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export class CdpHostProvider {
  private readonly targets = new Map<string, number>();
  private readonly debuggerAttached = new Map<string, boolean>();
  private readonly debuggerAttaching = new Map<string, Promise<void>>();
  private readonly debuggerCommandQueues = new Map<string, Promise<unknown>>();
  private readonly activeCdpTargets = new Set<string>();
  private readonly debuggerEventHandlers = new Map<
    string,
    (event: unknown, method: string, params?: unknown, sessionId?: string) => void
  >();
  private socket: CdpHostProviderSocket | null = null;
  private authenticated = false;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CdpHostProviderOptions) {}

  start(): void {
    this.running = true;
    this.clearReconnectTimer();
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const url = new URL("/api/cdp-host", this.options.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("hostConnectionId", this.options.hostConnectionId);
    const socket: CdpHostProviderSocket =
      this.options.socketFactory?.(url.toString()) ??
      (new WebSocket(url.toString()) as CdpHostProviderSocket);
    this.socket = socket;
    this.authenticated = false;

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "natstack:cdp-auth", token: this.authToken() }));
    });
    socket.on("message", (data: Buffer | string) => {
      this.handleSocketMessage(data).catch((error: unknown) => {
        log.warn(
          `CDP host provider message failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.authenticated = false;
      this.detachAll();
      this.scheduleReconnect();
    });
    socket.on("error", (error: unknown) => {
      log.warn(
        `CDP host provider socket error: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  stop(): void {
    this.running = false;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    socket?.close(1000, "CDP host provider stopped");
    this.detachAll();
  }

  registerTarget(targetId: string, webContentsId: number): void {
    this.targets.set(targetId, webContentsId);
    this.sendRegistration(targetId, webContentsId);
  }

  unregisterTarget(targetId: string): void {
    this.targets.delete(targetId);
    this.activeCdpTargets.delete(targetId);
    this.send({ type: "cdp:unregister", targetId: targetId });
    this.detachDebuggerIfIdle(targetId, this.getTargetContents(targetId), { force: true });
  }

  cleanupPanelAccess(_panelId: string): void {
    // Access grants live on the server-side broker. The Electron provider only
    // owns local webContents registration and debugger lifecycle.
  }

  async getAccessibilityTree(targetId: string): Promise<unknown[]> {
    const contents = this.requireTargetContents(targetId);
    await this.ensureDebuggerAttached(targetId, contents);
    try {
      const result = (await this.sendDebuggerCommand(
        targetId,
        contents,
        "Accessibility.getFullAXTree"
      )) as { nodes?: unknown[] };
      return result.nodes ?? [];
    } finally {
      this.detachDebuggerIfIdle(targetId, contents);
    }
  }

  async handleProviderMessageForTest(message: ProviderMessage): Promise<void> {
    await this.handleProviderMessage(message);
  }

  private async handleSocketMessage(data: Buffer | string): Promise<void> {
    const message = JSON.parse(data.toString()) as ProviderMessage;
    if (message.type === "natstack:cdp-auth-ok") {
      this.authenticated = true;
      this.registerAllTargets();
      return;
    }
    await this.handleProviderMessage(message);
  }

  private async handleProviderMessage(message: ProviderMessage): Promise<void> {
    switch (message.type) {
      case "cdp:command":
        await this.handleCdpCommand(message);
        return;
      case "cdp:detach":
        if (typeof message.targetId === "string") {
          this.activeCdpTargets.delete(message.targetId);
          this.detachDebuggerIfIdle(message.targetId, this.getTargetContents(message.targetId), {
            force: true,
          });
        }
        return;
      case "cdp:register-rejected":
        if (typeof message.targetId === "string") {
          log.warn(`Broker rejected CDP target registration: ${message.targetId}`);
          if (message.reason === "unknown_panel") {
            const contents = this.getTargetContents(message.targetId);
            this.targets.delete(message.targetId);
            this.activeCdpTargets.delete(message.targetId);
            this.detachDebuggerIfIdle(message.targetId, contents, { force: true });
          }
        }
        return;
      case "nav:command":
        await this.handleNavCommand(message);
        return;
      case "host:command":
        await this.handleHostCommand(message);
        return;
      default:
        return;
    }
  }

  private async handleNavCommand(message: ProviderMessage): Promise<void> {
    const { targetId, requestId, action } = message;
    if (!targetId || !requestId || !action) return;
    try {
      const contents = this.requireTargetContents(targetId);
      switch (action) {
        case "navigate": {
          if (typeof message.url !== "string" || !message.url) {
            throw new Error("Navigation URL is required");
          }
          try {
            await contents.loadURL(message.url);
          } catch (error) {
            if (isNavigationAbort(error)) break;
            throw error;
          }
          break;
        }
        case "reload":
          contents.reload();
          break;
        case "goBack":
          contents.goBack();
          break;
        case "goForward":
          contents.goForward();
          break;
        case "stop":
          contents.stop();
          break;
        default:
          throw new Error(`Unknown navigation command: ${action}`);
      }
      this.send({ type: "nav:result", targetId, requestId });
    } catch (error) {
      this.send({
        type: "nav:error",
        targetId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleHostCommand(message: ProviderMessage): Promise<void> {
    const { targetId, requestId, action } = message;
    if (!targetId || !requestId || !action) return;
    try {
      const args = Array.isArray(message.args) ? message.args : [];
      const result = this.options.onHostCommand
        ? await this.options.onHostCommand(targetId, action, args)
        : await this.handleBuiltInHostCommand(targetId, action, args);
      this.send({ type: "host:result", targetId, requestId, result });
    } catch (error) {
      this.send({
        type: "host:error",
        targetId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleBuiltInHostCommand(
    targetId: string,
    action: string,
    args: unknown[]
  ): Promise<unknown> {
    if (action === "openDevTools") {
      const mode = args[0] === "right" || args[0] === "bottom" ? args[0] : "detach";
      this.options.getViewManager()?.openDevTools(targetId, mode);
      return null;
    }
    if (action === "accessibilityTree") {
      return this.getAccessibilityTree(targetId);
    }
    throw new Error(`Unknown host command: ${action}`);
  }

  private async handleCdpCommand(message: ProviderMessage): Promise<void> {
    const { targetId, requestId, method } = message;
    if (!targetId || !requestId || !method) return;
    try {
      const contents = this.requireTargetContents(targetId);
      await this.ensureDebuggerAttached(targetId, contents);
      this.activeCdpTargets.add(targetId);
      const result = await this.sendDebuggerCommand(
        targetId,
        contents,
        method,
        message.params,
        message.sessionId
      );
      this.send({ type: "cdp:result", targetId, requestId, result });
    } catch (error) {
      this.send({
        type: "cdp:error",
        targetId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private registerAllTargets(): void {
    for (const [targetId, webContentsId] of this.targets) {
      this.sendRegistration(targetId, webContentsId);
    }
  }

  private sendRegistration(targetId: string, webContentsId: number): void {
    if (!this.authenticated) return;
    this.send({ type: "cdp:register", targetId: targetId, tabId: webContentsId });
  }

  private getTargetContents(targetId: string): Electron.WebContents | null {
    const fromView = this.options.getViewManager()?.getWebContents(targetId);
    if (fromView && !fromView.isDestroyed()) return fromView;
    const id = this.targets.get(targetId);
    if (id === undefined) return null;
    const fromId = webContents.fromId(id);
    return fromId && !fromId.isDestroyed() ? fromId : null;
  }

  private requireTargetContents(targetId: string): Electron.WebContents {
    const contents = this.getTargetContents(targetId);
    if (!contents || contents.isDestroyed()) {
      throw new Error(`Panel webContents not found: ${targetId}`);
    }
    return contents;
  }

  private async ensureDebuggerAttached(
    targetId: string,
    contents: Electron.WebContents
  ): Promise<void> {
    if (this.debuggerAttached.get(targetId)) return;
    const existing = this.debuggerAttaching.get(targetId);
    if (existing) {
      await existing;
      return;
    }
    const attachPromise = (async () => {
      try {
        contents.debugger.attach("1.3");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already.*attach/i.test(message)) {
          throw error;
        }
        // Already attached by this process or another cooperating caller.
      }
      this.debuggerAttached.set(targetId, true);
    })();
    this.debuggerAttaching.set(targetId, attachPromise);
    try {
      await attachPromise;
    } finally {
      this.debuggerAttaching.delete(targetId);
    }

    if (this.debuggerEventHandlers.has(targetId)) return;
    const handler = (_event: unknown, method: string, params?: unknown, sessionId?: string) => {
      this.send({
        type: "cdp:event",
        targetId: targetId,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      });
    };
    this.debuggerEventHandlers.set(targetId, handler);
    const debuggerEmitter = contents.debugger as unknown as EventEmitter;
    debuggerEmitter.on("message", handler);
  }

  private sendDebuggerCommand(
    targetId: string,
    contents: Electron.WebContents,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    const previous = this.debuggerCommandQueues.get(targetId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => {
        if (contents.isDestroyed()) {
          throw new Error(`Panel webContents destroyed: ${targetId}`);
        }
        return contents.debugger.sendCommand(method, params, sessionId);
      });
    const tail = run.finally(() => {
      if (this.debuggerCommandQueues.get(targetId) === tail) {
        this.debuggerCommandQueues.delete(targetId);
      }
    });
    this.debuggerCommandQueues.set(targetId, tail);
    return run;
  }

  private detachDebuggerIfIdle(
    targetId: string,
    contents: Electron.WebContents | null | undefined,
    opts: { force?: boolean } = {}
  ): void {
    if (!this.debuggerAttached.get(targetId)) return;
    if (!opts.force && this.activeCdpTargets.has(targetId)) return;
    try {
      if (contents && !contents.isDestroyed() && opts.force) {
        contents.debugger.detach();
      } else if (contents && !contents.isDestroyed() && !opts.force) {
        contents.debugger.detach();
      }
    } catch {
      // Already detached.
    } finally {
      const handler = this.debuggerEventHandlers.get(targetId);
      if (handler && contents && !contents.isDestroyed()) {
        (contents.debugger as unknown as EventEmitter).off("message", handler);
      }
      this.debuggerEventHandlers.delete(targetId);
      this.debuggerAttached.delete(targetId);
      this.debuggerAttaching.delete(targetId);
      this.debuggerCommandQueues.delete(targetId);
      if (opts.force) this.activeCdpTargets.delete(targetId);
    }
  }

  private detachAll(): void {
    for (const targetId of this.debuggerAttached.keys()) {
      this.detachDebuggerIfIdle(targetId, this.getTargetContents(targetId), { force: true });
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private authToken(): string {
    return typeof this.options.authToken === "function"
      ? this.options.authToken()
      : this.options.authToken;
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delayMs = this.options.reconnectDelayMs ?? 1_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.start();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function isNavigationAbort(error: unknown): boolean {
  const record = error as { code?: unknown; errno?: unknown; message?: unknown };
  return (
    record?.errno === -3 ||
    record?.code === "ERR_ABORTED" ||
    (typeof record?.message === "string" && record.message.includes("ERR_ABORTED"))
  );
}
