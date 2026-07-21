/**
 * ServiceDispatcher - Unified service dispatch for panels and shell.
 *
 * Panels and the shell renderer call main process services
 * like bridge, ai, db, browser, fs. This module provides a single registry
 * and dispatch mechanism that all code paths use.
 */

import { z } from "zod";
import type { PreparedAuthoritySelection, ServiceDefinition } from "./serviceDefinition.js";
import type {
  MethodAuthorityDescriptor,
  MethodSchema,
  PreparedAuthorityRequirement,
} from "./typedServiceClient.js";
import type { CallerKind, CodeIdentityCallerKind } from "./principalKinds.js";
import {
  rpcErrorDataOf,
  rpcErrorKindOf,
  type AuthenticatedCaller,
  type RpcCausalParent,
} from "@vibestudio/rpc";
import type { AgentBinding, UserSubject } from "@vibestudio/identity/types";
import type { AuthorizationContext, AuthorityGrant } from "./authorization.js";
import type {
  ApprovalDecision,
  ApprovalDetailFormat,
  ApprovalOperationDescriptor,
} from "./approvals.js";
import { capabilityPatternCovers } from "./authorityManifest.js";
import {
  bindMethodCapability,
  evaluateAuthority,
  requirementForPrincipals,
} from "./authorization.js";
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
  /** Immutable eval-delegation ceiling sealed into the exact execution recipe. */
  delegations?: readonly import("./authorityManifest.js").EvalAuthorityDelegation[];
}

/**
 * The entity/context/channel scope an `agent`-kind connection is bound to,
 * resolved from its agent credential at auth time. HOST-VERIFIED — stamped in
 * `handleAuth` from the redeemer result only, NEVER from client input (modelled
 * after the host-verified `callerContextId` precedent). Services read
 * `ctx.caller.agentBinding` to enforce scope without trusting client-supplied ids.
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
  /** Entity/context binding for `agent`-kind callers (host-verified; §3.2). */
  agentBinding?: AgentBinding;
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
  agentBinding?: AgentBinding | null,
  subject?: UserSubject | null
): VerifiedCaller {
  return {
    runtime: { id: callerId, kind: callerKind },
    ...(code ? { code } : {}),
    ...(agentBinding ? { agentBinding } : {}),
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

/**
 * Sentinel a service handler returns (via `ctx.deferral.run`) to signal that
 * the call will complete out-of-band: the transport sends a `{deferred,requestId}`
 * ack instead of a response body, and the eventual result is delivered to the
 * caller through `onDeferredResult`. Used for human-gated calls (approvals,
 * credential use) so a hibernatable DO caller need not hold an inbound request open.
 */
export const DEFERRED_RESULT: unique symbol = Symbol.for("vibestudio.rpc.deferredResult");

export interface DeferredResult {
  readonly [DEFERRED_RESULT]: true;
  readonly requestId: string;
}

export function isDeferredResult(value: unknown): value is DeferredResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[DEFERRED_RESULT] === true
  );
}

export interface DeferralApi {
  /**
   * True when this call can complete out-of-band — the caller stamped a
   * `requestId` and is a principal that can receive an inbound `onDeferredResult`
   * (a DO/worker). Handlers must check this before calling `run`.
   */
  readonly canDefer: boolean;
  /**
   * Park the call: run `work` detached and deliver its eventual result (or error)
   * to the caller via `onDeferredResult`. Returns the sentinel the handler must
   * return so the transport sends a deferred ack instead of a body. Reissued or
   * concurrent calls sharing an `idempotencyKey` collapse onto one `work` run.
   */
  run(work: (signal: AbortSignal) => Promise<unknown>): DeferredResult;
}

/**
 * Run `produce` inline, or — when the caller opted into deferral and the call
 * would otherwise block on a human — park it via `ctx.deferral.run` and return
 * the sentinel for the transport to ack. `needsApproval` is the cheap pre-check
 * that decides; when false (e.g. a grant already exists) the fast path runs
 * inline with no extra round-trip. This keeps UX identical for the common case
 * and only changes the hold-open behavior when an approval is actually pending.
 */
export function deferIfNeeded<T>(
  ctx: ServiceContext,
  needsApproval: boolean,
  produce: (signal: AbortSignal) => Promise<T>
): Promise<T> | DeferredResult {
  if (needsApproval && ctx.deferral?.canDefer) {
    return ctx.deferral.run(produce);
  }
  return produce(new AbortController().signal);
}

export type ServiceContext = {
  /** Canonical verified identity. Boundary code constructs this once. */
  caller: VerifiedCaller;
  /** Cancellation owned by the authenticated inbound RPC request. Service
   * handlers pass this through to nested work rather than inventing deadlines. */
  signal?: AbortSignal;
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
  /** Authority-only preparation of a canonical call shape. No handler may run,
   * and exact-dispatch (`once`) permits are intentionally unavailable. */
  evalPreauthorization?: boolean;
  /** Cancellation for a host-only eval preauthorization pass. Authority
   * challenges must bind their waiters to this signal. */
  evalPreauthorizationSignal?: AbortSignal;
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
      /** How invocation code may satisfy this dynamically prepared leaf. */
      acquisition?: import("./typedServiceClient.js").EvalCapabilityAcquisition;
      /** Verified principal on whose behalf a host-mediated operation runs. */
      authorizingCaller?: VerifiedCaller;
      /** Host-derived review copy for a state-dependent canonical resource. */
      challenge?: AuthorityChallengePresentation;
    }): Promise<void>;
    allows(input: {
      capability: string;
      resourceKey: string;
      requirement: import("./authorization.js").AuthorityRequirement;
      acquisition?: import("./typedServiceClient.js").EvalCapabilityAcquisition;
      authorizingCaller?: VerifiedCaller;
      challenge?: AuthorityChallengePresentation;
    }): Promise<boolean>;
  };
  /** Decisions produced by the canonical pre-handler authority challenge
   * adapter, available only for result/audit ergonomics. Handlers never use
   * this map to authorize an effect. */
  authorityDecisions?: Map<string, "once" | "run" | "session" | "version">;
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
  /** Correlation id stamped by the caller; present on deferrable calls. */
  requestId?: string;
  /** Dedup key stamped by the caller, when provided. */
  idempotencyKey?: string;
  /**
   * Out-of-band completion controller, present only when the caller can receive
   * a deferred reply. Handlers gate on `deferral?.canDefer` before deferring.
   */
  deferral?: DeferralApi;
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
  details?: readonly { label: string; value: string; format?: ApprovalDetailFormat }[];
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
  constructor(service: string, method: string, message?: string, code = "EACCES") {
    super(
      service,
      method,
      message ?? `Authority denied for service '${service}.${method}'`,
      code,
      undefined,
      "access"
    );
    this.name = "ServiceAccessError";
  }
}

/**
 * Service dispatcher — all services registered via registerService().
 */
export class ServiceDispatcher {
  private handlers = new Map<string, ServiceHandler>();
  private definitions = new Map<string, ServiceDefinition>();
  private initialized = false;
  private authorityResolver?: (input: {
    ctx: ServiceContext;
    caller: VerifiedCaller;
    service: string;
    method: string;
    capability: string;
    resourceKey: string;
    requirement: import("./authorization.js").AuthorityRequirement;
    acquisition?: import("./typedServiceClient.js").EvalCapabilityAcquisition;
    challenge?: AuthorityChallengePresentation;
    preauthorization?: boolean;
    sensitivity?: import("./serviceAuthority.js").MethodSensitivity;
  }) =>
    | {
        context: AuthorizationContext;
        grants: readonly AuthorityGrant[];
        effectiveCaller?: VerifiedCaller;
        authorizingCaller?: VerifiedCaller;
        contextId?: string;
        readOnly?: boolean;
        decision?: "once" | "run" | "session" | "version";
      }
    | Promise<{
        context: AuthorizationContext;
        grants: readonly AuthorityGrant[];
        effectiveCaller?: VerifiedCaller;
        authorizingCaller?: VerifiedCaller;
        contextId?: string;
        readOnly?: boolean;
        decision?: "once" | "run" | "session" | "version";
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
      acquisition?: import("./typedServiceClient.js").EvalCapabilityAcquisition;
      challenge?: AuthorityChallengePresentation;
      preauthorization?: boolean;
      sensitivity?: import("./serviceAuthority.js").MethodSensitivity;
    }) =>
      | {
          context: AuthorizationContext;
          grants: readonly AuthorityGrant[];
          effectiveCaller?: VerifiedCaller;
          authorizingCaller?: VerifiedCaller;
          contextId?: string;
          readOnly?: boolean;
          decision?: "once" | "run" | "session" | "version";
        }
      | Promise<{
          context: AuthorizationContext;
          grants: readonly AuthorityGrant[];
          effectiveCaller?: VerifiedCaller;
          authorizingCaller?: VerifiedCaller;
          contextId?: string;
          readOnly?: boolean;
          decision?: "once" | "run" | "session" | "version";
        }>
  ): void {
    this.authorityResolver = resolver;
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
        const capabilities = new Set(leaves.map((leaf) => leaf.capability));
        if (capabilities.size !== leaves.length) {
          throw new Error(
            `Service method ${def.name}.${method} declares duplicate prepared capability leaves`
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

    await this.assertAuthority(ctx, service, method, args);

    try {
      const result = await handler(ctx, method, args);
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
   * Validate and resolve a call's exact canonical authority leaves without
   * invoking its handler. Eval start uses this for up-front preauthorization;
   * eventual dispatch validates and evaluates the call again from live state.
   */
  async preauthorize(
    ctx: ServiceContext,
    service: string,
    method: string,
    args: unknown[]
  ): Promise<void> {
    if (!ctx.evalInvocation || ctx.evalPreauthorization !== true) {
      throw new ServiceError(service, method, "Preauthorization requires a live eval invocation");
    }
    const def = this.definitions.get(service);
    const methodDef = def?.methods[method];
    if (!def || !methodDef) throw new ServiceError(service, method, "Unknown service method");
    const normalized = normalizeServiceArgs(args, methodDef.args);
    const parsed = methodDef.args.safeParse(normalized);
    if (!parsed.success) {
      throw new ServiceError(
        service,
        method,
        `Invalid args: ${formatArgsValidationError(parsed.error)}${formatUsageHint(service, method, methodDef)}`
      );
    }
    await this.assertAuthority(ctx, service, method, normalized);
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
    const capabilityName = `service:${service}.${method}`;
    const descriptor =
      "requirement" in declaration
        ? declaration
        : {
            requirement: requirementForPrincipals(declaration.principals, capabilityName),
            resource: { kind: "literal" as const, key: capabilityName },
          };
    const resourceKey = deriveAuthorityResource(descriptor.resource, args);
    ctx.authority = {
      assert: ({
        capability,
        resourceKey: dynamicResource,
        requirement,
        acquisition,
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
          acquisition,
          authorizingCaller,
          challenge
        ),
      allows: async ({
        capability,
        resourceKey: dynamicResource,
        requirement,
        acquisition,
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
            acquisition,
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
    await this.enforceRequirement(
      ctx,
      service,
      method,
      capabilityName,
      resourceKey,
      bindMethodCapability(descriptor.requirement, capabilityName),
      methodDef,
      "evalAcquisition" in descriptor ? descriptor.evalAcquisition : undefined
    );
    for (const additional of "additional" in descriptor ? (descriptor.additional ?? []) : []) {
      if (
        additional.when &&
        !additional.when.origins.includes(ctx.authorization?.authorizingOrigin.kind ?? "code")
      ) {
        continue;
      }
      const additionalResourceKey = deriveAuthorityResource(additional.resource, args);
      await this.enforceRequirement(
        ctx,
        service,
        method,
        additional.capability,
        additionalResourceKey,
        bindMethodCapability(additional.requirement, additional.capability),
        methodDef,
        additional.evalAcquisition
      );
    }
    if ("prepared" in descriptor && descriptor.prepared) {
      const prepare = serviceDef.authorityPreparation?.[descriptor.prepared.resolver];
      if (!prepare) {
        throw new ServiceError(
          service,
          method,
          `Authority preparer '${descriptor.prepared.resolver}' is unavailable`
        );
      }
      const selected = await prepare(ctx, args);
      const seen = new Set<string>();
      for (const selection of selected) {
        const matchingLeaves = descriptor.prepared.leaves.filter((leaf) =>
          capabilityPatternCovers(leaf.capability, selection.capability)
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
        const requirement = resolvePreparedRequirement(
          service,
          method,
          leaf.requirement,
          selection
        );
        await this.enforceRequirement(
          ctx,
          service,
          method,
          selection.capability,
          selection.resourceKey,
          bindMethodCapability(requirement, selection.capability),
          methodDef,
          leaf.evalAcquisition,
          selection.authorizingCaller,
          selection.challenge
        );
      }
    }

    // Read-only containment: a caller may request a mode in which only methods
    // explicitly declared `access.sensitivity === "read"` may run. Default-deny —
    // an unmarked method is treated as mutating. This is the load-bearing
    // enforcement point (every dispatch path funnels here), so the containment
    // can't be bypassed.
    if (ctx.readOnly && methodDef.access?.sensitivity !== "read") {
      throw new ServiceError(
        service,
        method,
        `Blocked in read-only mode: '${service}.${method}' is not declared read-only ` +
          `(sensitivity ${methodDef?.access?.sensitivity ?? "unknown"}). A read-only caller may ` +
          `only invoke methods declaring access.sensitivity === "read".`,
        "EVAL_READ_ONLY"
      );
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
    acquisition?: import("./typedServiceClient.js").EvalCapabilityAcquisition,
    authorizingCaller?: VerifiedCaller,
    challenge?: AuthorityChallengePresentation
  ): Promise<void> {
    const resolver = this.authorityResolver;
    if (!resolver) {
      throw new ServiceError(service, method, "Compositional authority resolver is unavailable");
    }
    const resolved = await resolver({
      ctx,
      caller: authorizingCaller ?? ctx.caller,
      service,
      method,
      capability,
      resourceKey,
      requirement,
      ...(acquisition ? { acquisition } : {}),
      ...(challenge ? { challenge } : {}),
      ...(ctx.evalPreauthorization ? { preauthorization: true } : {}),
      ...(methodDef.access?.sensitivity ? { sensitivity: methodDef.access.sensitivity } : {}),
    });
    ctx.authorization = resolved.context;
    if (ctx.evalInvocation && resolved.contextId) {
      ctx.evalInvocation.contextId = resolved.contextId;
    }
    if (resolved.authorizingCaller) {
      ctx.authorizingCaller = resolved.authorizingCaller;
    }
    // Evaluated code is neither its initiating user/agent nor the EvalDO kernel
    // that transports its calls. Once the invocation coordinator authenticates
    // the opaque lease it supplies a host-attested code caller for domain
    // policy. The root initiator remains separately available for prompts and
    // user-facing attribution through `authorizingCaller`.
    if (resolved.effectiveCaller) ctx.caller = resolved.effectiveCaller;
    if (resolved.readOnly === true) ctx.readOnly = true;
    if (resolved.decision) {
      (ctx.authorityDecisions ??= new Map()).set(capability, resolved.decision);
    }
    const decision = evaluateAuthority({
      context: resolved.context,
      requirement,
      resourceKey,
      grants: resolved.grants,
    });
    if (!decision.allowed) {
      const evalCode = ctx.evalInvocation
        ? decision.code === "relationship" || decision.code === "session"
          ? "EVAL_RELATIONSHIP_FAILED"
          : decision.code === "delegation"
            ? "EVAL_CAPABILITY_NOT_DELEGATED"
            : decision.code === "denied"
              ? "EVAL_APPROVAL_DENIED"
              : decision.code === "missing-grant"
                ? "EVAL_APPROVAL_REQUIRED"
                : decision.code === "not-requested"
                  ? "EVAL_AUTHORITY_CONSTRAINT"
                  : "EVAL_CAPABILITY_CLOSED"
        : "EACCES";
      throw new ServiceAccessError(
        service,
        method,
        `${decision.reason} (${decision.code})${formatAccessHint(methodDef)}`,
        evalCode
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
      if (
        requirement.capability !== selection.capability ||
        !allowedPrincipals.has(requirement.principal)
      ) {
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
