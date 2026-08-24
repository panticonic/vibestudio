import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CompiledAuthorityPlanArtifact, CompiledAuthorityPlanLeaf } from "@vibestudio/rpc";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import { stateLayout } from "../stateLayout.js";
import { AUTHORITY_PLAN_SCHEMA } from "./authorityPlanSchema.js";

export const AUTHORITY_PLAN_COMPILER_VERSION = "authority-plan.v1";

export class AuthorityPlanStore {
  private readonly db: DatabaseSync;
  readonly databasePath: string;

  constructor(opts: { statePath: string }) {
    this.databasePath = stateLayout(opts.statePath).authority.authorityPlansDb;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    openCanonicalSqliteDatabase(this.db, AUTHORITY_PLAN_SCHEMA, {
      description: `authority plan artifact store in ${this.databasePath}`,
    });
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  publish(input: {
    catalogDigest: string;
    executionImageDigest: string;
    leaves: readonly CompiledAuthorityPlanLeaf[];
    now?: number;
  }): CompiledAuthorityPlanArtifact {
    const leaves = [...input.leaves].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))
    );
    const body = {
      schemaVersion: 1 as const,
      compilerVersion: AUTHORITY_PLAN_COMPILER_VERSION,
      catalogDigest: input.catalogDigest,
      executionImageDigest: input.executionImageDigest,
      leaves,
    };
    const bodyDigest = digest(body);
    const existing = this.get(bodyDigest);
    if (existing) return existing;
    const artifact: CompiledAuthorityPlanArtifact = {
      ...body,
      bodyDigest,
      createdAt: input.now ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO authority_plans
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

  get(digestValue: string): CompiledAuthorityPlanArtifact | null {
    const row = this.db
      .prepare(
        "SELECT artifact_json,compiler_version,catalog_digest FROM authority_plans WHERE digest = ?"
      )
      .get(digestValue) as
      | { artifact_json: string; compiler_version: string; catalog_digest: string }
      | undefined;
    if (!row) return null;
    const artifact = JSON.parse(row.artifact_json) as CompiledAuthorityPlanArtifact;
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
      throw new Error(`Authority plan ${digestValue} failed content-address verification`);
    }
    return artifact;
  }

  close(): void {
    this.db.close();
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update("authority-plan-artifact-v1\0")
    .update(canonicalJson(value))
    .digest("hex");
}
