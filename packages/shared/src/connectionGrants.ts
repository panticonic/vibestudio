import { randomBytes } from "node:crypto";
import { callerKindForPrincipalKind } from "./principalKinds.js";
import type { EntityCache } from "./runtime/entityCache.js";
import type { CallerKind } from "./serviceDispatcher.js";

export interface ConnectionGrant {
  token: string;
  principalId: string;
  issuedBy: string;
  expiresAt: number;
  redeemed?: boolean;
}

export interface ConnectionGrantValidation {
  principalId: string;
  principalKind: CallerKind;
  issuedBy: string;
}

export class ConnectionGrantService {
  private readonly entityCache: EntityCache;
  private readonly grants = new Map<string, ConnectionGrant>();
  private readonly gcTimer: ReturnType<typeof setInterval>;

  /**
   * A redeemed grant stays valid until its principal is revoked (the redemption
   * TTL is only the deadline to PRESENT it) — but a long-lived, frequently
   * reconnecting principal mints + redeems a fresh grant on every reconnect, so
   * without a bound the redeemed grants for one principal accumulate without
   * limit. Keep at most this many redeemed grants per principal (newest wins);
   * a reconnect supersedes the prior connection, so evicting the oldest is safe.
   * Generous enough that a legitimate multi-connection principal never hits it.
   */
  private static readonly MAX_REDEEMED_GRANTS_PER_PRINCIPAL = 16;

  constructor(deps: { entityCache: EntityCache }) {
    this.entityCache = deps.entityCache;
    this.gcTimer = setInterval(() => this.gcExpired(), 30_000);
    this.gcTimer.unref?.();
  }

  grant(
    principalId: string,
    issuedBy: string,
    ttlMs: number = 60_000
  ): { token: string; expiresAt: number } {
    if (!this.entityCache.resolveActive(principalId)) {
      throw new Error(`Cannot grant connection for unregistered principal: ${principalId}`);
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + ttlMs;
    this.grants.set(token, { token, principalId, issuedBy, expiresAt });
    return { token, expiresAt };
  }

  redeem(token: string): { principalId: string; issuedBy: string } | null {
    const grant = this.grants.get(token);
    if (!grant) return null;
    if (grant.redeemed) return null;
    if (grant.expiresAt <= Date.now()) {
      this.grants.delete(token);
      return null;
    }
    const record = this.entityCache.resolveActive(grant.principalId);
    if (!record) {
      this.grants.delete(token);
      return null;
    }
    try {
      callerKindForPrincipalKind(record.kind);
    } catch {
      this.grants.delete(token);
      return null;
    }
    grant.redeemed = true;
    this.pruneRedeemedForPrincipal(grant.principalId);
    return { principalId: grant.principalId, issuedBy: grant.issuedBy };
  }

  /**
   * Bound the redeemed grants held for one principal. Map iteration is insertion
   * order, so the leading entries are the oldest; evict them until the principal
   * is within the cap. The just-redeemed grant is always the newest, so it is
   * never the one evicted here. Does not touch other principals or unredeemed
   * grants (those expire via gcExpired), and leaves revokeForPrincipal intact.
   */
  private pruneRedeemedForPrincipal(principalId: string): void {
    const redeemedTokens: string[] = [];
    for (const [token, grant] of this.grants) {
      if (grant.redeemed && grant.principalId === principalId) redeemedTokens.push(token);
    }
    const excess =
      redeemedTokens.length - ConnectionGrantService.MAX_REDEEMED_GRANTS_PER_PRINCIPAL;
    for (let i = 0; i < excess; i++) this.grants.delete(redeemedTokens[i]!);
  }

  validate(token: string): ConnectionGrantValidation | null {
    const grant = this.grants.get(token);
    if (!grant) return null;
    if (!grant.redeemed && grant.expiresAt <= Date.now()) {
      this.grants.delete(token);
      return null;
    }
    const record = this.entityCache.resolveActive(grant.principalId);
    if (!record) {
      this.grants.delete(token);
      return null;
    }
    let principalKind: CallerKind;
    try {
      principalKind = callerKindForPrincipalKind(record.kind);
    } catch {
      this.grants.delete(token);
      return null;
    }
    return {
      principalId: grant.principalId,
      principalKind,
      issuedBy: grant.issuedBy,
    };
  }

  revokeForPrincipal(principalId: string): number {
    let revoked = 0;
    for (const [token, grant] of this.grants) {
      if (grant.principalId === principalId) {
        this.grants.delete(token);
        revoked++;
      }
    }
    return revoked;
  }

  stop(): void {
    clearInterval(this.gcTimer);
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [token, grant] of this.grants) {
      if (!grant.redeemed && grant.expiresAt <= now) this.grants.delete(token);
    }
  }
}
