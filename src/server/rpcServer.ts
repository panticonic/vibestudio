/**
 * RPC session server — handles caller-scoped app, panel, worker, extension,
 * shell-host and server communication over loopback WebSocket or remote Iroh.
 *
 * Auth and dispatch are transport-neutral. Each carrier owns only admission,
 * delivery, streaming, and close mechanics.
 */

import { WebSocketServer } from "ws";
import { createHmac, randomBytes, randomUUID } from "crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ExtensionInvocation } from "@vibestudio/extension";
import {
  createRpcClient,
  RemoteRpcError,
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
  type AgentExecutionTestPolicy,
  type CapabilityScope,
  type RpcAuthorityEffect,
} from "@vibestudio/rpc";
import type {
  DirectAuthorityAttestation,
  InternalRpcEvent,
  InternalRpcRequest,
  InternalRpcStreamRequest,
} from "@vibestudio/rpc/internal";
import { verifiedExternalContextFor } from "@vibestudio/rpc/internal";
import {
  createSessionServerTransport,
  type SessionServerTransportInternal,
} from "./sessionServerTransport.js";
import { SESSION_NOT_OPEN_CLOSE_CODE } from "@vibestudio/rpc/protocol/remoteSession";
import { FRAME_ERROR } from "@vibestudio/rpc/protocol/streamCodec";
import type { WsClientMessage, WsServerMessage } from "@vibestudio/shared/ws/protocol";
import {
  IROH_WIRE_VERSION,
  MAX_PENDING_STREAM_ADMISSIONS,
  MAX_CONTROL_FRAME_BYTES,
  MAX_ENVELOPE_FRAME_BYTES,
  readFrame,
  readIrohStreamPreamble,
  writeFrame,
  type IrohPhysicalBiStream,
  type IrohPhysicalConnection,
} from "@vibestudio/iroh-transport";
import {
  decodeIrohSessionControlFrame,
  encodeIrohSessionControlFrame,
  IROH_SESSION_CLOSE,
  IROH_SESSION_CLOSED,
  IROH_SESSION_HELLO,
  IROH_SESSION_OPEN,
  IROH_SESSION_OPEN_RESULT,
  type IrohSessionControlFrame,
} from "@vibestudio/rpc/protocol/irohSession";
import { irohReceiveStreamBody } from "@vibestudio/rpc/transports/irohClient";
import { IrohRpcSessionChannel } from "./irohRpcSessionChannel.js";
import { WebSocketSessionChannel, type RpcSessionChannel } from "./rpcServer/sessionChannel.js";
import { WsUploadBodies } from "./rpcServer/wsUploadBodies.js";
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
import type { PreparedAuthoritySelection } from "@vibestudio/shared/serviceDefinition";
import type { UserSubject } from "@vibestudio/identity/types";
import type { UserSubjectSource } from "@vibestudio/identity/userSubjectSource";
import { userlandReceiverResourceKey } from "@vibestudio/shared/authority/userlandResources";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import {
  AUTHENTICATION_FRAME_MAX_BYTES,
  RPC_MAX_PENDING_AUTHENTICATIONS,
  RPC_WS_ADMISSION_GRANT_TTL_MS,
  RPC_WS_ADMISSION_MAX_CLIENT_LABEL_BYTES,
  RPC_WS_ADMISSION_MAX_OUTSTANDING_GRANTS,
  RPC_WS_ADMISSION_MAX_PENDING_RESOLUTIONS,
  RPC_WS_ADMISSION_RESOLUTION_TIMEOUT_MS,
  RPC_WS_ADMISSION_RETRY_AFTER_MS,
  RPC_WS_PAIRING_REPLAY_TTL_MS,
  RPC_WEBSOCKET_MAX_PAYLOAD_BYTES,
} from "./ingressLimits.js";
import { parseWebSocketAuthProtocol } from "@vibestudio/rpc/protocol/webSocketAuthProtocol";
import {
  RPC_CLIENT_LABEL_HEADER,
  normalizeRpcClientLabel,
  RPC_CLIENT_PLATFORM_HEADER,
  RPC_OAUTH_CALLBACK_MODE_HEADER,
  RPC_WEBSOCKET_ADMISSION_PATH,
  decodeRpcClientLabelHeader,
  type RpcWebSocketAdmissionFailure,
  type RpcWebSocketAdmissionResponse,
} from "@vibestudio/rpc/protocol/rpcWebSocketAdmission";
import { constantTimeStringEqual } from "@vibestudio/shared/tokenManager";
import {
  executionHarnessCodeIdentity,
  refineExecutionTestPolicy,
} from "./services/liveExecutionCaller.js";

function refineTestPolicy(
  first: AgentExecutionTestPolicy | null | undefined,
  second: AgentExecutionTestPolicy | null | undefined
): AgentExecutionTestPolicy | null {
  const refined = refineExecutionTestPolicy(first, second);
  if (!refined && first && second) {
    throw createRelayError("Nested invocation test policy conflicts with live execution", "EACCES");
  }
  return refined;
}

export async function awaitRpcAdmissionResolution<T>(
  resolution: T | PromiseLike<T>,
  timeoutMs: number = RPC_WS_ADMISSION_RESOLUTION_TIMEOUT_MS
): Promise<{ status: "resolved"; value: T } | { status: "timed-out" }> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  return await Promise.race([
    Promise.resolve(resolution).then((value) => ({ status: "resolved" as const, value })),
    new Promise<{ status: "timed-out" }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}
import { callerKindForPrincipalKind } from "@vibestudio/shared/principalKinds";
import { resolveCodeIdentity } from "./services/principalIdentity.js";
import { SessionRegistry, type SessionRegistryOptions } from "./rpcServer/sessionRegistry.js";
import { ConnectionRegistry, type WsClientState } from "./rpcServer/connectionRegistry.js";
import type { ClientPlatform } from "@vibestudio/shared/panel/panelLease";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import type {
  DeviceCredential,
  OAuthCallbackMode,
  PairingContext,
  RpcAuthenticationFailureCode,
} from "@vibestudio/rpc/protocol/wsProtocol";
import { WS_STREAM_REQUEST_BODY_CAPABILITY } from "@vibestudio/rpc/protocol/wsProtocol";
import {
  HttpRpcHandler,
  resolveRpcMaxBodyBytes,
  type HttpRpcAdmission,
} from "./rpcServer/httpRpcHandler.js";
import { StreamingRelay } from "./rpcServer/streamingRelay.js";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import { lineageClasses } from "@vibestudio/shared/authorization";
import { joinContextIntegrity } from "@vibestudio/shared/authority/contextIntegrity";
import {
  receiverAuthorityPolicy,
  standingAgentScopeEligible,
} from "@vibestudio/shared/authority/receiverAuthorityPolicy";
import {
  attestDirectRpc,
  attestWorkspaceDoRpc,
  authorizeVerifiedCaller,
  directAuthorityAudience,
} from "./services/authorityRuntime.js";
import {
  productBuiltinByIdentity,
  productBuiltinMethodPolicy,
  productBuiltinMethodRequests,
} from "@vibestudio/shared/productBuiltinCatalog.generated";
import {
  authorityFailureForDecision,
  evaluateAuthority,
  requirementForPrincipals,
} from "@vibestudio/shared/authorization";
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
 * Caller kinds whose subject is derived from a runtime entity record rather
 * than a human credential: when they fail the membership gate, the cause is a
 * missing or retired entity, not workspace membership.
 */
const RUNTIME_CALLER_KINDS: ReadonlySet<string> = new Set(["panel", "do", "worker"]);

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

function envelopeTransportFromSessionServer(
  transport: SessionServerTransportInternal
): EnvelopeRpcTransport {
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
  clientWs: RpcSessionChannel;
}

interface ResolvedRpcCredential {
  entry: import("@vibestudio/shared/tokenManager").TokenEntry;
  deviceCredential?: DeviceCredential;
  pairingContext?: PairingContext;
  agentBinding?: import("@vibestudio/identity/types").AgentBinding;
  subject?: UserSubject;
  authorizedBy?: string;
  isValidAtUpgrade: () => boolean;
}

interface RedeemedRpcPairingCredential {
  callerId: string;
  callerKind: CallerKind;
  deviceCredential?: DeviceCredential;
  pairingContext?: PairingContext;
  agentBinding?: import("@vibestudio/identity/types").AgentBinding;
  subject?: UserSubject;
}

type RpcCredentialResolution =
  | { ok: true; resolved: ResolvedRpcCredential }
  | {
      ok: false;
      code: RpcAuthenticationFailureCode;
      message: string;
    };

const USED_OR_EXPIRED_PAIRING_MESSAGE =
  "This pairing link has already been used or has expired. Pairing links are one-time to prevent replay; request a fresh link from the server or a paired administrator.";

function rejectedCredential(error?: unknown): RpcCredentialResolution {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (code === "PAIRING_CODE_INVALID_OR_EXPIRED") {
    return {
      ok: false,
      code: "pairing_invalid_or_expired",
      message: USED_OR_EXPIRED_PAIRING_MESSAGE,
    };
  }
  return { ok: false, code: "invalid_credential", message: "Invalid token" };
}

interface RpcWebSocketAdmissionGrant {
  grant: string;
  expiresAt: number;
  resolved: ResolvedRpcCredential;
  clientLabel?: string;
  clientPlatform?: ClientPlatform;
  oauthCallbackMode?: OAuthCallbackMode;
}

interface RpcPairingAdmissionReplay {
  resolved: ResolvedRpcCredential;
  clientLabel?: string;
  clientPlatform?: ClientPlatform;
  oauthCallbackMode?: OAuthCallbackMode;
  grant: string;
  expiresAt: number;
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
  /** Transport-admitted principal with host-owned live relationships refreshed. */
  authenticatedCaller: VerifiedCaller;
  /** Host-resolved initiator whose verified account subject authorizes the operation. */
  authorizingCaller: VerifiedCaller;
  /** Exact outside lineage retained by the host's active invocation parent. */
  inheritedContextIntegrity?: import("@vibestudio/rpc").ContextIntegrityFact | null;
};

type ResolvedExtensionParent = {
  authorizingCaller: VerifiedCaller;
  chainCaller?: VerifiedCodeIdentity;
};

type ResolvedExtensionInvocation = Pick<ExtensionInvocation, "caller" | "chainCaller"> & {
  /** Exact host-retained initiator; never reconstructed from extension input. */
  authorizingCaller: VerifiedCaller;
  /** Host-retained edge from the verified context that invoked the extension. */
  causalParent: RpcCausalParent | null;
};

interface ResolvedCausalInvocation {
  parent: RpcCausalParent;
  /** Host-resolved turn author. This is attribution, never the authorizing principal. */
  initiatingUser: UserSubject | null;
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
    RpcSessionChannel,
    ReturnType<typeof setTimeout> | null
  >();
  private pendingWsAdmissionResolutions = 0;
  private readonly wsAdmissionGrants = new Map<string, RpcWebSocketAdmissionGrant>();
  private readonly pairingAdmissionReplayKey = randomBytes(32);
  private readonly pairingAdmissionReplays = new Map<string, RpcPairingAdmissionReplay>();
  /** Requests whose response still has to be queued before revocation may close the socket. */
  private readonly activeInboundRequests = new Map<RpcSessionChannel, number>();
  /** Exact unary requests owned by each authenticated socket. */
  private readonly inboundRequestControllers = new WeakMap<
    RpcSessionChannel,
    Map<string, AbortController>
  >();
  /** Terminal caller teardown, shared by token revocation and explicit reach cleanup. */
  private readonly callerRetirements = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      pendingSockets: Set<RpcSessionChannel>;
      callerKind?: CallerKind;
      settled: boolean;
    }
  >();
  private stopped = false;
  private quiescing = false;

  private isShuttingDown(): boolean {
    return this.stopped || this.quiescing;
  }

  private readonly bootId = randomUUID();
  /**
   * Invocation-scoped policy delegation for nested infrastructure calls.
   *
   * Keys are host-minted direct-attestation nonces. A claim is useful only
   * while the original receiver is executing, and only from that exact runtime.
   * The wire carries no policy or capability.
   */
  private readonly activeAuthorityParents = new Map<
    string,
    {
      receiverRuntimeId: string;
      testPolicy: AgentExecutionTestPolicy | null;
      requested: readonly CapabilityScope[] | null;
      authorizingCaller: VerifiedCaller | null;
      contextIntegrity: import("@vibestudio/rpc").ContextIntegrityFact | null;
    }
  >();

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
      fsService?: Pick<import("./services/fsService.js").FsService, "closeHandlesForCaller">;
      entityCache?: EntityCache;
      /** Exact active-row readiness barrier required before direct DO relay. */
      ensureUserlandDoReady: (ref: DORef) => Promise<void>;
      /** Live host-created admission for one concrete evaluated run. */
      executionSessionForRuntime?: (
        runtimeId: string,
        nonce: string
      ) => import("@vibestudio/rpc").ExecutionAdmissionFact | null;
      /** Validate the exact controller -> executor invocation that starts a generic execution. */
      executionSessionForDispatch?: (
        controllerRuntimeId: string,
        executorRuntimeId: string,
        method: string,
        nonce: string
      ) => import("@vibestudio/rpc").ExecutionAdmissionFact | null;
      /** Canonical unattended-test policy inherited by reviewed runtimes in a test context. */
      testPolicyForContext?: (
        contextId: string
      ) => import("@vibestudio/rpc").AgentExecutionTestPolicy | null;
      /** Resolve host-attested task membership through live runtime ancestry. */
      taskAuthorityForRuntime?: (
        runtimeId: string
      ) => import("@vibestudio/rpc").TaskGrantPrincipal | null;
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
        touch?(grantId: string): boolean;
        invalidate(snapshotDigest: string, ownerRuntimeId: string, callerPrincipal: string): void;
      };
      /** Durable server-observed context latch for direct userland calls. */
      contextIntegrityFactForSession?: (
        sessionId: string,
        caller: VerifiedCaller
      ) => import("@vibestudio/rpc").ContextIntegrityFact;
      /** Authenticate schema-declared hidden system-test receiver seams. */
      isAttestedSystemTestHarness?: (caller: VerifiedCaller) => boolean;
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
              serviceBinding?: "consent" | "declared";
              methodEffect: RpcAuthorityEffect;
              methodCapability?: string;
              methodReceiverAuthority?: {
                capabilityDefinitionDigest: string;
                resourceType: string;
                provider: string;
                providerExecutionDigest: string;
                grantScopes: readonly import("@vibestudio/shared/authorityManifest").UserlandGrantScope[];
                title: string;
                action: string;
                description?: string;
              };
              methodHandleProduction?: {
                capability: string;
                capabilityDefinitionDigest: string;
                resourceType: string;
                provider: string;
              };
              methodTier: "open" | "gated" | "critical";
              methodExecution?: { harness: "attested-system-test" };
              principals: readonly import("@vibestudio/rpc").PrincipalKind[];
              presentation: {
                domain: import("@vibestudio/shared/authority/authorityDomains").AuthorityDomainId;
                verb: import("@vibestudio/shared/authority/authorityDomains").AuthorityVerb;
                substanceKind?: import("@vibestudio/shared/approvals").OperationSubstance["kind"];
              };
              title: string;
              action: string;
              description?: string;
              declaredBy: string;
            }[]
          >
        | readonly {
            capability: string;
            serviceBinding?: "consent" | "declared";
            methodEffect: RpcAuthorityEffect;
            methodCapability?: string;
            methodReceiverAuthority?: {
              capabilityDefinitionDigest: string;
              resourceType: string;
              provider: string;
              providerExecutionDigest: string;
              grantScopes: readonly import("@vibestudio/shared/authorityManifest").UserlandGrantScope[];
              title: string;
              action: string;
              description?: string;
            };
            methodHandleProduction?: {
              capability: string;
              capabilityDefinitionDigest: string;
              resourceType: string;
              provider: string;
            };
            methodTier: "open" | "gated" | "critical";
            methodExecution?: { harness: "attested-system-test" };
            principals: readonly import("@vibestudio/rpc").PrincipalKind[];
            presentation: {
              domain: import("@vibestudio/shared/authority/authorityDomains").AuthorityDomainId;
              verb: import("@vibestudio/shared/authority/authorityDomains").AuthorityVerb;
              substanceKind?: import("@vibestudio/shared/approvals").OperationSubstance["kind"];
            };
            title: string;
            action: string;
            description?: string;
            declaredBy: string;
          }[];
      /**
       * Resolve state-dependent leaves declared by a product builtin method.
       * The declaration remains catalog-owned; this callback only reads the
       * current host facts needed to select its resource and presentation.
       */
      resolveProductBuiltinPreparedAuthority?: (input: {
        caller: VerifiedCaller;
        source: string;
        className: string;
        objectKey: string;
        method: string;
        args: readonly unknown[];
        resolver: string;
        contextBoundary?: {
          operation:
            | "openPanel"
            | "replacePanel"
            | "reload"
            | "unload"
            | "close"
            | "movePanel"
            | "takeOver"
            | "rebuildPanel"
            | "updatePanelState";
          targetArgument: number;
          targetPath?: readonly (string | number)[];
          requestedContextPath?: readonly (string | number)[];
          requestedContextLookup?: {
            method: string;
            arguments: readonly {
              argument: number;
              path?: readonly (string | number)[];
            }[];
            resultPath: readonly (string | number)[];
          };
        };
      }) => readonly PreparedAuthoritySelection[] | Promise<readonly PreparedAuthoritySelection[]>;
      userlandResourceHandles?: Pick<
        import("./services/userlandResourceHandleStore.js").UserlandResourceHandleStore,
        "issueFromPreparation" | "resolve"
      >;
      /**
       * Live identity gate for persistent WS/Iroh sessions. Authentication
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
      resolveExactCausalInvocation?: (
        parent: RpcCausalParent
      ) => Promise<{ initiatingUser: UserSubject | null } | null>;
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
       * endpoints (which a remote Iroh client cannot reach). A freshly issued
       * device credential is returned so the auth-result hands it back to the
       * client to persist for reconnects. Returns null if the token is neither.
       */
      redeemPairingCredential?: (
        token: string,
        ctx: {
          clientLabel?: string;
          clientPlatform?: ClientPlatform;
          transport: import("@vibestudio/identity/identityDb").DeviceTransportBinding;
        }
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
    }
  ) {
    if (typeof deps.ensureUserlandDoReady !== "function") {
      throw new Error("RpcServer requires a Durable Object execution readiness barrier");
    }
    this.dispatcher = deps.dispatcher;
    this.streamingRelay = new StreamingRelay({
      dispatcher: deps.dispatcher,
      egressProxy: deps.egressProxy,
      authenticateHttp: (req) => this.authenticateHttpRequest(req),
      verifiedCaller: (caller, request, subject) =>
        this.callerWithAuthorityParent(
          this.verifiedCallerFor(
            caller.callerId,
            caller.callerKind,
            caller.agentBinding,
            subject,
            this.authorityParentFor(
              caller.callerId,
              (request as InternalRpcRequest | InternalRpcStreamRequest).authorityParentNonce
            )?.testPolicy,
            (request as InternalRpcRequest | InternalRpcStreamRequest).executionSessionNonce
          ),
          this.authorityParentFor(
            caller.callerId,
            (request as InternalRpcRequest | InternalRpcStreamRequest).authorityParentNonce
          )
        ),
      authorizeRelay: (callerId, callerKind, targetId, method) =>
        this.checkRelayAuth(callerId, callerKind, targetId, method),
      resolveCausalParent: (caller, request) => this.resolveCausalParent(caller, request),
      createSessionContext: (client, request, caller, extras) =>
        this.serviceContextForRpcMessage(client, request, extras, caller),
      relayTargetStream: (caller, envelope, request, causalParent, signal) =>
        this.relayTargetStream(caller, envelope, request, causalParent, signal),
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
    agentBinding?:
      | import("@vibestudio/identity/types").AgentBinding
      | import("@vibestudio/shared/runtime/entitySpec").RuntimeAgentBinding,
    subject?: UserSubject,
    inheritedTestPolicy?: AgentExecutionTestPolicy | null,
    executionSessionNonce?: string
  ): VerifiedCaller {
    const activeEntity =
      callerKind === "worker" || callerKind === "do"
        ? this.deps.entityCache?.resolveActive(callerId)
        : undefined;
    const resolvedAgentBinding = agentBinding ?? activeEntity?.agentBinding;
    const residentCode =
      callerKind === "extension"
        ? (this.deps.resolveExtensionCodeIdentity?.(callerId) ?? null)
        : this.deps.entityCache
          ? resolveCodeIdentity(this.deps.entityCache, callerId)
          : null;
    // An explicitly-passed subject (device/agent credential, §5.1/§5.3) wins;
    // otherwise resolve it from the caller id (§5.2/§5.4).
    const resolvedSubject =
      subject ??
      this.resolveSubject(
        callerId,
        callerKind,
        agentBinding && "agentId" in agentBinding ? agentBinding : undefined
      );
    if (
      executionSessionNonce !== undefined &&
      (executionSessionNonce.length < 16 || executionSessionNonce.length > 256)
    ) {
      throw createRelayError("Invalid evaluated execution session", "EACCES");
    }
    const executionSession = executionSessionNonce
      ? (this.deps.executionSessionForRuntime?.(callerId, executionSessionNonce) ?? null)
      : null;
    if (executionSessionNonce && !executionSession) {
      throw createRelayError("Evaluated execution session is not active", "EACCES");
    }
    if (
      executionSession &&
      (executionSession.executor.runtimeId !== callerId ||
        executionSession.contextId !== activeEntity?.contextId ||
        executionSession.agentBinding?.entityId !== resolvedAgentBinding?.entityId ||
        executionSession.agentBinding?.channelId !== resolvedAgentBinding?.channelId)
    ) {
      throw createRelayError(
        "Evaluated execution admission no longer matches live state",
        "EACCES"
      );
    }
    const code = executionSession
      ? executionHarnessCodeIdentity({
          runtime: { id: callerId, kind: callerKind },
          executionSession,
          ...(residentCode ? { residentCode } : {}),
        })
      : residentCode;
    const contextTestPolicy = activeEntity?.contextId
      ? this.deps.testPolicyForContext?.(activeEntity.contextId)
      : null;
    const residentTestPolicy = refineTestPolicy(executionSession?.testPolicy, contextTestPolicy);
    const effectiveTestPolicy = refineTestPolicy(residentTestPolicy, inheritedTestPolicy);
    const verified = createVerifiedCaller(
      callerId,
      callerKind,
      code,
      resolvedAgentBinding,
      resolvedSubject,
      executionSession,
      effectiveTestPolicy
    );
    const taskAuthority =
      executionSession?.taskAuthority ?? this.deps.taskAuthorityForRuntime?.(callerId);
    const withTaskAuthority = {
      ...verified,
      ...(taskAuthority ? { taskAuthority } : {}),
    };
    return code && (this.deps.isCodeApproved?.(code) ?? true)
      ? { ...withTaskAuthority, codeApproved: true }
      : withTaskAuthority;
  }

  private authorityParentFor(
    callerRuntimeId: string,
    authorityParentNonce: string | undefined
  ): {
    receiverRuntimeId: string;
    testPolicy: AgentExecutionTestPolicy | null;
    requested: readonly CapabilityScope[] | null;
    authorizingCaller: VerifiedCaller | null;
    contextIntegrity: import("@vibestudio/rpc").ContextIntegrityFact | null;
  } | null {
    if (authorityParentNonce === undefined) return null;
    if (
      typeof authorityParentNonce !== "string" ||
      authorityParentNonce.length < 16 ||
      authorityParentNonce.length > 256
    ) {
      throw createRelayError("Invalid invocation authority parent", "EACCES");
    }
    const active = this.activeAuthorityParents.get(authorityParentNonce);
    if (!active) {
      throw createRelayError("Invocation authority parent is not active", "EACCES");
    }
    if (active.receiverRuntimeId !== callerRuntimeId) {
      throw createRelayError("Invocation authority parent belongs to another runtime", "EACCES");
    }
    return active;
  }

  private callerWithAuthorityParent(
    caller: VerifiedCaller,
    parent: {
      receiverRuntimeId: string;
      testPolicy: AgentExecutionTestPolicy | null;
      requested: readonly CapabilityScope[] | null;
      authorizingCaller: VerifiedCaller | null;
    } | null
  ): VerifiedCaller {
    if (!parent || parent.requested === null || !caller.code) return caller;
    return {
      ...caller,
      code: {
        ...caller.code,
        requested: parent.requested,
      },
    };
  }

  private beginAuthorityParent(
    receiverRuntimeId: string,
    authorization: DirectAuthorityAttestation,
    authorizingCaller: VerifiedCaller | null = null
  ): () => void {
    const inheritedTestPolicy = authorization.context.testPolicy;
    const receiver = this.deps.entityCache?.resolveActive(receiverRuntimeId);
    const residentTestPolicy = receiver?.contextId
      ? this.deps.testPolicyForContext?.(receiver.contextId)
      : null;
    const testPolicy = refineTestPolicy(residentTestPolicy, inheritedTestPolicy) ?? null;
    const ref = parseDOTarget(receiverRuntimeId);
    const requested = productBuiltinByIdentity(ref.source, ref.className)
      ? productBuiltinMethodRequests(ref.source, ref.className, authorization.method)
      : null;
    const inheritedContextIntegrity = authorization.context.contextIntegrity;
    const contextIntegrity = inheritedContextIntegrity
      ? Object.freeze({
          ...inheritedContextIntegrity,
          externalKeys: Object.freeze([...inheritedContextIntegrity.externalKeys]),
        })
      : null;
    if (this.activeAuthorityParents.has(authorization.nonce)) {
      throw createRelayError("Direct invocation authority nonce is already active", "EACCES");
    }
    const entry = {
      receiverRuntimeId,
      testPolicy,
      requested,
      authorizingCaller,
      contextIntegrity,
    };
    this.activeAuthorityParents.set(authorization.nonce, entry);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.activeAuthorityParents.get(authorization.nonce) === entry) {
        this.activeAuthorityParents.delete(authorization.nonce);
      }
    };
  }

  async withAuthorityParent<T>(
    receiverRuntimeId: string,
    authorization: DirectAuthorityAttestation,
    invoke: () => Promise<T>
  ): Promise<T> {
    const release = this.beginAuthorityParent(
      receiverRuntimeId,
      authorization,
      createHostCaller("server", "server", SYSTEM_SUBJECT)
    );
    try {
      return await invoke();
    } finally {
      release();
    }
  }

  private responseWithAuthorityParentLifetime(response: Response, release: () => void): Response {
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      release();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            finish();
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
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

  private serviceContextForRpcMessage(
    client: WsClientState,
    message: {
      parentRequestId?: string;
      causalParent?: import("@vibestudio/rpc").RpcCausalParent;
    },
    extras: Omit<ServiceContext, "caller" | "connectionId" | "wsClient" | "chainCaller"> = {},
    invocationCaller: VerifiedCaller = client.caller
  ): ServiceContext {
    const ctx: ServiceContext = {
      caller: invocationCaller,
      connectionId: client.connectionId,
      wsClient: client,
      ...extras,
    };
    const parent = this.resolveExtensionParentCaller(client, message);
    if (parent) ctx.authorizingCaller = parent.authorizingCaller;
    if (parent?.chainCaller) ctx.chainCaller = parent.chainCaller;
    return ctx;
  }

  private async resolveCausalParent(
    caller: VerifiedCaller,
    message: Pick<RpcRequest, "causalParent" | "parentRequestId">
  ): Promise<RpcCausalParent | undefined> {
    return (await this.resolveCausalInvocation(caller, message))?.parent;
  }

  private async resolveCausalInvocation(
    caller: VerifiedCaller,
    message: Pick<RpcRequest, "causalParent" | "parentRequestId">
  ): Promise<ResolvedCausalInvocation | undefined> {
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

    const resolver = this.deps.resolveExactCausalInvocation;
    if (!resolver) {
      throw createRelayError("Exact causal invocation verification is unavailable", "EACCES");
    }
    let resolved: { initiatingUser: UserSubject | null } | null;
    try {
      resolved = await resolver(causalParent);
    } catch (error) {
      throw createRelayError(
        `Exact causal invocation verification failed: ${error instanceof Error ? error.message : String(error)}`,
        "EACCES"
      );
    }
    if (!resolved) {
      throw createRelayError(
        `Causal invocation does not exist: ${causalParent.invocationId}`,
        "EACCES"
      );
    }
    return { parent: causalParent, initiatingUser: resolved.initiatingUser };
  }

  private callerWithCausalAttribution(
    caller: VerifiedCaller,
    causal: ResolvedCausalInvocation | undefined
  ): VerifiedCaller {
    if (!causal) return caller;
    return causal.initiatingUser ? { ...caller, subject: causal.initiatingUser } : caller;
  }

  private resolveExtensionParentCaller(
    client: WsClientState,
    message: Pick<RpcRequest | import("@vibestudio/rpc").RpcStreamRequest, "parentRequestId">
  ): ResolvedExtensionParent | null {
    if (client.caller.runtime.kind !== "extension" || !message.parentRequestId) {
      return null;
    }
    const invocation = this.deps.resolveExtensionInvocation?.(
      client.caller.runtime.id,
      message.parentRequestId
    );
    if (invocation?.chainCaller) {
      const chainCaller: VerifiedCodeIdentity = {
        callerId: invocation.chainCaller.callerId,
        callerKind: invocation.chainCaller.callerKind,
        repoPath: invocation.chainCaller.repoPath,
        effectiveVersion: invocation.chainCaller.effectiveVersion,
      };
      return {
        authorizingCaller: invocation.authorizingCaller,
        chainCaller,
      };
    }
    return invocation ? { authorizingCaller: invocation.authorizingCaller } : null;
  }

  private relayCallerScopeForRpcMessage(
    client: WsClientState,
    message: Pick<RpcRequest, "parentRequestId">
  ): RelayCallerScope {
    const parent = this.resolveExtensionParentCaller(client, message);
    const authenticatedCaller = this.withLiveRuntimeRelationships(client.caller);
    return {
      authenticatedCaller,
      authorizingCaller: parent?.authorizingCaller ?? authenticatedCaller,
    };
  }

  /**
   * Refresh relationships that are owned by workspace state without replacing
   * the principal, code identity, or account subject admitted by the transport.
   *
   * A worker can establish its self-channel binding after its long-lived RPC
   * socket has authenticated. Treating that connection-time snapshot as live
   * authority made the routed unary path disagree with HTTP and streaming RPC,
   * both of which already resolve the active entity for every request.
   */
  private withLiveRuntimeRelationships(caller: VerifiedCaller): VerifiedCaller {
    if (caller.runtime.kind !== "worker" && caller.runtime.kind !== "do") return caller;
    const active = this.deps.entityCache?.resolveActive(caller.runtime.id);
    if (!active) return caller;
    const { agentBinding: _staleBinding, ...admitted } = caller;
    return active.agentBinding ? { ...admitted, agentBinding: active.agentBinding } : admitted;
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

  /** Exact route fact used by panel readiness; a lease alone is not a live RPC target. */
  isRuntimeRouteReachable(targetId: string, connectionId: string): boolean {
    const routedTargetId = this.resolveRoutableTargetId(targetId);
    const client = this.getConnection(routedTargetId, connectionId);
    return Boolean(
      client?.ws.readyState === client?.ws.OPEN &&
      this.connections.getBridge(routedTargetId, connectionId)
    );
  }

  private setBridge(
    callerId: string,
    connectionId: string,
    bridge: RpcClient,
    transport: SessionServerTransportInternal
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
  setWorkerdUrl(url: string | null): void {
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
    if (this.isShuttingDown()) throw new Error("RpcServer has stopped and cannot be restarted");
    if (this.handlersInitialized) return;
    this.handlersInitialized = true;

    // RPC WebSockets carry control envelopes. Large payloads use the streaming
    // and Iroh bulk lanes instead of consuming one monolithic WS message.
    // Origin allow-listing remains at the gateway upgrade boundary.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: RPC_WEBSOCKET_MAX_PAYLOAD_BYTES,
    });

    // Register revocation-driven disconnect
    this.disposeTokenRevocationListener = this.deps.tokenManager.onRevoke((callerId) => {
      for (const [grant, admission] of this.wsAdmissionGrants) {
        if (admission.resolved.entry.callerId === callerId) {
          this.wsAdmissionGrants.delete(grant);
        }
      }
      for (const [digest, replay] of this.pairingAdmissionReplays) {
        if (replay.resolved.entry.callerId === callerId) {
          this.pairingAdmissionReplays.delete(digest);
        }
      }
      void this.retireCaller(callerId);
    });
  }
  private handlersInitialized = false;

  private handleConnection(
    ws: RpcSessionChannel,
    upgradeAdmission?: RpcWebSocketAdmissionGrant
  ): void {
    if (this.isShuttingDown()) {
      ws.close(1001, "Server shutting down");
      return;
    }
    if (this.pendingAuthentications.size >= RPC_MAX_PENDING_AUTHENTICATIONS) {
      ws.close(1013, "Too many pending RPC authentications; retry shortly");
      return;
    }
    ws.onError((error) => {
      log.warn("RPC session transport error", {
        cause: error instanceof Error ? error.message : String(error),
      });
    });
    // Expect first message to be ws:auth
    let authTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      ws.close(4003, "Auth timeout");
    }, 10000);
    this.pendingAuthentications.set(ws, authTimeout);

    let removeFirstMessageListener = (): void => undefined;
    const onFirstMessage = (msg: WsClientMessage, authFrameBytes: number) => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
        this.pendingAuthentications.set(ws, null);
      }
      removeFirstMessageListener();

      // This is a protocol-shape check. Every gateway WebSocket credential was
      // resolved by the bounded HTTP admission exchange before upgrade.
      if (authFrameBytes > AUTHENTICATION_FRAME_MAX_BYTES) {
        ws.close(1009, `RPC authentication frame exceeds ${AUTHENTICATION_FRAME_MAX_BYTES} bytes`);
        return;
      }

      if (msg.type !== "ws:auth") {
        ws.close(4005, "Expected ws:auth as first message");
        return;
      }

      if (
        upgradeAdmission &&
        (typeof msg.token !== "string" ||
          !constantTimeStringEqual(msg.token, upgradeAdmission.grant))
      ) {
        ws.close(4006, "RPC upgrade credential does not match authentication frame");
        return;
      }
      if (
        upgradeAdmission &&
        (normalizeRpcClientLabel(msg.clientLabel) !== upgradeAdmission.clientLabel ||
          msg.clientPlatform !== upgradeAdmission.clientPlatform ||
          msg.oauthCallbackMode !== upgradeAdmission.oauthCallbackMode)
      ) {
        ws.close(4006, "RPC authentication metadata does not match admission grant");
        return;
      }

      if (msg.contractVersion !== RPC_CONTRACT_VERSION) {
        const result: WsServerMessage = {
          type: "ws:auth-result",
          success: false,
          contractVersion: RPC_CONTRACT_VERSION,
          error: `Incompatible RPC contract: peer ${String(msg.contractVersion)}; server requires ${RPC_CONTRACT_VERSION}`,
        };
        ws.sendMessage(result);
        ws.close(4005, "Incompatible RPC contract");
        return;
      }

      void this.handleAuth(
        ws,
        msg.token,
        msg.connectionId,
        normalizeRpcClientLabel(msg.clientLabel),
        msg.clientSessionId,
        msg.clientPlatform,
        msg.oauthCallbackMode,
        upgradeAdmission?.resolved
      )
        .catch((error) => this.abortFailedAuthentication(ws, error))
        .finally(() => {
          this.pendingAuthentications.delete(ws);
        });
    };

    removeFirstMessageListener = ws.onMessage(onFirstMessage);
    ws.onClose(() => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      this.pendingAuthentications.delete(ws);
    });
  }

  private resolveRpcCredential(
    token: unknown,
    clientLabel?: string,
    clientPlatform?: ClientPlatform,
    transport: import("@vibestudio/identity/identityDb").DeviceTransportBinding = { kind: "local" }
  ): RpcCredentialResolution | Promise<RpcCredentialResolution> {
    if (typeof token !== "string" || token.length === 0) {
      return {
        ok: false,
        code: "invalid_credential",
        message: "Missing or invalid auth token",
      };
    }
    if (this.deps.tokenManager.validateAdminToken(token)) {
      return { ok: false, code: "admin_credential", message: ADMIN_RPC_AUTH_ERROR };
    }

    const remoteEndpointId = transport.kind === "iroh" ? transport.endpointId : undefined;
    const connectionGrant =
      this.deps.connectionGrants?.redeem(token, remoteEndpointId) ??
      this.deps.connectionGrants?.validate(token, remoteEndpointId) ??
      null;
    let entry: import("@vibestudio/shared/tokenManager").TokenEntry | null;
    let agentBinding: import("@vibestudio/identity/types").AgentBinding | undefined;
    let subject: UserSubject | undefined;
    let resolvedFromTokenManager = false;
    try {
      entry = connectionGrant
        ? {
            callerId: connectionGrant.principalId,
            callerKind: this.callerKindForRuntimePrincipal(connectionGrant.principalId),
          }
        : this.deps.tokenManager.validateToken(token);
      resolvedFromTokenManager = !connectionGrant && entry !== null;
      if (entry?.agentBinding) agentBinding = entry.agentBinding;
      if (connectionGrant && entry?.callerKind === "app") {
        subject = connectionGrant.subject;
      }
    } catch {
      entry = null;
    }

    const finish = (paired: RedeemedRpcPairingCredential | null): RpcCredentialResolution => {
      if (paired) {
        entry = { callerId: paired.callerId, callerKind: paired.callerKind };
        agentBinding = paired.agentBinding;
        subject = paired.subject;
      }
      if (!entry) {
        return rejectedCredential();
      }
      const resolvedEntry = entry;
      const isValidAtUpgrade = (): boolean => {
        if (connectionGrant) {
          const current = this.deps.connectionGrants?.validate(token, remoteEndpointId);
          return (
            current?.principalId === resolvedEntry.callerId &&
            current.principalKind === resolvedEntry.callerKind
          );
        }
        if (resolvedFromTokenManager) {
          const current = this.deps.tokenManager.validateToken(token);
          return (
            current?.callerId === resolvedEntry.callerId &&
            current.callerKind === resolvedEntry.callerKind
          );
        }
        try {
          const caller = this.verifiedCallerFor(
            resolvedEntry.callerId,
            resolvedEntry.callerKind,
            agentBinding,
            subject
          );
          return this.deps.liveCallerGate?.(caller) ?? true;
        } catch {
          return false;
        }
      };
      return {
        ok: true,
        resolved: {
          entry: resolvedEntry,
          ...(paired?.deviceCredential ? { deviceCredential: paired.deviceCredential } : {}),
          ...(paired?.pairingContext ? { pairingContext: paired.pairingContext } : {}),
          ...(agentBinding ? { agentBinding } : {}),
          ...(subject ? { subject } : {}),
          ...(connectionGrant?.issuedBy ? { authorizedBy: connectionGrant.issuedBy } : {}),
          isValidAtUpgrade,
        },
      };
    };
    // Ordinary token-manager bearers are loopback-only. A connection grant is
    // accepted remotely only when it was minted by and presented from the same
    // verified Iroh endpoint.
    if (entry && transport.kind === "iroh" && !connectionGrant) return rejectedCredential();
    if (entry) return finish(null);
    if (!this.deps.redeemPairingCredential) return finish(null);
    try {
      return Promise.resolve(
        this.deps.redeemPairingCredential(token, { clientLabel, clientPlatform, transport })
      ).then(
        (paired) => finish(paired),
        (error) => rejectedCredential(error)
      );
    } catch (error) {
      return rejectedCredential(error);
    }
  }

  private async handleAuth(
    ws: RpcSessionChannel,
    token: unknown,
    requestedConnectionId?: string,
    clientLabel?: string,
    clientSessionId?: string,
    clientPlatform?: ClientPlatform,
    oauthCallbackMode?: OAuthCallbackMode,
    preResolved?: ResolvedRpcCredential
  ): Promise<void> {
    if (this.isShuttingDown()) {
      ws.close(1001, "Server shutting down");
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    const resolutionOrPromise = preResolved
      ? ({ ok: true, resolved: preResolved } as const)
      : this.resolveRpcCredential(token, clientLabel, clientPlatform, ws.transportBinding);
    const resolution =
      resolutionOrPromise instanceof Promise ? await resolutionOrPromise : resolutionOrPromise;
    // Pairing redemption crosses the child→hub boundary. The unauthenticated
    // socket may disappear while that durable operation is in flight; never
    // create session/lease/bridge state for a transport that is already gone.
    if (this.isShuttingDown() || ws.readyState !== ws.OPEN) return;
    if (!resolution.ok) {
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
        error: resolution.message,
        errorCode: resolution.code,
      };
      ws.sendMessage(msg);
      ws.close(4006, resolution.message);
      return;
    }
    const { entry, deviceCredential, pairingContext, agentBinding, subject, authorizedBy } =
      resolution.resolved;
    // The literal caller id "shell" is reserved for in-process dispatch.
    // Host clients that authenticate over WS use kind:"shell" with concrete
    // caller ids such as "electron-main", headless-host, or paired devices.
    if (entry.callerKind === "shell" && entry.callerId === "shell") {
      const msg: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: 'callerId:"shell" cannot authenticate over WebSocket',
      };
      ws.sendMessage(msg);
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
        ws.sendMessage(msg);
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
      ws.sendMessage(msg);
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
        ws.sendMessage(msg);
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
        // Two very different failures reach this point: a real human who is not
        // a member, and a runtime whose entity is unknown or no longer active
        // (so no subject could be derived at all). Reporting both as
        // non-membership sends debugging into the identity system when the
        // fault is in the runtime registry, so name the actual condition.
        const reason =
          gateSubject === undefined && RUNTIME_CALLER_KINDS.has(callerKind)
            ? `Unknown or inactive runtime entity: ${callerId}`
            : "Not a member of this workspace";
        const msg: WsServerMessage = {
          type: "ws:auth-result",
          success: false,
          error: reason,
        };
        ws.sendMessage(msg);
        ws.close(4403, reason);
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
    const verifiedCaller = this.verifiedCallerFor(callerId, callerKind, agentBinding, subject);
    const caller: VerifiedCaller =
      ws.transportBinding.kind === "iroh"
        ? { ...verifiedCaller, remoteEndpointId: ws.transportBinding.endpointId }
        : verifiedCaller;
    // Denormalize the host-verified owning user once, at admission (WP4 §2.1).
    // Defensive invariant: only the in-process server can synthesize a subject;
    // every external unattributed caller fails here.
    let userId: string;
    try {
      userId = caller.subject?.userId ?? assertBootstrapSubject(caller);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const msg: WsServerMessage = { type: "ws:auth-result", success: false, error: message };
      ws.sendMessage(msg);
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
      authorizedBy,
      clientLabel,
      clientSessionId,
      clientPlatform,
      oauthCallbackMode,
      ...(ws.transportBinding.kind === "local" ? { uploadBodies: new WsUploadBodies() } : {}),
    };

    this.connections.addClient(client);
    // Install teardown immediately after registry admission. Any exception in
    // the remaining setup is rolled back by abortFailedAuthentication; a real
    // network close from this point onward must run the normal close path.
    ws.onMessage((message) => this.handleMessage(client, message));
    ws.onClose((code, reason) => this.handleClose(client, code, reason));

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
    const transport = createSessionServerTransport({
      ws,
      clientId: `${callerId}:${connectionId}`,
    });
    const bridge = createRpcClient({
      selfId: "server",
      callerKind: "server",
      transport: envelopeTransportFromSessionServer(transport),
    });
    this.setBridge(callerId, connectionId, bridge, transport);
    if (this.deps.eventService) {
      const release = this.deps.eventService.registerTransportSession({
        callerId,
        callerKind,
        connectionId,
        userId,
        send: (event, payload) => {
          this.sendToSession(ws, {
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
      transportCapabilities: [WS_STREAM_REQUEST_BODY_CAPABILITY],
      callerId,
      callerKind,
      connectionId,
      serverBootId: this.bootId,
      sessionDirty,
      ...(deviceCredential ? { deviceCredential } : {}),
      ...(pairingContext ? { pairingContext } : {}),
    };
    ws.sendMessage(authResult);

    if (sessionDirty) {
      this.sessions.clearInbox(callerId);
    } else {
      for (const queued of this.sessions.takeInbox(callerId)) {
        this.sendToSession(ws, {
          type: "ws:routed",
          envelope: queued.envelope,
        });
      }
    }
  }

  private abortFailedAuthentication(ws: RpcSessionChannel, error: unknown): void {
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
    if (ws.readyState !== ws.OPEN) return;
    try {
      const message: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: "Authentication failed",
      };
      ws.sendMessage(message);
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
   * callers may then tear down the Iroh room that carries those sessions.
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
    if (retirement?.pendingSockets.has(client.ws) && client.ws.readyState === client.ws.OPEN) {
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

  private handleMessage(client: WsClientState, msg: WsClientMessage): void {
    if (!this.connections.isActiveClient(client)) return;

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
        if (msg.streamBody) {
          if (rpcMessage.type !== "stream-request" || !client.uploadBodies) {
            client.ws.close(4004, "Invalid WebSocket stream body declaration");
            return;
          }
          try {
            client.uploadBodies.open(rpcMessage.requestId);
          } catch (error) {
            log.warn("rejected WebSocket stream body declaration", {
              callerId: client.caller.runtime.id,
              requestId: rpcMessage.requestId,
              error: error instanceof Error ? error.message : String(error),
            });
            client.ws.close(4004, "Invalid WebSocket stream body declaration");
            return;
          }
        }
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
      case "ws:stream-body-chunk": {
        if (!client.uploadBodies) {
          this.sendToSession(client.ws, {
            type: "ws:stream-body-ack",
            requestId: msg.requestId,
            seq: msg.seq,
            error: "WebSocket upload registry is unavailable",
          });
          break;
        }
        const uploadBodies = client.uploadBodies;
        void uploadBodies
          .push(msg)
          .then(() =>
            this.sendToSession(client.ws, {
              type: "ws:stream-body-ack",
              requestId: msg.requestId,
              seq: msg.seq,
            })
          )
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            uploadBodies.fail(msg.requestId, new Error(message));
            this.sendToSession(client.ws, {
              type: "ws:stream-body-ack",
              requestId: msg.requestId,
              seq: msg.seq,
              error: message,
            });
          });
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
      await this.streamingRelay.handleSessionRequest(client, message, envelope);
      return;
    }
    if (message.type === "stream-cancel") {
      client.uploadBodies?.fail(message.requestId, new Error("Streaming RPC cancelled by caller"));
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
      this.sendToSession(client.ws, {
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
      const causal = await this.resolveCausalInvocation(client.caller, request);
      const ctx = this.serviceContextForRpcMessage(
        client,
        request,
        {
          ...(request.requestId ? { requestId: request.requestId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(readOnly ? { readOnly: true } : {}),
          ...(causal ? { causalParent: causal.parent } : {}),
          signal: abort.signal,
        },
        this.callerWithCausalAttribution(client.caller, causal)
      );
      const result = await dispatcher.dispatch(ctx, service, method, request.args);
      this.sendToSession(client.ws, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: request.requestId,
          result,
        }),
      });
    } catch (error) {
      const errorCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      this.sendToSession(client.ws, {
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
      // `sendToSession` above synchronously queues the response. A concurrent token
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
    targetId: unknown,
    message: RpcMessage,
    targetConnectionId: string | undefined,
    routeEnvelope: RpcEnvelope
  ): Promise<void> {
    if (typeof targetId !== "string") {
      this.sendRouteError(
        client,
        "server",
        message,
        createRelayError("RPC target must be a target-id string", "RPC_PROTOCOL_ERROR")
      );
      return;
    }
    // A routed stream is still owned by the caller connection's canonical
    // streaming relay. That relay performs target authorization, dispatches the
    // connectionless DO stream, frames the response back to this exact socket,
    // and owns cancellation. Letting stream messages continue through the
    // ordinary unary route below silently drops them when the target is a DO
    // (there is deliberately no target WebSocket to forward to).
    if (message.type === "stream-request") {
      await this.streamingRelay.handleSessionRequest(client, message, routeEnvelope);
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
          this.sendToSession(originClient.ws, {
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
    if (!targetClient || targetClient.ws.readyState !== targetClient.ws.OPEN) {
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
                ...(rpcErrorDataOf(err) !== undefined ? { errorData: rpcErrorDataOf(err) } : {}),
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

    this.sendToSession(targetClient.ws, {
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
      this.sendToSession(client.ws, {
        type: "ws:routed",
        envelope: envelopeForWsDelivery(targetId, "unknown", client.caller.runtime.id, {
          type: "response",
          requestId: message.requestId,
          error: errorMessage,
          errorKind: rpcErrorKindOf(err, "transport"),
          ...(errorCode ? { errorCode } : {}),
          ...(rpcErrorDataOf(err) !== undefined ? { errorData: rpcErrorDataOf(err) } : {}),
        }),
      });
      return;
    }

    if (message.type === "stream-request") {
      this.sendToSession(client.ws, {
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
            ...(rpcErrorDataOf(err) !== undefined ? { errorData: rpcErrorDataOf(err) } : {}),
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
      this.sendToSession(client.ws, {
        type: "ws:routed-response-error",
        targetId,
        requestId: message.requestId,
        error: errorMessage,
        errorKind: rpcErrorKindOf(err, "transport"),
        ...(errorCode ? { errorCode } : {}),
        ...(rpcErrorDataOf(err) !== undefined ? { errorData: rpcErrorDataOf(err) } : {}),
      });
      return;
    }

    {
      const eventMessage = message as RpcEvent;
      // Host-local targets must be consumed before this server relay. Reaching
      // this path is therefore always diagnostic, including host commands.
      log.warn("relay event drop", {
        callerId: client.caller.runtime.id,
        callerKind: client.caller.runtime.kind,
        targetId,
        event: eventMessage.event,
        fromId: eventMessage.fromId,
        error: errorMessage,
        errorCode,
      });
      this.sendToSession(client.ws, {
        type: "ws:routed-event-error",
        targetId,
        event: eventMessage.event,
        error: errorMessage,
        errorKind: rpcErrorKindOf(err, "transport"),
        ...(errorCode ? { errorCode } : {}),
        ...(rpcErrorDataOf(err) !== undefined ? { errorData: rpcErrorDataOf(err) } : {}),
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

    this.sendToSession(client.ws, {
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
    this.sendToSession(originClient.ws, {
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
    client.uploadBodies?.closeAll(new Error("RPC connection closed"));
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
    if (this.isShuttingDown()) {
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
    client.uploadBodies?.closeAll(new Error("RPC connection replaced"));
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
          this.sendToSession(originClient.ws, {
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
      this.sendToSession(client.ws, msg);
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
   * is a direct service-dispatch; any other target is a relay.
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
    const authorityParent = this.authorityParentFor(
      callerId,
      (message as InternalRpcRequest | InternalRpcStreamRequest).authorityParentNonce
    );
    const executionSessionNonce = (message as InternalRpcRequest | InternalRpcStreamRequest)
      .executionSessionNonce;
    // A generic mission admission first travels on the exact controller ->
    // executor dispatch edge. The controller keeps its own identity and
    // authority; only later calls made by the executor are attributed to the
    // admitted execution. Treating the dispatch as an executor effect made
    // every real scheduled agent fail before its turn could start.
    const executionDispatch =
      executionSessionNonce && targetId !== "main"
        ? (this.deps.executionSessionForDispatch?.(
            callerId,
            targetId,
            method,
            executionSessionNonce
          ) ?? null)
        : null;
    const verifiedCaller = this.callerWithAuthorityParent(
      this.verifiedCallerFor(
        callerId,
        callerKind,
        agentBinding,
        undefined,
        authorityParent?.testPolicy,
        executionDispatch ? undefined : executionSessionNonce
      ),
      authorityParent
    );
    const causal = await this.resolveCausalInvocation(verifiedCaller, message);
    const causalParent = causal?.parent;
    // A causal parent authenticates invocation lineage; it does not change the
    // authorizing origin. Harness-owned tool and closure calls retain their
    // sealed code identity. EvalDO is marked session-originated when its exact
    // active runtime identity is resolved in verifiedCallerFor().
    const invocationCaller = this.callerWithCausalAttribution(verifiedCaller, causal);
    const authorizingCaller = authorityParent?.authorizingCaller ?? invocationCaller;

    // Direct service dispatch
    if (targetId === "main") {
      const parsed = parseServiceMethod(method);
      if (!parsed) throw new Error(`Invalid method format: "${method}"`);

      const ctx: ServiceContext = {
        caller: invocationCaller,
        ...(authorityParent?.authorizingCaller ? { authorizingCaller } : {}),
        ...(causalParent ? { causalParent } : {}),
        ...(requestId ? { requestId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...(authorityParent?.contextIntegrity
          ? { inheritedContextIntegrity: authorityParent.contextIntegrity }
          : {}),
        signal,
      };
      const dispatched = await this.dispatcher.dispatch(ctx, parsed.service, parsed.method, args);
      return dispatched;
    }

    // Relay to another target
    const auth = this.checkRelayAuth(callerId, callerKind, targetId, method);
    if (!auth.ok) throw createRelayError(auth.reason, "EACCES");
    const authenticatedCaller = invocationCaller;
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
        signal,
      },
      {
        authenticatedCaller,
        authorizingCaller,
        ...(authorityParent?.contextIntegrity
          ? { inheritedContextIntegrity: authorityParent.contextIntegrity }
          : {}),
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
    const executionSessionNonce = (message as InternalRpcEvent).executionSessionNonce;
    const attributedCaller =
      callerKind === "server"
        ? createHostCaller(callerId, "server", SYSTEM_SUBJECT)
        : this.verifiedCallerFor(
            callerId,
            callerKind,
            undefined,
            undefined,
            undefined,
            executionSessionNonce
          );
    await this.relayEvent(
      callerId,
      callerKind,
      targetId,
      message.event,
      message.payload,
      undefined,
      attributedCaller
    );
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
    if (client && client.ws.readyState === client.ws.OPEN) {
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
    const inheritedContextIntegrity = verifiedExternalContextFor(options);
    if (inheritedContextIntegrity && !targetId.startsWith("do:")) {
      throw new Error("Verified external context requires a direct Durable Object target");
    }
    const hostCaller = inheritedContextIntegrity
      ? createHostCaller("main", "server", SYSTEM_SUBJECT)
      : null;
    return this.relayCall(
      "main",
      "server",
      targetId,
      method,
      args,
      undefined,
      options,
      hostCaller
        ? {
            authenticatedCaller: hostCaller,
            authorizingCaller: hostCaller,
            inheritedContextIntegrity,
          }
        : undefined
    ) as Promise<T>;
  }

  async streamCallTarget(targetId: string, method: string, ...args: unknown[]): Promise<Response> {
    const wsClient = this.pickRoutableTarget(targetId);
    if (!wsClient || wsClient.ws.readyState !== wsClient.ws.OPEN) {
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
    targetId: unknown,
    method: string,
    args: unknown[],
    targetConnectionId?: string,
    meta?: RelayCallMeta,
    relayCallerScope?: RelayCallerScope
  ): Promise<unknown> {
    if (typeof targetId !== "string") {
      const resolvedTarget =
        targetId && typeof targetId === "object" && "targetId" in targetId
          ? (targetId as { targetId?: unknown }).targetId
          : undefined;
      throw createRelayError(
        typeof resolvedTarget === "string"
          ? "RPC target must be a target-id string; pass resolvedService.targetId, not the resolveService result object"
          : "RPC target must be a target-id string",
        "RPC_PROTOCOL_ERROR"
      );
    }
    const isPanelOrShellTarget = !targetId.startsWith("do:") && !targetId.startsWith("worker:");
    if (isPanelOrShellTarget) {
      const options = relayCallOptions(meta);
      const routedTargetId = this.resolveRoutableTargetId(targetId);
      const wsClient = this.pickRoutableTarget(targetId, targetConnectionId);
      if (wsClient && wsClient.ws.readyState === wsClient.ws.OPEN) {
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
    /** Host-retained outside lineage; never accepted from call args or wire metadata. */
    inheritedContextIntegrity?: import("@vibestudio/rpc").ContextIntegrityFact | null;
    /** Number of exact inline retries already performed after preauthorization. */
    preauthorizedRetries?: number;
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
    const productPolicy = productBuiltinMethodPolicy(
      input.ref.source,
      input.ref.className,
      input.method
    );
    if (
      (productPolicy?.execution?.harness === "attested-system-test" ||
        workspaceAuthority?.methodExecution?.harness === "attested-system-test") &&
      !this.deps.isAttestedSystemTestHarness?.(input.caller)
    ) {
      throw createRelayError(`${input.method} requires an attested system-test harness`, "EACCES");
    }
    const preparedDeclaration = productPolicy?.prepared;
    const sessionId = input.caller.agentBinding?.channelId ?? input.caller.runtime.id;
    const methodCapability = workspaceAuthority?.methodCapability ?? workspaceAuthority?.capability;
    const methodTier = workspaceAuthority?.methodTier;
    let resolvedHandle:
      | import("./services/userlandResourceHandleStore.js").ResolvedUserlandResourceHandle
      | undefined;
    if (
      workspaceAuthority?.methodEffect.kind === "userland-capability" &&
      workspaceAuthority.methodEffect.resource.kind === "opaque-handle"
    ) {
      const receiver = workspaceAuthority.methodReceiverAuthority;
      const handle = input.args[workspaceAuthority.methodEffect.resource.argument];
      if (!receiver || typeof handle !== "string" || !this.deps.userlandResourceHandles) {
        throw createRelayError("Opaque resource handle is missing or unavailable", "EACCES");
      }
      try {
        resolvedHandle = this.deps.userlandResourceHandles.resolve(handle, {
          workspaceId,
          capability: workspaceAuthority.methodCapability!,
          capabilityDefinitionDigest: receiver.capabilityDefinitionDigest,
          provider: receiver.provider,
          receiverSource: input.ref.source,
          receiverClass: input.ref.className,
          receiverObjectKey: input.ref.objectKey,
          resourceType: receiver.resourceType,
        });
      } catch {
        throw createRelayError(
          "Opaque resource handle is not valid for this receiver capability",
          "EACCES"
        );
      }
    }
    const receiverResourceKey = resolvedHandle
      ? resolvedHandle.resourceKey
      : workspaceAuthority?.methodReceiverAuthority &&
          workspaceAuthority.methodEffect.kind === "userland-capability"
        ? userlandReceiverResourceKey(
            workspaceAuthority.methodReceiverAuthority.resourceType,
            input.ref.source,
            input.ref.className,
            input.ref.objectKey
          )
        : undefined;
    const policyFor = (capability: string) =>
      receiverAuthorityPolicy(
        capability,
        workspaceAuthority && capability === workspaceAuthority.capability
          ? workspaceAuthority.presentation
          : undefined
      );
    const residentContextIntegrity =
      this.deps.contextIntegrityFactForSession?.(sessionId, input.caller) ??
      (input.caller.agentBinding
        ? { class: "internal" as const, latchEpoch: 0, externalKeys: [] }
        : { class: "not-applicable" as const, latchEpoch: 0, externalKeys: [] });
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
      contextIntegrity:
        joinContextIntegrity(residentContextIntegrity, input.inheritedContextIntegrity ?? null) ??
        residentContextIntegrity,
      ...(receiverResourceKey ? { resourceKey: receiverResourceKey } : {}),
    } as const;
    const attestation = workspaceAuthority
      ? attestWorkspaceDoRpc({
          ...authorityFacts,
          service: {
            name: workspaceAuthority.capability.slice("workspace-service:".length),
            principals: workspaceAuthority.principals,
            binding: workspaceAuthority.serviceBinding ?? "consent",
          },
          methodAuthority: {
            effect: workspaceAuthority.methodEffect,
            ...(workspaceAuthority.methodCapability
              ? { capability: workspaceAuthority.methodCapability }
              : {}),
            tier: workspaceAuthority.methodTier,
          },
          ...(workspaceAuthority.methodReceiverAuthority
            ? { receiverAuthority: workspaceAuthority.methodReceiverAuthority }
            : {}),
        })
      : attestDirectRpc(authorityFacts);
    const result: DirectAuthorityAttestation = {
      ...attestation,
      ...(resolvedHandle
        ? {
            resourceHandle: resolvedHandle.handle,
            resourceSelector: resolvedHandle.selector,
          }
        : {}),
      ...(workspaceAuthority?.methodHandleProduction
        ? { handleProduction: workspaceAuthority.methodHandleProduction }
        : {}),
      ...(workspaceAuthority
        ? {
            targetRequirement: requirementForPrincipals(
              workspaceAuthority.principals,
              workspaceAuthority.capability
            ),
            targetCapability: workspaceAuthority.capability,
            targetTier:
              workspaceAuthority.serviceBinding === "declared"
                ? ("open" as const)
                : ("gated" as const),
          }
        : {}),
      ...(input.readOnly ? { readOnly: true as const } : {}),
    };
    if ((!workspaceAuthority && !preparedDeclaration) || input.method.startsWith("__event:")) {
      return result;
    }

    const requiredMethodCapability =
      workspaceAuthority?.methodCapability ?? workspaceAuthority?.capability;
    const requiredMethodTier = workspaceAuthority?.methodTier;
    const requiredServiceTier =
      workspaceAuthority?.serviceBinding === "declared" ? ("open" as const) : ("gated" as const);
    const staticLeaves =
      workspaceAuthority && requiredMethodCapability && requiredMethodTier
        ? [
            {
              capability: requiredMethodCapability,
              tier: requiredMethodTier,
              requirement: requirementForPrincipals(
                workspaceAuthority.principals,
                requiredMethodCapability
              ),
              resourceKey: result.resourceKey,
              context: result.context,
              grants: result.grants,
              locks: result.locks,
              caller: input.caller,
              challenge: undefined,
            },
            ...(requiredMethodCapability !== workspaceAuthority.capability ||
            requiredMethodTier !== requiredServiceTier
              ? [
                  {
                    capability: workspaceAuthority.capability,
                    tier: requiredServiceTier,
                    requirement: requirementForPrincipals(
                      workspaceAuthority.principals,
                      workspaceAuthority.capability
                    ),
                    resourceKey: result.resourceKey,
                    context: result.context,
                    grants: result.grants,
                    locks: result.locks,
                    caller: input.caller,
                    challenge: undefined,
                  },
                ]
              : []),
          ]
        : [];
    const preparedSelections = preparedDeclaration
      ? await this.deps.resolveProductBuiltinPreparedAuthority?.({
          caller: input.caller,
          ...input.ref,
          method: input.method,
          args: input.args,
          resolver: preparedDeclaration.resolver,
          ...(preparedDeclaration.contextBoundary
            ? { contextBoundary: preparedDeclaration.contextBoundary }
            : {}),
        })
      : [];
    if (preparedDeclaration && preparedSelections === undefined) {
      throw createRelayError(
        `Direct builtin method ${input.ref.source}:${input.ref.className}.${input.method} requires unavailable authority preparation '${preparedDeclaration.resolver}'`,
        "EACCES"
      );
    }
    const preparedLeaves = [...(preparedSelections ?? [])].map((selection) => {
      const declaration = preparedDeclaration!.leaves.find((candidate) => {
        if ("capability" in candidate && candidate.capability !== undefined) {
          return candidate.capability === selection.capability;
        }
        return (
          "capabilityPrefix" in candidate &&
          candidate.capabilityPrefix !== undefined &&
          selection.capability.startsWith(candidate.capabilityPrefix)
        );
      });
      if (!declaration) {
        throw createRelayError(
          `Authority preparer '${preparedDeclaration!.resolver}' selected undeclared capability '${selection.capability}'`,
          "EACCES"
        );
      }
      const declaredRequirement = declaration.requirement;
      let requirement;
      if (declaredRequirement.kind === "selected") {
        if (!selection.requirement) {
          throw createRelayError(
            `Authority preparer '${preparedDeclaration!.resolver}' omitted the selected requirement for '${selection.capability}'`,
            "EACCES"
          );
        }
        requirement = selection.requirement;
      } else {
        if (selection.requirement) {
          throw createRelayError(
            `Authority preparer '${preparedDeclaration!.resolver}' replaced the fixed requirement for '${selection.capability}'`,
            "EACCES"
          );
        }
        requirement = declaredRequirement;
      }
      const declaredTier = declaration.tier;
      const tier = declaredTier && typeof declaredTier === "object" ? selection.tier : declaredTier;
      if (
        !tier ||
        (declaredTier &&
          typeof declaredTier === "object" &&
          (!selection.tier || !declaredTier.selectedFrom.includes(selection.tier))) ||
        (typeof declaredTier === "string" &&
          selection.tier !== undefined &&
          selection.tier !== declaredTier)
      ) {
        throw createRelayError(
          `Authority preparer '${preparedDeclaration!.resolver}' selected an undeclared tier for '${selection.capability}'`,
          "EACCES"
        );
      }
      const caller = selection.authorizingCaller ?? input.caller;
      const authorization = authorizeVerifiedCaller(caller, {
        workspaceId,
        workspaceMember:
          caller.runtime.kind === "server" ||
          !this.deps.membershipGate ||
          this.deps.membershipGate(caller.subject),
        workspaceRole: this.deps.workspaceRoleResolver?.(caller.subject) ?? null,
        sessionId,
        audience: directAuthorityAudience(
          input.ref.source,
          input.ref.className,
          input.ref.objectKey
        ),
        capability: selection.capability,
        resourceKey: selection.resourceKey,
        grantStore: this.deps.capabilityGrantStore,
        contextIntegrity: authorityFacts.contextIntegrity,
        tier,
      });
      return {
        capability: selection.capability,
        tier,
        requirement,
        resourceKey: selection.resourceKey,
        context: authorization.context,
        grants: authorization.grants,
        locks: authorization.locks,
        caller,
        challenge: selection.challenge,
      };
    });
    const leaves = [...staticLeaves, ...preparedLeaves];
    const snapshotFor = (leaf: (typeof leaves)[number]) =>
      createInvocationSnapshot({
        service: `direct:${input.ref.source}:${input.ref.className}`,
        method: input.method,
        capability: leaf.capability,
        capabilityDefinitionDigest:
          workspaceAuthority && leaf.capability === workspaceAuthority.methodCapability
            ? (workspaceAuthority.methodReceiverAuthority?.capabilityDefinitionDigest ?? "-")
            : "-",
        resourceType:
          workspaceAuthority && leaf.capability === workspaceAuthority.methodCapability
            ? (workspaceAuthority.methodReceiverAuthority?.resourceType ?? leaf.capability)
            : leaf.capability,
        provider:
          workspaceAuthority && leaf.capability === workspaceAuthority.methodCapability
            ? (workspaceAuthority.methodReceiverAuthority?.provider ?? "-")
            : "-",
        providerExecutionDigest:
          workspaceAuthority && leaf.capability === workspaceAuthority.methodCapability
            ? (workspaceAuthority.methodReceiverAuthority?.providerExecutionDigest ?? "-")
            : "-",
        targetRequirement: result.targetRequirement,
        targetCapability: result.targetCapability,
        resourceKey: leaf.resourceKey,
        args: input.args,
        preparedStateDigest: sha256Canonical({
          source: input.ref.source,
          className: input.ref.className,
          objectKey: input.ref.objectKey,
          methodCapability,
          methodTier,
          targetCapability: result.targetCapability ?? null,
          targetTier: result.targetTier ?? null,
          principals: workspaceAuthority?.principals ?? productPolicy?.principals ?? [],
        }),
        callerPrincipal: leaf.context.authorizingOrigin.principal,
        sessionId,
        ...(leaf.context.session.taskRef ? { taskRef: leaf.context.session.taskRef } : {}),
        ...(leaf.context.session.taskAuthority
          ? { taskAuthority: leaf.context.session.taskAuthority }
          : {}),
        ...(leaf.context.executionSession?.agentBinding?.bindingId
          ? {
              agentBindingId: leaf.context.executionSession.agentBinding.bindingId,
              agentName: leaf.context.executionSession.agentBinding.entityId,
            }
          : {}),
        lineageClasses: leaf.context.contextIntegrity
          ? lineageClasses(leaf.context.contextIntegrity)
          : ["none"],
        irreversible: policyFor(leaf.capability).irreversible,
        agentScopeEligible: standingAgentScopeEligible({
          capability: leaf.capability,
          tier: leaf.tier,
          policy: policyFor(leaf.capability),
          domain: workspaceAuthority?.presentation.domain ?? "computer",
          priorInteractiveApprovals:
            leaf.context.executionSession?.agentBinding?.bindingId === undefined
              ? 0
              : (this.deps.capabilityGrantStore?.priorInteractiveApprovalCount({
                  agentBindingId: leaf.context.executionSession.agentBinding.bindingId,
                  capability: leaf.capability,
                  resource: { kind: "exact", key: leaf.resourceKey },
                }) ?? 0),
        }),
        executionMode:
          leaf.context.executionSession?.mode ?? (leaf.context.testPolicy ? "test" : undefined),
        testPolicyId: leaf.context.testPolicy?.policyId,
        missionSubject: leaf.context.executionSession?.mission?.subject ?? "-",
        snippetDigest:
          leaf.context.authorizingOrigin.kind === "session"
            ? (leaf.context.executingCode?.principal.split("@").at(-1) ?? "-")
            : "-",
        codeLineage: leaf.context.executingCode
          ? {
              class: leaf.context.executingCode.sourceLineage.class,
              chain: leaf.context.executingCode.sourceLineage.externalKeys,
            }
          : { class: "unknown", chain: [] },
        contextLineage: leaf.context.contextIntegrity,
        initiatorChain: leaf.context.initiatorChain,
      });
    const decisions = leaves.map((leaf) => {
      const snapshot = snapshotFor(leaf);
      const snapshotDigest = invocationSnapshotDigest(snapshot);
      return {
        leaf,
        snapshot,
        snapshotDigest,
        decision: evaluateAuthority({
          context: leaf.context,
          requirement: leaf.requirement,
          resourceKey: leaf.resourceKey,
          grants: leaf.grants,
          locks: leaf.locks,
          tier: leaf.tier,
          invocationDigest: snapshotDigest,
          providerExecutionDigest: snapshot.providerExecutionDigest,
        }),
      };
    });
    result.invocationDigest = decisions[0]?.snapshotDigest;
    if (result.targetRequirement && result.targetCapability) {
      result.targetInvocationDigest = decisions.find(
        ({ leaf }) => leaf.capability === result.targetCapability
      )?.snapshotDigest;
    }
    const denied = decisions.find(({ decision }) => !decision.allowed);
    if (denied) {
      const preparedChallenge = "challenge" in denied.leaf ? denied.leaf.challenge : undefined;
      const authorityFailure = authorityFailureForDecision(denied.decision, {
        capability: denied.leaf.capability,
        resourceKey: denied.leaf.resourceKey,
        tier: denied.leaf.tier,
      });
      const acquirable =
        denied.leaf.tier !== "open" && denied.decision.code === "approval-required";
      if (!acquirable || !this.deps.directAuthorityAcquirer) {
        const error = createRelayError(
          `${input.method}: ${denied.decision.reason} (${denied.decision.code})`,
          "EACCES"
        );
        Object.assign(error, {
          errorKind: "access",
          errorData: { authorityFailure },
        });
        throw error;
      }
      const acquisitionInput = {
        snapshot: denied.snapshot,
        snapshotDigest: denied.snapshotDigest,
        tier: denied.leaf.tier as "gated" | "critical",
        caller: denied.leaf.caller,
        renderedAction:
          preparedChallenge?.operation.verb ??
          (workspaceAuthority &&
          denied.leaf.capability === workspaceAuthority.methodCapability &&
          workspaceAuthority.methodReceiverAuthority
            ? workspaceAuthority.methodReceiverAuthority.action
            : (this.deps.describeCapability ?? describeCapability)(denied.leaf.capability).action),
        resource: { kind: "exact", key: denied.leaf.resourceKey },
        ...(policyFor(denied.leaf.capability).requiresSubstance
          ? {
              substance: {
                kind: policyFor(denied.leaf.capability).substanceKind ?? "custom",
                summary: `${
                  (this.deps.describeCapability ?? describeCapability)(denied.leaf.capability)
                    .action
                } ${workspaceAuthority?.title ?? denied.leaf.resourceKey}`,
                digest: denied.snapshot.preparedStateDigest,
              },
            }
          : {}),
        ...(preparedChallenge
          ? { presentation: preparedChallenge }
          : workspaceAuthority?.methodReceiverAuthority &&
              denied.leaf.capability === workspaceAuthority.methodCapability
            ? {
                presentation: {
                  title: workspaceAuthority.methodReceiverAuthority.title,
                  description:
                    resolvedHandle?.presentation.detail ??
                    workspaceAuthority.methodReceiverAuthority.description ??
                    `Provided by ${workspaceAuthority.methodReceiverAuthority.provider}.`,
                  deniedReason: `${workspaceAuthority.methodReceiverAuthority.title} was not allowed`,
                  resource: {
                    type: workspaceAuthority.methodReceiverAuthority.resourceType,
                    label: "Resource",
                    value: resolvedHandle?.presentation.title ?? denied.leaf.resourceKey,
                  },
                  operation: {
                    kind: "unknown" as const,
                    verb: workspaceAuthority.methodReceiverAuthority.action,
                    object: {
                      type: workspaceAuthority.methodReceiverAuthority.resourceType,
                      label: "Resource",
                      value: resolvedHandle?.presentation.title ?? denied.leaf.resourceKey,
                    },
                  },
                  allowedDecisions: [
                    ...workspaceAuthority.methodReceiverAuthority.grantScopes,
                    "deny" as const,
                  ],
                  authorityVocabulary: {
                    ...workspaceAuthority.presentation,
                    declaredBy: workspaceAuthority.methodReceiverAuthority.provider,
                  },
                },
              }
            : workspaceAuthority && denied.leaf.capability === workspaceAuthority.capability
              ? {
                  presentation: {
                    title: workspaceAuthority.title,
                    description:
                      workspaceAuthority.description ??
                      `Use ${workspaceAuthority.title} in this workspace.`,
                    deniedReason: `The ${workspaceAuthority.title} request was not allowed`,
                    resource: {
                      type: "workspace-service",
                      label: "Service",
                      value: workspaceAuthority.title,
                    },
                    operation: {
                      kind: "unknown" as const,
                      verb: workspaceAuthority.action,
                      object: {
                        type: "workspace-service",
                        label: "Service",
                        value: workspaceAuthority.title,
                      },
                    },
                    authorityVocabulary: {
                      ...workspaceAuthority.presentation,
                      declaredBy: workspaceAuthority.declaredBy,
                    },
                  },
                }
              : {}),
      } as const;
      this.deps.directAuthorityAcquirer.invalidate(
        denied.snapshotDigest,
        denied.leaf.caller.runtime.id,
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
        const deniedByUser = outcome.state === "decided" && outcome.decision === "deny";
        const failure = deniedByUser
          ? authorityFailureForDecision(
              {
                ...denied.decision,
                allowed: false,
                code: "user-denied",
                reason: "The authority request was denied",
              },
              {
                capability: denied.leaf.capability,
                resourceKey: result.resourceKey,
                tier: denied.leaf.tier,
              }
            )
          : authorityFailure;
        const error = createRelayError(
          `${input.method}: authority acquisition was not granted`,
          "EACCES"
        );
        Object.assign(error, {
          errorKind: "access",
          errorData: {
            ...(deniedByUser ? { denied: true } : {}),
            authorityFailure: failure,
          },
        });
        throw error;
      }
      const acquisition = this.deps.directAuthorityAcquirer.request(acquisitionInput);
      if (acquisition.preauthorized) {
        const retryCount = input.preauthorizedRetries ?? 0;
        // A workspace direct call can have several independent gated leaves:
        // first the method effect, then the target service, and sometimes a
        // prepared context leaf. Each test-policy preauthorization admits one
        // exact leaf, so allow one bounded retry per current leaf while still
        // refusing an endlessly re-requested invocation.
        if (retryCount >= Math.max(1, decisions.length)) {
          throw createRelayError(
            `${input.method}: host preauthorization did not admit the exact invocation`,
            "EACCES"
          );
        }
        return this.directDOAuthorization({
          ...input,
          preauthorizedRetries: retryCount + 1,
        });
      }
      const error = createRelayError(`${input.method}: authority acquisition required`, "EACQUIRE");
      Object.assign(error, {
        errorKind: "access",
        errorData: { acquisition, authorityFailure },
      });
      throw error;
    }
    for (const { decision } of decisions) {
      if (decision.consumable && decision.grantId) {
        if (!this.deps.directAuthorityAcquirer?.consume(decision.grantId)) {
          throw createRelayError(`${input.method}: one-time approval was already used`, "EACCES");
        }
      }
      if (!decision.consumable && decision.grantId) {
        this.deps.directAuthorityAcquirer?.touch?.(decision.grantId);
      }
    }
    return result;
  }

  private async ensureDirectDoReady(ref: DORef): Promise<void> {
    await this.deps.ensureUserlandDoReady(ref);
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
    await this.ensureDirectDoReady(ref);
    // Assertion-only: the concrete DO entity must exist before dispatch.
    // Method-specific context checks (e.g. subscribeChannel) belong in the
    // DO's own handler, not in the generic relay path. Cross-context calls
    // to shared manifest-declared singletons must pass through.
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
      const transportCaller = this.withLiveRuntimeRelationships(
        relayCallerScope?.authenticatedCaller ?? this.verifiedCallerFor(callerId, callerKind)
      );
      const attributedCaller =
        callerKind === "server"
          ? createHostCaller(callerId, "server", SYSTEM_SUBJECT)
          : transportCaller.subject
            ? transportCaller
            : relayCallerScope?.authorizingCaller.subject
              ? {
                  ...transportCaller,
                  subject: relayCallerScope.authorizingCaller.subject,
                }
              : transportCaller;
      const authenticatedCaller = authenticatedCallerOf(attributedCaller);
      const authorization = await this.directDOAuthorization({
        caller: attributedCaller,
        ref,
        method,
        args,
        ...(relayCallerScope?.inheritedContextIntegrity !== undefined
          ? { inheritedContextIntegrity: relayCallerScope.inheritedContextIntegrity }
          : {}),
        readOnly: meta?.readOnly,
        signal: meta?.signal,
      });
      const dispatchedArgs = this.resolveOpaqueHandleArgument(args, authorization);
      const inheritedAuthorizingCaller = relayCallerScope?.authorizingCaller
        ? attributedCaller.subject
          ? {
              ...relayCallerScope.authorizingCaller,
              subject: attributedCaller.subject,
            }
          : relayCallerScope.authorizingCaller
        : attributedCaller;
      const releaseAuthorityParent = this.beginAuthorityParent(
        targetId,
        authorization,
        inheritedAuthorizingCaller
      );
      try {
        const result = await postToDurableObject(
          ref,
          method,
          dispatchedArgs,
          {
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
          },
          meta?.signal
        );
        return this.sealProducedResourceHandle(ref, authorization, result);
      } finally {
        releaseAuthorityParent();
      }
    };

    // A relay is one semantic invocation, not a transport-level retry unit.
    // Replaying here is unsafe even for an apparently pre-delivery failure:
    // the entity may retire while the first dispatch is in flight, and an
    // ensure-and-retry would then recreate infrastructure for a terminal
    // identity. Callers may retry explicitly with their semantic command's
    // idempotency key after resolving the entity lifecycle again.
    return await dispatch();
  }

  private resolveOpaqueHandleArgument(
    args: readonly unknown[],
    authorization: DirectAuthorityAttestation
  ): unknown[] {
    if (
      authorization.effect.kind !== "userland-capability" ||
      authorization.effect.resource.kind !== "opaque-handle"
    ) {
      return [...args];
    }
    if (authorization.resourceSelector === undefined) {
      throw createRelayError("Opaque resource handle was not resolved", "EACCES");
    }
    const next = [...args];
    next[authorization.effect.resource.argument] = authorization.resourceSelector;
    return next;
  }

  private sealProducedResourceHandle(
    ref: { source: string; className: string; objectKey: string },
    authorization: DirectAuthorityAttestation,
    result: unknown
  ): unknown {
    const production = authorization.handleProduction;
    if (!production) return result;
    if (!this.deps.workspaceId || !this.deps.userlandResourceHandles) {
      throw createRelayError("Opaque resource handle service is unavailable", "EACCES");
    }
    return this.deps.userlandResourceHandles.issueFromPreparation(
      {
        workspaceId: this.deps.workspaceId,
        capability: production.capability,
        capabilityDefinitionDigest: production.capabilityDefinitionDigest,
        provider: production.provider,
        receiverSource: ref.source,
        receiverClass: ref.className,
        receiverObjectKey: ref.objectKey,
        resourceType: production.resourceType,
      },
      result
    );
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
    await this.ensureDirectDoReady(ref);
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
    if (authorization.handleProduction) {
      throw createRelayError("Handle-producing RPC methods cannot stream responses", "EACCES");
    }
    const dispatchedArgs = this.resolveOpaqueHandleArgument(request.args, authorization);
    const releaseAuthorityParent = this.beginAuthorityParent(
      targetId,
      authorization,
      invocationCaller
    );
    try {
      const response = await streamFromDurableObject(
        ref,
        request.method,
        dispatchedArgs,
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
      return this.responseWithAuthorityParentLifetime(response, releaseAuthorityParent);
    } catch (error) {
      releaseAuthorityParent();
      throw error;
    }
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
    const { getWorkerdConnectionDispatcher } = await import("./workerdRpcRelay.js");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.workerdGatewayToken
          ? { Authorization: `Bearer ${this.workerdGatewayToken}` }
          : {}),
      },
      body: JSON.stringify(envelope),
      ...(meta?.signal ? { signal: meta.signal } : {}),
      dispatcher: getWorkerdConnectionDispatcher(),
    } as RequestInit);

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
        throw new RemoteRpcError(
          responseMessage.error,
          responseMessage.errorKind,
          responseMessage.errorCode,
          responseMessage.errorData
        );
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
    targetConnectionId?: string,
    authorizingCaller?: VerifiedCaller
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
        this.sendToSession(wsClient.ws, {
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
      await this.ensureDirectDoReady(ref);

      if (!this.deps.tokenManager || !this.workerdUrl || !this.workerdGatewayToken) {
        throw new Error(
          "Cannot relay event to DO: tokenManager, workerdUrl, or workerdGatewayToken not configured"
        );
      }

      const { postEventToDurableObject } = await import("./workerdRpcRelay.js");
      const attributedCaller =
        authorizingCaller ??
        (fromKind === "server"
          ? createHostCaller(fromId, "server", SYSTEM_SUBJECT)
          : this.verifiedCallerFor(fromId, fromKind));
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
      const { getWorkerdConnectionDispatcher } = await import("./workerdRpcRelay.js");
      const res = await fetch(`${this.workerdUrl}/${encodeURIComponent(workerName)}/__rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.workerdGatewayToken
            ? { Authorization: `Bearer ${this.workerdGatewayToken}` }
            : {}),
        },
        body: JSON.stringify(eventEnvelope),
        dispatcher: getWorkerdConnectionDispatcher(),
      } as RequestInit);
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
    if (wsClient && wsClient.ws.readyState === wsClient.ws.OPEN) {
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

  private static readonly IROH_PREAUTH_TIMEOUT_MS = 10_000;
  private static readonly IROH_STREAM_ADMISSION_TIMEOUT_MS = 10_000;

  private sendToSession(ws: RpcSessionChannel, msg: WsServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    const buffered = ws.bufferedAmount;
    if (buffered > RpcServer.WS_BACKPRESSURE_HARD_LIMIT) {
      log.warn(
        `WebSocket client buffer exceeded hard limit (${buffered} bytes buffered) — terminating slow consumer`
      );
      ws.terminate();
      return;
    }
    ws.sendMessage(msg);
  }

  // ===========================================================================
  // Gateway in-process handlers
  // ===========================================================================

  private writeWsAdmissionResponse(
    res: import("node:http").ServerResponse,
    status: number,
    body: RpcWebSocketAdmissionResponse
  ): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(body.ok || body.retryAfterMs === undefined
        ? {}
        : { "Retry-After": String(Math.max(1, Math.ceil(body.retryAfterMs / 1000))) }),
    });
    res.end(JSON.stringify(body));
  }

  private wsAdmissionFailure(
    res: import("node:http").ServerResponse,
    status: number,
    failure: RpcWebSocketAdmissionFailure
  ): void {
    this.writeWsAdmissionResponse(res, status, failure);
  }

  private pruneExpiredWsAdmissionGrants(now: number = Date.now()): void {
    for (const [grant, admission] of this.wsAdmissionGrants) {
      if (admission.expiresAt <= now) this.wsAdmissionGrants.delete(grant);
    }
    for (const [digest, replay] of this.pairingAdmissionReplays) {
      if (replay.expiresAt <= now) this.pairingAdmissionReplays.delete(digest);
    }
  }

  private pairingAdmissionDigest(credential: string): string {
    return createHmac("sha256", this.pairingAdmissionReplayKey)
      .update(credential, "utf8")
      .digest("hex");
  }

  private issueWsAdmissionGrant(
    resolved: ResolvedRpcCredential,
    clientLabel?: string,
    clientPlatform?: ClientPlatform,
    oauthCallbackMode?: OAuthCallbackMode
  ): RpcWebSocketAdmissionGrant {
    const grant = randomBytes(32).toString("hex");
    const admission: RpcWebSocketAdmissionGrant = {
      grant,
      expiresAt: Date.now() + RPC_WS_ADMISSION_GRANT_TTL_MS,
      resolved,
      ...(clientLabel !== undefined ? { clientLabel } : {}),
      ...(clientPlatform !== undefined ? { clientPlatform } : {}),
      ...(oauthCallbackMode !== undefined ? { oauthCallbackMode } : {}),
    };
    this.wsAdmissionGrants.set(grant, admission);
    return admission;
  }

  private takeWsAdmissionGrant(grant: string): RpcWebSocketAdmissionGrant | null {
    const admission = this.wsAdmissionGrants.get(grant);
    if (!admission) return null;
    this.wsAdmissionGrants.delete(grant);
    if (admission.expiresAt <= Date.now()) return null;
    if (!admission.resolved.isValidAtUpgrade()) return null;
    return admission;
  }

  private outstandingGrantRetryAfterMs(now: number = Date.now()): number {
    let earliestExpiry = Number.POSITIVE_INFINITY;
    for (const admission of this.wsAdmissionGrants.values()) {
      earliestExpiry = Math.min(earliestExpiry, admission.expiresAt);
    }
    for (const replay of this.pairingAdmissionReplays.values()) {
      earliestExpiry = Math.min(earliestExpiry, replay.expiresAt);
    }
    return Number.isFinite(earliestExpiry)
      ? Math.max(1, earliestExpiry - now)
      : RPC_WS_ADMISSION_RETRY_AFTER_MS;
  }

  private async handleWsAdmissionRequest(
    req: IncomingMessage,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    if (this.isShuttingDown()) {
      this.wsAdmissionFailure(res, 503, {
        ok: false,
        code: "server_unavailable",
        message: "RPC server is shutting down",
        retryAfterMs: RPC_WS_ADMISSION_RETRY_AFTER_MS,
      });
      req.resume();
      return;
    }
    const hasRequestBody =
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") ||
      req.headers["transfer-encoding"] !== undefined;
    if (hasRequestBody) {
      this.wsAdmissionFailure(res, 400, {
        ok: false,
        code: "invalid_request",
        message: "RPC WebSocket admission requests must have an empty body",
      });
      req.resume();
      return;
    }

    const authorization = req.headers.authorization;
    const credential =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
    const encodedClientLabel = req.headers[RPC_CLIENT_LABEL_HEADER];
    const decodedClientLabel =
      typeof encodedClientLabel === "string"
        ? decodeRpcClientLabelHeader(encodedClientLabel)
        : encodedClientLabel === undefined
          ? undefined
          : null;
    const clientLabel =
      decodedClientLabel === null ? null : normalizeRpcClientLabel(decodedClientLabel);
    const rawClientPlatform = req.headers[RPC_CLIENT_PLATFORM_HEADER];
    const clientPlatform =
      rawClientPlatform === "desktop" ||
      rawClientPlatform === "headless" ||
      rawClientPlatform === "mobile"
        ? rawClientPlatform
        : rawClientPlatform === undefined
          ? undefined
          : null;
    const rawOAuthCallbackMode = req.headers[RPC_OAUTH_CALLBACK_MODE_HEADER];
    const oauthCallbackMode =
      rawOAuthCallbackMode === "client-loopback" || rawOAuthCallbackMode === "app-scheme"
        ? rawOAuthCallbackMode
        : rawOAuthCallbackMode === undefined
          ? undefined
          : null;
    if (
      credential.length === 0 ||
      clientLabel === null ||
      (clientLabel !== undefined &&
        Buffer.byteLength(clientLabel, "utf8") > RPC_WS_ADMISSION_MAX_CLIENT_LABEL_BYTES) ||
      clientPlatform === null ||
      oauthCallbackMode === null
    ) {
      this.wsAdmissionFailure(res, 400, {
        ok: false,
        code: "invalid_request",
        message: "Invalid RPC WebSocket admission headers",
      });
      return;
    }

    this.pruneExpiredWsAdmissionGrants();
    const pairingReplayDigest = this.pairingAdmissionDigest(credential);
    const pairingReplay = this.pairingAdmissionReplays.get(pairingReplayDigest);
    if (pairingReplay) {
      if (
        pairingReplay.clientLabel !== clientLabel ||
        pairingReplay.clientPlatform !== clientPlatform ||
        pairingReplay.oauthCallbackMode !== oauthCallbackMode
      ) {
        this.wsAdmissionFailure(res, 400, {
          ok: false,
          code: "invalid_request",
          message: "Pairing admission retry metadata does not match the original request",
        });
        return;
      }
      this.wsAdmissionGrants.delete(pairingReplay.grant);
      const admission = this.issueWsAdmissionGrant(
        pairingReplay.resolved,
        clientLabel,
        clientPlatform,
        oauthCallbackMode
      );
      pairingReplay.grant = admission.grant;
      this.writeWsAdmissionResponse(res, 201, {
        ok: true,
        grant: admission.grant,
        expiresAt: admission.expiresAt,
      });
      return;
    }
    const pendingSaturated =
      this.pendingWsAdmissionResolutions >= RPC_WS_ADMISSION_MAX_PENDING_RESOLUTIONS;
    const outstandingSaturated =
      this.pendingWsAdmissionResolutions + this.wsAdmissionGrants.size >=
        RPC_WS_ADMISSION_MAX_OUTSTANDING_GRANTS ||
      this.pendingWsAdmissionResolutions + this.pairingAdmissionReplays.size >=
        RPC_WS_ADMISSION_MAX_OUTSTANDING_GRANTS;
    if (pendingSaturated || outstandingSaturated) {
      this.wsAdmissionFailure(res, 503, {
        ok: false,
        code: "admission_saturated",
        message: "RPC WebSocket admission is busy; retry shortly",
        retryAfterMs: outstandingSaturated
          ? this.outstandingGrantRetryAfterMs()
          : RPC_WS_ADMISSION_RETRY_AFTER_MS,
      });
      return;
    }

    // Reserve capacity before any async pairing/device-store operation begins.
    this.pendingWsAdmissionResolutions += 1;
    try {
      const boundedResolution = await awaitRpcAdmissionResolution(
        this.resolveRpcCredential(credential, clientLabel, clientPlatform)
      );
      if (boundedResolution.status === "timed-out") {
        this.wsAdmissionFailure(res, 503, {
          ok: false,
          code: "server_unavailable",
          message: "RPC credential verification timed out; retry shortly",
          retryAfterMs: RPC_WS_ADMISSION_RETRY_AFTER_MS,
        });
        return;
      }
      const resolution = boundedResolution.value;
      if (this.isShuttingDown()) {
        this.wsAdmissionFailure(res, 503, {
          ok: false,
          code: "server_unavailable",
          message: "RPC server is shutting down",
          retryAfterMs: RPC_WS_ADMISSION_RETRY_AFTER_MS,
        });
        return;
      }
      if (!resolution.ok) {
        this.wsAdmissionFailure(res, resolution.code === "admin_credential" ? 403 : 401, {
          ok: false,
          code: resolution.code,
          message: resolution.message,
        });
        return;
      }
      const resolved = resolution.resolved;
      const admission = this.issueWsAdmissionGrant(
        resolved,
        clientLabel,
        clientPlatform,
        oauthCallbackMode
      );
      if (resolved.deviceCredential) {
        this.pairingAdmissionReplays.set(pairingReplayDigest, {
          resolved,
          clientLabel,
          clientPlatform,
          oauthCallbackMode,
          grant: admission.grant,
          expiresAt: Date.now() + RPC_WS_PAIRING_REPLAY_TTL_MS,
        });
      }
      this.writeWsAdmissionResponse(res, 201, {
        ok: true,
        grant: admission.grant,
        expiresAt: admission.expiresAt,
      });
    } finally {
      this.pendingWsAdmissionResolutions = Math.max(0, this.pendingWsAdmissionResolutions - 1);
    }
  }

  /** Upgrade a WebSocket when this RPC server directly owns the gateway route. */
  handleGatewayWsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.isShuttingDown()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const wss = this.wss;
    if (!wss) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const protocolHeader = req.headers["sec-websocket-protocol"];
    const grant = parseWebSocketAuthProtocol(protocolHeader, "rpc");
    const admission = grant ? this.takeWsAdmissionGrant(grant) : null;
    if (!admission) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      this.handleConnection(new WebSocketSessionChannel(ws), admission)
    );
  }

  /**
   * Attach one fully handshaken Iroh connection. The first bidirectional stream
   * is the sole lifecycle control stream; every subsequent RPC owns its own
   * QUIC stream and enters the same handleConnection/auth/dispatch machinery as
   * loopback WebSocket.
   */
  async attachIrohConnection(connection: IrohPhysicalConnection): Promise<void> {
    if (this.isShuttingDown()) {
      throw new Error("RpcServer has stopped and cannot attach an Iroh connection");
    }
    const preauth = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              connection.close(0x203n, new TextEncoder().encode("pre-auth deadline exceeded"));
              reject(new Error("Iroh pre-auth deadline exceeded"));
            }, RpcServer.IROH_PREAUTH_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const control = await preauth(connection.acceptBi());
    const preamble = await preauth(readIrohStreamPreamble(control.recv));
    if (preamble.k !== "control") {
      throw new Error(`First Iroh stream must be control, received ${preamble.k}`);
    }
    const hello = decodeIrohSessionControlFrame(
      await preauth(readFrame(control.recv, MAX_CONTROL_FRAME_BYTES))
    );
    if (hello.t !== IROH_SESSION_HELLO || hello.contractVersion !== RPC_CONTRACT_VERSION) {
      throw new Error("Iroh peer has an incompatible RPC contract");
    }

    let controlTail = Promise.resolve();
    const writeControl = (frame: IrohSessionControlFrame): Promise<void> => {
      const operation = controlTail.then(() =>
        writeFrame(control.send, encodeIrohSessionControlFrame(frame), MAX_CONTROL_FRAME_BYTES)
      );
      controlTail = operation.catch(() => undefined);
      return operation;
    };
    await writeControl({
      t: IROH_SESSION_HELLO,
      protocolVersion: IROH_WIRE_VERSION,
      contractVersion: RPC_CONTRACT_VERSION,
    });

    // Completed logical sessions are product principals, not admission work:
    // panels may legitimately keep any number alive on one physical path.
    // handleConnection's shared RPC_MAX_PENDING_AUTHENTICATIONS budget bounds
    // the expensive unauthenticated phase regardless of transport.
    const sessions = new Map<string, IrohRpcSessionChannel>();
    let stopped = false;
    const closeAll = (reason: string): void => {
      if (stopped) return;
      stopped = true;
      for (const session of sessions.values()) session.remoteClosed(1006, reason);
      sessions.clear();
    };
    const refuseUnknownSession = async (sid: string): Promise<void> => {
      await writeControl({
        t: IROH_SESSION_CLOSED,
        sid,
        code: SESSION_NOT_OPEN_CLOSE_CODE,
        reason: "session not open",
        terminal: false,
      });
    };

    const controlLoop = async (): Promise<void> => {
      while (!stopped) {
        const frame = decodeIrohSessionControlFrame(
          await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES)
        );
        switch (frame.t) {
          case IROH_SESSION_OPEN: {
            sessions.get(frame.sid)?.remoteClosed(4000, "superseded by re-open");
            const session = new IrohRpcSessionChannel({
              sid: frame.sid,
              connection,
              writeControl,
              onClosed: (sid) => sessions.delete(sid),
              log: (message) => log.warn(message),
            });
            sessions.set(frame.sid, session);
            this.handleConnection(session);
            session.deliverAuth({
              type: "ws:auth",
              contractVersion: RPC_CONTRACT_VERSION,
              token: frame.token,
              connectionId: frame.connectionId,
              clientLabel: frame.clientLabel,
              clientSessionId: frame.clientSessionId,
              clientPlatform: frame.clientPlatform,
              oauthCallbackMode: frame.oauthCallbackMode,
            });
            break;
          }
          case IROH_SESSION_CLOSE:
            sessions.get(frame.sid)?.remoteClosed(frame.code, frame.reason);
            sessions.delete(frame.sid);
            break;
          case IROH_SESSION_HELLO:
            throw new Error("Duplicate Iroh session hello");
          case IROH_SESSION_OPEN_RESULT:
          case IROH_SESSION_CLOSED:
            throw new Error(`Server received client-invalid Iroh frame ${frame.t}`);
        }
      }
    };

    const fail = (error: unknown): void => {
      const reason = error instanceof Error ? error.message : String(error);
      closeAll(reason);
      connection.close(0x200n, new TextEncoder().encode(reason));
    };
    const handleStream = async (stream: IrohPhysicalBiStream): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const admission = (async (): Promise<void> => {
        const streamPreamble = await readIrohStreamPreamble(stream.recv);
        if (streamPreamble.k === "control") {
          throw new Error("Duplicate Iroh control stream");
        }
        if (streamPreamble.k === "message") {
          throw new Error("Client-opened Iroh message streams are not valid");
        }
        const session = sessions.get(streamPreamble.sid);
        if (!session) {
          await Promise.all([
            stream.recv.stop(0x201n).catch(() => undefined),
            stream.send.reset(0x201n).catch(() => undefined),
            refuseUnknownSession(streamPreamble.sid),
          ]);
          return;
        }
        const envelope = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readFrame(stream.recv, MAX_ENVELOPE_FRAME_BYTES)
          )
        ) as RpcEnvelope;
        const body =
          streamPreamble.k === "stream" && streamPreamble.body
            ? irohReceiveStreamBody(stream.recv)
            : undefined;
        session.deliverEnvelope(envelope, stream, body);
      })();
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void stream.recv.stop(0x200n).catch(() => undefined);
          void stream.send.reset(0x200n).catch(() => undefined);
          reject(
            new Error(
              `Iroh peer stream did not provide a complete header within ${RpcServer.IROH_STREAM_ADMISSION_TIMEOUT_MS}ms`
            )
          );
        }, RpcServer.IROH_STREAM_ADMISSION_TIMEOUT_MS);
        timer.unref();
      });
      try {
        await Promise.race([admission, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const streamLoop = async (): Promise<void> => {
      let pendingAdmissions = 0;
      while (!stopped) {
        const stream = await connection.acceptBi();
        if (pendingAdmissions >= MAX_PENDING_STREAM_ADMISSIONS) {
          void stream.recv.stop(0x200n).catch(() => undefined);
          void stream.send.reset(0x200n).catch(() => undefined);
          continue;
        }
        pendingAdmissions += 1;
        // Reading one stream's bounded preamble/envelope must not block
        // admission of independent later streams. This counter bounds only
        // incomplete header work; a long-lived response leaves admission as
        // soon as its envelope reaches the bounded logical session.
        void handleStream(stream)
          .catch((error) => {
            // QUIC request streams are independent failure domains. A bad or
            // partial stream is reset without discarding healthy logical
            // sessions on the physical connection.
            void stream.recv.stop(0x200n).catch(() => undefined);
            void stream.send.reset(0x200n).catch(() => undefined);
            log.warn("Rejected Iroh RPC stream", {
              cause: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            pendingAdmissions -= 1;
          });
      }
    };

    void controlLoop().catch(fail);
    void streamLoop().catch(fail);
    void connection.closed().then(closeAll);
  }

  /** Handle an HTTP POST /rpc from the gateway (in-process dispatch). */
  async handleGatewayHttpRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    // Keep the admission endpoint on its typed protocol even after quiescing.
    // The generic HTTP 503 shape is intentionally different and would make a
    // normal shutdown rejection look like malformed admission JSON to clients.
    if (req.method === "POST" && req.url === RPC_WEBSOCKET_ADMISSION_PATH) {
      await this.handleWsAdmissionRequest(req, res);
      return;
    }
    if (this.isShuttingDown()) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "RPC server is shutting down" }));
      return;
    }
    await this.httpRpc.handle(req, res);
  }

  /**
   * Close admission and cancel transport-owned work while keeping the
   * workerd→host back-channel available until the ordered service drain has
   * finished. The final stop closes the WebSocket server itself.
   */
  quiesce(reason = "Server shutting down"): void {
    if (this.quiescing) return;
    this.quiescing = true;
    this.httpRpc.stop(reason);
    this.streamingRelay.stop(reason);

    this.connections.closeAll(1001, reason);

    for (const [ws, authTimer] of this.pendingAuthentications) {
      if (authTimer) clearTimeout(authTimer);
      ws.close(1001, reason);
    }
    this.pendingAuthentications.clear();
    this.wsAdmissionGrants.clear();
    this.pairingAdmissionReplays.clear();

    for (const [, pending] of this.pendingToolCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingToolCalls.clear();

    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();

    for (const waiter of this.reconnectWaiters.values()) {
      waiter.reject(createRelayError(reason, "SERVER_SHUTTING_DOWN"));
    }
    this.reconnectWaiters.clear();
    for (const waiter of this.connectionReconnectWaiters.values()) {
      waiter.reject(createRelayError(reason, "SERVER_SHUTTING_DOWN"));
    }
    this.connectionReconnectWaiters.clear();
    this.routedRequestOrigins.clear();
    this.sessions.clear();
  }

  /** Shut down the server */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.disposeTokenRevocationListener?.();
    this.disposeTokenRevocationListener = null;
    this.quiesce();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}
