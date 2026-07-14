import * as fs from "node:fs";
import { stateLayout } from "../stateLayout.js";

import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import { writeJsonFileAtomic } from "../hostCore/atomicFile.js";
import type {
  ApprovalPrincipal,
  UserlandApprovalGrantScope,
  UserlandApprovalGrant,
  UserlandApprovalIssuer,
  UserlandApprovalSubject,
} from "@vibestudio/shared/approvals";
import { parseSha256 } from "@vibestudio/shared/execution/identity";

interface UserlandApprovalGrantFile {
  grants: UserlandApprovalGrant[];
}

export class UserlandApprovalGrantStore {
  private readonly filePath: string;
  private persistent: UserlandApprovalGrantFile = { grants: [] };
  private readonly sessionGrants: UserlandApprovalGrant[] = [];

  constructor(opts: { statePath: string }) {
    this.filePath = stateLayout(opts.statePath).userlandApprovalGrantsFile;
    this.load();
  }

  /**
   * Look up a grant for a (principal, issuer, subject) triple. When `issuer`
   * is omitted, defaults to the principal — this preserves the direct
   * panel/worker call shape, where the issuer is the principal itself.
   */
  lookup(
    principal: ApprovalPrincipal,
    subjectId: string,
    issuer?: UserlandApprovalIssuer
  ): UserlandApprovalGrant | null {
    const matches = (grant: UserlandApprovalGrant): boolean =>
      grant.subject.id === subjectId &&
      grantAppliesToPrincipal(grant, principal) &&
      issuerMatches(grant, principal, issuer);
    return this.sessionGrants.find(matches) ?? this.persistent.grants.find(matches) ?? null;
  }

  // `record`/`revoke` are `async` even though `save()` is sync today: the
  // service awaits them, and keeping the API async lets us swap in
  // temp-file+rename later without touching callers.
  async record(
    principal: ApprovalPrincipal,
    subject: UserlandApprovalSubject,
    choice: string,
    now = Date.now(),
    issuer?: UserlandApprovalIssuer,
    scope: UserlandApprovalGrantScope = "caller"
  ): Promise<void> {
    if (scope === "version") {
      if (!principal.repoPath) throw new Error("Version approval requires a source repository");
      parseSha256(principal.executionDigest ?? "", "userland approval execution digest");
    }
    const next: UserlandApprovalGrant = {
      principal: {
        callerId: principal.callerId,
        callerKind: principal.callerKind,
        repoPath: principal.repoPath,
        executionDigest: principal.executionDigest,
      },
      ...(issuer ? { issuer } : {}),
      subject,
      choice,
      grantedAt: now,
      scope,
    };
    const key = keyFor(next.principal, next.issuer, next.subject.id, scope);
    const current = scope === "session" ? this.sessionGrants : this.persistent.grants;
    const filtered = current.filter(
      (grant) =>
        keyFor(grant.principal, grant.issuer, grant.subject.id, grant.scope ?? "caller") !== key
    );
    if (scope === "session") {
      this.sessionGrants.splice(0, this.sessionGrants.length, ...filtered, next);
      return;
    }
    this.persistent.grants = [...filtered, next];
    this.save();
  }

  async revoke(
    principal: ApprovalPrincipal,
    subjectId: string,
    issuer?: UserlandApprovalIssuer
  ): Promise<boolean> {
    const shouldKeep = (grant: UserlandApprovalGrant): boolean =>
      !(
        grant.subject.id === subjectId &&
        grantAppliesToPrincipal(grant, principal) &&
        issuerMatches(grant, principal, issuer)
      );
    const persistentBefore = this.persistent.grants.length;
    const sessionBefore = this.sessionGrants.length;
    this.persistent.grants = this.persistent.grants.filter(shouldKeep);
    this.sessionGrants.splice(
      0,
      this.sessionGrants.length,
      ...this.sessionGrants.filter(shouldKeep)
    );
    const persistentRemoved = this.persistent.grants.length !== persistentBefore;
    const sessionRemoved = this.sessionGrants.length !== sessionBefore;
    if (persistentRemoved) this.save();
    return persistentRemoved || sessionRemoved;
  }

  list(principal: ApprovalPrincipal, issuer?: UserlandApprovalIssuer): UserlandApprovalGrant[] {
    const matches = (grant: UserlandApprovalGrant): boolean =>
      grantAppliesToPrincipal(grant, principal) && issuerMatches(grant, principal, issuer);
    return [...this.sessionGrants.filter(matches), ...this.persistent.grants.filter(matches)];
  }

  /** Administrative review surface: durable grants across all principals. */
  listPersistent(): UserlandApprovalGrant[] {
    return this.persistent.grants.map((grant) => ({
      ...grant,
      principal: { ...grant.principal },
      subject: { ...grant.subject },
      ...(grant.issuer ? { issuer: { ...grant.issuer } } : {}),
    }));
  }

  revokePersistent(id: string): boolean {
    const before = this.persistent.grants.length;
    this.persistent.grants = this.persistent.grants.filter(
      (grant) => userlandApprovalGrantId(grant) !== id
    );
    if (this.persistent.grants.length === before) return false;
    this.save();
    return true;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8")
      ) as UserlandApprovalGrantFile;
      this.persistent = {
        grants: Array.isArray(parsed.grants) ? parsed.grants.filter(isGrant) : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[UserlandApprovalGrantStore] Failed to load grants; starting empty:", err);
      }
      this.persistent = { grants: [] };
    }
  }

  private save(): void {
    writeJsonFileAtomic(this.filePath, this.persistent);
  }
}

export function userlandApprovalGrantId(grant: UserlandApprovalGrant): string {
  return keyFor(grant.principal, grant.issuer, grant.subject.id, grant.scope ?? "caller");
}

export function keyFor(
  principal: UserlandApprovalGrant["principal"],
  issuer: UserlandApprovalIssuer | undefined,
  subjectId: string,
  scope: UserlandApprovalGrantScope = "caller"
): string {
  return canonicalKey([
    "userland-grant",
    scope,
    scope === "version" ? (principal.repoPath ?? "") : principal.callerId,
    scope === "version" ? (principal.executionDigest ?? "") : "",
    issuer?.kind ?? "code",
    issuer?.id ?? (scope === "version" ? (principal.repoPath ?? "") : principal.callerId),
    subjectId,
  ]);
}

function grantAppliesToPrincipal(
  grant: UserlandApprovalGrant,
  principal: ApprovalPrincipal
): boolean {
  const scope = grant.scope ?? "caller";
  if (scope === "version") {
    return (
      grant.principal.repoPath === principal.repoPath &&
      grant.principal.executionDigest === principal.executionDigest
    );
  }
  return grant.principal.callerId === principal.callerId;
}

function issuerMatches(
  grant: UserlandApprovalGrant,
  principal: ApprovalPrincipal,
  issuer?: UserlandApprovalIssuer
): boolean {
  if (!issuer) return grant.issuer === undefined;
  return grant.issuer?.kind === issuer.kind && grant.issuer.id === issuer.id;
}

function isGrant(value: unknown): value is UserlandApprovalGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Partial<UserlandApprovalGrant>;
  if (
    grant.issuer !== undefined &&
    (typeof grant.issuer !== "object" ||
      grant.issuer === null ||
      typeof (grant.issuer as UserlandApprovalIssuer).id !== "string" ||
      !["panel", "app", "worker", "do", "extension"].includes(
        (grant.issuer as UserlandApprovalIssuer).kind
      ))
  ) {
    return false;
  }
  return (
    typeof grant.choice === "string" &&
    typeof grant.grantedAt === "number" &&
    !!grant.principal &&
    typeof grant.principal.callerId === "string" &&
    (grant.principal.callerKind === "panel" ||
      grant.principal.callerKind === "app" ||
      grant.principal.callerKind === "worker" ||
      grant.principal.callerKind === "do") &&
    (grant.scope === undefined ||
      grant.scope === "caller" ||
      grant.scope === "session" ||
      grant.scope === "version") &&
    (grant.scope !== "version" ||
      (typeof grant.principal.repoPath === "string" &&
        typeof grant.principal.executionDigest === "string" &&
        isExactDigest(grant.principal.executionDigest))) &&
    !!grant.subject &&
    typeof grant.subject.id === "string" &&
    (grant.subject.label === undefined || typeof grant.subject.label === "string")
  );
}

function isExactDigest(value: string): boolean {
  try {
    parseSha256(value, "userland approval execution digest");
    return true;
  } catch {
    return false;
  }
}
