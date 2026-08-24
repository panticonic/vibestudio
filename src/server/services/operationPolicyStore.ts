import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CompiledOperationPolicyArtifact, CompiledOperationPolicyLeaf } from "@vibestudio/rpc";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import { stateLayout } from "../stateLayout.js";
import { OPERATION_POLICY_SCHEMA } from "./operationPolicySchema.js";
import { scopeCovers } from "@vibestudio/shared/authorization";

export const OPERATION_POLICY_COMPILER_VERSION = "operation-policy.v1";

export class OperationPolicyStore {
  private readonly db: DatabaseSync;
  readonly databasePath: string;

  constructor(opts: { statePath: string }) {
    this.databasePath = stateLayout(opts.statePath).authority.operationPoliciesDb;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    openCanonicalSqliteDatabase(this.db, OPERATION_POLICY_SCHEMA, {
      description: `operation policy artifact store in ${this.databasePath}`,
    });
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  publish(input: {
    catalogDigest: string;
    executionImageDigest: string;
    leaves: readonly CompiledOperationPolicyLeaf[];
    now?: number;
  }): CompiledOperationPolicyArtifact {
    const leaves = [...input.leaves].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))
    );
    const body = {
      schemaVersion: 1 as const,
      compilerVersion: OPERATION_POLICY_COMPILER_VERSION,
      catalogDigest: input.catalogDigest,
      executionImageDigest: input.executionImageDigest,
      leaves,
    };
    const bodyDigest = digest(body);
    const existing = this.get(bodyDigest);
    if (existing) return existing;
    const artifact: CompiledOperationPolicyArtifact = {
      ...body,
      bodyDigest,
      createdAt: input.now ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO operation_policies
       (digest, artifact_json, compiler_version, catalog_digest, created_at)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        bodyDigest,
        canonicalJson(artifact),
        artifact.compilerVersion,
        artifact.catalogDigest,
        artifact.createdAt
      );
    return artifact;
  }

  get(digestValue: string): CompiledOperationPolicyArtifact | null {
    const row = this.db
      .prepare(
        "SELECT artifact_json,compiler_version,catalog_digest FROM operation_policies WHERE digest = ?"
      )
      .get(digestValue) as
      | { artifact_json: string; compiler_version: string; catalog_digest: string }
      | undefined;
    if (!row) return null;
    const artifact = JSON.parse(row.artifact_json) as CompiledOperationPolicyArtifact;
    if (
      artifact.bodyDigest !== digestValue ||
      artifact.bodyDigest !==
        digest({
          schemaVersion: artifact.schemaVersion,
          compilerVersion: artifact.compilerVersion,
          catalogDigest: artifact.catalogDigest,
          executionImageDigest: artifact.executionImageDigest,
          leaves: artifact.leaves,
        }) ||
      artifact.compilerVersion !== row.compiler_version ||
      artifact.catalogDigest !== row.catalog_digest
    ) {
      throw new Error(`Operation policy ${digestValue} failed content-address verification`);
    }
    return artifact;
  }

  permits(digestValue: string, service: string, method: string, resourceKey: string): boolean {
    const artifact = this.get(digestValue);
    if (!artifact) throw new Error(`Unknown operation policy ${digestValue}`);
    return artifact.leaves.some(
      (leaf) =>
        leaf.service === service &&
        leaf.method === method &&
        scopeCovers(leaf.resource, resourceKey)
    );
  }

  permitsService(digestValue: string, service: string): boolean {
    const artifact = this.get(digestValue);
    if (!artifact) throw new Error(`Unknown operation policy ${digestValue}`);
    return artifact.leaves.some((leaf) => leaf.service === service);
  }

  close(): void {
    this.db.close();
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update("operation-policy-artifact-v1\0")
    .update(canonicalJson(value))
    .digest("hex");
}
