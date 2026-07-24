import type {
  AuthorizationContext,
  AuthorityFailureInfo,
  AuthorityGrant,
  AuthorityRequirement,
  PrincipalKind,
  RpcAuthorityEffect,
} from "@vibestudio/rpc";
import type { DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import {
  authorityFailureForDecision,
  bindMethodCapability,
  evaluateAuthority,
  requirementForPrincipals,
} from "./authorization.js";

export interface ResolvedDirectRpcAuthority {
  tier: "open" | "gated" | "critical";
  sensitivity: "read" | "write" | "admin" | "destructive";
  effect: RpcAuthorityEffect;
  codeOnly?: boolean;
  principals?: readonly PrincipalKind[];
  requires?: AuthorityRequirement;
}

export interface EventIntakeRule {
  /** Non-empty topic family. Empty and wildcard catch-alls are invalid. */
  topicPrefix: string;
  tier: "open" | "gated" | "critical";
  sensitivity: "read" | "write" | "admin" | "destructive";
  effect: RpcAuthorityEffect;
  codeOnly?: boolean;
  principals?: readonly PrincipalKind[];
  requires?: AuthorityRequirement | ((self: object) => AuthorityRequirement);
}

/** Resolve one class-owned intake declaration. No match is default-deny. */
export function eventIntakeAuthority(
  self: object,
  topic: string
): ResolvedDirectRpcAuthority | null {
  const constructor = self.constructor as { eventIntake?: unknown };
  const rules = constructor.eventIntake;
  if (rules === undefined) return null;
  if (!Array.isArray(rules)) throw new Error("eventIntake must be an array");
  for (const candidate of rules) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("eventIntake entries must be objects");
    }
    const rule = candidate as EventIntakeRule;
    assertEventIntakeRule(rule);
    if (!topic.startsWith(rule.topicPrefix)) continue;
    return {
      tier: rule.tier,
      sensitivity: rule.sensitivity,
      effect: rule.effect,
      ...(rule.codeOnly ? { codeOnly: true } : {}),
      ...(rule.principals ? { principals: rule.principals } : {}),
      ...(rule.requires
        ? { requires: typeof rule.requires === "function" ? rule.requires(self) : rule.requires }
        : {}),
    };
  }
  return null;
}

export function assertEventIntakeRules(target: { eventIntake?: unknown }): void {
  if (target.eventIntake === undefined) return;
  if (!Array.isArray(target.eventIntake)) throw new Error("eventIntake must be an array");
  for (const rule of target.eventIntake) assertEventIntakeRule(rule as EventIntakeRule);
}

function assertEventIntakeRule(rule: EventIntakeRule): void {
  if (
    typeof rule.topicPrefix !== "string" ||
    rule.topicPrefix.length === 0 ||
    rule.topicPrefix.trim() !== rule.topicPrefix ||
    rule.topicPrefix.includes("*")
  ) {
    throw new Error("eventIntake topicPrefix must be non-empty, trimmed, and cannot contain '*'");
  }
  if (!(["open", "gated", "critical"] as const).includes(rule.tier)) {
    throw new Error(`eventIntake ${rule.topicPrefix} has an invalid tier`);
  }
  if (!(["read", "write", "admin", "destructive"] as const).includes(rule.sensitivity)) {
    throw new Error(`eventIntake ${rule.topicPrefix} has an invalid sensitivity`);
  }
  if ((rule.principals === undefined) === (rule.requires === undefined)) {
    throw new Error(
      `eventIntake ${rule.topicPrefix} must declare exactly one of principals or requires`
    );
  }
  if (rule.principals && rule.principals.length === 0) {
    throw new Error(`eventIntake ${rule.topicPrefix} has no principals`);
  }
}

export interface DirectRpcCheckInput {
  kind: "call" | "event";
  method: string;
  eventTopic?: string;
  caller: { authorization?: DirectAuthorityAttestation } | null;
  attestation: DirectAuthorityAttestation | null;
  declaration: ResolvedDirectRpcAuthority | null;
  audience: string;
  resourceKey: string;
  capability: string;
  now?: number;
  invocationDigest?: string;
}

export interface DirectRpcDenial {
  code: "EACCES" | "EVAL_READ_ONLY";
  reason: string;
  failure: AuthorityFailureInfo;
}

export interface HostControlDenial {
  code: "EACCES";
  reason: string;
  failure: AuthorityFailureInfo;
}

/** Pure declaration + fresh-attestation check shared by both DO bases. */
export function directRpcDenial(input: DirectRpcCheckInput): DirectRpcDenial | null {
  const { method, declaration, attestation } = input;
  if (!method) {
    const reason = "direct RPC method is required";
    return {
      code: "EACCES",
      reason,
      failure: directRpcInvalidAttestationFailure(reason),
    };
  }
  if (!declaration) {
    const reason = `${method}: refused — no direct authority declaration (RPC is default-deny)`;
    return {
      code: "EACCES",
      reason,
      failure: {
        reasonCode: "receiver-undeclared",
        reason,
        remediation: {
          kind: "declare-rpc-receiver",
          message:
            "The receiver owner must add a reviewed @rpc authority declaration; caller approval cannot repair an undeclared receiver.",
        },
      },
    };
  }
  if (!attestation) {
    const reason = `${method}: fresh host authority attestation is required`;
    return {
      code: "EACCES",
      reason,
      failure: {
        reasonCode: "attestation-required",
        reason,
        remediation: {
          kind: "retry-through-host",
          message: "Retry through the host-mediated RPC route so it can issue a fresh attestation.",
        },
      },
    };
  }
  const now = input.now ?? Date.now();
  if (
    attestation.audience !== input.audience ||
    attestation.method !== method ||
    attestation.resourceKey !== input.resourceKey
  ) {
    const reason =
      `${method}: host authority attestation is bound to another invocation ` +
      `(expected audience=${input.audience} method=${method} resource=${input.resourceKey}; ` +
      `received audience=${attestation.audience} method=${attestation.method} resource=${attestation.resourceKey})`;
    return {
      code: "EACCES",
      reason,
      failure: directRpcInvalidAttestationFailure(reason),
    };
  }
  if (!isAttestationNonce(attestation.nonce)) {
    const reason = `${method}: host authority attestation nonce is malformed`;
    return { code: "EACCES", reason, failure: directRpcInvalidAttestationFailure(reason) };
  }
  if (attestation.issuedAt > now || attestation.expiresAt <= now) {
    const reason =
      `${method}: host authority attestation was stale at trusted dispatch ingress ` +
      `(issuedAt=${attestation.issuedAt} expiresAt=${attestation.expiresAt} acceptedAt=${now})`;
    return {
      code: "EACCES",
      reason,
      failure: directRpcInvalidAttestationFailure(reason),
    };
  }
  if (attestation.readOnly === true && declaration.sensitivity !== "read") {
    const reason = `${method}: EVAL_READ_ONLY — direct method is ${declaration.sensitivity}`;
    return {
      code: "EVAL_READ_ONLY",
      reason,
      failure: {
        reasonCode: "eval-read-only",
        reason,
        remediation: {
          kind: "use-writable-session",
          message:
            "Run this write through an admitted writable task session; read-only evals cannot widen themselves.",
        },
      },
    };
  }
  const declaredCapability =
    declaration.effect.kind === "semantic" ? declaration.effect.capability : input.capability;
  const effectMatches =
    attestation.effect.kind === declaration.effect.kind &&
    (declaration.effect.kind !== "semantic" ||
      (attestation.effect.kind === "semantic" &&
        attestation.effect.capability === declaration.effect.capability));
  if (
    !effectMatches ||
    (declaration.effect.kind === "semantic" && attestation.capability !== declaredCapability) ||
    (declaration.effect.kind === "workspace-service" &&
      (attestation.capability !== attestation.targetCapability ||
        !(attestation.targetCapability ?? "").startsWith("workspace-service:") ||
        !attestation.targetRequirement)) ||
    (declaration.effect.kind === "runtime-intrinsic" && declaration.tier !== "open")
  ) {
    const reason = `${method}: attested effect does not match the receiver declaration`;
    return {
      code: "EACCES",
      reason,
      failure: directRpcInvalidAttestationFailure(reason),
    };
  }
  const methodRequirement = declaration.requires
    ? bindMethodCapability(declaration.requires, declaredCapability)
    : requirementForPrincipals(declaration.principals ?? [], declaredCapability, {
        codeOnly: declaration.codeOnly,
      });
  const invocationDigest = input.invocationDigest ?? attestation.invocationDigest;
  const methodDecision = evaluateAuthority({
    context: attestation.context,
    requirement: methodRequirement,
    resourceKey: input.resourceKey,
    grants: attestation.grants,
    locks: attestation.locks,
    now,
    tier: declaration.tier,
    invocationDigest,
  });
  if (!methodDecision.allowed) {
    return {
      code: "EACCES",
      reason: `${method}: ${methodDecision.reason} (${methodDecision.code})`,
      failure: authorityFailureForDecision(methodDecision, {
        capability: declaredCapability,
        resourceKey: input.resourceKey,
        tier: declaration.tier,
      }),
    };
  }
  if (attestation.targetRequirement) {
    if (!attestation.targetTier || !attestation.targetCapability) {
      const reason = `${method}: target authority has no reviewed tier`;
      return {
        code: "EACCES",
        reason,
        failure: directRpcInvalidAttestationFailure(reason),
      };
    }
    const targetDecision = evaluateAuthority({
      context: attestation.context,
      requirement: bindMethodCapability(
        attestation.targetRequirement,
        attestation.targetCapability
      ),
      resourceKey: input.resourceKey,
      grants: attestation.grants,
      locks: attestation.locks,
      now,
      tier: attestation.targetTier,
      invocationDigest,
    });
    if (!targetDecision.allowed) {
      return {
        code: "EACCES",
        reason: `${method}: ${targetDecision.reason} (${targetDecision.code})`,
        failure: authorityFailureForDecision(targetDecision, {
          capability: attestation.targetCapability,
          resourceKey: input.resourceKey,
          tier: attestation.targetTier,
        }),
      };
    }
  }
  return null;
}

export function directRpcInvalidAttestationFailure(reason: string): AuthorityFailureInfo {
  return {
    reasonCode: "attestation-invalid",
    reason,
    remediation: {
      kind: "retry-through-host",
      message:
        "Discard this attestation and retry through the host-mediated RPC route; do not replay or modify it.",
    },
  };
}

/**
 * Per-receiver replay protection. Durable bases persist the accepted nonce in
 * their own storage; workspace bases may use this bounded in-memory form only
 * for actors whose isolate lifetime is the attestation lifetime.
 */
export class DirectRpcNonceWindow {
  readonly #accepted = new Map<string, number>();

  consume(nonce: string, expiresAt: number, now = Date.now()): boolean {
    for (const [key, expiry] of this.#accepted) if (expiry <= now) this.#accepted.delete(key);
    if (!isAttestationNonce(nonce) || expiresAt <= now || this.#accepted.has(nonce)) return false;
    this.#accepted.set(nonce, expiresAt);
    return true;
  }
}

export interface DirectRpcNonceStorage {
  exec(
    query: string,
    ...bindings: unknown[]
  ): {
    toArray(): Record<string, unknown>[];
  };
  transactionSync<T>(callback: () => T): T;
}

/**
 * Receiver-owned, durable replay ledger.
 *
 * Durable Objects may be evicted at any point, so the replay boundary must
 * survive reconstruction of the JavaScript instance. The framework table is
 * deliberately separate from each product object's schema and is created
 * lazily after that schema is ready.
 */
export class DurableDirectRpcNonceLedger {
  #ready = false;

  constructor(private readonly storage: DirectRpcNonceStorage) {}

  consume(nonce: string, expiresAt: number, now = Date.now()): boolean {
    if (!isAttestationNonce(nonce) || expiresAt <= now) return false;
    this.ensureReady();
    return this.storage.transactionSync(() => {
      this.storage.exec(`DELETE FROM _vibestudio_direct_rpc_nonces WHERE expires_at <= ?`, now);
      const existing = this.storage
        .exec(`SELECT nonce FROM _vibestudio_direct_rpc_nonces WHERE nonce = ?`, nonce)
        .toArray();
      if (existing.length > 0) return false;
      this.storage.exec(
        `INSERT INTO _vibestudio_direct_rpc_nonces(nonce, expires_at) VALUES (?, ?)`,
        nonce,
        expiresAt
      );
      return true;
    });
  }

  private ensureReady(): void {
    if (this.#ready) return;
    this.storage.exec(
      `CREATE TABLE IF NOT EXISTS _vibestudio_direct_rpc_nonces (
        nonce TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID`
    );
    this.#ready = true;
  }
}

export function isAttestationNonce(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function hostControlDenial(input: {
  method: string;
  attestation: DirectAuthorityAttestation | null;
  audience: string;
  now?: number;
}): HostControlDenial | null {
  const attestation = input.attestation;
  const now = input.now ?? Date.now();
  if (!attestation) {
    const reason = `${input.method}: host attestation required`;
    return {
      code: "EACCES",
      reason,
      failure: directRpcInvalidAttestationFailure(reason),
    };
  }
  if (
    attestation.method !== input.method ||
    attestation.audience !== input.audience ||
    attestation.resourceKey !== input.audience ||
    attestation.issuedAt > now ||
    attestation.expiresAt <= now ||
    attestation.context.authorizingOrigin.kind !== "host" ||
    attestation.context.host === null
  ) {
    const reason = `${input.method}: valid host-bound attestation required`;
    return {
      code: "EACCES",
      reason,
      failure: directRpcInvalidAttestationFailure(reason),
    };
  }
  return null;
}

export function directRpcContext(input: DirectRpcCheckInput): AuthorizationContext | null {
  return input.attestation?.context ?? null;
}

export function directRpcGrants(input: DirectRpcCheckInput): readonly AuthorityGrant[] {
  return input.attestation?.grants ?? [];
}
