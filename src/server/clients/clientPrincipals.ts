import type { ClientPrincipalRow } from "@vibestudio/identity/identityDb";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { contextIdForTargetKey } from "@vibestudio/shared/runtime/contextIdentity";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { RpcServer } from "../rpcServer.js";
import { requireActiveExecutionIdentity } from "../runtimeExecutionIdentity.js";

/** The attested facts a workspace needs to run a principal; a hub row or an attestation payload. */
export type AdmittableClientPrincipal = Pick<
  ClientPrincipalRow,
  | "principalId"
  | "deviceId"
  | "clientId"
  | "runtime"
  | "source"
  | "buildKey"
  | "effectiveVersion"
  | "executionDigest"
> & { authority?: unknown };

/**
 * This workspace's view of hub-attested client principals
 * (`client:<id>:<runtime>:<deviceId>`).
 *
 * The hub's identity.db is the authority; a workspace mirrors a principal into
 * its own EntityCache only when one of its credentials is redeemed here, so a
 * restarted workspace holds nothing a revoked credential could resurrect. Each
 * workspace derives its own never-materialized routed context for the
 * principal, so two workspaces (and two devices) never share routed callbacks
 * or ephemeral state.
 */
export class ClientPrincipals {
  constructor(
    private readonly deps: {
      workspaceId: string;
      entityCache: Pick<EntityCache, "resolve" | "listActive" | "_onActivate" | "_onRetire">;
    }
  ) {}

  /** Activate (or refresh) the principal's entity from its hub-attested facts. */
  admit(row: AdmittableClientPrincipal): void {
    const { entityCache, workspaceId } = this.deps;
    const existing = entityCache.resolve(row.principalId);
    const record: EntityRecord = {
      id: row.principalId,
      kind: "client",
      source: { repoPath: row.source, effectiveVersion: row.effectiveVersion },
      activeBuildKey: row.buildKey,
      ...requireActiveExecutionIdentity(
        {
          executionDigest: row.executionDigest,
          // Revalidated by the parser: the row stores the sealed manifest as JSON.
          authority: row.authority as UnitAuthorityManifest | undefined,
        },
        `client principal ${row.principalId}`
      ),
      // The canonical derived-context format (`ctx-<32 hex>`).
      contextId: contextIdForTargetKey(
        `${workspaceId}\x00client\x00${row.clientId}\x00${row.runtime}\x00${row.deviceId}`
      ),
      key: row.principalId.slice("client:".length),
      createdAt: existing?.createdAt ?? Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    entityCache._onActivate(record);
  }

  /** Retire the named principals' entities; returns the ids that were active. */
  retire(principalIds: readonly string[]): string[] {
    const retired: string[] = [];
    const ids = new Set(principalIds);
    for (const record of this.deps.entityCache.listActive()) {
      if (record.kind !== "client" || !ids.has(record.id)) continue;
      this.deps.entityCache._onRetire({
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

/**
 * The workspace-side half of a hub revocation: retire the principals' entities
 * and close every live session they hold, with the reason their host relays.
 * Returns how many sessions were closed.
 */
export function createClientSessionRetirer(deps: {
  principals: Pick<ClientPrincipals, "retire">;
  rpc: () => Pick<RpcServer, "getPrincipalConnections" | "retireCaller">;
}): (principalIds: readonly string[], reason: string) => Promise<number> {
  return async (principalIds, reason) => {
    const rpc = deps.rpc();
    deps.principals.retire(principalIds);
    const closed = principalIds.reduce(
      (count, principalId) => count + rpc.getPrincipalConnections(principalId).length,
      0
    );
    await Promise.all(principalIds.map((id) => rpc.retireCaller(id, "client", reason)));
    return closed;
  };
}
