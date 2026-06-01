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
    return { principalId: grant.principalId, issuedBy: grant.issuedBy };
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
