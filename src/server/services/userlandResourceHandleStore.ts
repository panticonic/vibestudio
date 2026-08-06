import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  userlandHandleResourceKey,
  userlandHandleBindingMatches,
  type UserlandHandleBinding,
} from "@vibestudio/shared/authority/userlandResources";
import { stateLayout } from "../stateLayout.js";
import { USERLAND_RESOURCE_HANDLE_SCHEMA } from "./userlandResourceHandleSchema.js";

export interface UserlandResourceHandleBinding {
  workspaceId: string;
  capability: string;
  capabilityDefinitionDigest: string;
  provider: string;
  receiverSource: string;
  receiverClass: string;
  receiverObjectKey: string;
  resourceType: string;
}

export interface IssueUserlandResourceHandleInput extends UserlandResourceHandleBinding {
  selector: string;
  presentation: { title: string; detail?: string };
}

export interface ResolvedUserlandResourceHandle {
  handle: string;
  resourceKey: string;
  selector: string;
  presentation: { title: string; detail?: string };
}

const HANDLE_PATTERN = /^urh_[A-Za-z0-9_-]{43}$/u;

function validateBoundedInput(input: IssueUserlandResourceHandleInput): void {
  for (const [label, value] of Object.entries({
    workspaceId: input.workspaceId,
    capability: input.capability,
    capabilityDefinitionDigest: input.capabilityDefinitionDigest,
    provider: input.provider,
    receiverSource: input.receiverSource,
    receiverClass: input.receiverClass,
    receiverObjectKey: input.receiverObjectKey,
    resourceType: input.resourceType,
  })) {
    if (!value || value.length > 512) throw new Error(`${label} must contain 1-512 characters`);
  }
  if (!input.selector || input.selector.length > 512) {
    throw new Error("Opaque resource selector must contain 1-512 characters");
  }
  if (!input.presentation.title || input.presentation.title.length > 160) {
    throw new Error("Opaque resource title must contain 1-160 characters");
  }
  if (input.presentation.detail !== undefined && input.presentation.detail.length > 500) {
    throw new Error("Opaque resource detail must contain at most 500 characters");
  }
}

export class UserlandResourceHandleStore {
  private readonly db: DatabaseSync;
  readonly databasePath: string;

  constructor(options: { statePath: string }) {
    this.databasePath = stateLayout(options.statePath).authority.resourceHandlesDb;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    try {
      openCanonicalSqliteDatabase(this.db, USERLAND_RESOURCE_HANDLE_SCHEMA, {
        description: `userland resource handle store in ${this.databasePath}`,
      });
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      this.db.close();
      throw new Error(
        `Userland resource handle store ${this.databasePath} cannot be loaded safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  close(): void {
    this.db.close();
  }

  issue(input: IssueUserlandResourceHandleInput): ResolvedUserlandResourceHandle {
    validateBoundedInput(input);
    const handle = `urh_${randomBytes(32).toString("base64url")}`;
    this.db
      .prepare(
        `INSERT INTO userland_resource_handles (
          handle, workspace_id, capability, capability_definition_digest, provider,
          receiver_source, receiver_class, receiver_object_key, resource_type,
          selector, presentation_json, created_at, revoked_at, revocation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run(
        handle,
        input.workspaceId,
        input.capability,
        input.capabilityDefinitionDigest,
        input.provider,
        input.receiverSource,
        input.receiverClass,
        input.receiverObjectKey,
        input.resourceType,
        input.selector,
        canonicalJson(input.presentation),
        Date.now()
      );
    return {
      handle,
      resourceKey: userlandHandleResourceKey(input.resourceType, handle),
      selector: input.selector,
      presentation: { ...input.presentation },
    };
  }

  issueFromPreparation(
    binding: UserlandResourceHandleBinding,
    result: unknown
  ): { handle: string; presentation: { title: string; detail?: string } } {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Handle-producing RPC must return an opaque resource preparation");
    }
    const prepared = result as {
      __vibestudioOpaqueHandle?: unknown;
      selector?: unknown;
      presentation?: unknown;
    };
    if (
      prepared.__vibestudioOpaqueHandle !== 1 ||
      typeof prepared.selector !== "string" ||
      !prepared.presentation ||
      typeof prepared.presentation !== "object" ||
      Array.isArray(prepared.presentation)
    ) {
      throw new Error("Handle-producing RPC returned an invalid opaque resource preparation");
    }
    const presentation = prepared.presentation as { title?: unknown; detail?: unknown };
    if (
      typeof presentation.title !== "string" ||
      (presentation.detail !== undefined && typeof presentation.detail !== "string")
    ) {
      throw new Error("Handle-producing RPC returned an invalid resource presentation");
    }
    const issued = this.issue({
      ...binding,
      selector: prepared.selector,
      presentation: {
        title: presentation.title,
        ...(presentation.detail !== undefined ? { detail: presentation.detail } : {}),
      },
    });
    return { handle: issued.handle, presentation: issued.presentation };
  }

  resolve(handle: string, expected: UserlandResourceHandleBinding): ResolvedUserlandResourceHandle {
    if (!HANDLE_PATTERN.test(handle)) throw new Error("Unknown opaque resource handle");
    const row = this.db
      .prepare(
        `SELECT workspace_id, capability, capability_definition_digest, provider,
                receiver_source, receiver_class, receiver_object_key, resource_type,
                selector, presentation_json, revoked_at
           FROM userland_resource_handles
          WHERE handle = ?`
      )
      .get(handle) as Record<string, unknown> | undefined;
    if (!row || row["revoked_at"] !== null)
      throw new Error("Unknown or revoked opaque resource handle");
    const actual: UserlandResourceHandleHandleRow = {
      workspaceId: String(row["workspace_id"]),
      capability: String(row["capability"]),
      capabilityDefinitionDigest: String(row["capability_definition_digest"]),
      provider: String(row["provider"]),
      receiverSource: String(row["receiver_source"]),
      receiverClass: String(row["receiver_class"]),
      receiverObjectKey: String(row["receiver_object_key"]),
      resourceType: String(row["resource_type"]),
    };
    const expectedBinding: UserlandHandleBinding = {
      workspaceId: expected.workspaceId,
      canonicalCapability: expected.capability,
      definitionDigest: expected.capabilityDefinitionDigest,
      provider: expected.provider,
      receiverSource: expected.receiverSource,
      receiverClass: expected.receiverClass,
      receiverObjectKey: expected.receiverObjectKey,
      resourceType: expected.resourceType,
    };
    const actualBinding: UserlandHandleBinding = {
      workspaceId: actual.workspaceId,
      canonicalCapability: actual.capability,
      definitionDigest: actual.capabilityDefinitionDigest,
      provider: actual.provider,
      receiverSource: actual.receiverSource,
      receiverClass: actual.receiverClass,
      receiverObjectKey: actual.receiverObjectKey,
      resourceType: actual.resourceType,
    };
    if (!userlandHandleBindingMatches(actualBinding, expectedBinding)) {
      throw new Error("Opaque resource handle is not valid for this receiver capability");
    }
    return {
      handle,
      resourceKey: userlandHandleResourceKey(expected.resourceType, handle),
      selector: String(row["selector"]),
      presentation: JSON.parse(String(row["presentation_json"])) as {
        title: string;
        detail?: string;
      },
    };
  }

  revoke(handle: string, reason: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE userland_resource_handles
            SET revoked_at = ?, revocation_reason = ?
          WHERE handle = ? AND revoked_at IS NULL`
      )
      .run(Date.now(), reason, handle);
    return result.changes > 0;
  }

  revokeProvider(workspaceId: string, provider: string, reason: string): number {
    return this.revokeWhere("workspace_id = ? AND provider = ?", [workspaceId, provider], reason);
  }

  reconcileProviders(
    workspaceId: string,
    activeProviders: readonly string[],
    reason: string
  ): number {
    const active = [...new Set(activeProviders)];
    if (active.some((provider) => !provider || provider.length > 512)) {
      throw new Error("Active providers must contain 1-512 characters");
    }
    if (active.length === 0) return this.revokeWorkspace(workspaceId, reason);
    const placeholders = active.map(() => "?").join(", ");
    return this.revokeWhere(
      `workspace_id = ? AND provider NOT IN (${placeholders})`,
      [workspaceId, ...active],
      reason
    );
  }

  reconcileProviderDefinitions(
    workspaceId: string,
    provider: string,
    activeDefinitionDigests: readonly string[],
    reason: string
  ): number {
    const active = [...new Set(activeDefinitionDigests)];
    if (active.some((digest) => !digest || digest.length > 512)) {
      throw new Error("Active capability definition digests must contain 1-512 characters");
    }
    if (active.length === 0) return this.revokeProvider(workspaceId, provider, reason);
    const placeholders = active.map(() => "?").join(", ");
    return this.revokeWhere(
      `workspace_id = ? AND provider = ? AND capability_definition_digest NOT IN (${placeholders})`,
      [workspaceId, provider, ...active],
      reason
    );
  }

  reconcileReceiverClasses(
    workspaceId: string,
    receiverSource: string,
    activeClassNames: readonly string[],
    reason: string
  ): number {
    const active = [...new Set(activeClassNames)];
    if (active.some((className) => !className || className.length > 512)) {
      throw new Error("Active receiver class names must contain 1-512 characters");
    }
    if (active.length === 0) {
      return this.revokeWhere(
        "workspace_id = ? AND receiver_source = ?",
        [workspaceId, receiverSource],
        reason
      );
    }
    const placeholders = active.map(() => "?").join(", ");
    return this.revokeWhere(
      `workspace_id = ? AND receiver_source = ? AND receiver_class NOT IN (${placeholders})`,
      [workspaceId, receiverSource, ...active],
      reason
    );
  }

  revokeReceiver(
    workspaceId: string,
    receiver: { source: string; className: string; objectKey: string },
    reason: string
  ): number {
    return this.revokeWhere(
      "workspace_id = ? AND receiver_source = ? AND receiver_class = ? AND receiver_object_key = ?",
      [workspaceId, receiver.source, receiver.className, receiver.objectKey],
      reason
    );
  }

  revokeWorkspace(workspaceId: string, reason: string): number {
    return this.revokeWhere("workspace_id = ?", [workspaceId], reason);
  }

  private revokeWhere(predicate: string, values: string[], reason: string): number {
    const result = this.db
      .prepare(
        `UPDATE userland_resource_handles
            SET revoked_at = ?, revocation_reason = ?
          WHERE ${predicate} AND revoked_at IS NULL`
      )
      .run(Date.now(), reason, ...values);
    return Number(result.changes);
  }
}

interface UserlandResourceHandleHandleRow {
  workspaceId: string;
  capability: string;
  capabilityDefinitionDigest: string;
  provider: string;
  receiverSource: string;
  receiverClass: string;
  receiverObjectKey: string;
  resourceType: string;
}
