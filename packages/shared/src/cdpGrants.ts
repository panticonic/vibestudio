import { randomBytes } from "node:crypto";

export interface CdpGrant {
  token: string;
  principalId: string;
  targetId: string;
  expiresAt: number;
}

export class CdpGrantService {
  private readonly grants = new Map<string, CdpGrant>();
  private readonly gcTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.gcTimer = setInterval(() => this.gcExpired(), 30_000);
    this.gcTimer.unref?.();
  }

  grant(
    principalId: string,
    targetId: string,
    ttlMs: number = 60_000
  ): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + ttlMs;
    this.grants.set(token, { token, principalId, targetId, expiresAt });
    return { token, expiresAt };
  }

  redeem(token: string, targetId: string): { principalId: string } | null {
    const grant = this.grants.get(token);
    if (!grant) return null;
    this.grants.delete(token);
    if (grant.expiresAt <= Date.now()) return null;
    if (grant.targetId !== targetId) return null;
    return { principalId: grant.principalId };
  }

  stop(): void {
    clearInterval(this.gcTimer);
    this.grants.clear();
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token);
    }
  }
}
