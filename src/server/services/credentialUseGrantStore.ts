import fs from "node:fs";
import path from "node:path";
import { stateLayout } from "../stateLayout.js";
import type { CredentialUseGrant } from "@vibestudio/credential-client/types";
import {
  loadVersionedJsonFile,
  saveVersionedJsonFile,
  type VersionedJsonCodec,
} from "../hostCore/versionedJsonStore.js";

export type StoredCredentialUseGrant = CredentialUseGrant & { credentialId: string };

const CREDENTIAL_USE_GRANT_SCHEMA_VERSION = 2 as const;

interface CredentialUseGrantFile {
  grants: StoredCredentialUseGrant[];
}

const CREDENTIAL_USE_GRANT_CODEC: VersionedJsonCodec<CredentialUseGrantFile> = {
  schemaName: "Credential use grant store",
  currentVersion: CREDENTIAL_USE_GRANT_SCHEMA_VERSION,
  decodeCurrent(value) {
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "schemaVersion" && key !== "grants") ||
      !Array.isArray(record["grants"]) ||
      !record["grants"].every(isStoredCredentialUseGrant)
    ) {
      throw new Error("versioned grant store contains invalid data");
    }
    return { grants: record["grants"] };
  },
  migrations: [
    {
      version: 2,
      name: "add-agent-identity-credential-grants",
      migrate(value) {
        const record = value as Record<string, unknown>;
        if (
          Object.keys(record).some((key) => key !== "schemaVersion" && key !== "grants") ||
          !Array.isArray(record["grants"]) ||
          !record["grants"].every(isStoredVersionCredentialUseGrant)
        ) {
          throw new Error("version 1 grant store contains invalid data");
        }
        return { grants: record["grants"] };
      },
    },
  ],
  unversionedMigration: {
    version: 1,
    name: "recognize-pre-versioning-credential-grants",
    migrate(value) {
      if (Array.isArray(value)) {
        if (!value.every(isStoredVersionCredentialUseGrant)) {
          throw new Error("legacy grant array contains an invalid grant");
        }
        return { grants: value };
      }
      if (!value || typeof value !== "object") {
        throw new Error("expected a credential grant object");
      }
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).length !== 1 ||
        !Array.isArray(record["grants"]) ||
        !record["grants"].every(isStoredVersionCredentialUseGrant)
      ) {
        throw new Error("unversioned grant store does not match the recognized { grants } schema");
      }
      return { grants: record["grants"] };
    },
  },
  encode: (value) => ({ grants: value.grants }),
};

export interface CredentialUseGrantStoreLike {
  list(credentialId: string): CredentialUseGrant[];
  listAll(): StoredCredentialUseGrant[];
  upsert(credentialId: string, grant: CredentialUseGrant): void | Promise<void>;
  revoke(id: string): boolean | Promise<boolean>;
  revokeForAgent(agentId: string): number | Promise<number>;
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

  revokeForAgent(agentId: string): number {
    this.load();
    const before = this.grants.length;
    this.grants = this.grants.filter(
      (grant) => !(grant.scope === "agent" && grant.agentId === agentId)
    );
    const removed = before - this.grants.length;
    if (removed > 0) this.save();
    return removed;
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
    try {
      const decoded = loadVersionedJsonFile(this.filePath, CREDENTIAL_USE_GRANT_CODEC);
      this.grants = decoded?.grants ?? [];
      this.loaded = true;
    } catch (error) {
      throw new Error(
        `Credential use grant store ${this.filePath} cannot be loaded without risking data loss: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    saveVersionedJsonFile(this.filePath, { grants: this.grants }, CREDENTIAL_USE_GRANT_CODEC);
  }
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
        "agentId",
        "grantedAt",
        "grantedBy",
      ].includes(key)
    ) &&
    typeof grant.credentialId === "string" &&
    typeof grant.bindingId === "string" &&
    (grant.use === "fetch" || grant.use === "git-http" || grant.use === "git-ssh") &&
    typeof grant.resource === "string" &&
    (grant.action === "read" || grant.action === "write" || grant.action === "use") &&
    Number.isFinite(grant.grantedAt) &&
    typeof grant.grantedBy === "string" &&
    ((grant.scope === "version" &&
      typeof grant.repoPath === "string" &&
      typeof grant.effectiveVersion === "string" &&
      !("agentId" in grant)) ||
      (grant.scope === "agent" &&
        typeof grant.agentId === "string" &&
        grant.agentId.length > 0 &&
        !("repoPath" in grant) &&
        !("effectiveVersion" in grant)))
  );
}

function isStoredVersionCredentialUseGrant(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const grant = value as Record<string, unknown>;
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
    typeof grant["credentialId"] === "string" &&
    typeof grant["bindingId"] === "string" &&
    (grant["use"] === "fetch" || grant["use"] === "git-http" || grant["use"] === "git-ssh") &&
    typeof grant["resource"] === "string" &&
    (grant["action"] === "read" || grant["action"] === "write" || grant["action"] === "use") &&
    grant["scope"] === "version" &&
    Number.isFinite(grant["grantedAt"]) &&
    typeof grant["grantedBy"] === "string" &&
    typeof grant["repoPath"] === "string" &&
    typeof grant["effectiveVersion"] === "string"
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
    grant.scope === "version" ? grant.repoPath : grant.agentId,
    grant.scope === "version" ? grant.effectiveVersion : "",
  ].join("\x00");
}

export function credentialUseGrantId(grant: StoredCredentialUseGrant): string {
  return Buffer.from(storedCredentialUseGrantKey(grant), "utf8").toString("base64url");
}
