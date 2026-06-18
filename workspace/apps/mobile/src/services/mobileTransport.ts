/**
 * Mobile RPC client for React Native.
 */

import {
  createRpcClient,
  type RpcCallOptions,
  type RpcClient,
  type RpcConnectionStatus,
  type RpcEventContext,
} from "@natstack/rpc";
import type { WsLike } from "@natstack/rpc/protocol/wsAdapter";
import type { RecoveryKind } from "@natstack/rpc/protocol/recoveryCoordinator";
import { serverRpcWsUrl } from "@natstack/shared/connect";
import { createServerWsTransport } from "@natstack/shared/shell/transport/serverWsTransport";
import { isWorkspaceMobileAppCallerId, isWorkspaceMobileHostCallerId } from "./auth";

function smokePhase(phase: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[NatStackMobileSmoke] phase=${phase}${suffix}`);
}

export type ConnectionStatus = RpcConnectionStatus;

export interface MobileConnectionGrant {
  connectionGrant: string;
  callerId: string;
}

export interface MobileRpcClientConfig {
  /** Server URL, e.g. "https://natstack.example.com" or "http://192.168.1.5:3000" */
  serverUrl: string;
  /** Mint a fresh one-time app-scoped connection grant from the native host. */
  issueConnectionGrant: () => Promise<MobileConnectionGrant>;
  initialConnectionRetry?: {
    maxMs?: number;
    delayMs?: number;
    maxDelayMs?: number;
  };
}

export function createMobileRpcClient(config: MobileRpcClientConfig): MobileRpcClient {
  return new MobileRpcClient(config);
}

class BrowserWsLike implements WsLike {
  constructor(
    private readonly ws: WebSocket,
    private readonly url: string
  ) {}
  get readyState(): number {
    return this.ws.readyState;
  }
  get onopen(): (() => void) | null {
    return this.ws.onopen as (() => void) | null;
  }
  set onopen(handler: (() => void) | null) {
    this.ws.onopen = (() => {
      smokePhase("workspace-ws-opened", { url: this.url });
      handler?.();
    }) as WebSocket["onopen"];
  }
  get onmessage(): ((event: { data: unknown }) => void) | null {
    return this.ws.onmessage as ((event: { data: unknown }) => void) | null;
  }
  set onmessage(handler: ((event: { data: unknown }) => void) | null) {
    this.ws.onmessage = ((event: { data: unknown }) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (data.includes('"type":"ws:auth-result"')) {
        try {
          const parsed = JSON.parse(data) as { success?: unknown; error?: unknown };
          smokePhase("workspace-ws-auth-result", {
            success: parsed.success === true,
            ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
          });
        } catch {
          smokePhase("workspace-ws-auth-result", { parseError: true });
        }
      }
      handler?.(event);
    }) as unknown as WebSocket["onmessage"];
  }
  get onclose(): ((event: { code?: number; reason?: string }) => void) | null {
    return this.ws.onclose as ((event: { code?: number; reason?: string }) => void) | null;
  }
  set onclose(handler: ((event: { code?: number; reason?: string }) => void) | null) {
    this.ws.onclose = ((event: { code?: number; reason?: string }) => {
      smokePhase("workspace-ws-close", {
        code: event.code ?? null,
        reason: event.reason ?? "",
      });
      handler?.(event);
    }) as unknown as WebSocket["onclose"];
  }
  get onerror(): ((event: unknown) => void) | null {
    return this.ws.onerror as ((event: unknown) => void) | null;
  }
  set onerror(handler: ((event: unknown) => void) | null) {
    this.ws.onerror = ((event: unknown) => {
      smokePhase("workspace-ws-error", describeWebSocketEvent(event));
      handler?.(event);
    }) as unknown as WebSocket["onerror"];
  }
  send(data: string): void {
    this.ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

function describeWebSocketEvent(event: unknown): Record<string, unknown> {
  if (event instanceof Error) return { message: event.message };
  if (!event || typeof event !== "object") return { type: typeof event };
  const maybe = event as { message?: unknown; type?: unknown; code?: unknown; reason?: unknown };
  return {
    ...(typeof maybe.type === "string" ? { type: maybe.type } : {}),
    ...(typeof maybe.message === "string" ? { message: maybe.message } : {}),
    ...(typeof maybe.code === "number" ? { code: maybe.code } : {}),
    ...(typeof maybe.reason === "string" ? { reason: maybe.reason } : {}),
  };
}

type MobileWsTransport = ReturnType<typeof createServerWsTransport>;

/** Max consecutive re-minted connection grants before giving up (re-pair needed). */
const MAX_GRANT_RETRIES = 8;

export class MobileRpcClient implements Pick<
  RpcClient,
  "selfId" | "call" | "emit" | "on" | "stream"
> {
  private config: MobileRpcClientConfig;
  private transport: MobileWsTransport | null = null;
  private rpc: RpcClient | null = null;
  private currentCallerId: string | null = null;
  private preissuedGrant: string | null = null;
  // Connection grants are one-time + short-TTL (server-side). If one is rejected
  // (close 4006), we re-mint a fresh native grant and let the transport retry
  // rather than terminating — this survives webview restarts and expired grants.
  // Bounded so a genuinely-bad credential surfaces instead of looping forever;
  // reset to 0 on every successful (re)auth (see onRecovery in createTransport).
  private grantRetryCount = 0;
  private statusState: ConnectionStatus = "disconnected";
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly recoveryListeners = new Map<RecoveryKind, Set<() => void | Promise<void>>>();
  private readonly eventSubscriptions = new Map<string, Set<(event: RpcEventContext) => void>>();
  private readonly activeEventUnsubs = new Map<string, () => void>();

  constructor(config: MobileRpcClientConfig) {
    this.config = config;
  }

  get selfId(): string {
    return this.currentCallerId ?? "app:mobile:pending";
  }

  get status(): ConnectionStatus {
    return this.transport?.status?.() ?? this.statusState;
  }

  connect(): void {
    this.setStatus("connecting");
    void this.ensureRpc()
      .then(() => this.transport?.connect())
      .catch((error) => {
        console.warn("[MobileRpcClient] Failed to initialize mobile host principal:", error);
        this.setStatus("disconnected");
      });
  }

  async connectAndWait(timeoutMs?: number | null): Promise<void> {
    this.setStatus("connecting");
    try {
      await this.connectAndWaitWithRetry(timeoutMs);
    } catch (error) {
      console.warn("[MobileRpcClient] Failed to connect mobile RPC transport:", error);
      this.setStatus("disconnected");
      throw error;
    }
  }

  reconnect(): void {
    void this.transport?.close().finally(() => {
      this.transport = null;
      this.rpc = null;
      this.connect();
    });
  }

  disconnect(): void {
    if (!this.transport) {
      this.setStatus("disconnected");
      return;
    }
    void this.transport.close();
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  updateConfig(config: MobileRpcClientConfig): void {
    this.config = config;
    void this.transport?.close();
    this.transport = null;
    this.rpc = null;
    this.currentCallerId = null;
    this.preissuedGrant = null;
    this.activeEventUnsubs.clear();
    this.setStatus("disconnected");
  }

  async call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<T> {
    return (await this.ensureRpc()).call<T>(targetId, method, args, options);
  }

  async stream(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal }
  ): Promise<Response> {
    return (await this.ensureRpc()).stream(targetId, method, args, options);
  }

  async emit(targetId: string, event: string, payload: unknown): Promise<void> {
    return (await this.ensureRpc()).emit(targetId, event, payload);
  }

  on(event: string, listener: (event: RpcEventContext) => void): () => void {
    let listeners = this.eventSubscriptions.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventSubscriptions.set(event, listeners);
    }
    listeners.add(listener);
    this.attachEventSubscription(event);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.eventSubscriptions.delete(event);
        this.activeEventUnsubs.get(event)?.();
        this.activeEventUnsubs.delete(event);
      }
    };
  }

  onReconnect(listener: () => void): () => void {
    return this.onRecovery("resubscribe", listener);
  }

  onRecovery(kind: RecoveryKind, listener: () => void | Promise<void>): () => void {
    let listeners = this.recoveryListeners.get(kind);
    if (!listeners) {
      listeners = new Set();
      this.recoveryListeners.set(kind, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
    };
  }

  private async ensureRpc(): Promise<RpcClient> {
    if (this.rpc) return this.rpc;
    const grant = await this.issueNativeGrant();
    this.currentCallerId = grant.callerId;
    this.preissuedGrant = grant.connectionGrant;
    this.transport = this.createTransport(grant.callerId);
    this.rpc = createRpcClient({
      selfId: grant.callerId,
      callerKind: isWorkspaceMobileAppCallerId(grant.callerId) ? "app" : "shell-remote",
      transport: this.transport,
    });
    for (const event of this.eventSubscriptions.keys()) this.attachEventSubscription(event);
    return this.rpc;
  }

  private async connectAndWaitWithRetry(timeoutMs?: number | null): Promise<void> {
    const retry = this.config.initialConnectionRetry ?? {};
    const startedAt = Date.now();
    const maxMs =
      typeof timeoutMs === "number"
        ? timeoutMs
        : typeof retry.maxMs === "number"
          ? retry.maxMs
          : 120_000;
    const deadline = startedAt + maxMs;
    const baseDelayMs =
      typeof retry.delayMs === "number" && retry.delayMs >= 0 ? retry.delayMs : 750;
    const maxDelayMs =
      typeof retry.maxDelayMs === "number" && retry.maxDelayMs >= 0 ? retry.maxDelayMs : 5_000;
    const perAttemptTimeoutMs =
      typeof timeoutMs === "number" ? Math.min(timeoutMs, 15_000) : 15_000;
    let attempt = 0;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      attempt += 1;
      this.setStatus("connecting");
      await this.ensureRpc();
      try {
        await this.transport?.connectAndWait(perAttemptTimeoutMs);
        if (attempt > 1) {
          smokePhase("workspace-ws-retry-connected", { attempt });
        }
        return;
      } catch (error) {
        lastError = error;
        await this.resetTransportAfterFailedInitialConnection();
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const delayMs = Math.min(
          baseDelayMs * 2 ** Math.max(0, attempt - 1),
          maxDelayMs,
          remainingMs
        );
        smokePhase("workspace-ws-retry", {
          attempt,
          delayMs,
          message: errorMessage(error),
        });
        console.warn(
          `[MobileRpcClient] Initial WebSocket connection failed; retrying in ${delayMs}ms`,
          error
        );
        await sleep(delayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(
          `Server WS connection timeout (${maxMs}ms): ${buildWsUrl(this.config.serverUrl)}`
        );
  }

  private async resetTransportAfterFailedInitialConnection(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.rpc = null;
    this.preissuedGrant = null;
    // The caller-principal pin is scoped to a single connection lifetime. A failed initial connect
    // tears that lifetime down, so clear it (as updateConfig does) — otherwise the fresh native
    // grant minted on retry is wrongly rejected as a "different principal".
    this.currentCallerId = null;
    this.activeEventUnsubs.clear();
    await transport?.close().catch(() => undefined);
  }

  private async issueNativeGrant(): Promise<MobileConnectionGrant> {
    const grant = await this.config.issueConnectionGrant();
    if (
      typeof grant.connectionGrant !== "string" ||
      !grant.connectionGrant ||
      typeof grant.callerId !== "string" ||
      !isWorkspaceMobileHostCallerId(grant.callerId)
    ) {
      throw new Error("Native host returned an invalid mobile host connection grant");
    }
    if (this.currentCallerId && grant.callerId !== this.currentCallerId) {
      throw new Error("Native host returned a different mobile host principal for this connection");
    }
    smokePhase("workspace-grant-issued", { callerId: grant.callerId });
    return grant;
  }

  private async nextGrantToken(): Promise<string> {
    const preissued = this.preissuedGrant;
    if (preissued) {
      this.preissuedGrant = null;
      return preissued;
    }
    // Re-mint path: the one-time preissued grant was consumed, so this is a
    // (re)connect/refresh. Bound it so a genuinely-rejected credential stops
    // looping (the transport surfaces the failure instead of retrying forever).
    if (this.grantRetryCount >= MAX_GRANT_RETRIES) {
      throw new Error(
        `Mobile connection grant rejected ${this.grantRetryCount}x; giving up — re-pair this device`
      );
    }
    this.grantRetryCount += 1;
    return (await this.issueNativeGrant()).connectionGrant;
  }

  private createTransport(callerId: string): MobileWsTransport {
    const wsUrl = buildWsUrl(this.config.serverUrl);
    smokePhase("workspace-ws-url", { url: wsUrl });
    const transport = createServerWsTransport({
      selfId: callerId,
      serverUrl: this.config.serverUrl,
      // 4006 (auth/invalid-token) is intentionally NOT terminal: the transport
      // refreshes the auth token (re-mints a one-time grant via nextGrantToken)
      // and reconnects, so a consumed/expired grant or a webview restart recovers
      // instead of dead-ending. nextGrantToken bounds the retries. 4001/4005 stay
      // terminal (session replaced / version mismatch — a fresh grant won't help).
      terminalCloseCodes: [4001, 4005],
      logPrefix: "MobileRpcClient",
      onServerEvent: (event, payload) => this.dispatchServerEvent(event, payload),
      onRecovery: (kind) => {
        // A successful (re)auth happened — clear the re-mint budget.
        this.grantRetryCount = 0;
        for (const listener of this.recoveryListeners.get(kind) ?? []) {
          void listener();
        }
      },
      adapter: {
        now: () => Date.now(),
        getAuthToken: () => this.nextGrantToken(),
        refreshAuthToken: () => this.nextGrantToken(),
        createSocket: (url) => {
          smokePhase("workspace-ws-create", { url });
          return new BrowserWsLike(new WebSocket(url), url);
        },
      },
    });
    transport.onStatusChange?.((status) => this.setStatus(status));
    return transport;
  }

  private dispatchServerEvent(event: string, payload: unknown): void {
    const context: RpcEventContext = {
      caller: { callerId: "main", callerKind: "server" },
      origin: { callerId: "main", callerKind: "server" },
      event,
      payload,
    };
    for (const listener of this.eventSubscriptions.get(event) ?? []) listener(context);
  }

  private attachEventSubscription(event: string): void {
    if (!this.rpc || this.activeEventUnsubs.has(event)) return;
    const unsubscribe = this.rpc.on(event, (ev) => {
      for (const listener of this.eventSubscriptions.get(event) ?? []) listener(ev);
    });
    this.activeEventUnsubs.set(event, unsubscribe);
  }

  private setStatus(status: ConnectionStatus): void {
    this.statusState = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildWsUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error(`Invalid server URL: ${serverUrl}`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid server URL: ${serverUrl}`);
  }
  return serverRpcWsUrl(url);
}
