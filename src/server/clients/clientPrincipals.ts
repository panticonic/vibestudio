import { contextIdForTargetKey } from "@vibestudio/shared/runtime/contextIdentity";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import {
  clientPrincipalId,
  parseClientPrincipalId,
  type ClientRuntime,
} from "@vibestudio/workspace-contracts/clients";
import type { ActiveExecutionIdentity } from "../runtimeExecutionIdentity.js";

export interface ClientPrincipalsDeps {
  workspaceId: string;
  entityCache?: Pick<EntityCache, "resolve" | "listActive" | "_onActivate" | "_onRetire">;
}

/** The exact client incarnation a device principal was activated for. */
export interface ClientPrincipal {
  principalId: string;
  id: string;
  runtime: ClientRuntime;
  source: string;
  buildKey: string;
  effectiveVersion: string;
}

/**
 * One principal per running client per device (§4.4): `client:<id>:<runtime>:<deviceId>`.
 *
 * Each principal has its own context, so two devices running the same client
 * never share routed callbacks or ephemeral state, and carries the sealed
 * execution identity of the exact build its host verified. Capability checks
 * resolve it back to the client's registry entry by id and runtime.
 */
export class ClientPrincipals {
  constructor(private readonly deps: ClientPrincipalsDeps) {}

  register(input: {
    id: string;
    runtime: ClientRuntime;
    deviceId: string;
    source: string;
    buildKey: string;
    effectiveVersion: string;
    identity: ActiveExecutionIdentity;
  }): ClientPrincipal {
    const entityCache = this.deps.entityCache;
    if (!entityCache) {
      throw new Error("Cannot activate a client principal without an entity cache");
    }
    const principalId = clientPrincipalId(input.id, input.runtime, input.deviceId);
    const existing = entityCache.resolve(principalId);
    // The canonical derived-context format (`ctx-<32 hex>`): a valid context
    // folder and build ref, unlike a bare 64-hex digest.
    const contextId = contextIdForTargetKey(
      `${this.deps.workspaceId}\x00client\x00${input.id}\x00${input.runtime}\x00${input.deviceId}`
    );
    const record: EntityRecord = {
      id: principalId,
      kind: "client",
      source: { repoPath: input.source, effectiveVersion: input.effectiveVersion },
      activeBuildKey: input.buildKey,
      ...input.identity,
      contextId,
      key: principalId.slice("client:".length),
      createdAt: existing?.createdAt ?? Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    entityCache._onActivate(record);
    return {
      principalId,
      id: input.id,
      runtime: input.runtime,
      source: input.source,
      buildKey: input.buildKey,
      effectiveVersion: input.effectiveVersion,
    };
  }

  /** Retire every client principal of one device. Returns how many were active. */
  retireDevice(deviceId: string): number {
    return this.retireWhere((principal) => principal.deviceId === deviceId).length;
  }

  /** Retire every device's principal of one client. Returns the retired principal ids. */
  retireClient(id: string, runtime: ClientRuntime): string[] {
    return this.retireWhere((principal) => principal.id === id && principal.runtime === runtime);
  }

  private retireWhere(
    matches: (principal: NonNullable<ReturnType<typeof parseClientPrincipalId>>) => boolean
  ): string[] {
    const entityCache = this.deps.entityCache;
    if (!entityCache) return [];
    const retired: string[] = [];
    for (const record of entityCache.listActive()) {
      if (record.kind !== "client") continue;
      const principal = parseClientPrincipalId(record.id);
      if (!principal || !matches(principal)) continue;
      entityCache._onRetire({
        ...record,
        status: "retired",
        retiredAt: Date.now(),
        cleanupComplete: true,
      });
      retired.push(record.id);
    }
    return retired;
  }
}
