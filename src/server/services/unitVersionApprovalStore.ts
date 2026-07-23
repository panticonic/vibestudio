import * as fs from "node:fs";
import * as path from "node:path";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import { writeFileAtomicSync } from "../../atomicFile.js";
import { stateLayout } from "../stateLayout.js";

interface ApprovedUnitVersion {
  repoPath: string;
  effectiveVersion: string;
  authorityDigest: string;
  approvedAt: number;
}

interface ApprovedUnitVersionFile {
  schemaVersion: 1;
  approvals: ApprovedUnitVersion[];
}

export interface UnitVersionApprovalIdentity {
  repoPath: string;
  effectiveVersion: string;
  authority: UnitAuthorityManifest;
}

/** Durable exact-version decisions; never inferred from source or generated docs. */
export class UnitVersionApprovalStore {
  private readonly filePath: string;
  private approvals = new Map<string, ApprovedUnitVersion>();

  constructor(opts: { statePath: string }) {
    this.filePath = stateLayout(opts.statePath).authority.approvedUnitVersionsFile;
    this.load();
  }

  has(identity: UnitVersionApprovalIdentity): boolean {
    return this.approvals.has(identityKey(identity));
  }

  approve(identity: UnitVersionApprovalIdentity, now = Date.now()): void {
    this.approveMany([identity], now);
  }

  approveMany(identities: Iterable<UnitVersionApprovalIdentity>, now = Date.now()): void {
    let changed = false;
    for (const identity of identities) {
      const record = {
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        authorityDigest: authorityDigest(identity.authority),
        approvedAt: now,
      } satisfies ApprovedUnitVersion;
      this.approvals.set(identityKey(record), record);
      changed = true;
    }
    if (!changed) return;
    this.save();
  }

  private load(): void {
    let source: string;
    try {
      source = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(source) as Partial<ApprovedUnitVersionFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.approvals)) {
      throw new Error(`Unknown approved-unit-version schema in ${this.filePath}`);
    }
    for (const approval of parsed.approvals) {
      if (!isApproval(approval)) {
        throw new Error(`Invalid approved-unit-version record in ${this.filePath}`);
      }
      this.approvals.set(identityKey(approval), approval);
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const state: ApprovedUnitVersionFile = {
      schemaVersion: 1,
      approvals: [...this.approvals.values()].sort((left, right) =>
        identityKey(left).localeCompare(identityKey(right))
      ),
    };
    writeFileAtomicSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

function authorityDigest(authority: UnitAuthorityManifest): string {
  // The complete reviewed contract is load-bearing. In particular, approving
  // direct requests must never silently approve a later/unreviewed eval ceiling.
  return sha256Canonical({
    requests: authority.requests,
    evalCeilings: authority.evalCeilings,
  });
}

function identityKey(
  identity:
    | Pick<ApprovedUnitVersion, "repoPath" | "effectiveVersion" | "authorityDigest">
    | UnitVersionApprovalIdentity
): string {
  const digest =
    "authorityDigest" in identity ? identity.authorityDigest : authorityDigest(identity.authority);
  return `${identity.repoPath}\0${identity.effectiveVersion}\0${digest}`;
}

function isApproval(value: unknown): value is ApprovedUnitVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") ===
      "approvedAt,authorityDigest,effectiveVersion,repoPath" &&
    typeof record["repoPath"] === "string" &&
    record["repoPath"].length > 0 &&
    typeof record["effectiveVersion"] === "string" &&
    record["effectiveVersion"].length > 0 &&
    typeof record["authorityDigest"] === "string" &&
    /^[0-9a-f]{64}$/u.test(record["authorityDigest"]) &&
    typeof record["approvedAt"] === "number" &&
    Number.isFinite(record["approvedAt"])
  );
}
