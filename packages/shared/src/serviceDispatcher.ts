/**
 * ServiceDispatcher - Unified service dispatch for panels and shell.
 *
 * Panels and the shell renderer call main process services
 * like bridge, ai, db, browser, fs. This module provides a single registry
 * and dispatch mechanism that all code paths use.
 */

import { z } from "zod";
import type { PreparedAuthoritySelection, ServiceDefinition } from "./serviceDefinition.js";
import {
  preparedAuthoritySelectorKey,
  type MethodAuthorityDescriptor,
  type MethodSchema,
  type PreparedAuthorityRequirement,
} from "./typedServiceClient.js";
import type { CallerKind, CodeIdentityCallerKind } from "./principalKinds.js";
import {
  rpcErrorDataOf,
  rpcErrorKindOf,
  type AuthenticatedCaller,
  type RpcCausalParent,
} from "@vibestudio/rpc";
import type { AgentBinding, UserSubject } from "@vibestudio/identity/types";
import type { RuntimeAgentBinding } from "./runtime/entitySpec.js";
import type { AuthorizationContext, AuthorityGrant } from "./authorization.js";
import type {
  ApprovalDecision,
  ApprovalDetailFormat,
  ApprovalOperationDescriptor,
  DiffReviewEntry,
} from "./approvals.js";
import type {
  AcquisitionInfo,
  AuthorityPreflightLeaf,
  AuthorityPreflightResult,
  InvocationSnapshot,
  ResourceScope,
} from "@vibestudio/rpc";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
  sha256Canonical,
} from "./authority/invocationSnapshot.js";
import {
  authorityFailureForDecision,
  bindMethodCapability,
  evaluateAuthority,
  requirementForPrincipals,
  lineageClasses,
} from "./authorization.js";
import {
  receiverAuthorityPolicy,
  standingAgentScopeEligible,
} from "./authority/receiverAuthorityPolicy.js";
import { methodTier, type MethodTierDecision } from "./authority/tierTable.js";
import { resolveMethodTierPolicy } from "./serviceAuthority.js";
import { hostMethodCapability } from "./authority/hostMethodCapabilities.js";
import { describeCapability } from "./authorityPresentation.js";
export type { CallerKind } from "./principalKinds.js";

/**
 * Normalize an args array for wire compatibility with a Zod tuple schema.
 *
 * RPC args arrive as JSON arrays where:
 * - Trailing optional args may be omitted entirely (shorter array)
 * - `undefined` values become `null` after JSON round-trip
 *
 * This function pads short arrays to the expected tuple length and replaces
 * trailing `null` with `undefined` so Zod's `.optional()` accepts them.
 */
export function normalizeServiceArgs(args: unknown[], schema: z.ZodType): unknown[] {
  if (schemaKind(schema) === z.ZodFirstPartyTypeKind.ZodUnion) {
    // Many service methods model overloads as unions of tuples, e.g.
    // context-bound `fs.readFile(path, encoding?)` vs explicit-context
    // `fs.readFile(contextId, path, encoding?)`.
    if (schema.safeParse(args).success) return args;

    const options = (schema._def as z.ZodTypeDef & { options: z.ZodType[] }).options;
    for (const option of options) {
      const normalized = normalizeServiceArgs(args, option);
      if (option.safeParse(normalized).success) return normalized;
    }
    return args;
  }

  if (schemaKind(schema) !== z.ZodFirstPartyTypeKind.ZodTuple) return args;

  const items = (schema as z.ZodTuple)._def.items as z.ZodType[];
  // Single pass: pad short arrays to the tuple length (missing trailing args
  // become undefined) and replace null with undefined at optional positions.
  // Extra args beyond the tuple length are preserved as-is.
  const length = Math.max(args.length, items.length);
  const normalized = new Array<unknown>(length);
  for (let i = 0; i < length; i++) {
    const arg = i < args.length ? args[i] : undefined;
    normalized[i] = arg === null && i < items.length && items[i]!.isOptional() ? undefined : arg;
  }
  return normalized;
}

/**
 * Render a ZodError from method-args tuple validation as a concise,
 * human-readable summary, e.g. `invalid argument [1].limit — expected number,
 * received string`. The leading tuple index is shown as `[n]`; deeper path
 * segments are dot-joined.
 */
function formatArgsValidationError(error: z.ZodError): string {
  const summaries = error.issues.map((issue) => {
    const [head, ...rest] = issue.path;
    const where =
      typeof head === "number"
        ? `[${head}]${rest.length > 0 ? `.${rest.join(".")}` : ""}`
        : issue.path.length > 0
          ? issue.path.join(".")
          : "(args)";
    const detail =
      issue.code === "invalid_type"
        ? `expected ${issue.expected}, received ${issue.received}`
        : issue.message;
    return `invalid argument ${where} — ${detail}`;
  });
  return summaries.join("; ");
}

function formatReturnValidationError(error: z.ZodError): string {
  const summaries = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "(return)";
    const detail =
      issue.code === "invalid_type"
        ? `expected ${issue.expected}, received ${issue.received}`
        : issue.message;
    return `invalid return ${where} — ${detail}`;
  });
  return summaries.join("; ");
}

/** Cap a JSON rendering so an enriched error can't blow the agent's context. */
function safeJsonArg(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * Error-driven JIT teaching: a compact usage hint appended to an args-validation
 * error so the failing call itself teaches correct usage, from the literate
 * metadata that lives with the method (description + first example).
 */
function formatUsageHint(
  service: string,
  method: string,
  methodDef: MethodSchema | undefined
): string {
  const parts: string[] = [];
  if (methodDef?.description) parts.push(methodDef.description);
  const authored = methodDef?.examples?.[0];
  if (authored && Array.isArray(authored.args)) {
    parts.push(`Example: ${service}.${method}(${authored.args.map(safeJsonArg).join(", ")})`);
  }
  return parts.length ? ` — ${parts.join(" ")}` : "";
}

/**
 * Compact access hint appended to an access-denied error: surfaces the declared
 * conditional restrictions / approval gates so the caller learns the real reason
 * rather than only "denied".
 */
function formatAccessHint(methodDef: MethodSchema | undefined): string {
  const access = methodDef?.access;
  if (!access) return "";
  const parts: string[] = [];
  for (const r of access.restrictedTo ?? []) {
    parts.push(`when ${r.when}, only [${r.principals.join(", ")}] (${r.reason})`);
  }
  for (const a of access.approval ?? []) {
    parts.push(`may require approval${a.capability ? ` for '${a.capability}'` : ""}: ${a.reason}`);
  }
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function shouldValidateServiceReturns(): boolean {
  const override = process.env["VIBESTUDIO_VALIDATE_SERVICE_RETURNS"];
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  return process.env["NODE_ENV"] !== "production";
}

function normalizeReturnForSchema(result: unknown, schema: z.ZodType): unknown {
  // JSON and DO HTTP boundaries cannot carry `undefined`; void method returns
  // commonly round-trip as `null`. Treat that as the wire representation of
  // logical void while still validating every non-void return strictly.
  if (result === null && schemaKind(schema) === z.ZodFirstPartyTypeKind.ZodVoid) return undefined;
  return result;
}

/** Schema packages can carry a distinct Zod module instance at runtime, so
 * constructor identity (`instanceof`) is not a valid cross-package kind check. */
function schemaKind(schema: z.ZodType): z.ZodFirstPartyTypeKind | undefined {
  return (schema._def as z.ZodTypeDef & { typeName?: z.ZodFirstPartyTypeKind }).typeName;
}

export interface VerifiedCodeIdentity {
  /** Concrete caller this source/build attribution was verified for. */
  callerId: string;
  callerKind: CodeIdentityCallerKind;
  /** Workspace source path that produced this runtime. */
  repoPath: string;
  /** Existing source version identity, retained for grants and audit. */
  effectiveVersion: string;
  /** Full verified execution digest for policy and audit. */
  executionDigest?: string;
  /** Immutable requests sealed into the exact execution recipe. */
  requested?: readonly import("@vibestudio/rpc").CapabilityScope[];
  /**
   * Host-verified owner projection for a concrete EvalDO. This is attribution
   * only; dynamic authority comes from an AgentExecutionSessionFact.
   */
  evalOrigin?: {
    ownerId: string;
  };
}

/**
 * The entity/context/channel relationship carried by a caller. It is always
 * host-derived: directly from an authenticated agent credential, or from the
 * active runtime entity when installed worker/DO code relays that agent's work.
 */
export interface VerifiedCaller {
  runtime: {
    /** Concrete runtime principal, e.g. a panel id or do:source:Class:objectKey. */
    id: string;
    kind: CallerKind;
  };
  /**
   * Host-attested operation origin. This is deliberately independent of
   * runtime.kind: a transport or runtime labelled "server" does not acquire
   * the product host principal. Only host-owned call sites can stamp it.
   */
  hostOriginated?: true;
  /** Code/build identity verified at the trust boundary, when applicable. */
  code?: VerifiedCodeIdentity;
  /**
   * The exact code incarnation is currently active only because its workspace
   * unit passed the canonical unit-approval lifecycle. This is stamped by the
   * host after live-registry verification and is never accepted from RPC.
   */
  codeApproved?: true;
  /** Host-verified relationship fact; never selects the authorizing origin. */
  agentBinding?: RuntimeAgentBinding;
  /** Credential id exists only when the transport authenticated as an agent. */
  agentCredentialId?: string;
  /**
   * This invocation is authored by an eval/session rather than by the sealed
   * runtime code transporting it. Agent binding alone is only a relationship
   * fact and never selects the authorizing origin.
   */
  executionSession?: import("@vibestudio/rpc").AgentExecutionSessionFact;
  /**
   * Host-derived policy inherited by reviewed code running inside a canonical
   * system-test context. This does not change the authorizing origin to a
   * session and is never accepted from an RPC payload.
   */
  testPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicy;
  /**
   * Host-verified account subject (WP0 §3.4) — derived and stamped by the
   * host at auth time, never accepted from the wire. Absent only for the
   * enumerated pre-identity bootstrap principals (WP0 §5.4).
   */
  subject?: UserSubject;
}

export function createVerifiedCaller(
  callerId: string,
  callerKind: CallerKind,
  code?: VerifiedCodeIdentity | null,
  agentBinding?: AgentBinding | RuntimeAgentBinding | null,
  subject?: UserSubject | null,
  executionSession?: import("@vibestudio/rpc").AgentExecutionSessionFact | null,
  testPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicy | null
): VerifiedCaller {
  return {
    runtime: { id: callerId, kind: callerKind },
    ...(code ? { code } : {}),
    ...(agentBinding
      ? {
          agentBinding: {
            entityId: agentBinding.entityId,
            contextId: agentBinding.contextId,
            channelId: agentBinding.channelId,
          },
          ...(callerKind === "agent" && "agentId" in agentBinding
            ? { agentCredentialId: agentBinding.agentId }
            : {}),
        }
      : {}),
    ...(executionSession ? { executionSession } : {}),
    ...(testPolicy ? { testPolicy } : {}),
    ...(subject ? { subject } : {}),
  };
}

/** Construct a genuine product-host operation. Never use for relayed userland calls. */
export function createHostCaller(
  callerId: string,
  callerKind: Extract<CallerKind, "server" | "shell"> = "server",
  subject?: UserSubject | null
): VerifiedCaller {
  return {
    runtime: { id: callerId, kind: callerKind },
    hostOriginated: true,
    ...(subject ? { subject } : {}),
  };
}

/**
 * Project a server-side `VerifiedCaller` to the canonical inbound-caller shape
 * (`AuthenticatedCaller`) shared with the bridge and Durable Objects. This is
 * the single vocabulary for "who's calling" across all three layers; the
 * server's `VerifiedCaller` keeps its richer capability/code identity on top.
 */
export function authenticatedCallerOf(caller: VerifiedCaller): AuthenticatedCaller {
  return {
    callerId: caller.runtime.id,
    callerKind: caller.runtime.kind,
    // Copy the host-verified owning user through to userland (WP4 §2.4).
    // Attribution only — never re-validated as a capability by the receiver.
    ...(caller.subject ? { userId: caller.subject.userId } : {}),
  };
}

/**
 * WebSocket client state exposed to service handlers.
 * The full WsClientState in src/server/rpcServer/connectionRegistry.ts extends this with the
 * concrete WebSocket type. Here `ws` is typed as `unknown` so shared code
 * doesn't depend on the ws package -- server-side consumers cast as needed.
 */
export interface WsClientInfo {
  ws: unknown;
  caller: VerifiedCaller;
  connectionId: string;
  authenticated: boolean;
  /** Host-recorded client metadata from the authenticated transport. */
  clientLabel?: string;
  clientPlatform?: "desktop" | "headless" | "mobile";
}

export type ServiceContext = {
  /** Canonical verified identity. Boundary code constructs this once. */
  caller: VerifiedCaller;
  /** Cancellation owned by the authenticated inbound RPC request. Service
   * handlers pass this through to nested work rather than inventing deadlines. */
  signal?: AbortSignal;
  /**
   * Lifecycle policy selected by trusted boundary code. Connection-holding
   * callers and non-replayable streams wait at the canonical acquisition
   * rendezvous; durable effect owners leave this unset and journal EACQUIRE.
   */
  authorityAcquisition?: "wait" | "return";
  /** Immutable verified runtime that transported a live eval call. The
   * dispatcher snapshots this before replacing `caller` with evaluated code,
   * so methods with multiple authority leaves revalidate the same deputy. */
  transportCaller?: VerifiedCaller;
  /** Opaque live eval lease carried by the trusted runtime adapter. The host
   * coordinator resolves it; handlers never inspect or authorize from it. */
  evalInvocation?: {
    runId: string;
    credential: string;
    objectKey: string;
    /** Set only after the host coordinator authenticates the opaque lease. */
    contextId?: string;
  };
  /** Verified root initiator for prompts/audit when a deputy (notably EvalDO)
   * transports the operation. Domain routing still uses `caller`. */
  authorizingCaller?: VerifiedCaller;
  /** Complete host-authenticated authority facts for compositional methods. */
  authorization?: AuthorizationContext;
  /**
   * Same live resolver/evaluator used by the dispatcher, exposed for a method
   * whose resource contract is selected from authenticated host data at
   * runtime (for example a manifest-declared userland service).
   */
  authority?: {
    assert(input: {
      capability: string;
      resourceKey: string;
      requirement: import("./authorization.js").AuthorityRequirement;
      /** Verified principal on whose behalf a host-mediated operation runs. */
      authorizingCaller?: VerifiedCaller;
      /** Host-derived review copy for a state-dependent canonical resource. */
      challenge?: AuthorityChallengePresentation;
    }): Promise<void>;
    allows(input: {
      capability: string;
      resourceKey: string;
      requirement: import("./authorization.js").AuthorityRequirement;
      authorizingCaller?: VerifiedCaller;
      challenge?: AuthorityChallengePresentation;
    }): Promise<boolean>;
  };
  /** Decisions produced by the canonical pre-handler authority challenge
   * adapter, available only for result/audit ergonomics. Handlers never use
   * this map to authorize an effect. */
  authorityDecisions?: Map<string, "once" | "session" | "version">;
  /**
   * Upstream userland caller for an extension-originated service call. Set
   * only after the server validates an extension's opaque parent invocation
   * token against the active invocation table.
   */
  chainCaller?: VerifiedCodeIdentity;
  /** Non-authorizing upstream invocation coordinate selected by the trusted
   * vessel, then verified against the authenticated trajectory binding. */
  causalParent?: RpcCausalParent;
  /** WS transport instance ID when caller connected via WebSocket. */
  connectionId?: string;
  /** WS client state when caller connected via WebSocket */
  wsClient?: WsClientInfo;
  /** Correlation id stamped by the caller. */
  requestId?: string;
  /** Dedup key stamped by the caller, when provided. */
  idempotencyKey?: string;
  /**
   * Read-only containment. When true, the dispatcher refuses any method not
   * declared `access.sensitivity === "read"` (default-deny: unknown/unmarked
   * methods are treated as mutating). Enforced at this single choke point so a
   * caller run read-only — e.g. an inspection agent or eval session — cannot
   * bypass it regardless of which transport or proxy it calls through.
   */
  readOnly?: boolean;
  /**
   * Streaming REQUEST body for stream-request dispatches (WebRTC uploads, plan
   * §1.6): the client pumps it as bulk-channel DATA frames keyed by the
   * stream-open's `bodyStreamId`; the transport assembles it into this stream.
   * Present only when the caller declared a body; consumed by streaming
   * handlers (e.g. `gateway.fetch`) as the upstream request body.
   */
  body?: ReadableStream<Uint8Array>;
};

/** Review contract produced alongside a host-derived canonical authority leaf.
 * The dispatcher still derives and checks the capability, requirement,
 * resource, and authenticated principal; this contract supplies human review
 * copy plus any operation-specific restriction on meaningful decisions. */
export interface AuthorityChallengePresentation {
  title: string;
  description?: string;
  severity?: "standard" | "severe";
  deniedReason: string;
  dedupKey?: string | null;
  resource: { type: string; label: string; value: string };
  operation: {
    kind: ApprovalOperationDescriptor["kind"];
    verb: string;
    object: { type: string; label: string; value: string };
    groupKey?: string;
  };
  /** Receiver-owned presentation of the exact prepared effect. The dispatcher
   * seals it to `preparedStateDigest`; agent-authored text is never accepted. */
  substance?: {
    kind: import("./approvals.js").OperationSubstance["kind"];
    summary: string;
    detail?: string;
  };
  /** Sealed workspace-service categorization. Host-census capabilities ignore
   * caller data and are joined from the static reviewed table instead. */
  authorityVocabulary?: {
    domain: import("./authority/capabilityDomains.js").AuthorityDomainId;
    verb: import("./authority/capabilityDomains.js").AuthorityVerb;
    declaredBy: string;
    substanceKind?: import("./approvals.js").OperationSubstance["kind"];
  };
  details?: readonly { label: string; value: string; format?: ApprovalDetailFormat }[];
  diffReview?: readonly DiffReviewEntry[];
  /** Rich unit/config review rendered by the canonical authority acquisition.
   * This changes only the card projection; capability, resource, principal,
   * grant, cancellation, and settlement remain owned by the dispatcher. */
  unitBatch?: {
    trigger: import("./approvals.js").PendingUnitBatchApproval["trigger"];
    units: readonly import("./approvals.js").UnitBatchEntry[];
    configWrite?: import("./approvals.js").PendingUnitBatchApproval["configWrite"];
  };
  /**
   * Exact decisions meaningful for this operation. This is host-derived policy,
   * not UI presentation: authority brokers must intersect their ordinary grant
   * scopes with this set before presenting or accepting a decision.
   */
  allowedDecisions?: readonly ApprovalDecision[];
  signal?: AbortSignal;
}

export type ServiceHandler = (
  ctx: ServiceContext,
  method: string,
  args: unknown[]
) => Promise<unknown>;

export class ServiceError extends Error {
  public readonly service: string;
  public readonly method: string;
  /** Preserved error code from the original error (e.g. "ENOENT") */
  public readonly code?: string;
  /** Stable wire category preserved by RPC transports. */
  public readonly errorKind: import("@vibestudio/rpc").RpcErrorKind;
  /** Schema-owned failure payload preserved without parsing or translation. */
  public readonly errorData?: import("@vibestudio/rpc").RpcErrorData;

  constructor(
    service: string,
    method: string,
    message: string,
    code?: string,
    cause?: unknown,
    errorKind: import("@vibestudio/rpc").RpcErrorKind = "service",
    errorData?: import("@vibestudio/rpc").RpcErrorData
  ) {
    super(`[${service}.${method}] ${message}`);
    this.service = service;
    this.method = method;
    this.code = code;
    this.errorKind = errorKind;
    this.errorData = errorData;
    this.name = "ServiceError";
    if (cause instanceof Error) {
      (this as Error & { cause?: unknown }).cause = cause;
      if (cause.stack) {
        this.stack = `${this.message}\nCaused by: ${cause.stack}`;
      }
    }
  }
}

/**
 * Structured compositional-authority denial. Carries `code: "EACCES"` so
 * transports can map this to a 403 / structured RPC error code.
 */
export class ServiceAccessError extends ServiceError {
  constructor(
    service: string,
    method: string,
    message?: string,
    code = "EACCES",
    errorData?: import("@vibestudio/rpc").RpcErrorData
  ) {
    super(
      service,
      method,
      message ?? `Authority denied for service '${service}.${method}'`,
      code,
      undefined,
      "access",
      errorData
    );
    this.name = "ServiceAccessError";
  }
}

export interface HostAuthorityEffect {
  service: string;
  method: string;
  capability: string;
  resourceKey: string;
  requirement: import("./authorization.js").AuthorityRequirement;
  tier: "open" | "gated" | "critical";
  sessionAdmission: MethodTierDecision["session"];
  args: readonly unknown[];
  preparedStateDigest: string;
  challenge?: AuthorityChallengePresentation;
  sensitivity?: import("./serviceAuthority.js").MethodSensitivity;
}

/**
 * Service dispatcher — all services registered via registerService().
 */
export class ServiceDispatcher {
  private handlers = new Map<string, ServiceHandler>();
  private definitions = new Map<string, ServiceDefinition>();
  private readonly methodTiers = new Map<string, MethodTierDecision>();
  private initialized = false;
  private readonly tierLookup: (method: string) => MethodTierDecision | null;
  private readonly capabilityLookup: (method: string) => string | null;
  private authorityAcquirer?: {
    request(input: {
      snapshot: InvocationSnapshot;
      snapshotDigest: string;
      tier: "gated" | "critical";
      caller: VerifiedCaller;
      renderedAction: string;
      resource: ResourceScope;
      presentation?: AuthorityChallengePresentation;
    }): AcquisitionInfo;
    acquire(
      input: {
        snapshot: InvocationSnapshot;
        snapshotDigest: string;
        tier: "gated" | "critical";
        caller: VerifiedCaller;
        renderedAction: string;
        resource: ResourceScope;
        presentation?: AuthorityChallengePresentation;
      },
      signal?: AbortSignal
    ): Promise<{
      state: "decided" | "closed";
      decision?: "once" | "task" | "agent" | "lock" | "version" | "deny";
      info?: AcquisitionInfo;
    }>;
    consume(grantId: string): boolean;
    touch?(grantId: string): boolean;
    priorInteractiveApprovalCount?(input: {
      agentBindingId: string;
      capability: string;
      resource: ResourceScope;
    }): number;
    invalidate(snapshotDigest: string, ownerRuntimeId: string, callerPrincipal: string): void;
    proposeMissionRevision?(input: {
      snapshot: InvocationSnapshot;
      tier: "gated" | "critical";
      renderedAction: string;
      resource: ResourceScope;
      presentation?: AuthorityChallengePresentation;
    }): void | Promise<void>;
  };

  constructor(
    opts: {
      tierLookup?: (method: string) => MethodTierDecision | null;
      capabilityLookup?: (method: string) => string | null;
    } = {}
  ) {
    this.tierLookup = opts.tierLookup ?? methodTier;
    this.capabilityLookup = opts.capabilityLookup ?? hostMethodCapability;
  }

  setAuthorityAcquirer(acquirer: NonNullable<ServiceDispatcher["authorityAcquirer"]>): void {
    this.authorityAcquirer = acquirer;
  }
  private authorityResolver?: (input: {
    ctx: ServiceContext;
    caller: VerifiedCaller;
    service: string;
    method: string;
    capability: string;
    resourceKey: string;
    requirement: import("./authorization.js").AuthorityRequirement;
    challenge?: AuthorityChallengePresentation;
    sensitivity?: import("./serviceAuthority.js").MethodSensitivity;
    tier: MethodTierDecision["tier"];
    sessionAdmission: MethodTierDecision["session"];
  }) =>
    | {
        context: AuthorizationContext;
        grants: readonly AuthorityGrant[];
        locks?: readonly import("@vibestudio/rpc").AuthorityLock[];
        effectiveCaller?: VerifiedCaller;
        authorizingCaller?: VerifiedCaller;
        contextId?: string;
        readOnly?: boolean;
        decision?: "once" | "session" | "version";
        missionChangeRequired?: boolean;
      }
    | Promise<{
        context: AuthorizationContext;
        grants: readonly AuthorityGrant[];
        locks?: readonly import("@vibestudio/rpc").AuthorityLock[];
        effectiveCaller?: VerifiedCaller;
        authorizingCaller?: VerifiedCaller;
        contextId?: string;
        readOnly?: boolean;
        decision?: "once" | "session" | "version";
        missionChangeRequired?: boolean;
      }>;

  setAuthorityResolver(
    resolver: (input: {
      ctx: ServiceContext;
      caller: VerifiedCaller;
      service: string;
      method: string;
      capability: string;
      resourceKey: string;
      requirement: import("./authorization.js").AuthorityRequirement;
      challenge?: AuthorityChallengePresentation;
      sensitivity?: import("./serviceAuthority.js").MethodSensitivity;
      tier: MethodTierDecision["tier"];
      sessionAdmission: MethodTierDecision["session"];
    }) =>
      | {
          context: AuthorizationContext;
          grants: readonly AuthorityGrant[];
          locks?: readonly import("@vibestudio/rpc").AuthorityLock[];
          effectiveCaller?: VerifiedCaller;
          authorizingCaller?: VerifiedCaller;
          contextId?: string;
          readOnly?: boolean;
          decision?: "once" | "session" | "version";
          missionChangeRequired?: boolean;
        }
      | Promise<{
          context: AuthorizationContext;
          grants: readonly AuthorityGrant[];
          locks?: readonly import("@vibestudio/rpc").AuthorityLock[];
          effectiveCaller?: VerifiedCaller;
          authorizingCaller?: VerifiedCaller;
          contextId?: string;
          readOnly?: boolean;
          decision?: "once" | "session" | "version";
          missionChangeRequired?: boolean;
        }>
  ): void {
    this.authorityResolver = resolver;
  }

  /**
   * Enforce a host-owned effect that does not enter through an RPC method
   * (for example protected publication or raw egress). It deliberately runs
   * through the same resolver, snapshot, acquisition, grant, and consume path
   * as ordinary service dispatch; callers may not provide a precomputed allow.
   */
  async authorizeHostEffect(ctx: ServiceContext, effect: HostAuthorityEffect): Promise<void> {
    const methodDef = {
      description: effect.challenge?.title ?? effect.capability,
      args: z.tuple([]),
      ...(effect.sensitivity ? { access: { sensitivity: effect.sensitivity } } : {}),
    } as MethodSchema;
    await this.enforceRequirement(
      ctx,
      effect.service,
      effect.method,
      effect.capability,
      effect.resourceKey,
      effect.requirement,
      methodDef,
      effect.args,
      effect.preparedStateDigest,
      undefined,
      effect.challenge,
      false,
      effect.tier,
      { tier: effect.tier, session: effect.sessionAdmission, rationale: "host-owned effect" }
    );
  }

  /**
   * Mark the dispatcher as initialized. Must be called after all services are registered.
   */
  markInitialized(): void {
    this.initialized = true;
  }

  /**
   * Register a service with full definition (schema, authority, handler).
   *
   * If a service with the same name was already registered, the previous
   * definition is replaced and a warning is logged (audit finding #35 /
   * 02-Low-15: silent overrides should be audible). The previous
   * definition is returned so callers can detect the replacement.
   */
  registerService(def: ServiceDefinition): ServiceDefinition | undefined {
    const usedPreparers = new Set<string>();
    for (const [method, schema] of Object.entries(def.methods)) {
      const qualifiedMethod = `${def.name}.${method}`;
      const reviewedTier = resolveMethodTierPolicy(
        qualifiedMethod,
        schema.tier,
        this.tierLookup(qualifiedMethod)
      );
      if (!reviewedTier.rationale.trim()) {
        throw new Error(`Service method ${qualifiedMethod} has an empty tier rationale`);
      }
      if (
        reviewedTier.tier !== "open" &&
        !(schema.capability ?? this.capabilityLookup(qualifiedMethod))
      ) {
        throw new Error(
          `Promptable service method ${qualifiedMethod} has no reviewed semantic capability`
        );
      }
      this.methodTiers.set(qualifiedMethod, reviewedTier);
      if (!schema.authority && !def.authority) {
        throw new Error(`Service method ${def.name}.${method} has no authority declaration`);
      }
      const declaration = schema.authority ?? def.authority;
      if ("requirement" in declaration && declaration.prepared) {
        const { resolver, leaves } = declaration.prepared;
        if (!def.authorityPreparation?.[resolver]) {
          throw new Error(
            `Service method ${def.name}.${method} references missing authority preparer ${resolver}`
          );
        }
        if (leaves.length === 0) {
          throw new Error(
            `Service method ${def.name}.${method} declares an empty prepared leaf set`
          );
        }
        const selectors = new Set(leaves.map(preparedAuthoritySelectorKey));
        if (selectors.size !== leaves.length) {
          throw new Error(
            `Service method ${def.name}.${method} declares duplicate prepared authority selectors`
          );
        }
        usedPreparers.add(resolver);
      }
    }
    for (const resolver of Object.keys(def.authorityPreparation ?? {})) {
      if (!usedPreparers.has(resolver)) {
        throw new Error(`Service ${def.name} registers unused authority preparer ${resolver}`);
      }
    }
    const previous = this.definitions.get(def.name);
    if (previous || this.handlers.has(def.name)) {
      // Keep the word "Overwriting" so existing audits/log queries still
      // match. The new "Replacing" verb makes the audit-finding-#35 fix
      // (warn-then-replace-and-return-previous) visible.
      console.warn(
        `[ServiceDispatcher] Overwriting handler for service: ${def.name} ` +
          `(replacing previous registration; description: ${previous?.description ?? "<unknown>"})`
      );
    }
    this.definitions.set(def.name, def);
    this.handlers.set(def.name, def.handler);
    return previous;
  }

  /**
   * Dispatch a service call.
   */
  async dispatch(
    ctx: ServiceContext,
    service: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    if (!this.initialized && !this.handlers.has(service)) {
      throw new ServiceError(service, method, "Services not yet initialized");
    }

    const handler = this.handlers.get(service);
    if (!handler) {
      throw new ServiceError(service, method, "Unknown service");
    }

    // Validate args against schema if method has a definition
    const def = this.definitions.get(service);
    let methodDef: MethodSchema | undefined;
    if (def) {
      methodDef = def.methods[method];
      if (!methodDef) {
        throw new ServiceError(service, method, "Unknown method");
      }
      {
        // Normalize args for wire compatibility: RPC args arrive as JSON arrays
        // where trailing optional args may be omitted (shorter array) or null
        // (JSON serialization of undefined). Pad short arrays to match the
        // tuple length and replace null with undefined so Zod's .optional()
        // accepts them.
        const normalized = normalizeServiceArgs(args, methodDef.args);
        const parsed = methodDef.args.safeParse(normalized);
        if (!parsed.success) {
          const reason = formatArgsValidationError(parsed.error);
          // ServiceError prefixes the message with `[service.method]`, so the
          // full error reads e.g.:
          //   [workspace.logs] Invalid args: invalid argument [1].limit — expected number, received string
          throw new ServiceError(
            service,
            method,
            `Invalid args: ${reason}${formatUsageHint(service, method, methodDef)}`
          );
        }
        // Use normalized args so handlers see undefined (not null) for optional params
        args = normalized;
      }
    }

    const invoke = async (invocationCtx: ServiceContext): Promise<unknown> => {
      await this.assertAuthority(invocationCtx, service, method, args);
      const result = await handler(invocationCtx, method, args);
      let normalizedResult = result;
      if (methodDef?.returns) {
        normalizedResult = normalizeReturnForSchema(result, methodDef.returns);
        if (shouldValidateServiceReturns()) {
          const parsed = methodDef.returns.safeParse(normalizedResult);
          if (!parsed.success) {
            throw new ServiceError(
              service,
              method,
              `Invalid return: ${formatReturnValidationError(parsed.error)}`
            );
          }
        }
      }
      return normalizedResult;
    };

    try {
      return await invoke(ctx);
    } catch (error) {
      if (error instanceof ServiceError) {
        throw error;
      }
      throw new ServiceError(
        service,
        method,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
        error,
        rpcErrorKindOf(error, "service"),
        rpcErrorDataOf(error)
      );
    }
  }

  /**
   * Enforce the exact same compositional contract for alternate transports
   * whose byte streaming cannot pass through the ordinary handler invocation.
   */
  async assertAuthority(
    ctx: ServiceContext,
    service: string,
    method: string,
    args: unknown[]
  ): Promise<void> {
    await this.assessAuthority(ctx, service, method, args, false);
  }

  /** Execute the complete authority contract without cards, grants, consumption, or handlers. */
  async preflightAuthority(
    ctx: ServiceContext,
    service: string,
    method: string,
    args: unknown[]
  ): Promise<AuthorityPreflightResult> {
    const methodDef = this.definitions.get(service)?.methods[method];
    if (!methodDef) throw new ServiceError(service, method, "Unknown service method");
    const normalized = normalizeServiceArgs(args, methodDef.args);
    const parsed = methodDef.args.safeParse(normalized);
    if (!parsed.success) {
      throw new ServiceError(
        service,
        method,
        `Invalid args: ${formatArgsValidationError(parsed.error)}${formatUsageHint(service, method, methodDef)}`
      );
    }
    return this.assessAuthority(
      ctx,
      service,
      method,
      normalized,
      true
    ) as Promise<AuthorityPreflightResult>;
  }

  private async assessAuthority(
    ctx: ServiceContext,
    service: string,
    method: string,
    args: unknown[],
    preflight: boolean
  ): Promise<void | AuthorityPreflightResult> {
    if (ctx.evalInvocation && !ctx.transportCaller) ctx.transportCaller = ctx.caller;
    const serviceDef = this.definitions.get(service);
    const methodDef = serviceDef?.methods[method];
    if (!serviceDef || !methodDef) {
      throw new ServiceError(service, method, "Unknown service method");
    }
    const declaration = methodDef?.authority ?? serviceDef?.authority;
    if (!this.authorityResolver) {
      throw new ServiceError(service, method, "Compositional authority resolver is unavailable");
    }
    const transportLabel = `service:${service}.${method}`;
    const methodTierDecision = this.methodTiers.get(`${service}.${method}`);
    if (!methodTierDecision) {
      throw new ServiceError(service, method, "Reviewed method tier is unavailable");
    }
    const capabilityName =
      methodTierDecision.tier === "open"
        ? transportLabel
        : (methodDef.capability ?? this.capabilityLookup(`${service}.${method}`));
    if (!capabilityName) {
      throw new ServiceError(
        service,
        method,
        "Promptable host method has no reviewed semantic capability"
      );
    }
    const descriptor =
      "requirement" in declaration
        ? declaration
        : {
            requirement: requirementForPrincipals(declaration.principals, capabilityName, {
              codeOnly: methodTierDecision.session === "codeOnly",
            }),
            resource: { kind: "literal" as const, key: capabilityName },
          };
    const resourceKey = deriveAuthorityResource(descriptor.resource, args);
    const preflightLeaves: AuthorityPreflightLeaf[] = [];
    let preflightPrompt: AuthorityPreflightResult["wouldPrompt"];
    if (
      methodTierDecision.session === "codeOnly" &&
      (ctx.authorization?.authorizingOrigin.kind === "session" ||
        (!ctx.authorization && ctx.caller.executionSession !== undefined))
    ) {
      if (preflight) {
        return preflightResult(
          [
            {
              capability: capabilityName,
              resourceKey,
              status: "denied",
              tier: methodTierDecision.tier,
            },
          ],
          reviewedSeverity(methodTierDecision.tier)
        );
      }
      throw new ServiceAccessError(
        service,
        method,
        `The reviewed ${service}.${method} surface requires a durable code identity`,
        "EACCES"
      );
    }
    type PreparedSelection = {
      selection: PreparedAuthoritySelection;
      leaf: NonNullable<MethodAuthorityDescriptor["prepared"]>["leaves"][number];
      requirement: import("./authorization.js").AuthorityRequirement;
      tier?: "open" | "gated" | "critical";
    };
    const prepareDescriptor = "prepared" in descriptor ? descriptor.prepared : undefined;
    const collectPreparedSelections = async (): Promise<PreparedSelection[]> => {
      if (!prepareDescriptor) return [];
      const prepare = serviceDef.authorityPreparation?.[prepareDescriptor.resolver];
      if (!prepare) {
        throw new ServiceError(
          service,
          method,
          `Authority preparer '${prepareDescriptor.resolver}' is unavailable`
        );
      }
      const selected = await prepare(ctx, args);
      const collected: PreparedSelection[] = [];
      const seen = new Set<string>();
      for (const selection of selected) {
        const matchingLeaves = prepareDescriptor.leaves.filter((leaf) =>
          leaf.capability !== undefined
            ? leaf.capability === selection.capability
            : selection.capability.startsWith(leaf.capabilityPrefix)
        );
        if (matchingLeaves.length !== 1) {
          throw new ServiceError(
            service,
            method,
            matchingLeaves.length === 0
              ? `Authority preparer selected undeclared capability '${selection.capability}'`
              : `Authority preparer selected ambiguously declared capability '${selection.capability}'`
          );
        }
        const leaf = matchingLeaves[0]!;
        const selectionKey = `${selection.capability}\u0000${selection.resourceKey}`;
        if (seen.has(selectionKey)) {
          throw new ServiceError(
            service,
            method,
            `Authority preparer selected '${selection.capability}' for '${selection.resourceKey}' more than once`
          );
        }
        seen.add(selectionKey);
        collected.push({
          selection,
          leaf,
          requirement: resolvePreparedRequirement(service, method, leaf.requirement, selection),
          tier: resolvePreparedTier(service, method, leaf.tier, selection.tier),
        });
      }
      return collected;
    };
    const preparedDigest = (selections: readonly PreparedSelection[]): string =>
      sha256Canonical({
        service,
        method,
        args,
        selections: selections.map(({ selection, requirement, tier }) => ({
          capability: selection.capability,
          resourceKey: selection.resourceKey,
          requirement,
          authorizingCaller: selection.authorizingCaller
            ? {
                runtime: selection.authorizingCaller.runtime,
                hostOriginated: selection.authorizingCaller.hostOriginated === true,
                code: selection.authorizingCaller.code
                  ? {
                      principal: selection.authorizingCaller.code.repoPath,
                      effectiveVersion: selection.authorizingCaller.code.effectiveVersion,
                      executionDigest: selection.authorizingCaller.code.executionDigest ?? null,
                    }
                  : null,
                subject: selection.authorizingCaller.subject?.userId ?? null,
              }
            : null,
          challenge: selection.challenge ?? null,
          tier: tier ?? null,
        })),
      });
    const preparedSelections = await collectPreparedSelections();
    const preparedStateDigest = preparedDigest(preparedSelections);
    ctx.authority = {
      assert: ({
        capability,
        resourceKey: dynamicResource,
        requirement,
        authorizingCaller,
        challenge,
      }) =>
        this.enforceRequirement(
          ctx,
          service,
          method,
          capability,
          dynamicResource,
          bindMethodCapability(requirement, capability),
          methodDef,
          args,
          preparedStateDigest,
          authorizingCaller,
          challenge
        ).then(() => undefined),
      allows: async ({
        capability,
        resourceKey: dynamicResource,
        requirement,
        authorizingCaller,
        challenge,
      }) => {
        try {
          await this.enforceRequirement(
            ctx,
            service,
            method,
            capability,
            dynamicResource,
            bindMethodCapability(requirement, capability),
            methodDef,
            args,
            preparedStateDigest,
            authorizingCaller,
            challenge
          );
          return true;
        } catch (error) {
          if (isAuthorityDenial(error)) return false;
          throw error;
        }
      },
    };
    const primary = await this.enforceRequirement(
      ctx,
      service,
      method,
      capabilityName,
      resourceKey,
      bindMethodCapability(descriptor.requirement, capabilityName),
      methodDef,
      args,
      preparedStateDigest,
      undefined,
      undefined,
      preflight
    );
    if (primary) {
      preflightLeaves.push(primary.leaf);
      preflightPrompt ??= primary.wouldPrompt;
    }
    for (const additional of "additional" in descriptor ? (descriptor.additional ?? []) : []) {
      if (
        additional.when &&
        !additional.when.origins.includes(ctx.authorization?.authorizingOrigin.kind ?? "code")
      ) {
        continue;
      }
      const additionalResourceKey = deriveAuthorityResource(additional.resource, args);
      const result = await this.enforceRequirement(
        ctx,
        service,
        method,
        additional.capability,
        additionalResourceKey,
        bindMethodCapability(additional.requirement, additional.capability),
        methodDef,
        args,
        preparedStateDigest,
        undefined,
        undefined,
        preflight,
        additional.tier
      );
      if (result) {
        preflightLeaves.push(result.leaf);
        preflightPrompt ??= result.wouldPrompt;
      }
    }
    for (const { selection, requirement, tier } of preparedSelections) {
      const result = await this.enforceRequirement(
        ctx,
        service,
        method,
        selection.capability,
        selection.resourceKey,
        bindMethodCapability(requirement, selection.capability),
        methodDef,
        args,
        preparedStateDigest,
        selection.authorizingCaller,
        selection.challenge,
        preflight,
        tier
      );
      if (result) {
        preflightLeaves.push(result.leaf);
        preflightPrompt ??= result.wouldPrompt;
      }
    }

    // A parked acquisition may outlive the host state used to select a target,
    // provider, or canonical resource. Re-run the side-effect-free preparer at
    // the handler boundary and restart the complete authority assessment when
    // anything changed. The old invocation-bound grant remains unusable because
    // the replacement snapshot has a different prepared-state digest.
    if (!preflight && prepareDescriptor) {
      const livePrepared = await collectPreparedSelections();
      if (preparedDigest(livePrepared) !== preparedStateDigest) {
        return this.assessAuthority(ctx, service, method, args, false);
      }
    }

    // Read-only containment: a caller may request a mode in which only methods
    // explicitly declared `access.sensitivity === "read"` may run. Default-deny —
    // an unmarked method is treated as mutating. This is the load-bearing
    // enforcement point (every dispatch path funnels here), so the containment
    // can't be bypassed.
    if (ctx.readOnly && methodDef.access?.sensitivity !== "read") {
      if (preflight) {
        for (const leaf of preflightLeaves) leaf.status = "denied";
        return preflightResult(
          preflightLeaves,
          reviewedSeverity(methodTierDecision.tier),
          preflightPrompt
        );
      }
      throw new ServiceError(
        service,
        method,
        `Blocked in read-only mode: '${service}.${method}' is not declared read-only ` +
          `(sensitivity ${methodDef?.access?.sensitivity ?? "unknown"}). A read-only caller may ` +
          `only invoke methods declaring access.sensitivity === "read".`,
        "EVAL_READ_ONLY"
      );
    }
    if (preflight) {
      return preflightResult(preflightLeaves, severityForLeaves(preflightLeaves), preflightPrompt);
    }
  }

  private async enforceRequirement(
    ctx: ServiceContext,
    service: string,
    method: string,
    capability: string,
    resourceKey: string,
    requirement: import("./authorization.js").AuthorityRequirement,
    methodDef: MethodSchema,
    validatedArgs: readonly unknown[],
    preparedStateDigest: string,
    authorizingCaller?: VerifiedCaller,
    challenge?: AuthorityChallengePresentation,
    preflight = false,
    tierOverride?: "open" | "gated" | "critical",
    effectReview?: MethodTierDecision
  ): Promise<{
    leaf: AuthorityPreflightLeaf;
    wouldPrompt?: AuthorityPreflightResult["wouldPrompt"];
  } | void> {
    const reviewedMethod = effectReview ?? this.methodTiers.get(`${service}.${method}`);
    if (!reviewedMethod) {
      throw new ServiceError(service, method, "Reviewed method tier is unavailable");
    }
    const reviewedTier = tierOverride ?? reviewedMethod.tier;
    const receiverPolicy = receiverAuthorityPolicy(capability, challenge?.authorityVocabulary);
    const operationPresentation =
      challenge?.operation ?? methodDef.access?.approval?.[0]?.operation;
    const preparedTarget =
      validatedArgs.length === 1
        ? safeJsonArg(validatedArgs[0])
        : validatedArgs.length > 1
          ? safeJsonArg(validatedArgs)
          : resourceKey;
    const substance = receiverPolicy.requiresSubstance
      ? {
          kind: challenge?.substance?.kind ?? receiverPolicy.substanceKind ?? "custom",
          summary:
            challenge?.substance?.summary ??
            `${operationPresentation?.verb ?? describeCapability(capability).action} ${
              operationPresentation && "object" in operationPresentation
                ? operationPresentation.object.value
                : preparedTarget
            }`,
          ...(challenge?.substance?.detail ? { detail: challenge.substance.detail } : {}),
          digest: preparedStateDigest,
        }
      : challenge?.substance
        ? { ...challenge.substance, digest: preparedStateDigest }
        : null;
    const resolver = this.authorityResolver;
    if (!resolver) {
      throw new ServiceError(service, method, "Compositional authority resolver is unavailable");
    }
    const caller = authorizingCaller ?? ctx.caller;
    const resolveLive = () =>
      resolver({
        ctx,
        caller,
        service,
        method,
        capability,
        resourceKey,
        requirement,
        ...(challenge ? { challenge } : {}),
        ...(methodDef.access?.sensitivity ? { sensitivity: methodDef.access.sensitivity } : {}),
        tier: reviewedTier,
        sessionAdmission: reviewedMethod.session,
      });

    let preauthorizedRetry = false;
    for (;;) {
      const resolved = await resolveLive();
      if (!preflight) {
        ctx.authorization = resolved.context;
        if (ctx.evalInvocation && resolved.contextId)
          ctx.evalInvocation.contextId = resolved.contextId;
        if (resolved.authorizingCaller) ctx.authorizingCaller = resolved.authorizingCaller;
        if (resolved.effectiveCaller) ctx.caller = resolved.effectiveCaller;
        if (resolved.readOnly === true) ctx.readOnly = true;
        if (resolved.decision)
          (ctx.authorityDecisions ??= new Map()).set(capability, resolved.decision);
      }

      const snapshot = createInvocationSnapshot({
        service,
        method,
        capability,
        resourceKey,
        args: validatedArgs,
        preparedStateDigest,
        callerPrincipal: resolved.context.authorizingOrigin.principal,
        sessionId: resolved.context.session.id,
        ...(resolved.context.session.taskRef ? { taskRef: resolved.context.session.taskRef } : {}),
        ...(resolved.context.executionSession?.agentBinding?.bindingId
          ? {
              agentBindingId: resolved.context.executionSession.agentBinding.bindingId,
              agentName: resolved.context.executionSession.agentBinding.entityId,
            }
          : {}),
        lineageClasses: resolved.context.contextIntegrity
          ? lineageClasses(resolved.context.contextIntegrity)
          : ["none"],
        irreversible: receiverPolicy.irreversible,
        agentScopeEligible: standingAgentScopeEligible({
          capability,
          tier: reviewedTier,
          policy: receiverPolicy,
          domain: challenge?.authorityVocabulary?.domain,
          priorInteractiveApprovals:
            resolved.context.executionSession?.agentBinding?.bindingId === undefined
              ? 0
              : (this.authorityAcquirer?.priorInteractiveApprovalCount?.({
                  agentBindingId: resolved.context.executionSession.agentBinding.bindingId,
                  capability,
                  resource: { kind: "exact", key: resourceKey },
                }) ?? 0),
        }),
        executionMode:
          resolved.context.executionSession?.mode ??
          (resolved.context.testPolicy ? "test" : undefined),
        testPolicyId: resolved.context.testPolicy?.policyId,
        mission: resolved.context.session.mission
          ? `mission:${resolved.context.session.mission.missionId}@${resolved.context.session.mission.closureDigest}`
          : "-",
        snippetDigest:
          resolved.context.authorizingOrigin.kind === "session"
            ? (resolved.context.executingCode?.principal.split("@").slice(-1)[0] ?? "-")
            : "-",
        codeLineage: resolved.context.executingCode
          ? {
              class: resolved.context.executingCode.sourceLineage.class,
              chain: resolved.context.executingCode.sourceLineage.externalKeys,
            }
          : { class: "unknown", chain: [] },
        contextLineage: resolved.context.contextIntegrity,
        initiatorChain: resolved.context.initiatorChain,
      });
      const snapshotDigest = invocationSnapshotDigest(snapshot);
      const evaluated = evaluateAuthority({
        context: resolved.context,
        requirement,
        resourceKey,
        grants: resolved.grants,
        locks: resolved.locks,
        tier: reviewedTier,
        invocationDigest: snapshotDigest,
      });
      const decision =
        resolved.missionChangeRequired === true
          ? {
              allowed: false as const,
              code: "mission-change-required" as const,
              reason: "This operation is outside the active mission charter",
              requirement,
            }
          : evaluated;
      if (decision.allowed) {
        if (preflight) {
          return {
            leaf: {
              capability,
              resourceKey,
              status: decision.consumable ? "consumable-once" : "granted",
              tier: reviewedTier,
            },
          };
        }
        if (decision.consumable && decision.grantId) {
          if (!this.authorityAcquirer?.consume(decision.grantId)) {
            this.authorityAcquirer?.invalidate(
              snapshotDigest,
              caller.runtime.id,
              resolved.context.authorizingOrigin.principal
            );
            continue;
          }
        }
        if (!decision.consumable && decision.grantId) {
          this.authorityAcquirer?.touch?.(decision.grantId);
        }
        return;
      }

      const acquirable = reviewedTier !== "open" && decision.code === "approval-required";
      const authorityFailure = authorityFailureForDecision(decision, {
        capability,
        resourceKey,
        tier: reviewedTier,
      });
      if (decision.code === "mission-change-required") {
        if (!preflight) {
          await this.authorityAcquirer?.proposeMissionRevision?.({
            snapshot,
            tier: reviewedTier === "open" ? "gated" : reviewedTier,
            renderedAction:
              challenge?.operation.verb ??
              methodDef.access?.approval?.[0]?.operation.verb ??
              describeCapability(capability).action,
            resource: { kind: "exact", key: resourceKey },
            ...(challenge ? { presentation: challenge } : {}),
          });
        }
        throw new ServiceAccessError(
          service,
          method,
          `The mission must be revised before this operation can run${formatAccessHint(methodDef)}`,
          "EMISSIONCHANGE",
          { denied: true, authorityFailure }
        );
      }
      if (acquirable) {
        const tier = reviewedTier as "gated" | "critical";
        const renderedAction =
          challenge?.operation.verb ??
          methodDef.access?.approval?.[0]?.operation.verb ??
          describeCapability(capability).action;
        if (preflight) {
          return {
            leaf: {
              capability,
              resourceKey,
              status: "acquirable",
              tier,
              failure: authorityFailure,
            },
            wouldPrompt: {
              cardType:
                tier === "critical"
                  ? "confirm.critical"
                  : resolved.context.contextIntegrity?.class === "external"
                    ? "permission.outside"
                    : "permission.gated",
              renderedAction,
            },
          };
        }
        const acquisitionInput = {
          snapshot,
          snapshotDigest,
          tier,
          caller,
          renderedAction,
          resource: { kind: "exact" as const, key: resourceKey },
          ...(substance ? { substance } : {}),
          ...(challenge ? { presentation: challenge } : {}),
        };
        let presented: AcquisitionInfo | undefined;
        if (
          this.authorityAcquirer &&
          (ctx.authorityAcquisition === "wait" ||
            resolved.context.authorizingOrigin.kind !== "code")
        ) {
          this.authorityAcquirer.invalidate(
            snapshotDigest,
            caller.runtime.id,
            resolved.context.authorizingOrigin.principal
          );
          const outcome = await this.authorityAcquirer.acquire(acquisitionInput, ctx.signal);
          if (outcome.state === "decided" && outcome.decision !== "deny") continue;
          presented = outcome.info;
          if (outcome.state === "decided" && outcome.decision === "deny") {
            const deniedFailure = authorityFailureForDecision(
              {
                ...decision,
                allowed: false,
                code: "user-denied",
                reason: "The authority request was denied",
              },
              { capability, resourceKey, tier: reviewedTier }
            );
            throw new ServiceAccessError(
              service,
              method,
              `The authority request was denied${formatAccessHint(methodDef)}`,
              "EACCES",
              { denied: true, authorityFailure: deniedFailure }
            );
          }
        } else if (this.authorityAcquirer) {
          presented = this.authorityAcquirer.request(acquisitionInput);
          if (presented.preauthorized) {
            if (preauthorizedRetry) {
              throw new ServiceAccessError(
                service,
                method,
                "Host preauthorization did not admit the exact invocation",
                "EACCES",
                { denied: true, authorityFailure }
              );
            }
            preauthorizedRetry = true;
            continue;
          }
        }
        const acquisitionInfo: AcquisitionInfo = presented ?? {
          acquisitionId: `acq:${snapshotDigest}`,
          ownerRuntimeId: caller.runtime.id,
          snapshotDigest,
          capability,
          resourceKey,
          tier,
          cardType:
            tier === "critical"
              ? "confirm.critical"
              : resolved.context.contextIntegrity?.class === "external"
                ? "permission.outside"
                : "permission.gated",
          renderedAction,
          pending: false,
        };
        throw new ServiceAccessError(
          service,
          method,
          `${decision.reason} (${decision.code})${formatAccessHint(methodDef)}`,
          "EACQUIRE",
          { acquisition: acquisitionInfo, authorityFailure }
        );
      }
      if (preflight) {
        return {
          leaf: {
            capability,
            resourceKey,
            status: "denied",
            tier: reviewedTier,
            failure: authorityFailure,
          },
        };
      }
      throw new ServiceAccessError(
        service,
        method,
        `${decision.reason} (${decision.code})${formatAccessHint(methodDef)}`,
        "EACCES",
        {
          ...(decision.code === "user-denied" ? { denied: true } : {}),
          authorityFailure,
        }
      );
    }
  }

  /**
   * Check if a service is registered.
   */
  hasService(service: string): boolean {
    return this.handlers.has(service);
  }

  /**
   * Get all registered service names.
   */
  getServices(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Get all registered service definitions (for introspection/extension discovery).
   */
  getServiceDefinitions(): ServiceDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Get the Zod schema for a specific method.
   */
  getMethodSchema(service: string, method: string): MethodSchema | undefined {
    return this.definitions.get(service)?.methods[method];
  }
}

function isAuthorityDenial(error: unknown): boolean {
  if (error instanceof ServiceAccessError) return true;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return code === "EACCES" || code.startsWith("EVAL_");
}

function reviewedSeverity(tier: MethodTierDecision["tier"]): "routine" | "sensitive" | "critical" {
  return tier === "critical" ? "critical" : tier === "gated" ? "sensitive" : "routine";
}

function severityForLeaves(
  leaves: readonly AuthorityPreflightLeaf[]
): "routine" | "sensitive" | "critical" {
  if (leaves.some((leaf) => leaf.tier === "critical")) return "critical";
  if (leaves.some((leaf) => leaf.tier === "gated")) return "sensitive";
  return "routine";
}

function preflightResult(
  leaves: AuthorityPreflightLeaf[],
  severityPreview: NonNullable<AuthorityPreflightResult["severityPreview"]>,
  wouldPrompt?: AuthorityPreflightResult["wouldPrompt"]
): AuthorityPreflightResult {
  const decision = leaves.some((leaf) => leaf.status === "denied")
    ? "denied"
    : leaves.some((leaf) => leaf.status === "acquirable")
      ? "acquirable"
      : "allowed";
  return {
    decision,
    leaves,
    severityPreview,
    ...(wouldPrompt ? { wouldPrompt } : {}),
  };
}

function resolvePreparedTier(
  service: string,
  method: string,
  declaration:
    | "open"
    | "gated"
    | "critical"
    | { selectedFrom: readonly ("gated" | "critical")[] }
    | undefined,
  selection: "gated" | "critical" | undefined
): "open" | "gated" | "critical" | undefined {
  if (declaration && typeof declaration === "object") {
    if (!selection || !declaration.selectedFrom.includes(selection)) {
      throw new ServiceError(
        service,
        method,
        `Authority preparer selected an undeclared tier for a dynamic leaf`
      );
    }
    return selection;
  }
  if (selection !== undefined && selection !== declaration) {
    throw new ServiceError(service, method, `Authority preparer replaced a fixed leaf tier`);
  }
  return declaration;
}

function resolvePreparedRequirement(
  service: string,
  method: string,
  declaration: PreparedAuthorityRequirement,
  selection: PreparedAuthoritySelection
): import("./authorization.js").AuthorityRequirement {
  if (declaration.kind !== "selected") {
    if (selection.requirement) {
      throw new ServiceError(
        service,
        method,
        `Authority preparer replaced the fixed requirement for '${selection.capability}'`
      );
    }
    return declaration;
  }
  if (!selection.requirement) {
    throw new ServiceError(
      service,
      method,
      `Authority preparer omitted the selected requirement for '${selection.capability}'`
    );
  }
  const allowedPrincipals = new Set(declaration.principals);
  let capabilityLeaves = 0;
  const validate = (requirement: import("./authorization.js").AuthorityRequirement): void => {
    if (requirement.kind === "capability") {
      capabilityLeaves += 1;
      // A declaration for the code family admits both an installed-code origin
      // and the session principal that mediates agent execution.  The
      // preparer expands that family explicitly so the selected requirement
      // can still intersect it with resource/relationship constraints.  A
      // code-only declaration never produces the session leaf in the first
      // place.
      const principalIsInDeclaredFamily =
        allowedPrincipals.has(requirement.principal) ||
        (requirement.principal === "session" && allowedPrincipals.has("code"));
      if (requirement.capability !== selection.capability || !principalIsInDeclaredFamily) {
        throw new ServiceError(
          service,
          method,
          `Authority preparer produced an out-of-contract requirement for '${selection.capability}'`
        );
      }
      return;
    }
    if (requirement.kind === "all" || requirement.kind === "any") {
      for (const child of requirement.requirements) validate(child);
    }
  };
  validate(selection.requirement);
  if (capabilityLeaves === 0) {
    throw new ServiceError(
      service,
      method,
      `Authority preparer produced no capability leaf for '${selection.capability}'`
    );
  }
  return selection.requirement;
}

function deriveAuthorityResource(
  derivation: MethodAuthorityDescriptor["resource"],
  args: unknown[]
): string {
  if (derivation.kind === "literal") return derivation.key;
  let value: unknown = args[derivation.index];
  for (const segment of derivation.path ?? []) {
    if (value === null || typeof value !== "object") {
      throw new Error(`Cannot derive authority resource from argument ${derivation.index}`);
    }
    value = (value as Record<string | number, unknown>)[segment];
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Authority resource must resolve to a string or number`);
  }
  let rendered = String(value);
  if (derivation.transform === "url-origin") {
    const url = new URL(rendered);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Authority URL resource must use http or https");
    }
    rendered = url.origin;
  } else if (derivation.transform === "external-url-scope") {
    const url = new URL(rendered);
    if (url.protocol === "mailto:") rendered = "mailto:";
    else if (url.protocol === "http:" || url.protocol === "https:") rendered = url.origin;
    else throw new Error("Authority external URL must use http, https, or mailto");
  }
  return derivation.prefix ? `${derivation.prefix}${rendered}` : rendered;
}

/**
 * Helper to parse "service.method" format.
 */
export function parseServiceMethod(fullMethod: string): { service: string; method: string } | null {
  const dotIndex = fullMethod.indexOf(".");
  if (dotIndex === -1) {
    return null;
  }
  return {
    service: fullMethod.substring(0, dotIndex),
    method: fullMethod.substring(dotIndex + 1),
  };
}
