/**
 * RPC WebSocket Server — handles caller-scoped app, panel, worker, extension,
 * shell-host and server communication.
 *
 * Replaces Electron IPC with a single WebSocket transport.
 * Auth is unified through TokenManager. Events use owned streaming responses.
 */

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ExtensionInvocation } from "@vibestudio/extension";
import {
  createRpcClient,
  rpcErrorDataOf,
  rpcErrorKindOf,
  envelopeFromMessage,
  responseEnvelopeFor,
  stampEnvelopeCaller,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
  type RpcEvent,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
  type RpcCausalParent,
  type RpcCallOptions,
  type DirectAuthorityAttestation,
  type RpcAuthorityEffect,
} from "@vibestudio/rpc";
import { createWsServerTransport, type WsServerTransportInternal } from "./wsServerTransport.js";
import {
  decodeControlFrame,
  encodeControlFrame,
  SESSION_CLOSED,
  SESSION_NOT_OPEN_CLOSE_CODE,
  SESSION_OPEN_RESULT,
  type SessionControlFrame,
} from "@vibestudio/rpc/protocol/sessionNegotiation";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  parseEndFrame,
} from "@vibestudio/rpc/protocol/streamCodec";
import type { StreamFrameType } from "@vibestudio/rpc/protocol/bulkMux";
import { PIPE_LANE, SessionWebSocketShim, type PipeChannels } from "./webrtcSessionShim.js";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import type { ToolExecutionResult } from "@vibestudio/shared/types";
import { createDevLogger } from "@vibestudio/dev-log";
import {
  authenticatedCallerOf,
  parseServiceMethod,
  createHostCaller,
  createVerifiedCaller,
  ServiceDispatcher,
  type CallerKind,
  type ServiceContext,
  type VerifiedCodeIdentity,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import type { UserSubject } from "@vibestudio/identity/types";
import type { UserSubjectSource } from "@vibestudio/identity/userSubjectSource";
import type { EventService } from "@vibestudio/shared/eventsService";
import { DeferralRegistry } from "./services/deferralRegistry.js";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { callerKindForPrincipalKind } from "@vibestudio/shared/principalKinds";
import { resolveCodeIdentity } from "./services/principalIdentity.js";
import { SessionRegistry, type SessionRegistryOptions } from "./rpcServer/sessionRegistry.js";
import { ConnectionRegistry, type WsClientState } from "./rpcServer/connectionRegistry.js";
import type { ClientPlatform } from "@vibestudio/shared/panel/panelLease";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import type { DeviceCredential, PairingContext } from "@vibestudio/rpc/protocol/wsProtocol";
import {
  HttpRpcHandler,
  resolveRpcMaxBodyBytes,
  type HttpRpcAdmission,
} from "./rpcServer/httpRpcHandler.js";
import { StreamingRelay } from "./rpcServer/streamingRelay.js";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import { attestDirectRpc, attestWorkspaceDoRpc } from "./services/authorityRuntime.js";
import { evaluateAuthority, requirementForPrincipals } from "@vibestudio/shared/authorization";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
  sha256Canonical,
} from "@vibestudio/shared/authority/invocationSnapshot";
import { describeCapability } from "@vibestudio/shared/authorityPresentation";
import { resolveHttpRuntimeCaller } from "./httpRuntimeIdentity.js";

const log = createDevLogger("RpcServer");
const RPC_RUNTIME_ID_HEADER = "x-vibestudio-runtime-id";
const ADMIN_RPC_AUTH_ERROR =
  "Admin token cannot authenticate RPC; use a caller-scoped token or connection grant.";

/**
 * Parse a "do:source:className:objectKey" target ID.
 * Source contains "/" but no ":", so the first ":" after a "/" delimits
 * source from className. ObjectKey may contain ":" (e.g., fork keys).
 */
function parseDOTarget(targetId: string): { source: string; className: string; objectKey: string } {
  const body = targetId.slice(3); // Remove "do:"
  const slashIdx = body.indexOf("/");
  if (slashIdx === -1) throw new Error(`Invalid DO target (no source slash): ${targetId}`);
  const colonAfterSlash = body.indexOf(":", slashIdx);
  if (colonAfterSlash === -1) throw new Error(`Invalid DO target (no className): ${targetId}`);
  const source = body.slice(0, colonAfterSlash);
  const rest = body.slice(colonAfterSlash + 1);
  const nextColon = rest.indexOf(":");
  if (nextColon === -1) throw new Error(`Invalid DO target (no objectKey): ${targetId}`);
  const className = rest.slice(0, nextColon);
  const objectKey = rest.slice(nextColon + 1);
  return { source, className, objectKey };
}

/** The server's identity stamped onto response envelopes it returns over /rpc. */
const SERVER_RESPONDER = { callerId: "main", callerKind: "server" as const };

/**
 * The in-process `server` principal's synthetic subject (WP0 §5.4). It is NOT a
 * `UserStore` row — it is excluded from account joins and presence surfaces
 * (WP8 §4, WP5 render) — but is stamped so every in-process `ServiceContext`
 * still carries a subject rather than a null one.
 */
export const SYSTEM_SUBJECT: UserSubject = { userId: "system", handle: "system" };

/**
 * Resolve the `userId` to denormalize onto a connection whose `VerifiedCaller`
 * carries no host-verified `subject` (WP4 §2.1). Only the in-process `server`
 * principal is intentionally synthetic. Every shell, including the local
 * desktop, must resolve to a real account from the hub-owned identity store;
 * there is no subject-less local-console compatibility mode.
 */
function assertBootstrapSubject(caller: VerifiedCaller): string {
  const { id, kind } = caller.runtime;
  if (kind === "server") return SYSTEM_SUBJECT.userId;
  throw new Error(
    `Caller ${kind}:${id} reached connection admission without a host-verified subject ` +
      `(the WP0 §5.4 bootstrap set is closed)`
  );
}

function envelopeForWsDelivery(
  fromId: string,
  fromKind: CallerKind | "unknown",
  targetId: string,
  message: RpcMessage
): RpcEnvelope {
  return envelopeFromMessage({
    selfId: fromId,
    from: fromId,
    target: targetId,
    callerKind: fromKind,
    message,
  });
}

function envelopeTransportFromWsServer(transport: WsServerTransportInternal): EnvelopeRpcTransport {
  return {
    async send(envelope) {
      await transport.sendEnvelope(envelope);
    },
    onMessage(handler) {
      return transport.onAnyMessage((sourceId, message, callerKind) => {
        handler(
          envelopeFromMessage({
            selfId: "server",
            from: sourceId,
            target: "server",
            message,
            callerKind: callerKind ?? "unknown",
          })
        );
      });
    },
  };
}

interface PendingToolCall {
  resolve: (result: ToolExecutionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  clientWs: WebSocket;
}

type RelayAuthCheck = { ok: true } | { ok: false; reason: string };

export interface RelayAuthorizationRequest {
  callerId: string;
  callerKind: CallerKind;
  targetId: string;
  method?: string;
}

export type RelayAuthorizationPolicy = (request: RelayAuthorizationRequest) => RelayAuthCheck;

type RelayCallMeta = {
  requestId?: string;
  idempotencyKey?: string;
  readOnly?: boolean;
  causalParent?: RpcCausalParent;
  signal?: AbortSignal;
};

type RelayCallerScope = {
  /** Exact caller stamped at transport admission (never re-resolved by runtime id). */
  authenticatedCaller: VerifiedCaller;
  /** Host-resolved parent caller used for chained extension attribution. */
  invocationCaller: VerifiedCaller;
};

type ResolvedExtensionParentCaller = {
  caller: VerifiedCaller;
  code: VerifiedCodeIdentity;
  contextId?: string;
};

type ResolvedExtensionInvocation = Pick<ExtensionInvocation, "caller" | "chainCaller"> & {
  /** Host-retained edge from the verified context that invoked the extension. */
  causalParent: RpcCausalParent | null;
};

export interface RpcServerUploadPreopenLimits {
  maxPendingStreams?: number;
  maxBufferedBytes?: number;
}

const DEFAULT_UPLOAD_PREOPEN_STREAM_CAP = 65_536;
const DEFAULT_UPLOAD_PREOPEN_TOTAL_CAP_BYTES = 1024 * 1024 * 1024;

function resolvePositiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function relayCallOptions(meta?: RelayCallMeta): RpcCallOptions | undefined {
  if (!meta?.idempotencyKey && !meta?.readOnly && !meta?.causalParent && !meta?.signal) {
    return undefined;
  }
  return {
    ...(meta.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
    ...(meta.readOnly ? { readOnly: true } : {}),
    ...(meta.causalParent ? { causalParent: meta.causalParent } : {}),
    ...(meta.signal ? { signal: meta.signal } : {}),
  };
}

function relayMetaFromEnvelope(envelope?: RpcEnvelope): RelayCallMeta | undefined {
  if (!envelope) return undefined;
  const message = envelope.message;
  const requestId =
    message.type === "request" || message.type === "stream-request" ? message.requestId : undefined;
  const idempotencyKey = envelope.delivery.idempotencyKey;
  const readOnly = envelope.delivery.readOnly === true;
  const causalParent =
    message.type === "request" || message.type === "stream-request"
      ? message.causalParent
      : undefined;
  if (!requestId && !idempotencyKey && !readOnly && !causalParent) return undefined;
  return {
    ...(requestId ? { requestId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(causalParent ? { causalParent } : {}),
  };
}

type ReconnectOutcome =
  | { kind: "reconnected"; client: WsClientState }
  | { kind: "server-shutdown" }
  | { kind: "grace-expired" }
  | { kind: "no-waiter" };

type RelayErrorCode =
  | "EACQUIRE"
  | "EACCES"
  | "RECONNECT_GRACE_EXPIRED"
  | "SERVER_SHUTTING_DOWN"
  | "DO_CONTEXT_MISMATCH"
  | "DO_NOT_CREATED"
  | "RPC_PROTOCOL_ERROR"
  | "TARGET_NOT_REACHABLE"
  | "UNKNOWN_TARGET_KIND";

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function createRelayError(message: string, code: RelayErrorCode): Error {
  return Object.assign(new Error(message), { code });
}

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private workerdUrl: string | null = null;
  private workerdGatewayToken: string | null = null;
  private workerdDispatchSecret: string | null = null;
  private resolveWorkerInstanceNameFn: ((targetId: string) => string | null) | null = null;

  /**
   * Tracks DO/worker-initiated service calls that complete out-of-band. Settled
   * results wake a still-active caller. Retirement ends that notification
   * obligation; the caller's journal remains the recovery source.
   */
  private readonly deferrals = new DeferralRegistry({
    deliver: async (callerId, requestId, result, isError) => {
      if (!this.isActiveDeferredRecipient(callerId)) return;
      try {
        await this.callTarget(callerId, "onDeferredResult", [{ requestId, result, isError }]);
      } catch (error) {
        // Retirement may race the active check. That is successful disposal,
        // not a failed delivery and certainly not a reason to recreate/retry
        // the caller. Preserve real delivery faults for one bounded warning.
        if (!this.isActiveDeferredRecipient(callerId)) return;
        throw error;
      }
    },
    logger: console,
  });
  private connections = new ConnectionRegistry({
    onConnectionsChangedListenerError: (error) => {
      log.warn(`connections-changed listener failed: ${(error as Error).message}`);
    },
  });
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastDisconnectAt = new Map<string, number>();
  private reconnectWaiters = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      reject: (err: Error) => void;
    }
  >();
  private connectionReconnectWaiters = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      reject: (err: Error) => void;
    }
  >();
  private routedRequestOrigins = new Map<
    string,
    {
      callerId: string;
      connectionId: string;
      /**
       * Connection the request was actually DELIVERED to (§3.4: a callee that
       * terminally dies after delivery must still settle the caller — see
       * `failRoutedRequestsForCallee`). Absent for HTTP-relayed requests, whose
       * `relayCall` promise already settles the caller on every failure path.
       */
      callee?: { targetId: string; calleeId: string; connectionId: string };
    }
  >();
  private sessions: SessionRegistry;
  private readonly httpRpc: HttpRpcHandler;
  private readonly streamingRelay: StreamingRelay;
  private readonly eventSessionReleases = new WeakMap<WsClientState, () => void>();
  private disposeTokenRevocationListener: (() => void) | null = null;
  private readonly pendingAuthentications = new Map<
    WebSocket,
    ReturnType<typeof setTimeout> | null
  >();
  /** Requests whose response still has to be queued before revocation may close the socket. */
  private readonly activeInboundRequests = new Map<WebSocket, number>();
  /** Exact unary requests owned by each authenticated socket. */
  private readonly inboundRequestControllers = new WeakMap<
    WebSocket,
    Map<string, AbortController>
  >();
  /** Terminal caller teardown, shared by token revocation and explicit reach cleanup. */
  private readonly callerRetirements = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      pendingSockets: Set<WebSocket>;
      callerKind?: CallerKind;
      settled: boolean;
    }
  >();
  private stopped = false;

  private readonly bootId = randomUUID();
  private readonly uploadPreopenLimits: Required<RpcServerUploadPreopenLimits>;

  private static readonly DISCONNECT_GRACE_MS = 3000;

  private dispatcher: ServiceDispatcher;

  constructor(
    private deps: {
      tokenManager: TokenManager;
      dispatcher: ServiceDispatcher;
      /** Required when direct DO relay is configured. */
      workspaceId?: string;
      /** Called when an authenticated client disconnects (e.g., for fs handle cleanup) */
      onClientDisconnect?: (callerId: string, callerKind: CallerKind) => void;
      /** Called when a client successfully authenticates */
      onClientAuthenticate?: (callerId: string, callerKind: CallerKind) => void;
      /**
       * Optional: the EgressProxy. When provided, `POST /rpc/stream`
       * can serve the `credentials.proxyFetch` fast path with a
       * credentialed upstream response body. Other streaming service
       * methods are dispatched through the normal service dispatcher and
       * do not require this dependency.
       */
      egressProxy?: Pick<
        import("./services/egressProxy.js").EgressProxy,
        "forwardProxyFetchStream"
      >;
      fsService?: Pick<import("@vibestudio/shared/fsService").FsService, "closeHandlesForCaller">;
      entityCache?: EntityCache;
      /**
       * Optional: resolves the host-verified account `subject` for a caller at
       * auth time (WP0 §5.2/§5.5). Hub-backed in production (reads the shared
       * identity DB via `deviceAuthStore.userFor`, agent bindings, and entity
       * lineage), fakeable in tests. When absent, only the in-process `server`
       * receives its synthetic subject; every external caller is unattributed.
       */
      userSubjectSource?: UserSubjectSource;
      /**
       * Optional membership entry gate (WP2 §4, authoritative-at-child). A
       * hub-spawned workspace child carries the opaque VIBESTUDIO_WORKSPACE_ID
       * and the shared identity DB; `handleAuth` calls this with the connecting
       * caller's host-verified `subject` right after subject resolution and
       * refuses (`EACCES`, WS close) a non-member before any session state is
       * created. Wired from `index.ts` to `membershipStore.has(userId, wsId)`;
       * production supplies a fail-closed predicate: only the synthetic
       * in-process `system` subject bypasses it; unattributed callers are denied.
       * Absent only in test or non-workspace hosts.
       */
      membershipGate?: (subject: UserSubject | undefined) => boolean;
      /** Live workspace role used by declarative `workspace-role` requirements. */
      workspaceRoleResolver?: (subject: UserSubject | undefined) => string | null;
      /** Resolve human-facing copy for a capability string. When absent,
       *  falls back to the static shared catalog (no live workspace services). */
      describeCapability?: (
        capability: string
      ) => import("@vibestudio/shared/authorityPresentation").CapabilityPresentation;
      /** Live user decisions augment the reviewed direct-RPC product catalog. */
      capabilityGrantStore?: import("./services/capabilityGrantStore.js").CapabilityGrantStore;
      /** Shared user-acquisition rendezvous for protected direct receiver calls. */
      directAuthorityAcquirer?: {
        request(
          input: import("./services/acquisitionCoordinator.js").AcquisitionRequestInput
        ): import("@vibestudio/rpc").AcquisitionInfo;
        acquire(
          input: import("./services/acquisitionCoordinator.js").AcquisitionRequestInput,
          signal?: AbortSignal
        ): Promise<import("./services/acquisitionCoordinator.js").AcquisitionOutcome>;
        consume(grantId: string): boolean;
        invalidate(snapshotDigest: string, ownerRuntimeId: string, callerPrincipal: string): void;
      };
      /** Stable mission fact for the same session identity used by service dispatch. */
      missionFactForSession?: (
        sessionId: string
      ) => import("@vibestudio/rpc").SessionMissionFact | null;
      /** Durable server-observed context latch for direct userland calls. */
      contextIntegrityFactForSession?: (
        sessionId: string,
        caller: VerifiedCaller
      ) => import("@vibestudio/rpc").ContextIntegrityFact;
      /**
       * Resolve an exact live workspace service declaration for a direct DO
       * target. This is deliberately runtime data: context-scoped/user-created
       * services must not depend on a checked-in product census.
       */
      resolveWorkspaceDirectAuthority?: (input: {
        caller: VerifiedCaller;
        source: string;
        className: string;
        objectKey: string;
        method: string;
      }) =>
        | Promise<
            readonly {
              capability: string;
              methodEffect: RpcAuthorityEffect;
              methodCapability?: string;
              methodTier: "open" | "gated" | "critical";
              principals: readonly import("@vibestudio/rpc").PrincipalKind[];
            }[]
          >
        | readonly {
            capability: string;
            methodEffect: RpcAuthorityEffect;
            methodCapability?: string;
            methodTier: "open" | "gated" | "critical";
            principals: readonly import("@vibestudio/rpc").PrincipalKind[];
          }[];
      /**
       * Live identity gate for persistent WS/WebRTC sessions. Authentication
       * stamps a caller once, but revocation and workspace membership are
       * mutable. Production re-checks the shared identity DB before every
       * subsequent inbound frame so a failed administrative socket teardown
       * cannot leave a cached device, agent, or user usable.
       */
      liveCallerGate?: (caller: VerifiedCaller, authorizedBy?: string) => boolean;
      /**
       * Exact existence check for a causal invocation coordinate in the
       * canonical trajectory projection. Causal parents fail closed when this
       * dependency is absent, rejects, or reports that the node does not exist.
       */
      verifyExactCausalInvocation?: (parent: RpcCausalParent) => Promise<boolean>;
      /**
       * Host-level relay boundary composed with RpcServer's invariant transport
       * protections. Direct service dispatch to `main` never reaches this
       * policy; every attempt to address another runtime does.
       */
      relayAuthorization?: RelayAuthorizationPolicy;
      connectionGrants?: ConnectionGrantService;
      resolveExtensionInvocation?: (
        extensionName: string,
        requestId: string
      ) => ResolvedExtensionInvocation | null;
      resolveExtensionCodeIdentity?: (extensionName: string) => VerifiedCodeIdentity | null;
      /**
       * Exact-version admission established by the shared unit review. Code
       * identity remains attributable when false, but its manifest grants no
       * authority until the reviewed version has been admitted.
       */
      isCodeApproved?: (code: VerifiedCodeIdentity) => boolean;
      sessionInboxCapacity?: SessionRegistryOptions["inboxCapacity"];
      sessionTtlMs?: SessionRegistryOptions["ttlMs"];
      runtimeCoordinator?: PanelRuntimeCoordinator;
      /** Direct event addressing is owned by authenticated transport lifetime. */
      eventService?: EventService;
      /**
       * Optional: redeem a device-pairing credential presented as a session
       * token — a QR pairing `code` (fresh device) or `refresh:<deviceId>:<token>`
       * (returning device) — into a shell principal. This is the over-the-pipe
       * equivalent of the loopback HTTP `/complete-pairing` + `/refresh-shell`
       * endpoints (which a remote WebRTC client cannot reach). A freshly issued
       * device credential is returned so the auth-result hands it back to the
       * client to persist for reconnects. Returns null if the token is neither.
       */
      redeemPairingCredential?: (
        token: string,
        ctx: { clientLabel?: string; clientPlatform?: ClientPlatform }
      ) =>
        | {
            callerId: string;
            callerKind: CallerKind;
            deviceCredential?: DeviceCredential;
            pairingContext?: PairingContext;
            /**
             * Entity/context binding for an `agent:`-prefixed credential (§3.2),
             * stamped onto the connection's VerifiedCaller. Host-verified — never
             * from client input.
             */
            agentBinding?: import("@vibestudio/identity/types").AgentBinding;
            /** Host-verified account subject for the redeemed credential. */
            subject?: UserSubject;
          }
        | null
        | Promise<{
            callerId: string;
            callerKind: CallerKind;
            deviceCredential?: DeviceCredential;
            pairingContext?: PairingContext;
            agentBinding?: import("@vibestudio/identity/types").AgentBinding;
            subject?: UserSubject;
          } | null>;
      uploadPreopenLimits?: RpcServerUploadPreopenLimits;
    }
  ) {
    this.dispatcher = deps.dispatcher;
    this.streamingRelay = new StreamingRelay({
      dispatcher: deps.dispatcher,
      egressProxy: deps.egressProxy,
      authenticateHttp: (req) => this.authenticateHttpRequest(req),
      verifiedCaller: (caller) =>
        this.verifiedCallerFor(caller.callerId, caller.callerKind, caller.agentBinding),
      authorizeRelay: (callerId, callerKind, targetId, method) =>
        this.checkRelayAuth(callerId, callerKind, targetId, method),
      createHttpContext: (caller, extras) =>
        this.serviceContextFor(caller.callerId, caller.callerKind, extras, caller.agentBinding),
      resolveCausalParent: (caller, request) => this.resolveCausalParent(caller, request),
      createWsContext: (client, request, extras) =>
        this.serviceContextForRpcMessage(client, request, extras),
      relayTargetStream: (caller, envelope, request, causalParent, signal) =>
        this.relayTargetStream(caller, envelope, request, causalParent, signal),
      sendWs: (client, message) => this.sendToWs(client.ws, message),
    });
    this.httpRpc = new HttpRpcHandler({
      maxBodyBytes: resolveRpcMaxBodyBytes(process.env["VIBESTUDIO_RPC_MAX_BODY_BYTES"]),
      authenticate: (req) => this.authenticateHttpRequest(req),
      handleStreamingRequest: (req, res) => this.streamingRelay.handleHttpRequest(req, res),
      handleRequest: (caller, envelope, message, signal) =>
        this.handleEnvelopeRequest(
          caller.callerId,
          caller.callerKind,
          caller.agentBinding,
          envelope,
          message,
          signal
        ),
      handleEvent: (caller, envelope, message) =>
        this.handleEnvelopeEvent(caller.callerId, caller.callerKind, envelope, message),
    });
    this.uploadPreopenLimits = {
      maxPendingStreams: resolvePositiveLimit(
        deps.uploadPreopenLimits?.maxPendingStreams,
        DEFAULT_UPLOAD_PREOPEN_STREAM_CAP,
        "uploadPreopenLimits.maxPendingStreams"
      ),
      maxBufferedBytes: resolvePositiveLimit(
        deps.uploadPreopenLimits?.maxBufferedBytes,
        DEFAULT_UPLOAD_PREOPEN_TOTAL_CAP_BYTES,
        "uploadPreopenLimits.maxBufferedBytes"
      ),
    };
    deps.runtimeCoordinator?.setCloseConnection((panelId, connectionId, code, reason) => {
      this.connections.closeConnection(panelId, connectionId, code, reason);
    });
    this.sessions = new SessionRegistry({
      inboxCapacity: deps.sessionInboxCapacity,
      ttlMs: deps.sessionTtlMs,
      onSessionExpire: (callerId, callerKind) => {
        this.deps.onClientDisconnect?.(callerId, callerKind);
        // Session-TTL expiry ends the reconnect-grace window (WP4 §5): fan a
        // change signal so WP8 presence can flap a truly-departed user without
        // polling. Connection maps are already updated on disconnect; this
        // covers the delayed grace boundary.
        this.connections.notifyConnectionsChanged();
      },
    });
  }

  private verifiedCallerFor(
    callerId: string,
    callerKind: CallerKind,
    agentBinding?: import("@vibestudio/identity/types").AgentBinding,
    subject?: UserSubject
  ): VerifiedCaller {
    const activeEntity =
      callerKind === "worker" || callerKind === "do"
        ? this.deps.entityCache?.resolveActive(callerId)
        : undefined;
    const resolvedAgentBinding = agentBinding ?? activeEntity?.agentBinding;
    const code =
      callerKind === "extension"
        ? (this.deps.resolveExtensionCodeIdentity?.(callerId) ?? null)
        : this.deps.entityCache
          ? resolveCodeIdentity(this.deps.entityCache, callerId)
          : null;
    // An explicitly-passed subject (device/agent credential, §5.1/§5.3) wins;
    // otherwise resolve it from the caller id (§5.2/§5.4).
    const resolvedSubject = subject ?? this.resolveSubject(callerId, callerKind, agentBinding);
    const sessionOrigin = Boolean(
      code &&
      activeEntity?.source.repoPath === "vibestudio/internal" &&
      activeEntity.className === "EvalDO"
    );
    const verified = createVerifiedCaller(
      callerId,
      callerKind,
      code,
      resolvedAgentBinding,
      resolvedSubject,
      sessionOrigin
    );
    return code && (this.deps.isCodeApproved?.(code) ?? true)
      ? { ...verified, codeApproved: true }
      : verified;
  }

  /**
   * Resolve the host-verified account subject for a caller (WP0 §5.2/§5.4).
   * The in-process `server` principal maps to the synthetic system subject — the
   * one bootstrap subject the host can determine without any identity DB. Every
   * other caller — a local console principal (`electron-main`/`headless-host`,
   * resolved to the machine root), a
   * `shell:`/`agent:` credential, or a `panel:`/`do:`/`worker:` lineage — routes
   * through the hub-backed `userSubjectSource`. Returning null means admission
   * must fail for every external caller.
   */
  private resolveSubject(
    callerId: string,
    callerKind: CallerKind,
    agentBinding?: import("@vibestudio/identity/types").AgentBinding
  ): UserSubject | null {
    if (callerKind === "server") return SYSTEM_SUBJECT;
    if (callerKind === "extension") {
      return this.deps.resolveExtensionCodeIdentity?.(callerId) ? SYSTEM_SUBJECT : null;
    }
    return this.deps.userSubjectSource?.resolve(callerId, callerKind, agentBinding) ?? null;
  }

  /** Re-evaluate workspace membership at every stateless HTTP admission. */
  private isWorkspaceMember(
    callerId: string,
    callerKind: CallerKind,
    agentBinding?: import("@vibestudio/identity/types").AgentBinding
  ): boolean {
    if (!this.deps.membershipGate) return true;
    return this.deps.membershipGate(
      this.resolveSubject(callerId, callerKind, agentBinding) ?? undefined
    );
  }

  private serviceContextFor(
    callerId: string,
    callerKind: CallerKind,
    extras: Omit<ServiceContext, "caller"> = {},
    agentBinding?: import("@vibestudio/identity/types").AgentBinding
  ): ServiceContext {
    return {
      caller: this.verifiedCallerFor(callerId, callerKind, agentBinding),
      ...extras,
    };
  }

  private serviceContextForRpcMessage(
    client: WsClientState,
    message: {
      parentRequestId?: string;
      causalParent?: import("@vibestudio/rpc").RpcCausalParent;
    },
    extras: Omit<ServiceContext, "caller" | "connectionId" | "wsClient" | "chainCaller"> = {}
  ): ServiceContext {
    const ctx: ServiceContext = {
      caller: client.caller,
      connectionId: client.connectionId,
      wsClient: client,
      ...extras,
    };
    const parent = this.resolveExtensionParentCaller(client, message);
    if (parent) ctx.chainCaller = parent.code;
    return ctx;
  }

  private async resolveCausalParent(
    caller: VerifiedCaller,
    message: Pick<RpcRequest, "causalParent" | "parentRequestId">
  ): Promise<RpcCausalParent | undefined> {
    const presented = message.causalParent !== undefined;
    let causalParent = message.causalParent;
    if (!causalParent && caller.runtime.kind === "extension" && message.parentRequestId) {
      causalParent =
        this.deps.resolveExtensionInvocation?.(caller.runtime.id, message.parentRequestId)
          ?.causalParent ?? undefined;
    }
    if (!causalParent) return undefined;
    if (
      causalParent.kind !== "trajectory-invocation" ||
      typeof causalParent.logId !== "string" ||
      causalParent.logId.length === 0 ||
      typeof causalParent.head !== "string" ||
      causalParent.head.length === 0 ||
      typeof causalParent.invocationId !== "string" ||
      causalParent.invocationId.length === 0
    ) {
      throw createRelayError("Invalid causal parent coordinate", "RPC_PROTOCOL_ERROR");
    }
    if (presented) {
      // Agent credentials carry their binding directly. Agent vessels running
      // as a worker/DO authenticate with their runtime principal instead, so
      // their equally host-owned binding lives on the active entity record.
      // Resolve both forms here at the transport boundary; downstream services
      // must never have to reinterpret a valid causal coordinate as unbound.
      const binding =
        caller.agentBinding ??
        (caller.runtime.kind === "worker" || caller.runtime.kind === "do"
          ? this.deps.entityCache?.resolveActive(caller.runtime.id)?.agentBinding
          : undefined);
      if (!binding) {
        throw createRelayError("Causal parent requires a host-bound agent trajectory", "EACCES");
      }
      const expected = channelTrajectoryFor(binding.channelId);
      if (causalParent.logId !== expected.logId || causalParent.head !== expected.head) {
        throw createRelayError(
          "Causal parent does not match the presenter's host-bound trajectory",
          "EACCES"
        );
      }
    }

    const verifier = this.deps.verifyExactCausalInvocation;
    if (!verifier) {
      throw createRelayError("Exact causal invocation verification is unavailable", "EACCES");
    }
    let exists: boolean;
    try {
      exists = await verifier(causalParent);
    } catch (error) {
      throw createRelayError(
        `Exact causal invocation verification failed: ${error instanceof Error ? error.message : String(error)}`,
        "EACCES"
      );
    }
    if (!exists) {
      throw createRelayError(
        `Causal invocation does not exist: ${causalParent.invocationId}`,
        "EACCES"
      );
    }
    return causalParent;
  }

  private resolveExtensionParentCaller(
    client: WsClientState,
    message: Pick<RpcRequest | import("@vibestudio/rpc").RpcStreamRequest, "parentRequestId">
  ): ResolvedExtensionParentCaller | null {
    if (client.caller.runtime.kind !== "extension" || !message.parentRequestId) {
      return null;
    }
    const invocation = this.deps.resolveExtensionInvocation?.(
      client.caller.runtime.id,
      message.parentRequestId
    );
    if (invocation?.chainCaller) {
      const code: VerifiedCodeIdentity = {
        callerId: invocation.chainCaller.callerId,
        callerKind: invocation.chainCaller.callerKind,
        repoPath: invocation.chainCaller.repoPath,
        effectiveVersion: invocation.chainCaller.effectiveVersion,
      };
      return {
        caller: createVerifiedCaller(code.callerId, code.callerKind, code),
        code,
        ...(invocation.chainCaller.contextId
          ? { contextId: invocation.chainCaller.contextId }
          : {}),
      };
    }
    const caller = invocation?.caller;
    if (
      caller?.callerKind !== "panel" &&
      caller?.callerKind !== "app" &&
      caller?.callerKind !== "worker" &&
      caller?.callerKind !== "do"
    ) {
      return null;
    }
    const code: VerifiedCodeIdentity = {
      callerId: caller.callerId,
      callerKind: caller.callerKind,
      repoPath: "",
      effectiveVersion: "",
    };
    return {
      caller: createVerifiedCaller(code.callerId, code.callerKind, code),
      code,
      ...(caller.contextId ? { contextId: caller.contextId } : {}),
    };
  }

  private relayCallerScopeForRpcMessage(
    client: WsClientState,
    message: Pick<RpcRequest, "parentRequestId">
  ): RelayCallerScope {
    const parent = this.resolveExtensionParentCaller(client, message);
    return {
      authenticatedCaller: client.caller,
      invocationCaller: parent?.caller ?? client.caller,
    };
  }

  private connectionKey(callerId: string, connectionId: string): string {
    return `${callerId}:${connectionId}`;
  }

  private getCallerConnections(callerId: string): WsClientState[] {
    return this.connections.getCallerConnections(callerId);
  }

  private pickPrimary(callerId: string): WsClientState | undefined {
    return this.connections.pickPrimary(callerId);
  }

  private getConnection(callerId: string, connectionId: string): WsClientState | undefined {
    return this.connections.getConnection(callerId, connectionId);
  }

  private resolveRoutableTargetId(targetId: string): string {
    return this.deps.runtimeCoordinator?.resolveRouteRuntimeEntityId(targetId) ?? targetId;
  }

  private pickRoutableTarget(targetId: string, connectionId?: string): WsClientState | undefined {
    const routedTargetId = this.resolveRoutableTargetId(targetId);
    if (connectionId) {
      return (
        this.getConnection(routedTargetId, connectionId) ??
        this.getConnection(targetId, connectionId)
      );
    }
    const routeConnectionId = this.deps.runtimeCoordinator?.resolveRouteConnection(targetId);
    if (routeConnectionId) return this.getConnection(routedTargetId, routeConnectionId);
    return this.pickPrimary(targetId);
  }

  private setBridge(
    callerId: string,
    connectionId: string,
    bridge: RpcClient,
    transport: WsServerTransportInternal
  ): void {
    this.connections.setBridge(callerId, connectionId, bridge, transport);
  }

  /** Register a callback for client disconnect events. */
  setOnClientDisconnect(handler: (callerId: string, callerKind: CallerKind) => void): void {
    this.deps.onClientDisconnect = handler;
  }

  /** Register a callback for client authentication events. */
  setOnClientAuthenticate(handler: (callerId: string, callerKind: CallerKind) => void): void {
    this.deps.onClientAuthenticate = handler;
  }

  /** Set the base URL for the workerd process (for HTTP relay to workers/DOs). */
  setWorkerdUrl(url: string): void {
    this.workerdUrl = url;
  }

  setWorkerdGatewayToken(token: string): void {
    this.workerdGatewayToken = token;
  }

  setWorkerdDispatchSecret(secret: string): void {
    this.workerdDispatchSecret = secret;
  }

  setWorkerInstanceResolver(fn: (targetId: string) => string | null): void {
    this.resolveWorkerInstanceNameFn = fn;
  }

  /**
   * Initialize handlers without binding a socket.
   * Call this when the gateway owns the socket and dispatches to us.
   */
  initHandlers(): void {
    if (this.stopped) throw new Error("RpcServer has stopped and cannot be restarted");
    if (this.handlersInitialized) return;
    this.handlersInitialized = true;

    // WSS in noServer mode — gateway calls handleUpgrade then
    // handleGatewayWsConnection. Origin allow-listing for this path is
    // enforced by the gateway's own upgrade handler (see gateway.ts).
    this.wss = new WebSocketServer({ noServer: true });

    // Register revocation-driven disconnect
    this.disposeTokenRevocationListener = this.deps.tokenManager.onRevoke((callerId) => {
      void this.retireCaller(callerId);
    });
  }
  private handlersInitialized = false;

  private handleConnection(ws: WebSocket): void {
    if (this.stopped) {
      ws.close(1001, "Server shutting down");
      return;
    }
    // Expect first message to be ws:auth
    let authTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      ws.close(4003, "Auth timeout");
    }, 10000);
    this.pendingAuthentications.set(ws, authTimeout);

    const onFirstMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
        this.pendingAuthentications.set(ws, null);
      }
      ws.off("message", onFirstMessage);

      let msg: WsClientMessage;
      try {
        msg = JSON.parse(data.toString()) as WsClientMessage;
      } catch {
        ws.close(4004, "Invalid message");
        return;
      }

      if (msg.type !== "ws:auth") {
        ws.close(4005, "Expected ws:auth as first message");
        return;
      }

      if (msg.contractVersion !== RPC_CONTRACT_VERSION) {
        const result: WsServerMessage = {
          type: "ws:auth-result",
          success: false,
          contractVersion: RPC_CONTRACT_VERSION,
          error: `Incompatible RPC contract: peer ${String(msg.contractVersion)}; server requires ${RPC_CONTRACT_VERSION}`,
        };
        ws.send(JSON.stringify(result));
        ws.close(4005, "Incompatible RPC contract");
        return;
      }

      void this.handleAuth(
        ws,
        msg.token,
        msg.connectionId,
        msg.clientLabel,
        msg.clientSessionId,
        msg.clientPlatform
      )
        .catch((error) => this.abortFailedAuthentication(ws, error))
        .finally(() => this.pendingAuthentications.delete(ws));
    };

    ws.on("message", onFirstMessage);
    ws.on("close", () => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      this.pendingAuthentications.delete(ws);
    });
  }

  private async handleAuth(
    ws: WebSocket,
    token: unknown,
    requestedConnectionId?: string,
    clientLabel?: string,
    clientSessionId?: string,
    clientPlatform?: ClientPlatform
  ): Promise<void> {
    if (this.stopped) {
      ws.close(1001, "Server shutting down");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    // Both the WebSocket and WebRTC handshakes reach this method, and neither
    // transport guarantees that a malformed open frame contains a string token.
    // Reject before any credential parser calls string methods on the value.
    if (typeof token !== "string" || token.length === 0) {
      log.warn("rejecting ws:auth: missing or non-string token", {
        clientLabel: clientLabel ?? null,
        clientPlatform: clientPlatform ?? null,
      });
      const msg: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: "Missing or invalid auth token",
      };
      ws.send(JSON.stringify(msg));
      ws.close(4006, "Missing or invalid auth token");
      return;
    }
    // Admin tokens are management-only. RPC clients must use caller tokens.
    if (this.deps.tokenManager.validateAdminToken(token)) {
      const msg: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: ADMIN_RPC_AUTH_ERROR,
      };
      ws.send(JSON.stringify(msg));
      ws.close(4006, "Admin token cannot authenticate RPC");
      return;
    }

    const grant =
      this.deps.connectionGrants?.redeem(token) ??
      this.deps.connectionGrants?.validate(token) ??
      null;
    let entry: import("@vibestudio/shared/tokenManager").TokenEntry | null;
    let deviceCredential: DeviceCredential | undefined;
    let pairingContext: PairingContext | undefined;
    let agentBinding: import("@vibestudio/identity/types").AgentBinding | undefined;
    // Host-verified subject for a device/agent credential redeemed over the pipe
    // (§5.1/§5.3). Absent for the caller-token path (§5.2), where
    // `verifiedCallerFor` resolves it from the caller id via `userSubjectSource`.
    let subject: UserSubject | undefined;
    try {
      entry = grant
        ? {
            callerId: grant.principalId,
            callerKind: this.callerKindForRuntimePrincipal(grant.principalId),
          }
        : this.deps.tokenManager.validateToken(token);
      if (entry?.agentBinding) agentBinding = entry.agentBinding;
      if (grant && entry?.callerKind === "app") {
        subject = this.subjectForGrantIssuer(grant.issuedBy) ?? undefined;
      }
    } catch {
      entry = null;
    }
    if (!entry) {
      // A fresh device (pairing code) or a returning one (refresh credential)
      // bootstraps its shell session over the pipe with no pre-issued bearer
      // token. The refresh secret only exists at completePairing time (the store
      // keeps just its hash), so a freshly issued device credential rides back on
      // the auth-result for the client to persist for reconnects.
      let paired: {
        callerId: string;
        callerKind: CallerKind;
        deviceCredential?: DeviceCredential;
        pairingContext?: PairingContext;
        agentBinding?: import("@vibestudio/identity/types").AgentBinding;
        subject?: UserSubject;
      } | null = null;
      if (this.deps.redeemPairingCredential) {
        try {
          paired =
            (await this.deps.redeemPairingCredential(token, {
              clientLabel,
              clientPlatform,
            })) ?? null;
        } catch {
          paired = null;
        }
      }
      if (paired) {
        entry = { callerId: paired.callerId, callerKind: paired.callerKind };
        deviceCredential = paired.deviceCredential;
        pairingContext = paired.pairingContext;
        agentBinding = paired.agentBinding;
        subject = paired.subject;
      }
    }
    // Pairing redemption crosses the child→hub boundary. The unauthenticated
    // socket may disappear while that durable operation is in flight; never
    // create session/lease/bridge state for a transport that is already gone.
    if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
    if (!entry) {
      // Fail-loud observability: a device/panel/agent presented a token that
      // matched no grant, bearer, or pairing/refresh credential. Log the device
      // label/platform for diagnosis — NEVER the token itself.
      log.warn("rejecting ws:auth: no valid credential", {
        clientLabel: clientLabel ?? null,
        clientPlatform: clientPlatform ?? null,
      });
      const msg: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: "Invalid token",
      };
      ws.send(JSON.stringify(msg));
      ws.close(4006, "Invalid token");
      return;
    }
    // The literal caller id "shell" is reserved for in-process dispatch.
    // Host clients that authenticate over WS use kind:"shell" with concrete
    // caller ids such as "electron-main", headless-host, or paired devices.
    if (entry.callerKind === "shell" && entry.callerId === "shell") {
      const msg: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: 'callerId:"shell" cannot authenticate over WebSocket',
      };
      ws.send(JSON.stringify(msg));
      ws.close(4006, 'callerId:"shell" cannot authenticate over WebSocket');
      return;
    }
    const callerKind: CallerKind = entry.callerKind;
    const callerId = entry.callerId;
    const connectionId = requestedConnectionId || randomUUID();
    const connectionKey = this.connectionKey(callerId, connectionId);

    // Panel lease gate FIRST — before clearing this connection's grace timer or
    // resolving its reconnect waiters. If the lease is denied (4090) the prior
    // connection's grace path must stay intact: the grace timer is the ONLY place
    // failRoutedRequestsForCallee runs, so cancelling it here would hang in-flight
    // routed requests forever, and resolving the waiters would wake parked
    // relayCalls into the "no client found" invariant throw. Gate, THEN (only on
    // success) clear the timer / wake the waiters.
    if (callerKind === "panel") {
      const auth = this.deps.runtimeCoordinator?.authorizePanelConnection(callerId, connectionId);
      if (!auth?.ok) {
        const msg: WsServerMessage = {
          type: "ws:auth-result",
          success: false,
          error: auth?.reason ?? "Panel runtime coordinator is unavailable",
        };
        ws.send(JSON.stringify(msg));
        ws.close(4090, "Panel runtime lease denied");
        return;
      }
    }

    // Credential validation may have raced a revocation while awaiting its
    // durable redeemer. Retirement is terminal; never resurrect its session.
    const priorRetirement = this.callerRetirements.get(callerId);
    if (priorRetirement && !priorRetirement.settled) {
      const msg: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: "Caller has been revoked",
      };
      ws.send(JSON.stringify(msg));
      ws.close(4001, "Token revoked");
      return;
    }
    // Caller ids are stable identities, not credential generations. Once the
    // old transport is fully gone, a newly valid credential (for example after
    // workspace membership is restored) may establish a fresh generation.
    if (priorRetirement?.settled) this.callerRetirements.delete(callerId);

    const pendingTimer = this.disconnectTimers.get(connectionKey);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.disconnectTimers.delete(connectionKey);
    }

    const callerWaiter = this.reconnectWaiters.get(callerId);
    if (callerWaiter) {
      this.reconnectWaiters.delete(callerId);
      callerWaiter.resolve();
    }
    const connectionWaiter = this.connectionReconnectWaiters.get(connectionKey);
    if (connectionWaiter) {
      this.connectionReconnectWaiters.delete(connectionKey);
      connectionWaiter.resolve();
    }

    if (callerKind === "panel") {
      const auth = this.deps.runtimeCoordinator?.authorizePanelConnection(callerId, connectionId);
      if (!auth?.ok) {
        const msg: WsServerMessage = {
          type: "ws:auth-result",
          success: false,
          error: auth?.reason ?? "Panel runtime coordinator is unavailable",
        };
        ws.send(JSON.stringify(msg));
        ws.close(4090, "Panel runtime lease denied");
        return;
      }
    }

    // Membership entry gate (WP2 §4, authoritative-at-child): once the
    // connecting caller's host-verified subject is known, a hub-spawned
    // workspace child refuses a non-member before establishing any session
    // state. The production gate allows only the synthetic in-process `system`
    // subject or a live workspace member (root is implicit).
    if (this.deps.membershipGate) {
      const gateSubject =
        subject ?? this.resolveSubject(callerId, callerKind, agentBinding) ?? undefined;
      if (!this.deps.membershipGate(gateSubject)) {
        const msg: WsServerMessage = {
          type: "ws:auth-result",
          success: false,
          error: "Not a member of this workspace",
        };
        ws.send(JSON.stringify(msg));
        ws.close(4403, "Not a member of this workspace");
        return;
      }
    }

    const existing = this.connections.getConnection(callerId, connectionId);
    if (existing) {
      // De-register the old connection BEFORE closing it. A real `ws` closes
      // asynchronously (handleClose runs after we return, by which point the
      // replacement is registered, so it sees wasReplaced). But
      // SessionWebSocketShim also preserves ordered asynchronous close, but
      // de-register first so both transports classify any later close callback
      // as replacement cleanup rather than a reconnectable disconnect.
      this.cleanupClient(existing);
      this.sessions.markDisconnected(existing.caller.runtime.id, existing.caller.runtime.kind);
      existing.ws.close(4002, "Replaced by new connection");
    }
    const caller = this.verifiedCallerFor(callerId, callerKind, agentBinding, subject);
    // Denormalize the host-verified owning user once, at admission (WP4 §2.1).
    // Defensive invariant: only the in-process server can synthesize a subject;
    // every external unattributed caller fails here.
    let userId: string;
    try {
      userId = caller.subject?.userId ?? assertBootstrapSubject(caller);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const msg: WsServerMessage = { type: "ws:auth-result", success: false, error: message };
      ws.send(JSON.stringify(msg));
      ws.close(4006, "Unattributed caller");
      return;
    }
    const { sessionDirty } = this.sessions.markConnected(callerId, callerKind);

    const client: WsClientState = {
      ws,
      caller,
      connectionId,
      authenticated: true,
      authenticatedAt: Date.now(),
      userId,
      authorizedBy: grant?.issuedBy,
      clientLabel,
      clientSessionId,
      clientPlatform,
    };

    this.connections.addClient(client);
    // Install teardown immediately after registry admission. Any exception in
    // the remaining setup is rolled back by abortFailedAuthentication; a real
    // network close from this point onward must run the normal close path.
    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", (code, reason) => this.handleClose(client, code, reason.toString()));

    if (callerKind === "panel") {
      this.deps.runtimeCoordinator?.markConnected(callerId, connectionId);
      const previousDisconnectAt = this.lastDisconnectAt.get(callerId);
      log.info("panel connected", {
        callerId,
        sinceLastDisconnectMs:
          previousDisconnectAt === undefined ? null : Date.now() - previousDisconnectAt,
      });
    } else if (callerKind === "shell") {
      // Fail-loud observability: a paired device (or host shell) authenticated.
      // Log the device label/platform so operators can see WHICH device attached
      // (the pipe's first-connect log only knows the room, not the principal).
      log.info("device connected", {
        callerId,
        clientLabel: clientLabel ?? null,
        clientPlatform: clientPlatform ?? null,
      });
    }

    // Create per-client RPC client for server→client calls
    const transport = createWsServerTransport({ ws, clientId: `${callerId}:${connectionId}` });
    const bridge = createRpcClient({
      selfId: "server",
      callerKind: "server",
      transport: envelopeTransportFromWsServer(transport),
    });
    this.setBridge(callerId, connectionId, bridge, transport);
    if (this.deps.eventService) {
      const release = this.deps.eventService.registerTransportSession({
        callerId,
        callerKind,
        connectionId,
        userId,
        send: (event, payload) => {
          this.sendToWs(ws, {
            type: "ws:rpc",
            envelope: envelopeFromMessage({
              selfId: "main",
              from: "main",
              target: callerId,
              caller: SERVER_RESPONDER,
              message: { type: "event", fromId: "main", event, payload },
            }),
          });
        },
      });
      this.eventSessionReleases.set(client, release);
    }

    // Notify auth callback (e.g., for HarnessManager bridge resolution) before
    // acknowledging success. A host integration failure must roll admission
    // back instead of telling the client it owns a usable session.
    this.deps.onClientAuthenticate?.(callerId, callerKind);

    // Send auth result
    const authResult: WsServerMessage = {
      type: "ws:auth-result",
      success: true,
      contractVersion: RPC_CONTRACT_VERSION,
      callerId,
      callerKind,
      connectionId,
      serverBootId: this.bootId,
      sessionDirty,
      ...(deviceCredential ? { deviceCredential } : {}),
      ...(pairingContext ? { pairingContext } : {}),
    };
    ws.send(JSON.stringify(authResult));

    if (sessionDirty) {
      this.sessions.clearInbox(callerId);
    } else {
      for (const queued of this.sessions.takeInbox(callerId)) {
        this.sendToWs(ws, {
          type: "ws:routed",
          envelope: queued.envelope,
        });
      }
    }
  }

  private abortFailedAuthentication(ws: WebSocket, error: unknown): void {
    const client = this.connections.getBySocket(ws);
    if (client) this.releaseEventSession(client);
    if (client && this.connections.removeClient(client)) {
      if (client.caller.runtime.kind === "panel") {
        try {
          this.deps.runtimeCoordinator?.markDisconnected(
            client.caller.runtime.id,
            client.connectionId
          );
        } catch (rollbackError) {
          log.error("failed to roll back panel runtime admission", {
            callerId: client.caller.runtime.id,
            connectionId: client.connectionId,
            cause: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
      }
      this.sessions.markDisconnected(client.caller.runtime.id, client.caller.runtime.kind);
    }
    log.error("authentication task failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      const message: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: "Authentication failed",
      };
      ws.send(JSON.stringify(message));
    } catch {
      // The close below is the authoritative failure signal.
    }
    try {
      ws.close(1011, "Authentication failed");
    } catch {
      // A concurrently closed socket already has the desired terminal state.
    }
  }

  getConnectionForPrincipal(principalId: string): WsClientState | null {
    return this.pickPrimary(principalId) ?? null;
  }

  /** Count live authenticated connections whose caller kind is in `kinds`. */
  countConnectedClients(kinds: readonly CallerKind[]): number {
    return this.connections.countByKinds(new Set(kinds));
  }

  /**
   * Transport-fact presence accessors (WP4 §2.3/§5) consumed by WP8's host
   * `workspacePresence` service: which users hold a live connection to this
   * workspace child. Pure `{userId}`-level facts — no channel/roster concept.
   */
  listUsersWithLiveConnections(): string[] {
    return this.connections.listUsersWithLiveConnections();
  }

  isUserOnline(userId: string): boolean {
    return this.connections.isUserOnline(userId);
  }

  getUserConnections(userId: string): WsClientState[] {
    return this.connections.getUserConnections(userId);
  }

  /** Administrative teardown surface for one concrete runtime principal. */
  getPrincipalConnections(callerId: string): WsClientState[] {
    return this.connections.getCallerConnections(callerId);
  }

  /**
   * Retire one authenticated caller without racing its currently executing RPC
   * response. Authentication is already invalid when TokenManager invokes this;
   * this method owns only transport disposal. Idle sockets close immediately,
   * while a socket dispatching a unary request closes after that response has
   * been queued. The promise settles after every concrete socket has closed, so
   * callers may then tear down the WebRTC room that carries those sessions.
   */
  retireCaller(callerId: string): Promise<void> {
    const existing = this.callerRetirements.get(callerId);
    if (existing) return existing.promise;

    const clients = this.getCallerConnections(callerId);
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const sessionKind = this.sessions.retire(callerId);
    const retirement = {
      promise,
      resolve,
      pendingSockets: new Set(clients.map((client) => client.ws)),
      ...(clients[0]?.caller.runtime.kind || sessionKind
        ? { callerKind: clients[0]?.caller.runtime.kind ?? sessionKind }
        : {}),
      settled: false,
    };
    this.callerRetirements.set(callerId, retirement);
    this.clearReconnectStateForRetirement(callerId);

    for (const client of clients) {
      if ((this.activeInboundRequests.get(client.ws) ?? 0) === 0) {
        client.ws.close(4001, "Token revoked");
      }
    }
    this.maybeCompleteCallerRetirement(callerId);
    return promise;
  }

  private clearReconnectStateForRetirement(callerId: string): void {
    const terminal = createRelayError("Caller retired", "EACCES");
    const reconnect = this.reconnectWaiters.get(callerId);
    if (reconnect) {
      this.reconnectWaiters.delete(callerId);
      reconnect.reject(terminal);
    }
    const prefix = `${callerId}:`;
    for (const [key, timer] of this.disconnectTimers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.disconnectTimers.delete(key);
    }
    for (const [key, waiter] of this.connectionReconnectWaiters) {
      if (!key.startsWith(prefix)) continue;
      this.connectionReconnectWaiters.delete(key);
      waiter.reject(terminal);
    }
  }

  private maybeCompleteCallerRetirement(callerId: string): void {
    const retirement = this.callerRetirements.get(callerId);
    if (!retirement || retirement.settled || retirement.pendingSockets.size > 0) return;
    retirement.settled = true;
    if (retirement.callerKind) {
      this.deps.onClientDisconnect?.(callerId, retirement.callerKind);
    }
    retirement.resolve();
  }

  private finishRetiredConnection(client: WsClientState): void {
    const callerId = client.caller.runtime.id;
    const retirement = this.callerRetirements.get(callerId);
    if (!retirement) return;
    retirement.callerKind ??= client.caller.runtime.kind;
    retirement.pendingSockets.delete(client.ws);
    this.maybeCompleteCallerRetirement(callerId);
  }

  private beginInboundRequest(
    client: WsClientState,
    requestId: string,
    controller: AbortController
  ): void {
    let requests = this.inboundRequestControllers.get(client.ws);
    if (!requests) {
      requests = new Map();
      this.inboundRequestControllers.set(client.ws, requests);
    }
    const previous = requests.get(requestId);
    if (previous) {
      previous.abort(new Error("RPC request id reused on the same connection"));
    }
    requests.set(requestId, controller);
    this.activeInboundRequests.set(client.ws, (this.activeInboundRequests.get(client.ws) ?? 0) + 1);
  }

  private finishInboundRequest(
    client: WsClientState,
    requestId: string,
    controller: AbortController
  ): void {
    const requests = this.inboundRequestControllers.get(client.ws);
    if (requests?.get(requestId) === controller) requests.delete(requestId);
    const remaining = (this.activeInboundRequests.get(client.ws) ?? 1) - 1;
    if (remaining > 0) {
      this.activeInboundRequests.set(client.ws, remaining);
      return;
    }
    this.activeInboundRequests.delete(client.ws);
    const retirement = this.callerRetirements.get(client.caller.runtime.id);
    if (retirement?.pendingSockets.has(client.ws) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.close(4001, "Token revoked");
    }
  }

  /** Subscribe to connection add/drop + session-expiry change signals (WP4 §5). */
  onConnectionsChanged(listener: () => void): () => void {
    return this.connections.onConnectionsChanged(listener);
  }

  getAuthorizingShell(principalId: string): WsClientState | null {
    const panelConnection = this.getConnectionForPrincipal(principalId);
    const authorizingPrincipal = panelConnection?.authorizedBy;
    if (!authorizingPrincipal) return null;
    return this.getConnectionForPrincipal(authorizingPrincipal);
  }

  private callerKindForRuntimePrincipal(principalId: string): CallerKind {
    const kind = this.deps.entityCache?.resolve(principalId)?.kind;
    return callerKindForPrincipalKind(kind);
  }

  private subjectForGrantIssuer(issuedBy: string): UserSubject | null {
    if (issuedBy === "server") return SYSTEM_SUBJECT;
    if (
      issuedBy === "electron-main" ||
      issuedBy === "headless-host" ||
      issuedBy.startsWith("shell:")
    ) {
      return this.resolveSubject(issuedBy, "shell");
    }
    const kind = this.deps.entityCache?.resolveActive(issuedBy)?.kind;
    if (!kind) return null;
    return this.resolveSubject(issuedBy, callerKindForPrincipalKind(kind));
  }

  private handleMessage(client: WsClientState, data: Buffer | ArrayBuffer | Buffer[]): void {
    if (!this.connections.isActiveClient(client)) return;

    let msg: WsClientMessage;
    try {
      msg = JSON.parse(data.toString()) as WsClientMessage;
    } catch (error) {
      log.warn("malformed ws frame", {
        callerId: client.caller.runtime.id,
        callerKind: client.caller.runtime.kind,
        cause: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Authentication is admission, not a lifetime grant. Account/device/agent
    // revocation and workspace membership changes are read from their live
    // stores before ANY post-auth frame is processed. This intentionally also
    // gates routed responses/tool results: a revoked caller cannot keep acting
    // merely because the hub's best-effort socket close failed.
    if (this.callerRetirements.has(client.caller.runtime.id)) {
      if ((this.activeInboundRequests.get(client.ws) ?? 0) === 0) {
        client.ws.close(4001, "Token revoked");
      }
      return;
    }
    if (
      msg.type !== "ws:auth" &&
      this.deps.liveCallerGate &&
      !this.deps.liveCallerGate(client.caller, client.authorizedBy)
    ) {
      client.ws.close(4403, "Caller identity or workspace membership is no longer active");
      return;
    }

    switch (msg.type) {
      case "ws:rpc": {
        const inboundEnvelope = (msg as { envelope?: RpcEnvelope }).envelope;
        if (!inboundEnvelope?.message) {
          log.warn("malformed ws:rpc frame without envelope", {
            callerId: client.caller.runtime.id,
            callerKind: client.caller.runtime.kind,
          });
          return;
        }
        const envelope = stampEnvelopeCaller(inboundEnvelope, authenticatedCallerOf(client.caller));
        const rpcMessage = envelope.message;
        // If the message belongs to a server-initiated call via the client's RPC bridge,
        // route it to the client transport. Streaming responses use `stream-frame`; without
        // this branch, server -> extension stream callers wait forever for HEAD.
        if (
          rpcMessage.type === "response" ||
          rpcMessage.type === "event" ||
          rpcMessage.type === "stream-frame"
        ) {
          const transport = this.connections.getTransport(
            client.caller.runtime.id,
            client.connectionId
          );
          if (transport) {
            transport.deliver(client.caller.runtime.id, rpcMessage);
            // Bridge-delivered messages are not new service requests.
            return;
          }
        }
        void this.handleRpc(client, rpcMessage, envelope);
        break;
      }
      case "ws:tool-result":
        this.handleToolResult(msg.callId, msg.result as ToolExecutionResult);
        break;
      case "ws:route": {
        if (!msg.envelope?.message) {
          log.warn("malformed ws:route frame without envelope", {
            callerId: client.caller.runtime.id,
            callerKind: client.caller.runtime.kind,
          });
          return;
        }
        const routeEnvelope = stampEnvelopeCaller(
          msg.envelope,
          authenticatedCallerOf(client.caller)
        );
        void this.handleRoute(
          client,
          routeEnvelope.target,
          routeEnvelope.message,
          msg.targetConnectionId,
          routeEnvelope
        );
        break;
      }
      case "ws:auth":
        // Ignore duplicate auth messages
        break;
    }
  }

  private async handleRpc(
    client: WsClientState,
    message: RpcMessage,
    envelope: RpcEnvelope
  ): Promise<void> {
    if (message.type === "stream-request") {
      await this.streamingRelay.handleWsRequest(client, message, envelope);
      return;
    }
    if (message.type === "stream-cancel") {
      this.streamingRelay.cancel(client, message.requestId);
      return;
    }
    if (message.type === "request-cancel") {
      this.inboundRequestControllers
        .get(client.ws)
        ?.get(message.requestId)
        ?.abort(new Error("RPC call aborted by caller"));
      return;
    }
    if (message.type === "stream-frame") {
      // Stream frames flow server→client during a streaming response.
      // A client sending one is malformed; ignore.
      return;
    }
    if (message.type !== "request") return;

    const request = message as RpcRequest;
    const parsed = parseServiceMethod(request.method);

    if (!parsed) {
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: request.requestId,
          error: `Invalid method format: "${request.method}". Expected "service.method"`,
          errorKind: "protocol",
        }),
      });
      return;
    }

    const { service, method } = parsed;

    const idempotencyKey = envelope.delivery.idempotencyKey;
    const readOnly = envelope.delivery.readOnly === true;
    const dispatcher = this.dispatcher;

    const abort = new AbortController();
    this.beginInboundRequest(client, request.requestId, abort);
    try {
      const causalParent = await this.resolveCausalParent(client.caller, request);
      const ctx = this.serviceContextForRpcMessage(client, request, {
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...(causalParent ? { causalParent } : {}),
        signal: abort.signal,
      });
      const result = await dispatcher.dispatch(ctx, service, method, request.args);
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: request.requestId,
          result,
        }),
      });
    } catch (error) {
      const errorCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
          errorKind: rpcErrorKindOf(error, "internal"),
          ...(errorCode ? { errorCode } : {}),
          ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
        }),
      });
    } finally {
      // `sendToWs` above synchronously queues the response. A concurrent token
      // revocation may close this connection only after that ordering point.
      this.finishInboundRequest(client, request.requestId, abort);
    }
  }

  private handleToolResult(callId: string, result: ToolExecutionResult): void {
    const pending = this.pendingToolCalls.get(callId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingToolCalls.delete(callId);
    pending.resolve(result);
  }

  private async handleRoute(
    client: WsClientState,
    targetId: string,
    message: RpcMessage,
    targetConnectionId: string | undefined,
    routeEnvelope: RpcEnvelope
  ): Promise<void> {
    // A routed stream is still owned by the caller connection's canonical
    // streaming relay. That relay performs target authorization, dispatches the
    // connectionless DO stream, frames the response back to this exact socket,
    // and owns cancellation. Letting stream messages continue through the
    // ordinary unary route below silently drops them when the target is a DO
    // (there is deliberately no target WebSocket to forward to).
    if (message.type === "stream-request") {
      await this.streamingRelay.handleWsRequest(client, message, routeEnvelope);
      return;
    }
    if (message.type === "stream-cancel") {
      this.streamingRelay.cancel(client, message.requestId);
      return;
    }

    if (
      message.type === "request" &&
      (message.causalParent ||
        (client.caller.runtime.kind === "extension" && message.parentRequestId))
    ) {
      try {
        const causalParent = await this.resolveCausalParent(client.caller, message);
        if (causalParent && message.causalParent !== causalParent) {
          message = { ...message, causalParent };
          routeEnvelope = { ...routeEnvelope, message };
        }
      } catch (error) {
        this.sendRouteError(client, targetId, message, error);
        return;
      }
    }
    const method = message.type === "request" ? message.method : undefined;
    const auth = this.checkRelayAuth(
      client.caller.runtime.id,
      client.caller.runtime.kind,
      targetId,
      method
    );
    if (!auth.ok) {
      this.sendRouteError(client, targetId, message, createRelayError(auth.reason, "EACCES"));
      return;
    }

    if (message.type === "response") {
      if (targetId === "server") {
        this.failServerBoundRoutedResponse(client, message);
        return;
      }

      // MED-7: route the response back to the ORIGIN CONNECTION that issued the
      // request, not merely to the origin caller's primary connection. A
      // multi-connection origin would otherwise misroute the reply to the wrong
      // socket. If the origin is unknown (never recorded, or evicted by the
      // count cap on `routedRequestOrigins`) there is no correct destination —
      // reject the responder's relay rather than best-effort delivering to the
      // primary connection (which is the silent-misroute being fixed here).
      const origin = this.routedRequestOrigins.get(message.requestId);
      if (!origin || origin.callerId !== targetId) {
        // No correct destination is known — reject the responder's relay
        // instead of best-effort delivering to the target's primary connection
        // (the silent misroute). Surfaces the same TARGET_NOT_REACHABLE shape an
        // unreachable target produced before this connection-keyed routing.
        this.sendRouteError(
          client,
          targetId,
          message,
          createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE")
        );
        return;
      }
      this.routedRequestOrigins.delete(message.requestId);
      void this.resolveWsRelayTarget(origin.callerId, origin.connectionId).then(
        (originClient) => {
          this.sendToWs(originClient.ws, {
            type: "ws:routed",
            envelope: routeEnvelope,
          });
        },
        (err) => this.sendRouteError(client, targetId, message, err)
      );
      return;
    }

    // FIX 1 (unification): events ALWAYS flow through the single canonical
    // `relayEvent` path — whether or not the target currently looks connected,
    // and across every target kind (panel/shell fan-out, DO, worker). Collapsing
    // delivery here is what prevents an event path from being silently
    // re-implemented inline (and a target kind, e.g. connectionless DOs,
    // forgotten). `relayEvent` is fire-and-forget; an undeliverable event
    // rejects and surfaces as a logged `ws:routed-event-error` rather than being
    // dropped or stalling behind a reconnect grace window.
    if (message.type === "event") {
      void this.relayEvent(
        client.caller.runtime.id,
        client.caller.runtime.kind,
        targetId,
        message.event,
        message.payload,
        targetConnectionId
      ).catch((err) => {
        this.sendRouteError(client, targetId, message, err);
      });
      return;
    }

    const targetClient = this.pickRoutableTarget(targetId, targetConnectionId);
    if (!targetClient || targetClient.ws.readyState !== WebSocket.OPEN) {
      // Target not connected via WS — try HTTP relay for workers/DOs; panel
      // and shell targets fail fast when unreachable.
      if (message.type === "request") {
        const { requestId, method: reqMethod, args: reqArgs } = message;
        const relayCallerScope = this.relayCallerScopeForRpcMessage(client, message);
        this.recordRoutedRequestOrigin(requestId, client);
        void this.relayCall(
          client.caller.runtime.id,
          client.caller.runtime.kind,
          targetId,
          reqMethod,
          reqArgs ?? [],
          targetConnectionId,
          relayMetaFromEnvelope(routeEnvelope),
          relayCallerScope
        ).then(
          (result) => {
            void this.sendRoutedResponseToOrigin(
              { callerId: client.caller.runtime.id, connectionId: client.connectionId },
              targetId,
              {
                type: "response",
                requestId,
                result,
              }
            ).catch((sendErr) => {
              this.sendRouteError(client, targetId, message, sendErr);
            });
          },
          (err) => {
            const errorCode = getErrorCode(err);
            void this.sendRoutedResponseToOrigin(
              { callerId: client.caller.runtime.id, connectionId: client.connectionId },
              targetId,
              {
                type: "response",
                requestId,
                error: err instanceof Error ? err.message : String(err),
                errorKind: rpcErrorKindOf(err, "transport"),
                ...(errorCode ? { errorCode } : {}),
              }
            ).catch((sendErr) => this.sendRouteError(client, targetId, message, sendErr));
          }
        );
      }
      // `response` and `event` messages are fully handled (and returned) above,
      // so only `request`/stream messages reach this not-connected block.
      return;
    }

    // Events and responses were already dispatched and returned above; only
    // `request`/stream messages reach here. Record the origin connection for
    // routed requests so the eventual response is delivered back to the exact
    // connection that issued it (see MED-7 response handling above), and the
    // CALLEE connection the request is delivered to so the caller can be
    // settled if that callee terminally dies (§3.4, failRoutedRequestsForCallee).
    if (message.type === "request") {
      this.recordRoutedRequestOrigin(message.requestId, client, {
        targetId,
        calleeId: targetClient.caller.runtime.id,
        connectionId: targetClient.connectionId,
      });
    }

    this.sendToWs(targetClient.ws, {
      type: "ws:routed",
      envelope: routeEnvelope,
    });
  }

  /**
   * Convert a relay error into a routed response back to the caller.
   *
   * For request-typed messages, sends a `ws:routed` carrying a response with
   * `requestId` echoed back so the client's RPC bridge can reject the matching
   * promise. Streaming requests receive an ERROR frame so their head promise
   * settles too. For response and event messages, surface the drop explicitly
   * back to the sender.
   */
  private sendRouteError(
    client: WsClientState,
    targetId: string,
    message: RpcMessage,
    err: unknown
  ): void {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = getErrorCode(err);
    if (message.type === "request") {
      this.sendToWs(client.ws, {
        type: "ws:routed",
        envelope: envelopeForWsDelivery(targetId, "unknown", client.caller.runtime.id, {
          type: "response",
          requestId: message.requestId,
          error: errorMessage,
          errorKind: rpcErrorKindOf(err, "transport"),
          ...(errorCode ? { errorCode } : {}),
        }),
      });
      return;
    }

    if (message.type === "stream-request") {
      this.sendToWs(client.ws, {
        type: "ws:routed",
        envelope: envelopeForWsDelivery(targetId, "unknown", client.caller.runtime.id, {
          type: "stream-frame",
          requestId: message.requestId,
          fromId: targetId,
          frameType: FRAME_ERROR,
          payload: JSON.stringify({
            status: 403,
            message: errorMessage,
            code: errorCode,
            errorKind: rpcErrorKindOf(err, "transport"),
          }),
        }),
      });
      return;
    }

    if (message.type === "response") {
      log.warn("relay response drop", {
        callerId: client.caller.runtime.id,
        callerKind: client.caller.runtime.kind,
        targetId,
        requestId: message.requestId,
        error: errorMessage,
        errorKind: rpcErrorKindOf(err, "transport"),
        errorCode,
      });
      this.sendToWs(client.ws, {
        type: "ws:routed-response-error",
        targetId,
        requestId: message.requestId,
        error: errorMessage,
        errorKind: rpcErrorKindOf(err, "transport"),
        ...(errorCode ? { errorCode } : {}),
      });
      return;
    }

    {
      const eventMessage = message as RpcEvent;
      log.warn("relay event drop", {
        callerId: client.caller.runtime.id,
        callerKind: client.caller.runtime.kind,
        targetId,
        event: eventMessage.event,
        fromId: eventMessage.fromId,
        error: errorMessage,
        errorCode,
      });
      this.sendToWs(client.ws, {
        type: "ws:routed-event-error",
        targetId,
        event: eventMessage.event,
        error: errorMessage,
        errorKind: rpcErrorKindOf(err, "transport"),
        ...(errorCode ? { errorCode } : {}),
      });
    }
  }

  private failServerBoundRoutedResponse(client: WsClientState, message: RpcResponse): void {
    const err = createRelayError(
      `Protocol error: response for server request ${message.requestId} was sent via ws:route; use ws:rpc for server-bound responses`,
      "RPC_PROTOCOL_ERROR"
    );
    const errorMessage = err.message;
    const errorCode = getErrorCode(err);

    log.warn("server-bound routed response", {
      callerId: client.caller.runtime.id,
      callerKind: client.caller.runtime.kind,
      requestId: message.requestId,
      error: errorMessage,
      errorCode,
    });

    const transport = this.connections.getTransport(client.caller.runtime.id, client.connectionId);
    if (transport) {
      transport.deliver(client.caller.runtime.id, {
        type: "response",
        requestId: message.requestId,
        error: errorMessage,
        errorKind: "protocol",
        ...(errorCode ? { errorCode } : {}),
      });
    }

    this.sendToWs(client.ws, {
      type: "ws:routed-response-error",
      targetId: "server",
      requestId: message.requestId,
      error: errorMessage,
      errorKind: "protocol",
      ...(errorCode ? { errorCode } : {}),
    });
  }

  private recordRoutedRequestOrigin(
    requestId: string,
    client: WsClientState,
    callee?: { targetId: string; calleeId: string; connectionId: string }
  ): void {
    this.routedRequestOrigins.set(requestId, {
      callerId: client.caller.runtime.id,
      connectionId: client.connectionId,
      ...(callee ? { callee } : {}),
    });

    // Bound memory if a responder never replies. Drop oldest entries first.
    const maxEntries = 10_000;
    while (this.routedRequestOrigins.size > maxEntries) {
      const oldest = this.routedRequestOrigins.keys().next().value as string | undefined;
      if (!oldest) break;
      this.routedRequestOrigins.delete(oldest);
    }
  }

  private async sendRoutedResponseToOrigin(
    origin: { callerId: string; connectionId: string },
    fromId: string,
    message: RpcResponse
  ): Promise<void> {
    const originClient = await this.resolveWsRelayTarget(origin.callerId, origin.connectionId);
    this.sendToWs(originClient.ws, {
      type: "ws:routed",
      envelope: envelopeForWsDelivery(fromId, "unknown", origin.callerId, message),
    });
  }

  private handleClose(client: WsClientState, code?: number, reason?: string): void {
    const callerId = client.caller.runtime.id;
    const callerKind = client.caller.runtime.kind;
    const retirement = this.callerRetirements.get(callerId);
    const connectionKey = this.connectionKey(callerId, client.connectionId);
    this.releaseEventSession(client);
    const removedActive = this.connections.removeClient(client);
    const wasReplaced = !removedActive;

    this.streamingRelay.abortConnection(client);
    for (const controller of this.inboundRequestControllers.get(client.ws)?.values() ?? []) {
      controller.abort(new Error("RPC connection closed"));
    }
    this.inboundRequestControllers.delete(client.ws);

    if (!wasReplaced && callerKind === "panel") {
      this.deps.runtimeCoordinator?.markDisconnected(callerId, client.connectionId);
      this.lastDisconnectAt.set(callerId, Date.now());
      log.info("panel disconnected", {
        callerId,
        code: code ?? null,
        reason: reason || null,
        initiator:
          code === 4001
            ? "token-revoke"
            : code === 4002
              ? "replaced"
              : code === 1005 || code === 1006
                ? "network-or-reload"
                : "other",
      });
    }
    if (!wasReplaced && !retirement) {
      this.sessions.markDisconnected(callerId, callerKind);
    }

    // Reject pending tool calls for this client
    for (const [callId, pending] of this.pendingToolCalls) {
      if (pending.clientWs === client.ws) {
        clearTimeout(pending.timeout);
        this.pendingToolCalls.delete(callId);
        pending.reject(new Error("Client disconnected"));
      }
    }

    // Closing sockets is part of stop(). Their close events may arrive on a
    // later turn after the registries have been cleared. Shutdown is terminal:
    // cleanup the concrete connection above, but never recreate session grace
    // state or timers from a delayed close callback.
    if (this.stopped) {
      this.finishRetiredConnection(client);
      return;
    }

    // Revocation is terminal, unlike a network drop. Its credential is already
    // invalid and the ordered close has drained, so skip all reconnect grace
    // state and settle transport-owned work immediately.
    if (retirement) {
      this.failRoutedRequestsForCallee(callerId, client.connectionId);
      this.cleanupRoutedOriginsForConnection(callerId, client.connectionId);
      this.finishRetiredConnection(client);
      return;
    }

    // If this socket was replaced, the replacement is already connected under the
    // same caller/connection id. Do not arm reconnect waiters or expire the live lease.
    if (wasReplaced) return;

    if (!this.connectionReconnectWaiters.has(connectionKey)) {
      let resolveWaiter!: () => void;
      let rejectWaiter!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolveWaiter = res;
        rejectWaiter = rej;
      });
      void promise.catch((error) => {
        const code = getErrorCode(error);
        if (code === "RECONNECT_GRACE_EXPIRED" || code === "SERVER_SHUTTING_DOWN") return;
        log.error("unexpected connection reconnect waiter rejection", {
          callerId,
          connectionId: client.connectionId,
          cause: error instanceof Error ? error.message : String(error),
          errorCode: code,
        });
      });
      this.connectionReconnectWaiters.set(connectionKey, {
        promise,
        resolve: resolveWaiter,
        reject: rejectWaiter,
      });
    }

    const callerHasOtherConnections = this.getCallerConnections(callerId).length > 0;
    const existing = this.disconnectTimers.get(connectionKey);
    if (existing) clearTimeout(existing);

    if (!callerHasOtherConnections && !this.reconnectWaiters.has(callerId)) {
      let resolveWaiter!: () => void;
      let rejectWaiter!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolveWaiter = res;
        rejectWaiter = rej;
      });
      void promise.catch((error) => {
        const code = getErrorCode(error);
        if (code === "RECONNECT_GRACE_EXPIRED" || code === "SERVER_SHUTTING_DOWN") return;
        log.error("unexpected reconnect waiter rejection", {
          callerId,
          cause: error instanceof Error ? error.message : String(error),
          errorCode: code,
        });
      });
      this.reconnectWaiters.set(callerId, {
        promise,
        resolve: resolveWaiter,
        reject: rejectWaiter,
      });
    }

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(connectionKey);
      const waiter = this.reconnectWaiters.get(callerId);
      if (waiter) {
        this.reconnectWaiters.delete(callerId);
        waiter.reject(
          createRelayError(
            "Client did not reconnect within grace window",
            "RECONNECT_GRACE_EXPIRED"
          )
        );
      }
      const connectionWaiter = this.connectionReconnectWaiters.get(connectionKey);
      if (connectionWaiter) {
        this.connectionReconnectWaiters.delete(connectionKey);
        connectionWaiter.reject(
          createRelayError(
            "Client did not reconnect within grace window",
            "RECONNECT_GRACE_EXPIRED"
          )
        );
      }
      this.failRoutedRequestsForCallee(callerId, client.connectionId);
      this.cleanupRoutedOriginsForConnection(callerId, client.connectionId);
      if (this.getCallerConnections(callerId).length === 0) {
        this.deps.onClientDisconnect?.(callerId, callerKind);
      }
    }, RpcServer.DISCONNECT_GRACE_MS);

    this.disconnectTimers.set(connectionKey, timer);
  }

  private cleanupClient(client: WsClientState): void {
    const callerId = client.caller.runtime.id;
    const connectionKey = this.connectionKey(callerId, client.connectionId);
    const pendingTimer = this.disconnectTimers.get(connectionKey);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.disconnectTimers.delete(connectionKey);
    }
    this.releaseEventSession(client);
    this.connections.removeClient(client);
  }

  private releaseEventSession(client: WsClientState): void {
    const release = this.eventSessionReleases.get(client);
    if (!release) return;
    this.eventSessionReleases.delete(client);
    release();
  }

  private cleanupRoutedOriginsForConnection(callerId: string, connectionId: string): void {
    for (const [requestId, origin] of this.routedRequestOrigins) {
      if (origin.callerId === callerId && origin.connectionId === connectionId) {
        this.routedRequestOrigins.delete(requestId);
      }
    }
  }

  /**
   * §3.4 ("nothing hangs, ever"): a routed request that was DELIVERED to a
   * callee cannot be recovered by inbox replay or the transport re-drive if
   * that callee terminally dies — only the server knows a response will never
   * come. Runs at the callee's TERMINAL departure (grace expiry, which is also
   * where token-revoke closes land), the same point its own routed origins are
   * dropped; a mere pipe-down within grace leaves entries alone (resubscribe
   * replay / re-drive own that case). Deleting the map entry FIRST arbitrates
   * against a concurrently arriving response (handleRoute's response branch
   * does get→delete on the same map): whichever consumes the entry settles the
   * caller, the loser bounces to the responder as TARGET_NOT_REACHABLE — the
   * caller settles exactly once.
   */
  private failRoutedRequestsForCallee(calleeId: string, connectionId: string): void {
    for (const [requestId, origin] of this.routedRequestOrigins) {
      const callee = origin.callee;
      if (!callee || callee.calleeId !== calleeId || callee.connectionId !== connectionId) {
        continue;
      }
      this.routedRequestOrigins.delete(requestId);
      // Same error shape relayCall produces when a bridge-relayed target's
      // grace window expires; the client's routed-response-error handler turns
      // it into a rejecting response, settling the pending.
      void this.resolveWsRelayTarget(origin.callerId, origin.connectionId).then(
        (originClient) => {
          this.sendToWs(originClient.ws, {
            type: "ws:routed-response-error",
            targetId: callee.targetId,
            requestId,
            error: `Target ${callee.targetId} did not reconnect within grace window`,
            errorKind: "transport",
            errorCode: "RECONNECT_GRACE_EXPIRED",
          });
        },
        (deliveryErr) => {
          // Caller is itself gone (its own terminal teardown rejects its
          // pendings client-side) — nothing to settle, just record the drop.
          log.warn("stranded routed request error undeliverable", {
            requestId,
            callerId: origin.callerId,
            calleeId,
            cause: deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr),
          });
        }
      );
    }
  }

  // ===========================================================================
  // Public API for server-side pushes
  // ===========================================================================

  /**
   * Get the RPC client for a connected client.
   * Returns undefined if the client is not connected.
   *
   * The server can use this client to call methods exposed by the client.
   */
  getClientBridge(callerId: string): RpcClient | undefined {
    return this.connections.getPrimaryBridge(callerId);
  }

  /** Send a message to a specific caller by ID */
  sendToClient(callerId: string, msg: WsServerMessage): void {
    for (const client of this.getCallerConnections(callerId)) {
      this.sendToWs(client.ws, msg);
    }
  }

  /** Get the WsClientState for a caller (for creating StreamTargets, etc.) */
  getClientState(callerId: string): WsClientState | undefined {
    return this.pickPrimary(callerId);
  }

  // ===========================================================================
  // HTTP POST /rpc endpoint
  // ===========================================================================

  private authenticateHttpRequest(req: import("http").IncomingMessage): HttpRpcAdmission {
    const authHeader = req.headers["authorization"];
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return { ok: false, status: 401, body: { error: "Missing authorization" } };
    }

    if (this.deps.tokenManager.validateAdminToken(token)) {
      return { ok: false, status: 401, body: { error: ADMIN_RPC_AUTH_ERROR } };
    }

    const entry = this.deps.tokenManager.validateToken(token);
    if (!entry) {
      return { ok: false, status: 401, body: { error: "Invalid token" } };
    }
    if (entry.callerKind === "shell" && entry.callerId === "shell") {
      return {
        ok: false,
        status: 403,
        body: { error: 'callerId:"shell" cannot authenticate over HTTP RPC' },
      };
    }
    let callerKind = entry.callerKind;
    let callerId: string;
    try {
      callerId = resolveHttpRuntimeCaller(
        entry.callerId,
        callerKind,
        req.headers[RPC_RUNTIME_ID_HEADER]
      );
      if (callerId !== entry.callerId) {
        callerKind = this.callerKindForRuntimePrincipal(callerId);
      }
    } catch (error) {
      return {
        ok: false,
        status: 403,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
    const httpAgentBinding = callerId === entry.callerId ? entry.agentBinding : undefined;
    if (!this.isWorkspaceMember(callerId, callerKind, httpAgentBinding)) {
      return {
        ok: false,
        status: 403,
        body: { error: "Not a member of this workspace", code: "EACCES" },
      };
    }
    return {
      ok: true,
      caller: {
        callerId,
        callerKind,
        ...(httpAgentBinding ? { agentBinding: httpAgentBinding } : {}),
      },
    };
  }

  /**
   * Dispatch a `request` envelope arriving over HTTP `/rpc`. `target === "main"`
   * is a direct service-dispatch (with deferral opt-in); any other target is a
   * relay. Returns the raw result, or a `DeferredResult` sentinel when parked.
   */
  private async handleEnvelopeRequest(
    callerId: string,
    callerKind: CallerKind,
    agentBinding: import("@vibestudio/identity/types").AgentBinding | undefined,
    envelope: RpcEnvelope,
    message: RpcRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    const targetId = envelope.target;
    const method = message.method;
    const args = message.args ?? [];
    const requestId = message.requestId;
    const idempotencyKey = envelope.delivery.idempotencyKey;
    const readOnly = envelope.delivery.readOnly === true;
    const verifiedCaller = this.verifiedCallerFor(callerId, callerKind, agentBinding);
    const causalParent = await this.resolveCausalParent(verifiedCaller, message);
    // A causal parent authenticates invocation lineage; it does not change the
    // authorizing origin. Harness-owned tool and closure calls retain their
    // sealed code identity. EvalDO is marked session-originated when its exact
    // active runtime identity is resolved in verifiedCallerFor().
    const invocationCaller = verifiedCaller;

    // Direct service dispatch
    if (targetId === "main") {
      const parsed = parseServiceMethod(method);
      if (!parsed) throw new Error(`Invalid method format: "${method}"`);

      // A handler may complete out-of-band only when the caller explicitly opted
      // in (via callDeferred → `deferrable`), stamped a requestId, and can receive
      // an inbound onDeferredResult (DO/worker). Plain `call` callers never defer.
      const canDefer =
        message.deferrable === true &&
        !!requestId &&
        (callerKind === "do" || callerKind === "worker");
      const deferredRequestId = canDefer ? requestId : undefined;
      const deferral = deferredRequestId
        ? this.deferrals.createApi({
            callerId,
            requestId: deferredRequestId,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            service: parsed.service,
            method: parsed.method,
          })
        : undefined;
      const ctx: ServiceContext = {
        caller: invocationCaller,
        ...(causalParent ? { causalParent } : {}),
        ...(requestId ? { requestId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(deferral ? { deferral } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        signal,
      };
      const dispatched = await this.dispatcher.dispatch(ctx, parsed.service, parsed.method, args);
      return dispatched;
    }

    // Relay to another target
    const auth = this.checkRelayAuth(callerId, callerKind, targetId, method);
    if (!auth.ok) throw createRelayError(auth.reason, "EACCES");
    const authenticatedCaller = verifiedCaller;
    return await this.relayCall(
      callerId,
      callerKind,
      targetId,
      method,
      args,
      undefined,
      {
        ...(requestId ? { requestId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...(causalParent ? { causalParent } : {}),
      },
      {
        authenticatedCaller,
        invocationCaller,
      }
    );
  }

  /** Dispatch an `event` envelope arriving over HTTP `/rpc` (relay to a target). */
  private async handleEnvelopeEvent(
    callerId: string,
    callerKind: CallerKind,
    envelope: RpcEnvelope,
    message: RpcEvent
  ): Promise<void> {
    const targetId = envelope.target;
    const auth = this.checkRelayAuth(callerId, callerKind, targetId);
    if (!auth.ok) throw new Error(auth.reason);
    await this.relayEvent(callerId, callerKind, targetId, message.event, message.payload);
  }

  // ===========================================================================
  // Relay helpers (used by both HTTP POST /rpc and WS handleRoute)
  // ===========================================================================

  /**
   * Enforce authorization for relay calls/events.
   *
   * RPC relay authorization is open between authenticated participants except
   * for host-control RPC. Extension children expose their transport control
   * plane under `extension.*`; userland must reach extension APIs through the
   * host `extensions` service so provider exclusivity and service schemas are
   * applied before the child runs.
   */
  private checkRelayAuth(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method?: string
  ): RelayAuthCheck {
    if (callerKind !== "server" && typeof method === "string" && method.startsWith("extension.")) {
      return {
        ok: false,
        reason:
          `Caller ${callerId} (${callerKind}) cannot directly relay host-control method ` +
          `${method} to ${targetId}; call the host extensions service instead`,
      };
    }
    return (
      this.deps.relayAuthorization?.({
        callerId,
        callerKind,
        targetId,
        ...(method ? { method } : {}),
      }) ?? { ok: true }
    );
  }

  private async awaitReconnectIfPending(targetId: string): Promise<ReconnectOutcome> {
    const waiter = this.reconnectWaiters.get(targetId);
    if (!waiter) return { kind: "no-waiter" };

    try {
      await waiter.promise;
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "SERVER_SHUTTING_DOWN") return { kind: "server-shutdown" };
      if (code === "RECONNECT_GRACE_EXPIRED") return { kind: "grace-expired" };
      throw error;
    }

    const client = this.pickPrimary(targetId);
    if (client?.ws.readyState === WebSocket.OPEN) {
      return { kind: "reconnected", client };
    }

    throw new Error(
      `Invariant violated: reconnect waiter resolved for ${targetId} but no client found`
    );
  }

  async callTarget<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[] = [],
    options?: RpcCallOptions
  ): Promise<T> {
    return this.relayCall(
      "main",
      "server",
      targetId,
      method,
      args,
      undefined,
      options
    ) as Promise<T>;
  }

  private isActiveDeferredRecipient(callerId: string): boolean {
    const cache = this.deps.entityCache;
    return !cache || cache.resolveActive(callerId) != null;
  }

  async streamCallTarget(targetId: string, method: string, ...args: unknown[]): Promise<Response> {
    const wsClient = this.pickRoutableTarget(targetId);
    if (wsClient?.ws.readyState !== WebSocket.OPEN) {
      throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
    }
    const routedTargetId = this.resolveRoutableTargetId(targetId);
    const bridge = this.connections.getBridge(routedTargetId, wsClient.connectionId);
    if (!bridge) {
      throw createRelayError(`Target bridge not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
    }
    return bridge.stream(routedTargetId, method, args);
  }

  private async relayCall(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method: string,
    args: unknown[],
    targetConnectionId?: string,
    meta?: RelayCallMeta,
    relayCallerScope?: RelayCallerScope
  ): Promise<unknown> {
    const isPanelOrShellTarget = !targetId.startsWith("do:") && !targetId.startsWith("worker:");
    if (isPanelOrShellTarget) {
      const options = relayCallOptions(meta);
      const routedTargetId = this.resolveRoutableTargetId(targetId);
      const wsClient = this.pickRoutableTarget(targetId, targetConnectionId);
      if (wsClient?.ws.readyState === WebSocket.OPEN) {
        const bridge = this.connections.getBridge(routedTargetId, wsClient.connectionId);
        if (bridge) {
          return await bridge.call(routedTargetId, method, args, options);
        }
      }

      if (targetConnectionId) {
        const reconnectedClient = await this.resolveWsRelayTarget(
          routedTargetId,
          targetConnectionId
        );
        const bridge = this.connections.getBridge(routedTargetId, reconnectedClient.connectionId);
        if (!bridge) {
          throw new Error(
            `Target ${targetId}:${targetConnectionId} reconnected but bridge missing`
          );
        }
        return await bridge.call(routedTargetId, method, args, options);
      }

      const outcome = await this.awaitReconnectIfPending(routedTargetId);
      switch (outcome.kind) {
        case "reconnected": {
          const bridge = this.connections.getBridge(routedTargetId, outcome.client.connectionId);
          if (!bridge) {
            throw new Error(`Target ${targetId} reconnected but bridge missing`);
          }
          return await bridge.call(routedTargetId, method, args, options);
        }
        case "server-shutdown":
          throw createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN");
        case "grace-expired":
          throw createRelayError(
            `Target ${targetId} did not reconnect within grace window`,
            "RECONNECT_GRACE_EXPIRED"
          );
        case "no-waiter":
          throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
      }
    }

    if (targetId.startsWith("do:")) {
      return await this.relayToDO(
        callerId,
        callerKind,
        targetId,
        method,
        args,
        meta,
        relayCallerScope
      );
    }

    if (targetId.startsWith("worker:")) {
      return await this.relayToWorker(callerId, callerKind, targetId, method, args, meta);
    }

    throw createRelayError(`Unknown target kind: ${targetId}`, "UNKNOWN_TARGET_KIND");
  }

  /**
   * Mint the single host attestation used by every direct DO transport.
   * Unary and streaming calls are the same semantic invocation boundary; only
   * their response ownership differs, so their authority derivation must not.
   */
  private async directDOAuthorization(input: {
    caller: VerifiedCaller;
    ref: { source: string; className: string; objectKey: string };
    method: string;
    args: readonly unknown[];
    readOnly?: boolean;
    /** Response streams cannot be replayed after EACQUIRE; park before dispatch. */
    waitForAuthority?: boolean;
    signal?: AbortSignal;
  }): Promise<DirectAuthorityAttestation> {
    const workspaceId = this.deps.workspaceId;
    if (!workspaceId) {
      throw new Error("Direct DO relay requires an authority workspace identity");
    }
    const workspaceAuthorities = input.method.startsWith("__event:")
      ? []
      : await this.deps.resolveWorkspaceDirectAuthority?.({
          caller: input.caller,
          ...input.ref,
          method: input.method,
        });
    if (workspaceAuthorities && workspaceAuthorities.length > 1) {
      throw createRelayError(
        `Direct DO target ${input.ref.source}:${input.ref.className}:${input.ref.objectKey} has ambiguous workspace service authority`,
        "EACCES"
      );
    }
    const workspaceAuthority = workspaceAuthorities?.[0];
    const sessionId = input.caller.agentBinding?.channelId ?? input.caller.runtime.id;
    const methodCapability = workspaceAuthority?.methodCapability ?? workspaceAuthority?.capability;
    const methodTier = workspaceAuthority?.methodTier;
    const authorityFacts = {
      caller: input.caller,
      source: input.ref.source,
      className: input.ref.className,
      objectKey: input.ref.objectKey,
      method: input.method,
      workspaceId,
      workspaceMember:
        input.caller.runtime.kind === "server" ||
        !this.deps.membershipGate ||
        this.deps.membershipGate(input.caller.subject),
      workspaceRole: this.deps.workspaceRoleResolver?.(input.caller.subject) ?? null,
      sessionId,
      grantStore: this.deps.capabilityGrantStore,
      mission: this.deps.missionFactForSession?.(sessionId) ?? null,
      contextIntegrity:
        this.deps.contextIntegrityFactForSession?.(sessionId, input.caller) ??
        (input.caller.agentBinding
          ? { class: "internal" as const, latchEpoch: 0, externalKeys: [] }
          : { class: "not-applicable" as const, latchEpoch: 0, externalKeys: [] }),
    } as const;
    const attestation = workspaceAuthority
      ? attestWorkspaceDoRpc({
          ...authorityFacts,
          service: {
            name: workspaceAuthority.capability.slice("workspace-service:".length),
            principals: workspaceAuthority.principals,
          },
          methodAuthority: {
            effect: workspaceAuthority.methodEffect,
            tier: workspaceAuthority.methodTier,
          },
        })
      : attestDirectRpc(authorityFacts);
    const result: DirectAuthorityAttestation = {
      ...attestation,
      ...(workspaceAuthority
        ? {
            targetRequirement: requirementForPrincipals(
              workspaceAuthority.principals,
              workspaceAuthority.capability
            ),
            targetCapability: workspaceAuthority.capability,
            targetTier: "gated" as const,
          }
        : {}),
      ...(input.readOnly ? { readOnly: true as const } : {}),
    };
    if (!workspaceAuthority || input.method.startsWith("__event:")) return result;

    const requiredMethodCapability =
      workspaceAuthority.methodCapability ?? workspaceAuthority.capability;
    const requiredMethodTier = workspaceAuthority.methodTier;
    const leaves = [
      {
        capability: requiredMethodCapability,
        tier: requiredMethodTier,
        requirement: requirementForPrincipals(
          workspaceAuthority.principals,
          requiredMethodCapability
        ),
      },
      ...(requiredMethodCapability !== workspaceAuthority.capability ||
      requiredMethodTier !== "gated"
        ? [
            {
              capability: workspaceAuthority.capability,
              tier: "gated" as const,
              requirement: requirementForPrincipals(
                workspaceAuthority.principals,
                workspaceAuthority.capability
              ),
            },
          ]
        : []),
    ];
    const snapshotFor = (capability: string) =>
      createInvocationSnapshot({
        service: `direct:${input.ref.source}:${input.ref.className}`,
        method: input.method,
        capability,
        targetRequirement: result.targetRequirement,
        targetCapability: result.targetCapability,
        resourceKey: result.resourceKey,
        args: input.args,
        preparedStateDigest: sha256Canonical({
          source: input.ref.source,
          className: input.ref.className,
          objectKey: input.ref.objectKey,
          methodCapability,
          methodTier,
          targetCapability: result.targetCapability ?? null,
          targetTier: result.targetTier ?? null,
          principals: workspaceAuthority.principals,
        }),
        callerPrincipal: result.context.authorizingOrigin.principal,
        sessionId,
        mission: result.context.session.mission
          ? `mission:${result.context.session.mission.missionId}@${result.context.session.mission.closureDigest}`
          : "-",
        snippetDigest:
          result.context.authorizingOrigin.kind === "session"
            ? (result.context.executingCode?.principal.split("@").at(-1) ?? "-")
            : "-",
        codeLineage: result.context.executingCode
          ? {
              class: result.context.executingCode.sourceLineage.class,
              chain: result.context.executingCode.sourceLineage.externalKeys,
            }
          : { class: "unknown", chain: [] },
        contextLineage: result.context.contextIntegrity,
        initiatorChain: result.context.initiatorChain,
      });
    const decisions = leaves.map((leaf) => {
      const snapshot = snapshotFor(leaf.capability);
      const snapshotDigest = invocationSnapshotDigest(snapshot);
      return {
        leaf,
        snapshot,
        snapshotDigest,
        decision: evaluateAuthority({
          context: result.context,
          requirement: leaf.requirement,
          resourceKey: result.resourceKey,
          grants: result.grants,
          tier: leaf.tier,
          invocationDigest: snapshotDigest,
        }),
      };
    });
    result.invocationDigest = decisions[0]?.snapshotDigest;
    const denied = decisions.find(({ decision }) => !decision.allowed);
    if (denied) {
      const acquirable =
        denied.leaf.tier !== "open" &&
        (denied.decision.code === "missing-grant" || denied.decision.code === "lineage");
      if (!acquirable || !this.deps.directAuthorityAcquirer) {
        throw createRelayError(
          `${input.method}: ${denied.decision.reason} (${denied.decision.code})`,
          "EACCES"
        );
      }
      const acquisitionInput = {
        snapshot: denied.snapshot,
        snapshotDigest: denied.snapshotDigest,
        tier: denied.leaf.tier as "gated" | "critical",
        caller: input.caller,
        renderedAction: (this.deps.describeCapability ?? describeCapability)(denied.leaf.capability)
          .action,
        resource: { kind: "exact", key: result.resourceKey },
      } as const;
      this.deps.directAuthorityAcquirer.invalidate(
        denied.snapshotDigest,
        input.caller.runtime.id,
        denied.snapshot.callerPrincipal
      );
      if (input.waitForAuthority) {
        const outcome = await this.deps.directAuthorityAcquirer.acquire(
          acquisitionInput,
          input.signal
        );
        if (outcome.state === "decided" && outcome.decision !== "deny") {
          return this.directDOAuthorization(input);
        }
        throw createRelayError(`${input.method}: authority acquisition was not granted`, "EACCES");
      }
      const acquisition = this.deps.directAuthorityAcquirer.request(acquisitionInput);
      const error = createRelayError(`${input.method}: authority acquisition required`, "EACQUIRE");
      Object.assign(error, { errorKind: "access", errorData: { acquisition } });
      throw error;
    }
    for (const { decision } of decisions) {
      if (decision.consumable && decision.grantId) {
        if (!this.deps.directAuthorityAcquirer?.consume(decision.grantId)) {
          throw createRelayError(`${input.method}: one-time approval was already used`, "EACCES");
        }
      }
    }
    return result;
  }

  private async relayResponse(
    fromId: string,
    targetId: string,
    response: RpcResponse
  ): Promise<void> {
    const client = this.pickRoutableTarget(targetId);
    if (client?.ws.readyState === WebSocket.OPEN) {
      this.sendToWs(client.ws, {
        type: "ws:routed",
        envelope: envelopeForWsDelivery(fromId, "unknown", targetId, response),
      });
      return;
    }
    if (this.sessions.enqueueResponse(targetId, fromId, response)) return;
    throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
  }

  private async relayToDO(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method: string,
    args: unknown[],
    meta?: RelayCallMeta,
    relayCallerScope?: RelayCallerScope
  ): Promise<unknown> {
    const ref = parseDOTarget(targetId);
    // Assertion-only: the concrete DO entity must exist before dispatch.
    // Method-specific context checks (e.g. subscribeChannel) belong in the
    // DO's own handler, not in the generic relay path. Cross-context calls
    // to shared singletons (panel → GadWorkspaceDO) must pass through.
    const cache = this.deps.entityCache;
    if (cache && !cache.resolveActive(targetId)) {
      throw createRelayError(
        `DO ${targetId} is not registered as an active runtime entity. Call runtime.createEntity first.`,
        "DO_NOT_CREATED"
      );
    }

    const { postToDurableObject } = await import("./workerdRpcRelay.js");

    const dispatch = async () => {
      if (!this.deps.tokenManager || !this.workerdUrl || !this.workerdGatewayToken) {
        throw new Error(
          "Cannot relay to DO: tokenManager, workerdUrl, or workerdGatewayToken not configured"
        );
      }
      const workerdUrl = this.workerdUrl;
      const workerdGatewayToken = this.workerdGatewayToken;
      const workerdDispatchSecret = this.workerdDispatchSecret;
      const callerPanelId =
        callerKind === "panel"
          ? (this.deps.runtimeCoordinator?.getLease(callerId)?.slotId ?? undefined)
          : undefined;
      const transportCaller =
        relayCallerScope?.authenticatedCaller ?? this.verifiedCallerFor(callerId, callerKind);
      const attributedCaller =
        callerKind === "server"
          ? createHostCaller(callerId, "server", SYSTEM_SUBJECT)
          : relayCallerScope?.invocationCaller.subject
            ? relayCallerScope.invocationCaller
            : transportCaller;
      const authenticatedCaller = authenticatedCallerOf(attributedCaller);
      const authorization = await this.directDOAuthorization({
        caller: attributedCaller,
        ref,
        method,
        args,
        readOnly: meta?.readOnly,
      });
      const result = await postToDurableObject(ref, method, args, {
        workerdUrl,
        workerdGatewayToken,
        ...(workerdDispatchSecret ? { workerdDispatchSecret } : {}),
        callerId,
        callerKind,
        ...(callerPanelId ? { callerPanelId } : {}),
        ...(authenticatedCaller.userId ? { userId: authenticatedCaller.userId } : {}),
        authorization,
        ...(meta?.requestId ? { requestId: meta.requestId } : {}),
        ...(meta?.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
        ...(meta?.readOnly ? { readOnly: true } : {}),
        ...(meta?.causalParent ? { causalParent: meta.causalParent } : {}),
      });
      return result;
    };

    // A relay is one semantic invocation, not a transport-level retry unit.
    // Replaying here is unsafe even for an apparently pre-delivery failure:
    // the entity may retire while the first dispatch is in flight, and an
    // ensure-and-retry would then recreate infrastructure for a terminal
    // identity. Callers may retry explicitly with their semantic command's
    // idempotency key after resolving the entity lifecycle again.
    return await dispatch();
  }

  private async relayTargetStream(
    caller: VerifiedCaller,
    envelope: RpcEnvelope,
    request: import("@vibestudio/rpc").RpcStreamRequest,
    causalParent: RpcCausalParent | undefined,
    signal: AbortSignal
  ): Promise<Response> {
    const invocationCaller = caller;
    const targetId = envelope.target;
    if (!targetId.startsWith("do:")) {
      throw createRelayError(
        `Streaming target ${targetId} is not a Durable Object`,
        "UNKNOWN_TARGET_KIND"
      );
    }
    const ref = parseDOTarget(targetId);
    if (this.deps.entityCache && !this.deps.entityCache.resolveActive(targetId)) {
      throw createRelayError(
        `DO ${targetId} is not registered as an active runtime entity`,
        "DO_NOT_CREATED"
      );
    }
    if (!this.workerdUrl || !this.workerdGatewayToken) {
      throw new Error("Cannot stream to DO: workerdUrl or workerdGatewayToken not configured");
    }
    const { streamFromDurableObject } = await import("./workerdRpcRelay.js");
    const authenticatedCaller = authenticatedCallerOf(caller);
    const callerPanelId =
      caller.runtime.kind === "panel"
        ? (this.deps.runtimeCoordinator?.getLease(caller.runtime.id)?.slotId ?? undefined)
        : undefined;
    const authorization = await this.directDOAuthorization({
      caller: invocationCaller,
      ref,
      method: request.method,
      args: request.args,
      readOnly: envelope.delivery.readOnly,
      waitForAuthority: true,
      signal,
    });
    return streamFromDurableObject(
      ref,
      request.method,
      request.args,
      {
        workerdUrl: this.workerdUrl,
        workerdGatewayToken: this.workerdGatewayToken,
        ...(this.workerdDispatchSecret
          ? { workerdDispatchSecret: this.workerdDispatchSecret }
          : {}),
        callerId: caller.runtime.id,
        callerKind: caller.runtime.kind,
        ...(callerPanelId ? { callerPanelId } : {}),
        ...(authenticatedCaller.userId ? { userId: authenticatedCaller.userId } : {}),
        authorization,
        requestId: request.requestId,
        ...(envelope.delivery.idempotencyKey
          ? { idempotencyKey: envelope.delivery.idempotencyKey }
          : {}),
        ...(envelope.delivery.readOnly ? { readOnly: true } : {}),
        ...(causalParent ? { causalParent } : {}),
      },
      signal
    );
  }

  private async relayToWorker(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method: string,
    args: unknown[],
    meta?: RelayCallMeta
  ): Promise<unknown> {
    const workerName = this.resolveWorkerInstanceNameFn?.(targetId) ?? null;
    if (!workerName) throw new Error(`Worker not found: ${targetId}`);
    if (!this.workerdUrl) throw new Error("workerdUrl not configured");

    const caller = { callerId, callerKind };
    const envelope = envelopeFromMessage({
      selfId: callerId,
      from: callerId,
      target: targetId,
      caller,
      ...(meta?.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
      ...(meta?.readOnly ? { readOnly: true } : {}),
      message: {
        type: "request",
        requestId: meta?.requestId ?? randomUUID(),
        fromId: callerId,
        method,
        args,
        ...(meta?.causalParent ? { causalParent: meta.causalParent } : {}),
      },
    });

    const url = `${this.workerdUrl}/${encodeURIComponent(workerName)}/__rpc`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.workerdGatewayToken
          ? { Authorization: `Bearer ${this.workerdGatewayToken}` }
          : {}),
      },
      body: JSON.stringify(envelope),
    });

    if (!res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch (error) {
        throw new Error(
          `Worker relay to ${targetId} failed (${res.status}) and response body could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      throw new Error(`Worker relay to ${targetId} failed (${res.status}): ${text}`);
    }

    const responseEnvelope = (await res.json()) as RpcEnvelope | undefined;
    const responseMessage = responseEnvelope?.message as RpcResponse | undefined;
    if (responseMessage && responseMessage.type === "response") {
      if ("error" in responseMessage) {
        const err = new Error(responseMessage.error) as Error & { code?: unknown };
        if (responseMessage.errorCode) err.code = responseMessage.errorCode;
        throw err;
      }
      return responseMessage.result;
    }
    throw new Error(`Worker relay to ${targetId} returned a malformed response envelope`);
  }

  /**
   * Canonical event delivery used by the `handleRoute` WS path for EVERY target
   * kind (panel/shell fan-out, DO, worker). Events are fire-and-forget: unlike
   * `relayCall`, the panel/shell branch does NOT await a reconnect grace window.
   * A connectionless target throws `TARGET_NOT_REACHABLE` immediately so the
   * drop is SURFACED (logged + `ws:routed-event-error`) rather than swallowed or
   * stalled behind a reconnect that may never come. Keeping every target kind in
   * this one function is what stops a kind (e.g. connectionless DOs) from being
   * "forgotten" by a duplicate inline delivery path.
   *
   * `targetConnectionId`, when supplied, pins delivery to a single connection
   * (e.g. a lease-resolved slot); otherwise the event fans out to every live
   * connection for the caller.
   */
  private async relayEvent(
    fromId: string,
    fromKind: CallerKind,
    targetId: string,
    event: string,
    payload: unknown,
    targetConnectionId?: string
  ): Promise<void> {
    const isPanelOrShellTarget = !targetId.startsWith("do:") && !targetId.startsWith("worker:");
    if (isPanelOrShellTarget) {
      const routedTargetId = this.resolveRoutableTargetId(targetId);
      // Pin to an explicit connection, then a lease-resolved one, else fan out.
      const pinnedConnectionId =
        targetConnectionId ?? this.deps.runtimeCoordinator?.resolveRouteConnection(targetId);
      const wsClients = pinnedConnectionId
        ? [this.getConnection(routedTargetId, pinnedConnectionId)].filter(
            (connection): connection is WsClientState => Boolean(connection)
          )
        : this.getCallerConnections(routedTargetId);
      if (wsClients.length === 0) {
        // Fire-and-forget: no live connection means the event is undeliverable
        // now. Surface it instead of stalling on a reconnect that may never
        // come (the call path keeps its reconnect behavior; events do not).
        throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
      }
      for (const wsClient of wsClients) {
        this.sendToWs(wsClient.ws, {
          type: "ws:routed",
          envelope: envelopeForWsDelivery(fromId, fromKind, routedTargetId, {
            type: "event",
            fromId,
            event,
            payload,
          }),
        });
      }
      return;
    }

    // DO?
    if (targetId.startsWith("do:")) {
      const ref = parseDOTarget(targetId);

      if (!this.deps.tokenManager || !this.workerdUrl || !this.workerdGatewayToken) {
        throw new Error(
          "Cannot relay event to DO: tokenManager, workerdUrl, or workerdGatewayToken not configured"
        );
      }

      const { postEventToDurableObject } = await import("./workerdRpcRelay.js");
      const attributedCaller =
        fromKind === "server"
          ? createHostCaller(fromId, "server", SYSTEM_SUBJECT)
          : this.verifiedCallerFor(fromId, fromKind);
      const authenticatedCaller = authenticatedCallerOf(attributedCaller);
      const authorization = await this.directDOAuthorization({
        caller: attributedCaller,
        ref,
        method: `__event:${event}`,
        args: [payload],
      });
      // `fromId`/`fromKind` become the event envelope's caller — the DO's
      // `handleEvent` surfaces it to listeners as `event.caller`.
      await postEventToDurableObject(ref, event, payload, {
        workerdUrl: this.workerdUrl,
        workerdGatewayToken: this.workerdGatewayToken,
        ...(this.workerdDispatchSecret
          ? { workerdDispatchSecret: this.workerdDispatchSecret }
          : {}),
        callerId: fromId,
        callerKind: fromKind,
        ...(authenticatedCaller.userId ? { userId: authenticatedCaller.userId } : {}),
        authorization,
      });
      return;
    }

    // Worker?
    if (targetId.startsWith("worker:")) {
      const workerName = this.resolveWorkerInstanceNameFn?.(targetId) ?? null;
      if (!workerName) throw new Error(`Worker not found: ${targetId}`);
      if (!this.workerdUrl) throw new Error("workerdUrl not configured");

      const eventEnvelope = envelopeFromMessage({
        selfId: fromId,
        from: fromId,
        target: targetId,
        caller: { callerId: fromId, callerKind: fromKind },
        message: { type: "event", fromId, event, payload },
      });
      const res = await fetch(`${this.workerdUrl}/${encodeURIComponent(workerName)}/__rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.workerdGatewayToken
            ? { Authorization: `Bearer ${this.workerdGatewayToken}` }
            : {}),
        },
        body: JSON.stringify(eventEnvelope),
      });
      if (!res.ok) {
        let text: string;
        try {
          text = await res.text();
        } catch (error) {
          throw new Error(
            `Event relay to ${targetId} failed (${res.status}) and response body could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        throw new Error(`Event relay to ${targetId} failed (${res.status}): ${text}`);
      }
      return;
    }

    throw createRelayError(`Unknown target kind: ${targetId}`, "UNKNOWN_TARGET_KIND");
  }

  private async resolveWsRelayTarget(
    targetId: string,
    connectionId?: string
  ): Promise<WsClientState> {
    const wsClient = connectionId
      ? this.getConnection(targetId, connectionId)
      : this.pickPrimary(targetId);
    if (wsClient?.ws.readyState === WebSocket.OPEN) {
      return wsClient;
    }

    if (connectionId) {
      const connectionKey = this.connectionKey(targetId, connectionId);
      const waiter = this.connectionReconnectWaiters.get(connectionKey);
      if (!waiter) {
        throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
      }
      try {
        await waiter.promise;
      } catch (error) {
        const code = getErrorCode(error);
        if (code === "SERVER_SHUTTING_DOWN") {
          throw createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN");
        }
        if (code === "RECONNECT_GRACE_EXPIRED") {
          throw createRelayError(
            `Target ${targetId} did not reconnect within grace window`,
            "RECONNECT_GRACE_EXPIRED"
          );
        }
        throw error;
      }

      const reconnected = this.getConnection(targetId, connectionId);
      if (reconnected) return reconnected;
      throw new Error(
        `Invariant violated: reconnect waiter resolved for ${targetId}:${connectionId} but no client found`
      );
    }

    const outcome = await this.awaitReconnectIfPending(targetId);
    switch (outcome.kind) {
      case "reconnected":
        return outcome.client;
      case "server-shutdown":
        throw createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN");
      case "grace-expired":
        throw createRelayError(
          `Target ${targetId} did not reconnect within grace window`,
          "RECONNECT_GRACE_EXPIRED"
        );
      case "no-waiter":
        throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
    }
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  // A slow consumer is terminated once its buffer crosses the hard bound. No
  // message class is silently discarded below that bound.
  private static readonly WS_BACKPRESSURE_HARD_LIMIT = 128 * 1024 * 1024;

  /** Min interval between `closed(4008)` self-heal frames per unknown sid (plan §1.5). */
  private static readonly SESSION_NOT_OPEN_CLOSED_INTERVAL_MS = 2000;

  /**
   * Hard cap on the per-pipe `notOpenClosedAt` rate-limiter map. The interval
   * sweep only evicts entries older than the window, so a peer flooding MANY
   * unique fake sids WITHIN one window leaves every entry "recent" and the sweep
   * frees nothing — the map would grow unbounded. Past this cap we additionally
   * evict oldest-first (insertion order) so it can never exceed the ceiling.
   * Generous: a legitimate multi-panel client tracks at most a handful of sids.
   */
  private static readonly SESSION_NOT_OPEN_MAX_TRACKED = 1024;

  /**
   * Generous ceiling on concurrent logical sessions (shims) per WebRTC pipe.
   * Each `open` drives a full handleConnection (10s auth timer + auth work), so
   * an unbounded flood of opens is a pre-auth DoS. A legitimate client multiplexes
   * its panels + shell — dozens at most — so this is far above any real need; a
   * re-open of an already-tracked sid is never blocked.
   */
  private static readonly MAX_SESSIONS_PER_PIPE = 512;

  /**
   * Bound on one inbound upload's UNCONSUMED bytes (plan §1.6). SCTP delivers
   * reliably and cannot be paused mid-stream, so a consumer that falls more
   * than this far behind gets the body errored (and the request fails loudly)
   * instead of the server buffering without bound. Mirrors the client's
   * `STREAM_RECEIVE_CAP_BYTES` receive-cap policy.
   */
  private static readonly UPLOAD_RECEIVE_CAP_BYTES = 8 * 1024 * 1024;

  /**
   * TTL on upload frames buffered BEFORE their stream-open arrives (see the
   * pre-open buffer in `attachWebRtcPipe`). Control (stream-open) and bulk
   * (DATA) are independent SCTP streams, so under packet loss a retransmitted
   * stream-open can trail its first DATA frames — by retransmission round
   * trips, not by seconds. Past this window the frames belong to a request
   * whose open will never come (a client that kept pumping after teardown/
   * settle) and are discarded; if the open DOES arrive later still, the body
   * fails loudly rather than resuming truncated.
   */
  private static readonly UPLOAD_PREOPEN_TTL_MS = 5000;

  private sendToWs(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const buffered = ws.bufferedAmount;
    if (buffered > RpcServer.WS_BACKPRESSURE_HARD_LIMIT) {
      log.warn(
        `WebSocket client buffer exceeded hard limit (${buffered} bytes buffered) — terminating slow consumer`
      );
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  // ===========================================================================
  // Gateway in-process handlers
  // ===========================================================================

  /** Accept a pre-upgraded WebSocket from the gateway (no WSS needed on our side). */
  handleGatewayWsConnection(ws: WebSocket): void {
    this.handleConnection(ws);
  }

  /** Upgrade a WebSocket when this RPC server directly owns the gateway route. */
  handleGatewayWsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const wss = this.wss;
    if (!wss) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws));
  }

  /**
   * Attach the answerer side of a WebRTC pipe (plan §1/§3). N logical panel/shell
   * sessions multiplex over the pipe's control channel; each `open` frame stands
   * up a per-session `SessionWebSocketShim` that drives the EXISTING per-connection
   * machinery (handleConnection → handleAuth → per-session bridge with close-time
   * `CONNECTION_LOST` synthesis). Streaming bodies ride the binary bulk channel.
   * This reuses one server RPC implementation — the answerer is a translation
   * layer, not a parallel server (fail-loud rule). Local co-located mode keeps the
   * loopback WS via `handleGatewayWsConnection`; both feed the same dispatch.
   */
  attachWebRtcPipe(
    pipe: PipeChannels & {
      onControl(handler: (data: Uint8Array) => void): void;
      onBulkFrame(
        handler: (streamId: number, type: StreamFrameType, payload: Uint8Array) => void
      ): void;
      onDown?(handler: (reason: string) => void): () => void;
    }
  ): void {
    if (this.stopped) throw new Error("RpcServer has stopped and cannot attach a WebRTC pipe");
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const shims = new Map<string, SessionWebSocketShim>();
    const writeControlFrame = (frame: SessionControlFrame): void => {
      // Lane = the frame's sid so the pipe's fragment scheduler round-robins
      // fairly across sessions; pipe-level frames ride the shared lane.
      const lane = (frame as { sid?: string }).sid ?? PIPE_LANE;
      void pipe.writeControl(encoder.encode(encodeControlFrame(frame)), lane).catch(() => {
        // Pipe failure surfaces via onDown (which closes every session); a
        // frame lost in the same instant is moot.
      });
    };
    // Self-healing closed semantics (plan §1.5): ANY frame for an unknown sid
    // gets a non-terminal `closed` so the client reopens the session — events
    // for a desynced session no longer vanish silently. Rate-limited per sid so
    // a chatty desynced client gets one closed per window, not a storm.
    const notOpenClosedAt = new Map<string, number>();
    const sendSessionNotOpenClosed = (sid: string): void => {
      const now = Date.now();
      const last = notOpenClosedAt.get(sid);
      if (last !== undefined && now - last < RpcServer.SESSION_NOT_OPEN_CLOSED_INTERVAL_MS) return;
      // Bound the map: a client inventing sids must not grow it without limit.
      if (notOpenClosedAt.size >= RpcServer.SESSION_NOT_OPEN_MAX_TRACKED) {
        // First free anything past the rate-limit window…
        for (const [staleSid, at] of notOpenClosedAt) {
          if (now - at >= RpcServer.SESSION_NOT_OPEN_CLOSED_INTERVAL_MS) {
            notOpenClosedAt.delete(staleSid);
          }
        }
        // …then hard-cap: a peer flooding >cap unique sids WITHIN one window
        // leaves every entry "recent" so the sweep frees nothing. Evict oldest
        // (Map preserves insertion order) until we are back under the ceiling.
        while (notOpenClosedAt.size >= RpcServer.SESSION_NOT_OPEN_MAX_TRACKED) {
          const oldest = notOpenClosedAt.keys().next().value;
          if (oldest === undefined) break;
          notOpenClosedAt.delete(oldest);
        }
      }
      notOpenClosedAt.set(sid, now);
      writeControlFrame({
        t: SESSION_CLOSED,
        sid,
        code: SESSION_NOT_OPEN_CLOSE_CODE,
        reason: "session not open",
        terminal: false,
      });
    };
    const writeUnknownSessionResponse = (sid: string, envelope: RpcEnvelope): void => {
      const message = envelope.message;
      if (message.type !== "request" && message.type !== "stream-request") return;
      const response: RpcMessage = {
        type: "response",
        requestId: message.requestId,
        error: "WebRTC session is not open",
        errorKind: "transport",
        errorCode: "SESSION_NOT_OPEN",
      };
      writeControlFrame({
        t: "rpc",
        sid,
        envelope: responseEnvelopeFor(
          envelope,
          { callerId: "main", callerKind: "server" },
          response
        ),
      });
    };
    const getShim = (sid: string, frameType: string): SessionWebSocketShim | undefined => {
      const shim = shims.get(sid);
      if (!shim) log.warn(`WebRTC pipe: ${frameType} for unknown session ${sid}`);
      return shim;
    };

    // Upload seam (plan §1.6): request bodies arrive as inbound bulk DATA
    // frames keyed by the stream-open's `bodyStreamId` and are assembled into
    // per-request ReadableStreams the stream dispatch consumes.
    //
    // ORDERING: the client sends the stream-open (control channel) before its
    // first DATA frame (bulk channel), but those are independent SCTP streams —
    // under packet loss DATA can ARRIVE before the open. Frames for an id with
    // no registered body are therefore held in a bounded pre-open buffer
    // (`pendingBodies`) and flushed, in order, when `registerInboundBody` runs
    // for that id. Frames for a RETIRED id (body settled — the client kept
    // pumping after teardown/settle) still drop.
    interface InboundBodyEntry {
      controller: ReadableStreamDefaultController<Uint8Array>;
      /** Bytes enqueued so far — checked against the bytesIn count on END. */
      received: number;
      settle: (error?: Error) => void;
    }
    const inboundBodies = new Map<number, InboundBodyEntry>();
    // Pre-open frames awaiting their stream-open, keyed by bodyStreamId.
    // Bounded four ways: total buffered bytes per stream (UPLOAD_RECEIVE_CAP_BYTES,
    // the same cap a registered body enforces), catastrophic total buffered bytes
    // across the pipe, catastrophic total pending ids, and a TTL
    // (UPLOAD_PREOPEN_TTL_MS). Breaching any fuse CONDEMNS the id: buffered frames
    // are freed, and an open arriving later fails the body loudly — never a
    // silently truncated upload.
    interface PendingBodyBuffer {
      frames: Array<{ type: StreamFrameType; payload: Uint8Array }>;
      bytes: number;
      timer: ReturnType<typeof setTimeout>;
    }
    const pendingBodies = new Map<number, PendingBodyBuffer>();
    let pendingBodyBytes = 0;
    // Terminal per-id outcomes, FIFO-bounded (bodyStreamIds are monotonic per
    // client, so old entries only shield against ever-later stragglers):
    //   null  — the body existed and settled: late frames drop silently.
    //   Error — pre-open buffering was condemned (over-cap / TTL expiry): late
    //           frames drop, and a later stream-open errors the body with this.
    const retiredBodyIds = new Map<number, Error | null>();
    const RETIRED_BODY_IDS_MAX = 1024;
    const retireBodyId = (bodyStreamId: number, outcome: Error | null): void => {
      retiredBodyIds.delete(bodyStreamId); // re-insert = refresh FIFO position
      retiredBodyIds.set(bodyStreamId, outcome);
      if (retiredBodyIds.size > RETIRED_BODY_IDS_MAX) {
        const oldest = retiredBodyIds.keys().next().value;
        if (oldest !== undefined) retiredBodyIds.delete(oldest);
      }
    };
    const condemnPending = (bodyStreamId: number, error: Error): void => {
      const pending = pendingBodies.get(bodyStreamId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingBodies.delete(bodyStreamId);
        pendingBodyBytes -= pending.bytes;
      }
      retireBodyId(bodyStreamId, error);
    };
    const bufferPreOpenFrame = (
      streamId: number,
      type: StreamFrameType,
      payload: Uint8Array
    ): void => {
      if (retiredBodyIds.has(streamId)) return; // settled/condemned — drop
      let pending = pendingBodies.get(streamId);
      if (!pending) {
        if (pendingBodies.size >= this.uploadPreopenLimits.maxPendingStreams) {
          const error = new Error(
            `upload pre-open buffer has too many pending streams ` +
              `(cap ${this.uploadPreopenLimits.maxPendingStreams})`
          );
          log.warn(`WebRTC pipe: ${error.message}; condemning upload stream ${streamId}`);
          retireBodyId(streamId, error);
          return;
        }
        const timer = setTimeout(
          () =>
            // Never opened within the TTL — the legitimate drop case (client
            // pumped past teardown), so no log; the condemnation marker makes
            // a pathologically late open fail loud instead of truncating.
            condemnPending(
              streamId,
              new Error(
                `upload stream ${streamId}'s early frames expired ` +
                  `${RpcServer.UPLOAD_PREOPEN_TTL_MS}ms before its stream-open arrived`
              )
            ),
          RpcServer.UPLOAD_PREOPEN_TTL_MS
        );
        (timer as { unref?: () => void }).unref?.();
        pending = { frames: [], bytes: 0, timer };
        pendingBodies.set(streamId, pending);
      }
      if (type === FRAME_DATA && payload.byteLength === 0) return;
      if (
        payload.byteLength > 0 &&
        pendingBodyBytes + payload.byteLength > this.uploadPreopenLimits.maxBufferedBytes
      ) {
        const error = new Error(
          `upload pre-open buffers exceeded the ` +
            `${this.uploadPreopenLimits.maxBufferedBytes}-byte aggregate cap`
        );
        log.warn(
          `WebRTC pipe: upload stream ${streamId} would take pre-open buffers to ` +
            `${pendingBodyBytes + payload.byteLength} bytes ` +
            `(cap ${this.uploadPreopenLimits.maxBufferedBytes}) — condemning the stream`
        );
        condemnPending(streamId, error);
        return;
      }
      pending.bytes += payload.byteLength;
      pendingBodyBytes += payload.byteLength;
      if (pending.bytes > RpcServer.UPLOAD_RECEIVE_CAP_BYTES) {
        log.warn(
          `WebRTC pipe: upload stream ${streamId} buffered ${pending.bytes} bytes ` +
            `before its stream-open arrived (cap ${RpcServer.UPLOAD_RECEIVE_CAP_BYTES}) — condemning the stream`
        );
        condemnPending(
          streamId,
          new Error(
            `upload exceeded the ${RpcServer.UPLOAD_RECEIVE_CAP_BYTES}-byte ` +
              `pre-open buffer before its stream-open arrived`
          )
        );
        return;
      }
      // COPY: the payload is a subarray view into the transport's receive
      // buffer, valid only during this callback (see decodeBulkMessage).
      pending.frames.push({ type, payload: payload.slice() });
    };
    const registerInboundBody = (bodyStreamId: number): ReadableStream<Uint8Array> => {
      // A duplicate bodyStreamId is a client protocol bug: fail the old body
      // loudly rather than cross-feeding two requests.
      inboundBodies
        .get(bodyStreamId)
        ?.settle(new Error(`upload stream ${bodyStreamId} superseded by a re-used id`));
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>(
        {
          start(c) {
            controller = c;
          },
          cancel() {
            // Consumer walked away (e.g. upstream fetch failed): unregister +
            // retire so late DATA frames drop instead of enqueueing into a
            // dead stream (or piling into the pre-open buffer).
            inboundBodies.delete(bodyStreamId);
            retireBodyId(bodyStreamId, null);
          },
        },
        // Byte-length strategy sized to the cap: desiredSize = cap - unconsumed
        // bytes, giving the DATA handler an exact overflow gauge (mirror of the
        // client's receive-cap policy — SCTP cannot be paused, so past the cap
        // the body errors loudly instead of buffering without bound).
        {
          highWaterMark: RpcServer.UPLOAD_RECEIVE_CAP_BYTES,
          size: (chunk) => chunk?.byteLength ?? 0,
        }
      );
      const entry: InboundBodyEntry = {
        controller,
        received: 0,
        settle: (error?: Error) => {
          if (!inboundBodies.delete(bodyStreamId)) return;
          // Retire the id so post-settle frames drop rather than buffering as
          // "pre-open" for a request that is already over.
          retireBodyId(bodyStreamId, null);
          try {
            if (error) controller.error(error);
            else controller.close();
          } catch {
            // already settled by the stream itself
          }
        },
      };
      // A retired id must never be re-registered. Condemned ids fail loudly
      // because leading frames were dropped; normally retired ids close
      // immediately so a duplicate stream-open cannot resurrect the route.
      if (retiredBodyIds.has(bodyStreamId)) {
        const condemned = retiredBodyIds.get(bodyStreamId);
        // Not registered, so no retire bookkeeping — just settle the fresh body.
        if (condemned) controller.error(condemned);
        else controller.close();
        return body;
      }
      inboundBodies.set(bodyStreamId, entry);
      // Flush frames that beat this stream-open across the channel boundary,
      // in arrival order. A flushed END/ERROR settles the body (unregistering
      // it), so re-check registration between frames.
      const pending = pendingBodies.get(bodyStreamId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingBodies.delete(bodyStreamId);
        pendingBodyBytes -= pending.bytes;
        for (const frame of pending.frames) {
          if (!inboundBodies.has(bodyStreamId)) break;
          deliverBodyFrame(bodyStreamId, frame.type, frame.payload);
        }
      }
      return body;
    };
    const deliverBodyFrame = (
      streamId: number,
      type: StreamFrameType,
      payload: Uint8Array
    ): void => {
      const entry = inboundBodies.get(streamId);
      if (!entry) return; // settled under a pre-open flush — drop
      if (type === FRAME_DATA) {
        if (payload.byteLength === 0) return;
        try {
          // COPY: the payload is a subarray view into the transport's receive
          // buffer, valid only during this callback (see decodeBulkMessage);
          // the stream queue retains it until the consumer reads. (Pre-open
          // flushes hand in already-owned copies; re-slicing those is a cheap
          // one-time cost for a single delivery path.)
          entry.controller.enqueue(payload.slice());
        } catch {
          // Stream already errored/cancelled under us — unregister the route.
          inboundBodies.delete(streamId);
          retireBodyId(streamId, null);
          return;
        }
        entry.received += payload.byteLength;
        const desired = entry.controller.desiredSize;
        if (desired !== null && desired < 0) {
          const buffered = RpcServer.UPLOAD_RECEIVE_CAP_BYTES - desired;
          log.warn(
            `WebRTC pipe: upload stream ${streamId} exceeded the ` +
              `${RpcServer.UPLOAD_RECEIVE_CAP_BYTES}-byte receive buffer (${buffered} buffered) — failing the request`
          );
          entry.settle(
            new Error(
              `upload exceeded the ${RpcServer.UPLOAD_RECEIVE_CAP_BYTES}-byte receive buffer (${buffered} bytes unconsumed)`
            )
          );
        }
        return;
      }
      if (type === FRAME_END) {
        // END carries the sender's byte count (`EndFramePayload.bytesIn`, sent
        // by the client's pumpRequestBody). Validate it against what actually
        // arrived — mirroring the HTTP stream path's END accounting — so a
        // transport that lost or duplicated DATA fails the request loudly
        // instead of settling a truncated upload as complete.
        let declared: number | undefined;
        try {
          declared = parseEndFrame(payload).bytesIn;
        } catch {
          // malformed END payload — fails the typeof check below
        }
        if (typeof declared !== "number" || !Number.isFinite(declared)) {
          entry.settle(
            new Error(`protocol violation: upload END frame for stream ${streamId} has no bytesIn`)
          );
          return;
        }
        if (declared !== entry.received) {
          log.warn(
            `WebRTC pipe: upload stream ${streamId} byte-count mismatch — ` +
              `sender declared ${declared}, received ${entry.received} — failing the request`
          );
          entry.settle(
            new Error(
              `upload stream truncated: sender declared ${declared} bytes, received ${entry.received}`
            )
          );
          return;
        }
        entry.settle();
        return;
      }
      // ERROR (or a protocol-violating HEAD on an upload stream): error the
      // body so the in-flight request fails loudly, never a truncated upload.
      let message = "upload failed";
      let code: string | undefined;
      if (type === FRAME_ERROR) {
        try {
          const parsed = JSON.parse(decoder.decode(payload)) as { message?: string; code?: string };
          if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
          if (typeof parsed.code === "string") code = parsed.code;
        } catch {
          // malformed error payload — keep the generic message
        }
      } else {
        message = `protocol violation: frame type ${type} on upload stream ${streamId}`;
      }
      const error = new Error(message) as Error & { code?: string };
      if (code) error.code = code;
      entry.settle(error);
    };
    const resetPipe = (reason: string): void => {
      for (const [sid, shim] of [...shims]) {
        shims.delete(sid);
        shim.remoteClosed(1006, reason || "WebRTC pipe down");
      }
      for (const body of [...inboundBodies.values()]) {
        body.settle(new Error(reason || "WebRTC pipe down"));
      }
      for (const pending of pendingBodies.values()) clearTimeout(pending.timer);
      pendingBodies.clear();
      pendingBodyBytes = 0;
      retiredBodyIds.clear();
    };
    // A transport-down is a generation boundary, not necessarily the end of
    // the answerer object: WebRTC recovery may reopen sessions on this same
    // pipe. Reset generation-owned state while retaining the subscription.
    pipe.onDown?.((reason) => resetPipe(reason));

    pipe.onBulkFrame((streamId, type, payload) => {
      if (this.stopped) return;
      if (inboundBodies.has(streamId)) {
        deliverBodyFrame(streamId, type, payload);
        return;
      }
      // No registered body: either the frame beat its stream-open across the
      // channel boundary (buffer it) or the id is retired (drop, inside).
      bufferPreOpenFrame(streamId, type, payload);
    });

    pipe.onControl((data) => {
      if (this.stopped) return;
      let frame: SessionControlFrame;
      try {
        frame = decodeControlFrame(decoder.decode(data));
      } catch (err) {
        log.warn(`WebRTC pipe: dropping malformed control frame: ${(err as Error).message}`);
        return;
      }
      switch (frame.t) {
        case "open": {
          // Generous pre-auth DoS backstop: cap concurrent logical sessions per
          // pipe. Each open drives a full handleConnection (10s auth timer + auth
          // work), so an unbounded open flood would pin resources before any auth.
          // A re-open of an already-tracked sid is never blocked (it replaces).
          if (!shims.has(frame.sid) && shims.size >= RpcServer.MAX_SESSIONS_PER_PIPE) {
            log.warn(
              `WebRTC pipe: refusing open for ${frame.sid} — session cap ` +
                `(${RpcServer.MAX_SESSIONS_PER_PIPE}) reached; possible pre-auth flood`
            );
            writeControlFrame({
              t: SESSION_OPEN_RESULT,
              sid: frame.sid,
              success: false,
              error: "Too many concurrent sessions on this connection",
              terminal: true,
            });
            return;
          }
          // A re-sent SESSION_OPEN on reconnect means the prior pipe generation's
          // shim is stale (its connection is gone, but the answerer pipe + this
          // closure survive the ICE re-establish). Tear it down — firing the old
          // connection's handleClose WITHOUT writing SESSION_CLOSED to the client
          // (it is re-opening, not closing), and GC'ing the old shim's per-session
          // stream maps — so the re-sent auth drives a FRESH handleConnection →
          // handleAuth that emits a new open-result. Reusing the stale shim would
          // route the auth into the live handleMessage, which IGNORES a duplicate
          // ws:auth (rpcServer ~"ws:auth" case), so reopen()/ready() would hang
          // forever and onRecovery (resubscribe / cold-recover) would never fire.
          const stale = shims.get(frame.sid);
          if (stale) stale.remoteClosed(4000, "superseded by re-open");
          const shim = new SessionWebSocketShim(frame.sid, pipe, (sid) => shims.delete(sid));
          shims.set(frame.sid, shim);
          // Drive the full auth/session/bridge pipeline for this logical session.
          this.handleConnection(shim as unknown as WebSocket);
          shim.deliverInbound({
            type: "ws:auth",
            contractVersion: RPC_CONTRACT_VERSION,
            token: frame.token,
            connectionId: frame.connectionId,
            clientLabel: frame.clientLabel,
            clientSessionId: frame.clientSessionId,
            clientPlatform: frame.clientPlatform,
          });
          return;
        }
        case "rpc": {
          const shim = getShim(frame.sid, frame.t);
          if (!shim) {
            // Requests get a per-request SESSION_NOT_OPEN response so the
            // pending call settles NOW; event-carrying envelopes have nothing
            // to respond to. Both also get the self-healing non-terminal
            // closed so the client reopens the session.
            writeUnknownSessionResponse(frame.sid, frame.envelope);
            sendSessionNotOpenClosed(frame.sid);
            return;
          }
          shim.deliverInbound({ type: "ws:rpc", envelope: frame.envelope });
          return;
        }
        case "route": {
          const shim = getShim(frame.sid, frame.t);
          if (!shim) {
            writeUnknownSessionResponse(frame.sid, frame.envelope);
            sendSessionNotOpenClosed(frame.sid);
            return;
          }
          shim.deliverInbound({
            type: "ws:route",
            envelope: frame.envelope,
            targetConnectionId: frame.targetConnectionId,
          });
          return;
        }
        case "stream-open": {
          const shim = getShim(frame.sid, frame.t);
          if (!shim) {
            // Settle the client's pending stream: a bulk ERROR frame whose
            // payload is the UTF-8 JSON `ErrorFramePayload` the client's
            // decodeFramedStream/parseErrorFrame expects.
            void pipe
              .writeBulkFrame(
                frame.streamId,
                FRAME_ERROR,
                encoder.encode(
                  JSON.stringify({
                    status: 409,
                    message: "WebRTC session is not open",
                    code: "SESSION_NOT_OPEN",
                  })
                )
              )
              .catch(() => {
                // Pipe failure surfaces via onDown; the stream is moot then.
              });
            sendSessionNotOpenClosed(frame.sid);
            return;
          }
          const requestId = (frame.envelope.message as { requestId?: string }).requestId;
          if (requestId) shim.registerStream(requestId, frame.streamId);
          // Upload path (plan §1.6): a declared bodyStreamId routes inbound
          // bulk DATA/END/ERROR frames into a per-request body stream the
          // dispatch consumes (shim.takeInboundBody). The client SENDS the
          // stream-open before its first DATA frame, but control and bulk are
          // independent SCTP streams, so DATA can ARRIVE first — such frames
          // wait in the bounded pre-open buffer and registerInboundBody
          // flushes them, in order, into the body here.
          if (requestId && typeof frame.bodyStreamId === "number") {
            const bodyStreamId = frame.bodyStreamId;
            const body = registerInboundBody(bodyStreamId);
            shim.registerInboundBody(requestId, body, () =>
              inboundBodies
                .get(bodyStreamId)
                ?.settle(new Error("request settled before the upload completed"))
            );
          }
          shim.deliverInbound({ type: "ws:rpc", envelope: frame.envelope });
          return;
        }
        case "stream-cancel": {
          const shim = getShim(frame.sid, frame.t);
          if (!shim) {
            sendSessionNotOpenClosed(frame.sid);
            return;
          }
          shim.cancelStream(frame.streamId);
          return;
        }
        case "close": {
          // Deliberately NO closed(4008) reply for an unknown sid: the client
          // is discarding this session; echoing closed would auto-reopen it.
          const shim = shims.get(frame.sid);
          shims.delete(frame.sid);
          shim?.remoteClosed(frame.code, frame.reason);
          return;
        }
        default: {
          // open-result/closed/routed/event/*-error are client-bound; pong is
          // pipe-level (keepalive lives inside the answerer transport now, so
          // ping never reaches here). A session-scoped frame for an unknown
          // sid still self-heals via closed(4008) — plan §1.5.
          const sid = (frame as { sid?: string }).sid;
          if (typeof sid === "string" && !shims.has(sid)) sendSessionNotOpenClosed(sid);
          return;
        }
      }
    });
  }

  /** Handle an HTTP POST /rpc from the gateway (in-process dispatch). */
  async handleGatewayHttpRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    if (this.stopped) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "RPC server is shutting down" }));
      return;
    }
    await this.httpRpc.handle(req, res);
  }

  /** Shut down the server */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.disposeTokenRevocationListener?.();
    this.disposeTokenRevocationListener = null;

    this.connections.closeAll(1001, "Server shutting down");

    for (const [ws, authTimer] of this.pendingAuthentications) {
      if (authTimer) clearTimeout(authTimer);
      ws.close(1001, "Server shutting down");
    }
    this.pendingAuthentications.clear();

    // Clear pending tool calls
    for (const [, pending] of this.pendingToolCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Server shutting down"));
    }
    this.pendingToolCalls.clear();

    this.deferrals.cancelAll();

    for (const timer of this.disconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectTimers.clear();

    for (const waiter of this.reconnectWaiters.values()) {
      waiter.reject(createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN"));
    }
    this.reconnectWaiters.clear();
    for (const waiter of this.connectionReconnectWaiters.values()) {
      waiter.reject(createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN"));
    }
    this.connectionReconnectWaiters.clear();
    this.routedRequestOrigins.clear();
    this.sessions.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}
