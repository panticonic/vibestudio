import type { AuthorityGrant } from "@vibestudio/rpc";
import type {
  UnitAuthorityManifest,
  UnitAuthorityRequest,
} from "@vibestudio/shared/authorityManifest";
import { codePrincipal } from "@vibestudio/shared/authority/codePrincipal";
import {
  installReviewRows,
  installRowKey,
  type UserlandDefinitions,
} from "@vibestudio/shared/authority/unitInstallReview";
import type { CapabilityPresentationResolver } from "@vibestudio/shared/authorityPresentation";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { UnitAdmissionOrigin } from "./unitAdmissionStore.js";

/**
 * Install clearance: the standing grants a review's acceptance mints
 * (docs/template-install-unit-approval-ux-plan.md §6.4).
 *
 * These are ordinary grants through the canonical store, not a bypass flag.
 * That is the whole point: after this change a declared request with no stored
 * grant prompts rather than resolving itself, which is what makes revocation
 * mean anything — there is a record to revoke, it appears in Permissions, and
 * removing it makes the part ask again.
 *
 * The subject is `code:<repoPath>@<effectiveVersion>` (see
 * `authority/codePrincipal`), so clearance can be minted the moment a review is
 * accepted — before anything is built — and survives every rebuild that does not
 * change the unit's source.
 */

export interface UnitClearanceIdentity {
  repoPath: string;
  effectiveVersion: string;
  authority: UnitAuthorityManifest;
  /**
   * The row keys the user allowed now. Absent means every install-clearable row
   * for this unit; an empty array means the user chose to be asked about
   * everything, which is a real choice and not a missing one (U5).
   */
  clearedRowKeys?: readonly string[];
}

export interface MintUnitClearanceInput {
  grantStore: CapabilityGrantStore;
  units: readonly UnitClearanceIdentity[];
  origin: UnitAdmissionOrigin;
  /** The human whose decision this was, for Permissions and audit. */
  decidedBy: string;
  issuedBy: string;
  /** Receiver definitions carried by the same operation, for §6.1 classification. */
  userlandDefinitions?: UserlandDefinitions;
  presentationFor?: CapabilityPresentationResolver;
  now?: number;
}

/** Human-readable provenance shown in Permissions as `Added with News`. */
export const CLEARANCE_DECISION_SURFACE: Record<UnitAdmissionOrigin, string> = {
  "workspace-creation": "workspace-creation",
  "template-install": "template-install",
  publication: "publication",
  // Client apps and extensions are decided before the workspace UI exists, in a
  // host-owned window and in the terminal (§7.6). That is a different surface
  // from workspace settings and reads differently in Permissions, so it is a
  // distinct origin rather than a reuse of `chrome`.
  "launch-gate": "launch-gate",
  // Shipped with Vibestudio itself, proven by a signed record over the unit's
  // own source. Never offered at the gate: installing Vibestudio was the
  // decision, and there is no third party to name.
  "host-build": "host-build",
  chrome: "workspace-settings",
};

/**
 * Mint one version-bound grant per cleared row.
 *
 * Rows the platform keeps contextual or critical are never minted here, however
 * an acceptance was shaped: the server derives the clearable set itself from the
 * manifest and policy, so a client that asks for more than it was offered gets
 * less, not more.
 */
export function mintUnitClearanceGrants(input: MintUnitClearanceInput): AuthorityGrant[] {
  const now = input.now ?? Date.now();
  return input.grantStore.transaction(() => {
    const issued: AuthorityGrant[] = [];
    // Receivers declared by the same operation classify their own capabilities:
    // the user is accepting the receiver and its declaration in one decision, so
    // a service one part provides is not "unknown" to the part that calls it.
    const definitions = new Map(input.userlandDefinitions ?? []);
    for (const unit of input.units) {
      for (const definition of unit.authority.provides) {
        if (!definitions.has(`workspace-service:${definition.name}`)) {
          definitions.set(`workspace-service:${definition.name}`, definition);
        }
      }
    }
    for (const unit of input.units) {
      const subject = codePrincipal(unit);
      const requested = new Set(unit.clearedRowKeys ?? null);
      const clearable = clearableRequests(unit.authority, definitions, input.presentationFor);
      for (const { request, key } of clearable) {
        if (unit.clearedRowKeys !== undefined && !requested.has(key)) continue;
        issued.push(
          input.grantStore.issue({
            effect: "allow",
            capability: request.capability,
            resource: request.resource,
            subject,
            scope: "version",
            constraints: { lineageAtConsent: [] },
            issuedBy: input.issuedBy,
            provenance: "install",
            decidedBy: input.decidedBy,
            decisionSurface: CLEARANCE_DECISION_SURFACE[input.origin],
            createdAt: now,
          })
        );
      }
    }
    return issued;
  });
}

/**
 * Revoke every standing clearance a unit version holds.
 *
 * Used when an operation removes a part, and when an update re-mints against a
 * new version: grants are version-bound, so the old version's grants are dead
 * weight the moment its version changes, and leaving them behind would let a
 * reverted unit silently regain authority the user had moved on from.
 */
export function retireUnitClearanceGrants(input: {
  grantStore: CapabilityGrantStore;
  units: readonly { repoPath: string; effectiveVersion: string }[];
  now?: number;
}): number {
  const subjects = new Set<string>(input.units.map((unit) => codePrincipal(unit)));
  if (subjects.size === 0) return 0;
  const now = input.now ?? Date.now();
  return input.grantStore.transaction(() => {
    let revoked = 0;
    for (const grant of input.grantStore.listActiveAuthorityGrants(now)) {
      if (grant.provenance !== "install" || !subjects.has(grant.subject)) continue;
      if (grant.id && input.grantStore.revoke(grant.id, now)) revoked += 1;
    }
    return revoked;
  });
}

/**
 * Which of a unit's declared requests a review may pre-authorize, with the row
 * key each is identified by.
 *
 * Derived from the same builder every review surface renders from, so what the
 * server mints and what the user saw can never drift apart.
 */
export function clearableRequests(
  authority: UnitAuthorityManifest,
  userlandDefinitions?: UserlandDefinitions,
  presentationFor?: CapabilityPresentationResolver
): Array<{ request: UnitAuthorityRequest; key: string }> {
  const { notableRows, everydayRows } = installReviewRows({
    requests: authority.requests,
    ...(userlandDefinitions ? { userlandDefinitions } : {}),
    ...(presentationFor ? { presentationFor } : {}),
  });
  const clearableKeys = new Set(
    [...notableRows, ...everydayRows].filter((row) => row.selectable).map((row) => row.key)
  );
  return authority.requests
    .map((request) => ({
      request,
      key: installRowKey({ capability: request.capability, resourceScope: request.resource }),
    }))
    .filter((entry) => clearableKeys.has(entry.key));
}

/**
 * The clearance a unit currently holds, as row keys — the input to §7.3's
 * re-mint rule, which carries an earlier decision forward instead of silently
 * undoing a deselection or breaking a part that was working.
 */
export function heldClearanceRowKeys(input: {
  grantStore: CapabilityGrantStore;
  repoPath: string;
  effectiveVersion: string;
  now?: number;
}): Set<string> {
  const subject = codePrincipal(input);
  const keys = new Set<string>();
  for (const grant of input.grantStore.listActiveAuthorityGrants(input.now)) {
    if (grant.provenance !== "install" || grant.subject !== subject) continue;
    keys.add(installRowKey({ capability: grant.capability, resourceScope: grant.resource }));
  }
  return keys;
}
