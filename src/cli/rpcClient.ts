import { AuthError, ConnectionError, networkErrorMessage } from "./output.js";
import { serverAuthRouteUrl, serverRpcHttpUrl, serverRpcWsUrl } from "@vibestudio/shared/connect";
import {
  isIrohCredential,
  type CliCredentials,
  type CliDeviceCredentials,
  type CliStoredPairing,
} from "./credentialStore.js";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import { deserializeRpcFailure, decodeRpcJson, encodeRpcJson } from "@vibestudio/rpc";
import type {
  DecodedFramedStream,
  EnvelopeRpcTransport,
  RpcConnectionStatus,
  RpcErrorData,
  RpcErrorKind,
  RpcStreamOptions,
  RpcCallOptions,
} from "@vibestudio/rpc";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import { Agent, type Dispatcher } from "undici";
import {
  RefreshAgentResponseSchema,
  RefreshShellResponseSchema,
} from "@vibestudio/service-schemas/auth";
import { createMainRpcCaller, type MainRpcCaller } from "@vibestudio/service-schemas/mainRpc";
import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import type { z } from "zod";
import {
  requireQualifiedServiceMethod,
  type QualifiedServiceMethod,
} from "@vibestudio/shared/typedServiceClient";

/**
 * HTTP RPC client for a paired Vibestudio server.
 *
 * Auth flow: the long-lived device credential (deviceId + refreshToken) is
 * exchanged at `/_r/s/auth/refresh-shell` for a short-lived shell token,
 * which authorizes `POST /rpc` Bearer calls. Shell tokens are cached
 * in-process per (url, deviceId); a 401 from `/rpc` triggers exactly one
 * refresh + retry before failing with an AuthError.
 */

export type DeviceCredential = CliDeviceCredentials;

export type RefreshShellResponse = z.infer<typeof RefreshShellResponseSchema>;

/**
 * A raw-token credential for internal callers and focused transport tests.
 * Ordinary CLI agent login always uses the canonical persisted agent profile.
 * The `agent:` token IS the auth; there is no
 * refresh-shell device exchange; WS/Iroh auth and the HTTP `/refresh-agent`
 * bearer exchange all use it verbatim.
 */
export interface RawTokenCredential {
  url: string;
  token: string;
  workspacePairing?: CliStoredPairing;
  endpointSecret?: string;
}

export type RefreshAgentResponse = z.infer<typeof RefreshAgentResponseSchema>;

/**
 * One device-authenticated RPC endpoint. Unlike a complete CLI credential,
 * this does not select a workspace and therefore never participates in local
 * workspace routing. It is used for already-resolved HTTP endpoints and for
 * non-workspace Iroh endpoints such as hub control.
 */
export interface DeviceEndpointCredential {
  url: string;
  deviceId: string;
  refreshToken: string;
  pairing?: CliStoredPairing;
  endpointSecret?: string;
}

export type RpcClientCredential = CliCredentials | DeviceEndpointCredential | RawTokenCredential;

/**
 * An authenticated session for another principal of this device, opened over
 * the same transport the CLI already uses (loopback WebSocket or the Iroh
 * connection). Wrap it with `createRpcClient` to act as that principal.
 */
export interface PrincipalTransport extends EnvelopeRpcTransport {
  status(): RpcConnectionStatus;
  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void;
  /** True once the session ended for good (closed locally or terminally by the server). */
  isClosed(): boolean;
  close(): Promise<void>;
}

export interface PrincipalTransportOptions {
  /** Envelope identity; the server derives the authenticated caller from the token. */
  selfId: string;
  /** Redeemable credential for the principal; called for every (re)authentication. */
  getToken(signal?: AbortSignal): Promise<string>;
  clientLabel: string;
  onRecovery?(kind: RecoveryKind): void | Promise<void>;
  /** The server ended the session for good (credential revoked, principal retired). */
  onTerminalClose?(error: Error): void;
  signal?: AbortSignal;
}

/** Shared surface of the persistent local-WebSocket and remote-Iroh clients. */
interface PersistentRpcClient {
  streamReadable(
    targetId: string,
    method: string,
    args?: unknown[],
    options?: RpcStreamOptions
  ): Promise<DecodedFramedStream>;
  callTarget(
    targetId: string,
    method: string,
    args?: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown>;
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

function isAgentCliCredentials(
  creds: RpcClientCredential
): creds is Extract<CliCredentials, { kind: "agent" }> {
  return (creds as Partial<CliCredentials>).kind === "agent";
}

function isCompleteDeviceCredentials(creds: RpcClientCredential): creds is CliDeviceCredentials {
  const candidate = creds as Partial<CliDeviceCredentials>;
  return (
    candidate.schemaVersion === 6 &&
    candidate.phase === "workspace" &&
    candidate.kind === "device" &&
    typeof candidate.workspaceId === "string" &&
    candidate.workspaceId.length > 0 &&
    typeof candidate.workspaceName === "string" &&
    typeof candidate.serverId === "string" &&
    (candidate.transport === "local" ||
      (candidate.transport === "iroh" &&
        candidate.controlPairing !== undefined &&
        candidate.workspacePairing !== undefined))
  );
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
    public readonly errorKind: RpcErrorKind = "application",
    public readonly errorData?: RpcErrorData
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

async function readRpcResponseBody(response: Response): Promise<unknown> {
  try {
    return decodeRpcJson(await response.text());
  } catch {
    return {};
  }
}

function responseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type RpcRequestInit = RequestInit & { dispatcher?: Dispatcher };

async function fetchOrAuthError(url: URL, init: RpcRequestInit): Promise<Response> {
  try {
    return await fetch(url, init as RequestInit);
  } catch (error) {
    init.signal?.throwIfAborted();
    throw new ConnectionError(`cannot reach ${url.origin}: ${networkErrorMessage(error)}`);
  }
}

export async function refreshShell(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken">,
  options: { signal?: AbortSignal } = {}
): Promise<RefreshShellResponse> {
  const response = await fetchOrAuthError(serverAuthRouteUrl(creds.url, "refresh-shell"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: creds.deviceId, refreshToken: creds.refreshToken }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const raw = (await response.json().catch(() => {
    options.signal?.throwIfAborted();
    return {};
  })) as unknown;
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
 * mirror of the WS/Iroh redeemer (one auth model everywhere, §6.1).
 */
export async function refreshAgent(
  creds: {
    url: string;
    token: string;
  },
  options: { signal?: AbortSignal } = {}
): Promise<RefreshAgentResponse> {
  const response = await fetchOrAuthError(serverAuthRouteUrl(creds.url, "refresh-agent"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentToken: creds.token }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const raw = (await response.json().catch(() => {
    options.signal?.throwIfAborted();
    return {};
  })) as unknown;
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
  readonly mainCall: MainRpcCaller;
  private readonly url: string;
  /** Non-null for a raw agent-token credential (`agent:<agentId>:<token>`). */
  private readonly rawToken: string | null;
  private readonly deviceId: string | null;
  private readonly refreshToken: string | null;
  private readonly pairing: CliStoredPairing | undefined;
  /** Hub control reach of a complete Iroh device credential. */
  private readonly controlPairing: CliStoredPairing | undefined = undefined;
  private readonly endpointSecret: string | undefined;
  /** Envelope self-id + kind. The server re-derives the authenticated caller
   *  from the redeemed token, so these are informational for routing/logging. */
  private callerId: string;
  private readonly callerKind: CallerKind;

  private irohClient: Promise<import("../node/iroh/irohRpcClient.js").IrohRpcClient> | null = null;
  private ownsIrohClient = true;
  private releaseEndpointLock: (() => void) | null = null;
  private wsClient: Promise<import("./wsClient.js").WsRpcClient> | null = null;
  private httpDispatcher: Agent | null = null;
  private keepPushOpen = false;
  private retainedConnections = 0;
  private closePromise: Promise<void> | null = null;
  private closeFailure: Promise<void> | null = null;

  private cancellationAttached = false;
  private readonly cancel = () => {
    void this.close().catch(() => undefined);
  };

  constructor(
    creds: RpcClientCredential,
    private readonly owner: { signal?: AbortSignal } = {}
  ) {
    this.url = creds.url;
    if (isAgentCliCredentials(creds)) {
      this.pairing = creds.transport === "iroh" ? creds.workspacePairing : undefined;
      this.endpointSecret = creds.transport === "iroh" ? creds.endpointSecret : undefined;
      this.rawToken = creds.agentToken;
      this.deviceId = null;
      this.refreshToken = null;
      this.callerId = `agent:${creds.entityId}`;
      this.callerKind = "agent";
    } else if (isRawTokenCredential(creds)) {
      this.pairing = creds.workspacePairing;
      this.endpointSecret = creds.endpointSecret;
      this.rawToken = creds.token;
      this.deviceId = null;
      this.refreshToken = null;
      this.callerId = `agent:${agentIdFromToken(creds.token)}`;
      this.callerKind = "agent";
    } else {
      if (isCompleteDeviceCredentials(creds)) {
        this.pairing = creds.transport === "iroh" ? creds.workspacePairing : undefined;
        this.controlPairing = creds.transport === "iroh" ? creds.controlPairing : undefined;
        this.endpointSecret = creds.transport === "iroh" ? creds.endpointSecret : undefined;
      } else {
        this.pairing = creds.pairing;
        this.endpointSecret = creds.endpointSecret;
      }
      this.rawToken = null;
      this.deviceId = creds.deviceId;
      this.refreshToken = creds.refreshToken;
      this.callerId = shellCallerId(creds.deviceId);
      this.callerKind = "shell";
    }
    this.mainCall = createMainRpcCaller(
      schemaRpcCaller({
        call: (target, method, args, options) => this.callTarget(target, method, args, options),
      })
    );
  }

  /** Result of the most recent shell refresh, if one occurred. */
  lastRefresh: RefreshShellResponse | null = null;

  /** Whether this credential rides Iroh (a pairing blob is present). */
  private get isIroh(): boolean {
    return isIrohCredential({ workspacePairing: this.pairing });
  }

  /** The redeemable WS/Iroh auth token (`agent:…` or `refresh:…`). */
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
   * For push transports (WS/Iroh) the redeemable token IS the auth; for the
   * one-shot HTTP path it is a short-lived bearer (shell or agent).
   */
  async getShellToken(): Promise<string> {
    this.assertOpen();
    if (this.rawToken) return this.rawToken;
    if (this.isIroh) return this.authToken();
    return await this.ensureBearerToken();
  }

  private async ensureBearerToken(signal = this.owner.signal): Promise<string> {
    signal?.throwIfAborted();
    const cached = shellTokenCache.get(cacheKey(this.url, this.principalCacheId()));
    if (cached) return cached;
    return await this.refreshBearerToken(signal);
  }

  private async refreshBearerToken(signal = this.owner.signal): Promise<string> {
    if (this.rawToken) {
      const refresh = await refreshAgent({ url: this.url, token: this.rawToken }, { signal });
      this.callerId = refresh.callerId || `agent:${refresh.entityId}`;
      shellTokenCache.set(cacheKey(this.url, this.principalCacheId()), refresh.token);
      return refresh.token;
    }
    const device = this.deviceCredential();
    const refresh = await refreshShell(
      {
        url: this.url,
        deviceId: device.deviceId,
        refreshToken: device.refreshToken,
      },
      { signal }
    );
    this.lastRefresh = refresh;
    this.callerId = refresh.callerId;
    shellTokenCache.set(cacheKey(this.url, this.principalCacheId()), refresh.shellToken);
    return refresh.shellToken;
  }

  /** Direct service dispatch: `service.method` on the server dispatcher. */
  async call(
    method: QualifiedServiceMethod,
    args: unknown[] = [],
    options?: RpcCallOptions
  ): Promise<unknown> {
    return this.callTarget("main", method, args, options);
  }

  /** Relay call to a runtime target (worker, DO, panel) by entity/target id. */
  async callTarget(
    targetId: string,
    method: string,
    args: unknown[] = [],
    options?: RpcCallOptions
  ): Promise<unknown> {
    this.assertOpen();
    options?.signal?.throwIfAborted();
    if (targetId === "main") requireQualifiedServiceMethod(method);
    if (this.isIroh) {
      return await this.dispatchIroh(targetId, method, args, options);
    }
    return await this.dispatch(targetId, method, args, options);
  }

  /**
   * `callTarget` over the PERSISTENT push transport (WS, or Iroh when paired),
   * not the one-shot HTTP path. Use this for unary calls whose peer may issue
   * routed callbacks over the same authenticated connection. Long-lived
   * resources use {@link stream} so the response itself owns their lifetime.
   */
  async callTargetPush(targetId: string, method: string, args: unknown[] = []): Promise<unknown> {
    this.assertOpen();
    if (targetId === "main") requireQualifiedServiceMethod(method);
    this.keepPushOpen = true;
    const client = await this.persistentClient();
    this.assertOpen();
    return await client.callTarget(targetId, method, args);
  }

  async stream(
    targetId: string,
    method: string,
    args: unknown[] = [],
    options?: RpcStreamOptions
  ): Promise<Response> {
    this.assertOpen();
    if (targetId === "main") requireQualifiedServiceMethod(method);
    // Push/stream: Iroh when the credential is a pairing blob, otherwise the
    // persistent loopback/LAN WebSocket (no more "streaming requires Iroh").
    this.keepPushOpen = true;
    const client = await this.persistentClient();
    this.assertOpen();
    return await client.stream(targetId, method, args, options);
  }
  async streamReadable(
    targetId: string,
    method: string,
    args: unknown[] = [],
    options?: RpcStreamOptions
  ): Promise<DecodedFramedStream> {
    this.assertOpen();
    if (targetId === "main") requireQualifiedServiceMethod(method);
    this.keepPushOpen = true;
    const client = await this.persistentClient();
    this.assertOpen();
    return await client.streamReadable(targetId, method, args, options);
  }

  async onEvent(
    event: string,
    listener: (payload: unknown, fromId: string) => void
  ): Promise<() => void> {
    this.assertOpen();
    this.keepPushOpen = true;
    const client = await this.persistentClient();
    this.assertOpen();
    return await client.onEvent(event, listener);
  }

  async onRecovery(
    handler: (kind: "resubscribe" | "cold-recover") => void | Promise<void>
  ): Promise<() => void> {
    this.assertOpen();
    this.keepPushOpen = true;
    const client = await this.persistentClient();
    this.assertOpen();
    return await client.onRecovery(handler);
  }

  /**
   * Open an authenticated session for another principal of this device over
   * this client's transport: a second logical session on the same Iroh
   * connection (so endpoint-bound grants redeem on it), or a WebSocket to the
   * same loopback workspace URL.
   */
  async openPrincipalTransport(options: PrincipalTransportOptions): Promise<PrincipalTransport> {
    this.assertOpen();
    options.signal?.throwIfAborted();
    if (this.isIroh) {
      this.keepPushOpen = true;
      const client = await this.ensureIrohClient();
      this.assertOpen();
      const session = await client.openSession({
        clientLabel: options.clientLabel,
        clientPlatform: "headless",
        getToken: options.getToken,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onRecovery ? { onRecovery: (kind) => options.onRecovery!(kind) } : {}),
        ...(options.onTerminalClose ? { onTerminalClose: options.onTerminalClose } : {}),
      });
      return session;
    }
    const [{ WebSocket }, { wsClientTransport }, { NodeWsLike }] = await Promise.all([
      import("ws"),
      import("@vibestudio/rpc/transports/wsClient"),
      import("@vibestudio/rpc/transports/nodeWsLike"),
    ]);
    options.signal?.throwIfAborted();
    const url = this.url;
    let closing = false;
    const transport = wsClientTransport({
      selfId: options.selfId,
      getWsUrl: () => serverRpcWsUrl(url),
      reconnect: true,
      logPrefix: "[cli-principal-ws]",
      getAuthMessageFields: () => ({
        clientLabel: options.clientLabel,
        clientPlatform: "headless",
        oauthCallbackMode: "client-loopback",
      }),
      ...(options.onRecovery ? { onRecovery: options.onRecovery } : {}),
      adapter: {
        now: () => Date.now(),
        getAuthToken: (signal) => options.getToken(signal),
        createSocket: (socketUrl, protocols) => new NodeWsLike(new WebSocket(socketUrl, protocols)),
      },
    });
    const unsubscribe = transport.onStatusChange!((status) => {
      if (status === "disconnected" && transport.isClosed() && !closing) {
        unsubscribe();
        options.onTerminalClose?.(
          new ConnectionError("the server ended the session (credential revoked or app retired)")
        );
      }
    });
    const closeTransport = transport.close.bind(transport);
    let retirement: Promise<void> | undefined;
    const close = () => {
      closing = true;
      unsubscribe();
      options.signal?.removeEventListener("abort", cancel);
      return (retirement ??= closeTransport());
    };
    const cancel = () => {
      void close().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      await transport.connectAndWait();
      options.signal?.throwIfAborted();
    } catch (error) {
      const failure = options.signal?.aborted ? options.signal.reason : error;
      try {
        await close();
      } catch (cleanup) {
        throw new AggregateError([failure, cleanup], "Principal admission and retirement failed", {
          cause: failure,
        });
      }
      throw failure;
    }
    return Object.assign(transport as typeof transport & PrincipalTransport, {
      close,
    });
  }

  /**
   * A second session for this device's own shell principal over this
   * client's transport, for a client that drives the workspace through
   * `createRpcClient` (the terminal browser's workspace connection).
   */
  async openShellTransport(
    options: Omit<PrincipalTransportOptions, "selfId" | "getToken">
  ): Promise<PrincipalTransport> {
    this.deviceCredential();
    return await this.openPrincipalTransport({
      ...options,
      selfId: this.callerId,
      getToken: async () => this.authToken(),
    });
  }

  /**
   * A device client for another workspace of this account, routed with
   * `selectRemoteWorkspace`, that shares this client's transport: a new
   * loopback client for a local credential, or a second peer dialed from the
   * same Iroh endpoint (binding the endpoint twice is invalid). The caller
   * closes it; this client keeps owning the endpoint.
   */
  async openWorkspaceConnection(routed: CliDeviceCredentials): Promise<RpcClient> {
    this.assertOpen();
    const device = this.deviceCredential();
    if (routed.deviceId !== device.deviceId) {
      throw new Error("A workspace connection must use this client's device credential");
    }
    if (!this.isIroh) return new RpcClient(routed, this.owner);
    if (routed.transport !== "iroh") {
      throw new Error("A workspace route of an Iroh credential must carry Iroh reach");
    }
    const parent = await this.ensureIrohClient();
    this.assertOpen();
    const workspace = new RpcClient(routed, this.owner);
    workspace.irohClient = Promise.resolve(
      parent.peer({
        reach: routed.workspacePairing,
        callerId: this.callerId,
        callerKind: this.callerKind,
        getToken: () => this.authToken(),
        clientLabel: "Vibestudio CLI",
        onPaired: () => undefined,
      })
    );
    // Like the control connection: the peer lives until its owner closes it.
    workspace.keepPushOpen = true;
    return workspace;
  }

  /**
   * A client for the hub control service (workspace listing and routing) that
   * shares this device client's transport: the loopback hub for a local
   * credential, or a second peer dialed from the same Iroh endpoint. The
   * caller closes it; this client keeps owning the endpoint.
   */
  async openControlConnection(): Promise<RpcClient> {
    this.assertOpen();
    const device = this.deviceCredential();
    if (!this.isIroh)
      return new RpcClient({ url: new URL(this.url).origin, ...device }, this.owner);
    const controlPairing = this.controlPairing;
    if (!controlPairing) {
      throw new Error("Stored credential does not contain hub control reach");
    }
    const parent = await this.ensureIrohClient();
    this.assertOpen();
    const control = new RpcClient(
      {
        url: this.url,
        ...device,
        pairing: controlPairing,
        endpointSecret: this.endpointSecret,
      },
      this.owner
    );
    control.irohClient = Promise.resolve(
      parent.peer({
        reach: controlPairing,
        callerId: this.callerId,
        callerKind: this.callerKind,
        getToken: () => this.authToken(),
        clientLabel: "Vibestudio CLI",
        onPaired: () => undefined,
      })
    );
    // The peer connection lives until its owner closes it; ordinary calls must
    // not retire it (re-dialing would bind the endpoint a second time).
    control.keepPushOpen = true;
    return control;
  }

  /**
   * Open an independent transport to the same resolved workspace endpoint.
   *
   * Long-lived streams must not own the connection used for ordinary RPCs.
   * Iroh siblings share the credential endpoint and own separate request
   * streams; HTTP siblings use the same authenticated workspace URL.
   */
  async openSiblingConnection(): Promise<RpcClient> {
    this.assertOpen();
    if (this.isIroh) {
      // QUIC gives every request its own independently flow-controlled stream,
      // so the old Iroh reason for a second physical connection no longer
      // exists. Share the one credential endpoint and let the event/watch own a
      // separate request stream. Binding the same Endpoint ID twice is invalid.
      await this.ensureIrohClient();
      this.assertOpen();
      const sibling = this.rawToken
        ? new RpcClient(
            {
              url: this.url,
              token: this.rawToken,
              workspacePairing: this.pairing,
              endpointSecret: this.endpointSecret,
            },
            this.owner
          )
        : new RpcClient(
            {
              url: this.url,
              ...this.deviceCredential(),
              pairing: this.pairing,
              endpointSecret: this.endpointSecret,
            },
            this.owner
          );
      sibling.irohClient = this.irohClient;
      sibling.ownsIrohClient = false;
      return sibling;
    }
    if (this.rawToken) {
      return new RpcClient(
        {
          url: this.url,
          token: this.rawToken,
          ...(this.pairing ? { workspacePairing: this.pairing } : {}),
        },
        this.owner
      );
    }
    const device = this.deviceCredential();
    return new RpcClient(
      {
        url: this.url,
        ...device,
        ...(this.pairing ? { pairing: this.pairing } : {}),
      },
      this.owner
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closeFailure) return this.closeFailure;
    const closing = Promise.resolve().then(() => this.retireResources());
    this.closePromise = closing;
    void closing.then(
      () => {
        if (this.closePromise === closing) this.closePromise = null;
      },
      () => {
        if (this.closePromise === closing) {
          this.closePromise = null;
          this.closeFailure = closing;
        }
      }
    );
    return closing;
  }

  private async retireResources(): Promise<void> {
    this.owner.signal?.removeEventListener("abort", this.cancel);
    this.cancellationAttached = false;
    const iroh = this.irohClient;
    const ws = this.wsClient;
    const httpDispatcher = this.httpDispatcher;
    this.irohClient = null;
    this.wsClient = null;
    this.httpDispatcher = null;
    const resources = [
      ...(iroh && this.ownsIrohClient
        ? [{ label: "Iroh client", close: async () => (await iroh).close() }]
        : []),
      ...(ws ? [{ label: "WebSocket client", close: async () => (await ws).close() }] : []),
      ...(httpDispatcher
        ? [
            {
              label: "HTTP RPC dispatcher",
              // Closing this client ends its calls just as closing its push
              // transports does. A graceful pool close waits indefinitely for
              // RPC responses whose semantic owner has already been cancelled.
              close: async () => await httpDispatcher.destroy(),
            },
          ]
        : []),
    ];
    const settled = await Promise.allSettled(resources.map((resource) => resource.close()));
    const failures = settled.flatMap((result, index) => {
      if (result.status !== "rejected") return [];
      const resource = resources[index];
      return resource
        ? [new Error(`${resource.label} close failed`, { cause: result.reason })]
        : [new Error("Unknown CLI resource close failed", { cause: result.reason })];
    });
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "CLI connections could not all be closed");
    }
    this.releaseEndpointLock?.();
    this.releaseEndpointLock = null;
  }

  private assertOpen(): void {
    this.owner.signal?.throwIfAborted();
    if (this.owner.signal && !this.cancellationAttached) {
      this.owner.signal.addEventListener("abort", this.cancel, { once: true });
      this.cancellationAttached = true;
    }
    if (this.closePromise || this.closeFailure) {
      throw new ConnectionError("RPC client is closing or could not be closed");
    }
  }

  /**
   * Keep the push transport alive across a bounded batch of ordinary calls.
   * Pollers use this so Iroh pairing/ICE is paid once per command, not once
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
      const ownsResources =
        this.irohClient !== null ||
        this.wsClient !== null ||
        this.httpDispatcher !== null ||
        this.releaseEndpointLock !== null;
      if (
        this.retainedConnections === 0 &&
        !this.keepPushOpen &&
        (ownsResources || this.closePromise !== null || this.closeFailure !== null)
      ) {
        await this.close();
      }
    };
  }

  /** Build an `RpcEnvelope` and POST it to the envelope-native `/rpc`. */
  private async dispatch(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown> {
    const signal =
      options?.signal && this.owner.signal
        ? AbortSignal.any([options.signal, this.owner.signal])
        : (options?.signal ?? this.owner.signal);
    const token = await this.ensureBearerToken(signal);
    this.assertOpen();
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
    return await this.post(envelope, token, signal);
  }

  private async post(
    body: Record<string, unknown>,
    initialToken?: string,
    signal = this.owner.signal
  ): Promise<unknown> {
    let token = initialToken ?? (await this.ensureBearerToken(signal));
    let response = await this.postRpc(token, body, signal);
    if (response.status === 401) {
      // Bearer token expired or server restarted — refresh once and retry.
      shellTokenCache.delete(cacheKey(this.url, this.principalCacheId()));
      token = await this.refreshBearerToken(signal);
      response = await this.postRpc(token, body, signal);
      if (response.status === 401) {
        const errorBody = responseRecord(await readRpcResponseBody(response));
        throw new AuthError(remoteErrorMessage(errorBody, "unauthorized after token refresh"));
      }
    }
    const raw = responseRecord(await readRpcResponseBody(response));
    if (!response.ok) {
      throw new RpcError(
        typeof raw["error"] === "string"
          ? (raw["error"] as string)
          : `rpc failed (${response.status} ${response.statusText})`,
        undefined,
        response.status >= 500 ? "transport" : "application"
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
          errorData?: unknown;
        }
      | undefined;
    if (!message || message.type !== "response") {
      throw new RpcError("malformed rpc response (non-envelope or proxy response?)");
    }
    if ("error" in message) throw deserializeRpcFailure(message.error);
    if (!("result" in message)) {
      throw new RpcError("malformed rpc response (no result)");
    }
    return message.result;
  }

  private postRpc(
    token: string,
    body: Record<string, unknown>,
    signal = this.owner.signal
  ): Promise<Response> {
    // RPC methods own their semantic lifetime. Template publication, builds,
    // and reviewed operations may legitimately remain open past Undici's
    // implicit ~300s response-header deadline. Cancellation belongs to the
    // caller or connection lifecycle, not an undocumented transport timer.
    this.httpDispatcher ??= new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      pipelining: 0,
    });
    return fetchOrAuthError(serverRpcHttpUrl(this.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: encodeRpcJson(body),
      dispatcher: this.httpDispatcher,
      ...(signal ? { signal } : {}),
    });
  }

  private async dispatchIroh(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown> {
    const client = await this.ensureIrohClient();
    this.assertOpen();
    let result: unknown;
    let operationFailure: unknown;
    let operationFailed = false;
    try {
      result =
        targetId === "main"
          ? await client.call(requireQualifiedServiceMethod(method), args, options)
          : await client.callTarget(targetId, method, args, options);
    } catch (error) {
      operationFailure = toRpcError(error);
      operationFailed = true;
    }
    let cleanupFailure: unknown;
    let cleanupFailed = false;
    if (!this.keepPushOpen && this.retainedConnections === 0) {
      try {
        await this.close();
      } catch (error) {
        cleanupFailure = error;
        cleanupFailed = true;
      }
    }
    if (operationFailed && cleanupFailed) {
      throw new AggregateError(
        [operationFailure, cleanupFailure],
        "RPC call and transport cleanup failed",
        { cause: operationFailure }
      );
    }
    if (operationFailed) throw operationFailure;
    if (cleanupFailed) throw cleanupFailure;
    return result;
  }

  private ensureIrohClient(): Promise<import("../node/iroh/irohRpcClient.js").IrohRpcClient> {
    this.assertOpen();
    if (!this.pairing || !this.endpointSecret) {
      throw new Error("Stored credential does not contain Iroh reach and endpoint identity");
    }
    if (!this.irohClient) {
      const pairing = this.pairing;
      const endpointSecret = this.endpointSecret;
      this.irohClient = Promise.all([
        import("../node/iroh/irohRpcClient.js"),
        import("./irohEndpointLock.js"),
      ])
        .then(async ([{ IrohRpcClient }, { acquireIrohEndpointLock }]) => {
          this.releaseEndpointLock = await acquireIrohEndpointLock(endpointSecret);
          return new IrohRpcClient({
            reach: pairing,
            endpointSecret: Buffer.from(endpointSecret, "base64url"),
            callerId: this.callerId,
            callerKind: this.callerKind,
            getToken: () => this.authToken(),
            clientLabel: "Vibestudio CLI",
            onPaired: () => undefined,
            ...(this.owner.signal ? { signal: this.owner.signal } : {}),
          });
        })
        .catch((error) => {
          this.releaseEndpointLock?.();
          this.releaseEndpointLock = null;
          this.irohClient = null;
          throw error;
        });
    }
    return this.irohClient;
  }

  /** Select the credential's one persistent push/stream transport. */
  private async persistentClient(): Promise<PersistentRpcClient> {
    this.assertOpen();
    if (!this.isIroh) return await this.ensureWsClient();
    return await this.ensureIrohClient();
  }

  private ensureWsClient(): Promise<import("./wsClient.js").WsRpcClient> {
    this.assertOpen();
    if (!this.wsClient) {
      this.wsClient = import("./wsClient.js")
        .then(({ WsRpcClient }) => {
          return new WsRpcClient({
            url: this.url,
            callerId: this.callerId,
            callerKind: this.callerKind,
            getToken: () => this.authToken(),
            clientLabel: "Vibestudio CLI",
            ...(this.owner.signal ? { signal: this.owner.signal } : {}),
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
  // Transport failures already carry their complete causes and aggregate members.
  return error instanceof Error ? error : new Error(String(error));
}
