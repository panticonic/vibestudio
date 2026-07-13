import fs from "node:fs";
import path from "node:path";
import { stateLayout } from "../stateLayout.js";
import type { CredentialUseGrant } from "@vibestudio/credential-client/types";
import { writeJsonFileAtomic } from "../hostCore/atomicFile.js";

export interface StoredCredentialUseGrant extends CredentialUseGrant {
  credentialId: string;
}

export interface CredentialUseGrantStoreLike {
  list(credentialId: string): CredentialUseGrant[];
  listAll(): StoredCredentialUseGrant[];
  upsert(credentialId: string, grant: CredentialUseGrant): void | Promise<void>;
  revoke(id: string): boolean | Promise<boolean>;
}

export class CredentialUseGrantStore implements CredentialUseGrantStoreLike {
  private readonly filePath: string;
  private loaded = false;
  private grants: StoredCredentialUseGrant[] = [];

  constructor(opts: { statePath: string }) {
    this.filePath = stateLayout(opts.statePath).credentialUseGrantsFile;
  }

  list(credentialId: string): CredentialUseGrant[] {
    this.load();
    return this.grants
      .filter((grant) => grant.credentialId === credentialId)
      .map(({ credentialId: _credentialId, ...grant }) => ({ ...grant }));
  }

  listAll(): StoredCredentialUseGrant[] {
    this.load();
    return this.grants.map((grant) => ({ ...grant }));
  }

  revoke(id: string): boolean {
    this.load();
    const before = this.grants.length;
    this.grants = this.grants.filter((grant) => credentialUseGrantId(grant) !== id);
    if (this.grants.length === before) return false;
    this.save();
    return true;
  }

  upsert(credentialId: string, grant: CredentialUseGrant): void {
    this.load();
    const key = storedCredentialUseGrantKey({ credentialId, ...grant });
    this.grants = [
      ...this.grants.filter((entry) => storedCredentialUseGrantKey(entry) !== key),
      { credentialId, ...grant },
    ];
    this.save();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredCredentialUseGrantFile(parsed)) {
        throw new Error("expected the current exact { grants } schema");
      }
      this.grants = parsed.grants;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.grants = [];
        return;
      }
      console.warn(
        `[CredentialUseGrantStore] Resetting invalid grant store ${this.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.grants = [];
      this.save();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(this.filePath, { grants: this.grants });
  }
}

function isStoredCredentialUseGrantFile(
  value: unknown
): value is { grants: StoredCredentialUseGrant[] } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray((value as { grants?: unknown }).grants) &&
    (value as { grants: unknown[] }).grants.every(isStoredCredentialUseGrant)
  );
}

function isStoredCredentialUseGrant(value: unknown): value is StoredCredentialUseGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Partial<StoredCredentialUseGrant>;
  return (
    Object.keys(grant).every((key) =>
      [
        "credentialId",
        "bindingId",
        "use",
        "resource",
        "action",
        "scope",
        "repoPath",
        "effectiveVersion",
        "grantedAt",
        "grantedBy",
      ].includes(key)
    ) &&
    typeof grant.credentialId === "string" &&
    typeof grant.bindingId === "string" &&
    (grant.use === "fetch" || grant.use === "git-http" || grant.use === "git-ssh") &&
    typeof grant.resource === "string" &&
    (grant.action === "read" || grant.action === "write" || grant.action === "use") &&
    grant.scope === "version" &&
    Number.isFinite(grant.grantedAt) &&
    typeof grant.grantedBy === "string" &&
    typeof grant.repoPath === "string" &&
    typeof grant.effectiveVersion === "string"
  );
}

function storedCredentialUseGrantKey(grant: StoredCredentialUseGrant): string {
  return [
    grant.credentialId,
    grant.bindingId,
    grant.use,
    grant.resource,
    grant.action,
    grant.scope,
    grant.repoPath,
    grant.effectiveVersion,
  ].join("\x00");
}

export function credentialUseGrantId(grant: StoredCredentialUseGrant): string {
  return Buffer.from(storedCredentialUseGrantKey(grant), "utf8").toString("base64url");
}
