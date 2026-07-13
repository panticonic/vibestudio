import { AuthError, networkErrorMessage } from "./output.js";
import { serverAuthRouteUrl, serverRpcHttpUrl } from "@vibestudio/shared/connect";
import { isWebRtcCredential, type CliStoredPairing } from "./credentialStore.js";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import type { RpcErrorKind, RpcStreamOptions } from "@vibestudio/rpc";
import {
  RefreshAgentResponseSchema,
  RefreshShellResponseSchema,
} from "@vibestudio/service-schemas/auth";
import type { z } from "zod";

/**
 * HTTP RPC client for a paired Vibestudio server.
 *
 * Auth flow: the long-lived device credential (deviceId + refreshToken) is
 * exchanged at `/_r/s/auth/refresh-shell` for a short-lived shell token,
 * which authorizes `POST /rpc` Bearer calls. Shell tokens are cached
 * in-process per (url, deviceId); a 401 from `/rpc` triggers exactly one
 * refresh + retry before failing with an AuthError.
 */

export interface DeviceCredential {
  schemaVersion: 3;
  kind: "device";
  url: string;
  workspaceName: string;
  serverId: string;
  deviceId: string;
  refreshToken: string;
  controlPairing: CliStoredPairing;
  workspacePairing: CliStoredPairing;
  pairedAt: number;
}

export type RefreshShellResponse = z.infer<typeof RefreshShellResponseSchema>;

/**
 * A raw-token credential: an entity-scoped agent credential
 * `agent:<agentId>:<token>`, typically supplied via `VIBESTUDIO_AGENT_TOKEN`.
 * The `agent:` token IS the auth; there is no
 * refresh-shell device exchange; WS/WebRTC auth and the HTTP `/refresh-agent`
 * bearer exchange all use it verbatim.
 */
export interface RawTokenCredential {
  url: string;
  token: string;
  workspacePairing?: CliStoredPairing;
}

export type RefreshAgentResponse = z.infer<typeof RefreshAgentResponseSchema>;

export type RpcClientCredential =
  | (Pick<DeviceCredential, "url" | "deviceId" | "refreshToken"> &
      Partial<Pick<DeviceCredential, "workspacePairing">>)
  | RawTokenCredential;

/** Shared surface of the persistent WS and WebRTC clients. */
interface PersistentRpcClient {
  callTarget<T = unknown>(targetId: string, method: string, args?: unknown[]): Promise<T>;
  stream(
    targetId: string,
    method: string,
    args?: unknown[],
    options?: RpcStreamOptions
  ): Promise<Response>;
  onEvent(event: string, listener: (payload: unknown, fromId: string) => void): Promise<() => void>;
  onRecovery(
    handler: (kind: "resubscribe" | "cold-recover") => void | Promise<void>
  ): Promise<() => void>;
}

function isRawTokenCredential(creds: RpcClientCredential): creds is RawTokenCredential {
  return typeof (creds as RawTokenCredential).token === "string";
}

/** Extract the `<agentId>` from an `agent:<agentId>:<secret>` token. */
function agentIdFromToken(token: string): string {
  const rest = token.startsWith("agent:") ? token.slice("agent:".length) : token;
  const sep = rest.indexOf(":");
  return sep > 0 ? rest.slice(0, sep) : rest;
}

export function shellCallerId(deviceId: string): string {
  return deviceId.startsWith("shell:") ? deviceId : `shell:${deviceId}`;
}

/** Server-reported RPC failure (HTTP 200 with an `error` body). */
export class RpcError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: string,
    public readonly errorKind: RpcErrorKind = "application"
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function remoteErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const message = typeof body["error"] === "string" ? body["error"] : fallback;
  const code = typeof body["code"] === "string" ? body["code"] : undefined;
  return code ? `${message} [${code}]` : message;
}

function responseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function fetchOrAuthError(url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new AuthError(`cannot reach ${url.origin}: ${networkErrorMessage(error)}`);
  }
}

export async function refreshShell(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken">
): Promise<RefreshShellResponse> {
  const response = await fetchOrAuthError(serverAuthRouteUrl(creds.url, "refresh-shell"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: creds.deviceId, refreshToken: creds.refreshToken }),
  });
  const raw = (await response.json().catch(() => ({}))) as unknown;
  const body = responseRecord(raw);
  if (!response.ok) {
    throw new AuthError(
      remoteErrorMessage(body, `shell refresh failed (${response.status} ${response.statusText})`)
    );
  }
  const parsed = RefreshShellResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AuthError("shell refresh returned a malformed response");
  }
  return parsed.data;
}

/**
 * Exchange an `agent:<agentId>:<token>` credential for a short-lived caller
 * (bearer) token, so HTTP `POST /rpc` works with agent credentials — the HTTP
 * mirror of the WS/WebRTC redeemer (one auth model everywhere, §6.1).
 */
export async function refreshAgent(creds: {
  url: string;
  token: string;
}): Promise<RefreshAgentResponse> {
  const response = await fetchOrAuthError(serverAuthRouteUrl(creds.url, "refresh-agent"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentToken: creds.token }),
  });
  const raw = (await response.json().catch(() => ({}))) as unknown;
  const body = responseRecord(raw);
  if (!response.ok) {
    throw new AuthError(
      remoteErrorMessage(
        body,
        `agent token exchange failed (${response.status} ${response.statusText})`
      )
    );
  }
  const parsed = RefreshAgentResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AuthError("agent token exchange returned a malformed response");
  }
  return parsed.data;
}

// In-process bearer-token cache, keyed per (url, principal) so multiple
// RpcClient instances within one CLI invocation share a token.
const shellTokenCache = new Map<string, string>();

function cacheKey(url: string, principalId: string): string {
  return `${url}#${principalId}`;
}

/** Test hook: drop all cached shell tokens. */
export function clearShellTokenCache(): void {
  shellTokenCache.clear();
}

export class RpcClient {
  private readonly url: string;
  /** Non-null for a raw agent-token credential (`agent:<agentId>:<token>`). */
  private readonly rawToken: string | null;
  private readonly deviceId: string | null;
  private readonly refreshToken: string | null;
  private readonly pairing: CliStoredPairing | undefined;
  /** Envelope self-id + kind. The server re-derives the authenticated caller
   *  from the redeemed token, so these are informational for routing/logging. */
  private callerId: string;
  private readonly callerKind: CallerKind;

  private webRtcClient: Promise<import("./webrtcClient.js").WebRtcRpcClient> | null = null;
  private wsClient: Promise<import("./wsClient.js").WsRpcClient> | null = null;
  private keepPushOpen = false;
  private retainedConnections = 0;

  constructor(creds: RpcClientCredential) {
    this.url = creds.url;
    this.pairing = creds.workspacePairing;
    if (isRawTokenCredential(creds)) {
      this.rawToken = creds.token;
      this.deviceId = null;
      this.refreshToken = null;
      this.callerId = `agent:${agentIdFromToken(creds.token)}`;
      this.callerKind = "agent";
    } else {
      this.rawToken = null;
      this.deviceId = creds.deviceId;
      this.refreshToken = creds.refreshToken;
      this.callerId = shellCallerId(creds.deviceId);
      this.callerKind = "shell";
    }
  }

  /** Result of the most recent shell refresh, if one occurred. */
  lastRefresh: RefreshShellResponse | null = null;

  /** Whether this credential rides WebRTC (a pairing blob is present). */
  private get isWebRtc(): boolean {
    return isWebRtcCredential({ workspacePairing: this.pairing });
  }

  /** The redeemable WS/WebRTC auth token (`agent:…` or `refresh:…`). */
  private authToken(): string {
    if (this.rawToken) return this.rawToken;
    const device = this.deviceCredential();
    return `refresh:${device.deviceId}:${device.refreshToken}`;
  }

  /** Cache principal id for bearer tokens (agentId or deviceId). */
  private principalCacheId(): string {
    return this.rawToken ? agentIdFromToken(this.rawToken) : this.deviceCredential().deviceId;
  }

  private deviceCredential(): { deviceId: string; refreshToken: string } {
    if (!this.deviceId || !this.refreshToken) {
      throw new Error("Device credential is unavailable for an agent-token client");
    }
    return { deviceId: this.deviceId, refreshToken: this.refreshToken };
  }

  /**
   * Ensure a token exists (cached or freshly refreshed) and return it.
   * For push transports (WS/WebRTC) the redeemable token IS the auth; for the
   * one-shot HTTP path it is a short-lived bearer (shell or agent).
   */
  async getShellToken(): Promise<string> {
    if (this.rawToken) return this.rawToken;
    if (this.isWebRtc) return this.authToken();
    return await this.ensureBearerToken();
  }

  private async ensureBearerToken(): Promise<string> {
    const cached = shellTokenCache.get(cacheKey(this.url, this.principalCacheId()));
    if (cached) return cached;
    return await this.refreshBearerToken();
  }

  private async refreshBearerToken(): Promise<string> {
    if (this.rawToken) {
      const refresh = await refreshAgent({ url: this.url, token: this.rawToken });
      this.callerId = refresh.callerId || `agent:${refresh.entityId}`;
      shellTokenCache.set(cacheKey(this.url, this.principalCacheId()), refresh.token);
      return refresh.token;
    }
    const device = this.deviceCredential();
    const refresh = await refreshShell({
      url: this.url,
      deviceId: device.deviceId,
      refreshToken: device.refreshToken,
    });
    this.lastRefresh = refresh;
    this.callerId = refresh.callerId;
    shellTokenCache.set(cacheKey(this.url, this.principalCacheId()), refresh.shellToken);
    return refresh.shellToken;
  }

  /** Direct service dispatch: `service.method` on the server dispatcher. */
  async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    return await this.callTarget<T>("main", method, args);
  }

  /** Relay call to a runtime target (worker, DO, panel) by entity/target id. */
  async callTarget<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[] = []
  ): Promise<T> {
    if (this.isWebRtc) {
      return await this.dispatchWebRtc<T>(targetId, method, args);
    }
    return await this.dispatch<T>(targetId, method, args);
  }

  /**
   * `callTarget` over the PERSISTENT push transport (WS, or WebRTC when paired),
   * not the one-shot HTTP path. A subsequent {@link onEvent} on this same client
   * receives pushes the call registers — e.g. `channel subscribe`, whose
   * `channel:message` emits are routed to the subscribing connection. A plain
   * HTTP `callTarget` would register against a transient request connection that
   * never receives emits.
   */
  async callTargetPush<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[] = []
  ): Promise<T> {
    this.keepPushOpen = true;
    const client = await this.persistentClient();
    return await client.callTarget<T>(targetId, method, args);
  }

  async stream(
    targetId: string,
    method: string,
    args: unknown[] = [],
    options?: RpcStreamOptions
  ): Promise<Response> {
    // Push/stream: WebRTC when the credential is a pairing blob, otherwise the
    // persistent loopback/LAN WebSocket (no more "streaming requires WebRTC").
    this.keepPushOpen = true;
    const client = await this.persistentClient();
    return await client.stream(targetId, method, args, options);
  }

  async onEvent(
    event: string,
    listener: (payload: unknown, fromId: string) => void
  ): Promise<() => void> {
    this.keepPushOpen = true;
    const client = await this.persistentClient();
    return await client.onEvent(event, listener);
  }

  async onRecovery(
    handler: (kind: "resubscribe" | "cold-recover") => void | Promise<void>
  ): Promise<() => void> {
    this.keepPushOpen = true;
    const client = await this.persistentClient();
    return await client.onRecovery(handler);
  }

  async close(): Promise<void> {
    const webRtc = this.webRtcClient;
    const ws = this.wsClient;
    this.webRtcClient = null;
    this.wsClient = null;
    if (webRtc) await (await webRtc).close();
    if (ws) await (await ws).close();
  }

  /**
   * Keep the push transport alive across a bounded batch of ordinary calls.
   * Pollers use this so WebRTC pairing/ICE is paid once per command, not once
   * per poll. The returned async release is idempotent and closes when the last
   * batch holder leaves (unless an event subscriber owns the connection).
   */
  retainConnection(): () => Promise<void> {
    this.retainedConnections += 1;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.retainedConnections = Math.max(0, this.retainedConnections - 1);
      if (this.retainedConnections === 0 && !this.keepPushOpen) {
        await this.close().catch(() => undefined);
      }
    };
  }

  /** Build an `RpcEnvelope` and POST it to the envelope-native `/rpc`. */
  private async dispatch<T>(targetId: string, method: string, args: unknown[]): Promise<T> {
    const token = await this.ensureBearerToken();
    const requestId =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const caller = { callerId: this.callerId, callerKind: this.callerKind };
    const envelope = {
      from: caller.callerId,
      target: targetId,
      delivery: { caller },
      provenance: [caller],
      message: { type: "request", requestId, fromId: caller.callerId, method, args },
    };
    return await this.post<T>(envelope, token);
  }

  private async post<T>(body: Record<string, unknown>, initialToken?: string): Promise<T> {
    let token = initialToken ?? (await this.ensureBearerToken());
    let response = await this.postRpc(token, body);
    if (response.status === 401) {
      // Bearer token expired or server restarted — refresh once and retry.
      shellTokenCache.delete(cacheKey(this.url, this.principalCacheId()));
      token = await this.refreshBearerToken();
      response = await this.postRpc(token, body);
      if (response.status === 401) {
        const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        throw new AuthError(remoteErrorMessage(errorBody, "unauthorized after token refresh"));
      }
    }
    const raw = responseRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      throw new RpcError(
        typeof raw["error"] === "string"
          ? (raw["error"] as string)
          : `rpc failed (${response.status} ${response.statusText})`
      );
    }
    // The current HTTP RPC contract is one raw response envelope.
    const message = raw["message"] as
      | {
          type?: unknown;
          result?: unknown;
          error?: unknown;
          errorCode?: unknown;
          errorKind?: unknown;
        }
      | undefined;
    if (!message || message.type !== "response") {
      throw new RpcError("malformed rpc response (non-envelope or proxy response?)");
    }
    if (typeof message.error === "string") {
      if (!isRpcErrorKind(message.errorKind)) {
        throw new RpcError(
          "malformed rpc error response (missing errorKind)",
          undefined,
          "protocol"
        );
      }
      throw new RpcError(
        message.error,
        typeof message.errorCode === "string" ? message.errorCode : undefined,
        message.errorKind
      );
    }
    if (!("result" in message)) {
      throw new RpcError("malformed rpc response (no result)");
    }
    return message.result as T;
  }

  private postRpc(token: string, body: Record<string, unknown>): Promise<Response> {
    return fetchOrAuthError(serverRpcHttpUrl(this.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  private async dispatchWebRtc<T>(targetId: string, method: string, args: unknown[]): Promise<T> {
    const client = await this.ensureWebRtcClient();
    try {
      return targetId === "main"
        ? await client.call<T>(method, args)
        : await client.callTarget<T>(targetId, method, args);
    } catch (error) {
      throw toRpcError(error);
    } finally {
      if (!this.keepPushOpen && this.retainedConnections === 0) {
        await this.close().catch(() => undefined);
      }
    }
  }

  private ensureWebRtcClient(): Promise<import("./webrtcClient.js").WebRtcRpcClient> {
    if (!this.pairing) {
      throw new Error("Stored credential does not contain WebRTC pairing material");
    }
    if (!this.webRtcClient) {
      const pairing = this.pairing;
      this.webRtcClient = import("./webrtcClient.js")
        .then(({ WebRtcRpcClient }) => {
          return new WebRtcRpcClient({
            pairing,
            callerId: this.callerId,
            callerKind: this.callerKind,
            getToken: () => this.authToken(),
            clientLabel: "Vibestudio CLI",
            onPaired: () => undefined,
          });
        })
        .catch((error) => {
          this.webRtcClient = null;
          throw error;
        });
    }
    return this.webRtcClient;
  }

  /** Select the credential's one persistent push/stream transport. */
  private persistentClient(): Promise<PersistentRpcClient> {
    return this.isWebRtc ? this.ensureWebRtcClient() : this.ensureWsClient();
  }

  private ensureWsClient(): Promise<import("./wsClient.js").WsRpcClient> {
    if (!this.wsClient) {
      this.wsClient = import("./wsClient.js")
        .then(({ WsRpcClient }) => {
          return new WsRpcClient({
            url: this.url,
            callerId: this.callerId,
            callerKind: this.callerKind,
            getToken: () => this.authToken(),
            clientLabel: "Vibestudio CLI",
          });
        })
        .catch((error) => {
          this.wsClient = null;
          throw error;
        });
    }
    return this.wsClient;
  }
}

function toRpcError(error: unknown): Error {
  if (error instanceof RpcError || error instanceof AuthError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code?: string }).code
      : undefined;
  const kind = isRpcErrorKind((error as { errorKind?: unknown } | null)?.errorKind)
    ? (error as { errorKind: RpcErrorKind }).errorKind
    : "application";
  return new RpcError(message, code, kind);
}

function isRpcErrorKind(value: unknown): value is RpcErrorKind {
  return (
    value === "access" ||
    value === "service" ||
    value === "transport" ||
    value === "protocol" ||
    value === "application" ||
    value === "internal"
  );
}
