import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { UserlandDefinitions } from "@vibestudio/shared/authority/unitInstallReview";
import type { CapabilityPresentationResolver } from "@vibestudio/shared/authorityPresentation";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  heldClearanceRowKeys,
  mintUnitClearanceGrants,
  retireUnitClearanceGrants,
} from "./unitClearanceGrants.js";
import type {
  UnitAdmissionIdentity,
  UnitAdmissionOrigin,
  UnitAdmissionStore,
  UnitSourceOrigin,
} from "./unitAdmissionStore.js";

/**
 * What accepting a unit install review does — wherever it was answered
 * (docs/template-install-unit-approval-ux-plan.md §6.4, §7.6).
 *
 * There are two review surfaces and there will only ever be two: the launch
 * gate, which decides client apps and extensions before the workspace UI exists
 * because `apps/shell` cannot render its own approval, and the in-workspace
 * collection route, which decides everything sandboxed. They ask different
 * questions in different words — whose code is this, versus what can it reach —
 * and that difference is deliberate.
 *
 * What they must never differ on is the bookkeeping. An acceptance means the
 * same two things on both:
 *
 *   admission — this exact unit version, with this exact declared authority, was
 *               reviewed and accepted;
 *   clearance — standing grants for the part of that declaration platform policy
 *               allows a review to pre-authorize.
 *
 * Before this module existed, only the collection route did either, so a unit
 * decided at the launch gate was left running with no admission on record. The
 * gate that reads admission then treated it as un-reviewed and demanded a review
 * it had already been given — and `apps/shell`, being one of those units, could
 * not answer the review because answering is itself gated on admission. One
 * acceptance path is what keeps that from being possible.
 */

export interface AcceptedUnit {
  /** The exact version being admitted. */
  identity: UnitAdmissionIdentity;
  /**
   * The version this one replaces. Its clearance retires in the same step:
   * grants are version-bound, so leaving them behind would let a reverted unit
   * silently regain authority the user had moved on from. It is also what an
   * unasked update inherits from (§7.3) — so an update that omits this looks
   * like a first install and re-grants the full slate.
   */
  previous?: { repoPath: string; effectiveVersion: string };
  /**
   * Row keys the user allowed now, when a review asked. Absent means the user
   * was not asked about this unit at all — a code-only update, a unit admitted
   * by the decision that landed it — and is answered from what it already holds
   * (§7.3), or, for a unit with no previous version, by the one-click slate. An
   * empty array means the user chose to be asked about everything, which is a
   * real decision and not a missing one (U5).
   */
  clearedRowKeys?: readonly string[];
  /** Candidate source facts verified by the server for this acceptance. */
  sourceOrigin?: UnitSourceOrigin | null;
}

export interface UnitInstallAcceptanceDeps {
  admissionStore: UnitAdmissionStore;
  /** Absent only in tests that exercise admission bookkeeping on its own. */
  grantStore?: CapabilityGrantStore;
  /** The human whose decision this was, for Permissions and audit. */
  decidedBy?: () => string;
  issuedBy?: () => string;
  presentationFor?: CapabilityPresentationResolver;
}

export interface UnitInstallAcceptanceTransaction {
  /** The protected publication has committed; keep the prepared state. */
  committed(): void;
  /** The protected publication failed; restore admission and clearance. */
  failed(error: unknown): void;
}

/**
 * Prepare an accepted install for a publication transaction.
 *
 * Admission and the new version's grants are written before the protected refs
 * move, while the outgoing grants are captured and made reversible. A failed
 * ref write therefore restores both the old version's clearance and the old
 * admission ledger instead of leaving either side half-applied.
 */
export function prepareUnitInstallReview(
  deps: UnitInstallAcceptanceDeps,
  input: { units: readonly AcceptedUnit[]; origin: UnitAdmissionOrigin }
): UnitInstallAcceptanceTransaction {
  if (input.units.length === 0) {
    return { committed: () => undefined, failed: () => undefined };
  }

  const admission = deps.admissionStore.beginTransaction();
  const grantStore = deps.grantStore;
  const previous = input.units.flatMap((unit) => (unit.previous ? [unit.previous] : []));
  const retiredGrantIds = grantStore
    ? grantStore
        .listActiveAuthorityGrants()
        .filter(
          (grant) =>
            grant.provenance === "install" &&
            previous.some(
              (unit) => grant.subject === `code:${unit.repoPath}@${unit.effectiveVersion}`
            )
        )
        .flatMap((grant) => (grant.id ? [grant.id] : []))
    : [];
  let issuedGrantIds: string[] = [];
  const retiredAt = Date.now();
  let settled = false;

  try {
    const sourceOrigins = new Map<string, UnitSourceOrigin | null>();
    for (const unit of input.units) {
      if (unit.sourceOrigin !== undefined) {
        sourceOrigins.set(unit.identity.repoPath, unit.sourceOrigin);
      }
    }
    const identities = input.units.map((unit) => unit.identity);
    if (sourceOrigins.size > 0) {
      admission.admitMany(identities, input.origin, undefined, sourceOrigins);
    } else {
      admission.admitMany(identities, input.origin);
    }
    if (grantStore) {
      // §7.3: read carried clearance before retiring the outgoing version.
      const cleared = input.units.map((unit) =>
        unit.clearedRowKeys === undefined && unit.previous
          ? [...heldClearanceRowKeys({ grantStore, ...unit.previous })]
          : unit.clearedRowKeys
      );
      const issued = mintUnitClearanceGrants({
        grantStore,
        units: input.units.map((unit, index) => ({
          ...unit.identity,
          ...(cleared[index] === undefined ? {} : { clearedRowKeys: cleared[index] }),
        })),
        origin: input.origin,
        decidedBy: deps.decidedBy?.() ?? "user:workspace",
        issuedBy: deps.issuedBy?.() ?? "host:vibestudio",
        userlandDefinitions: reviewedUserlandDefinitions(input.units.map((unit) => unit.identity)),
        ...(deps.presentationFor ? { presentationFor: deps.presentationFor } : {}),
      });
      issuedGrantIds = issued.flatMap((grant) => (grant.id ? [grant.id] : []));
      if (previous.length > 0) {
        retireUnitClearanceGrants({ grantStore, units: previous, now: retiredAt });
      }
    }
  } catch (error) {
    rollbackPreparedInstall(error);
    throw error;
  }

  function rollbackPreparedInstall(error: unknown): void {
    const rollbackErrors: unknown[] = [];
    try {
      grantStore?.rollbackInstallClearance({
        issuedGrantIds,
        restoreRevokedGrantIds: retiredGrantIds,
        retiredAt,
      });
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      admission.failed(error);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Install acceptance could not be rolled back"
      );
    }
  }

  return {
    committed: () => {
      if (settled) return;
      admission.committed();
      settled = true;
    },
    failed: (error) => {
      if (settled) return;
      rollbackPreparedInstall(error);
      settled = true;
    },
  };
}

/**
 * Admit every unit an accepted operation lands, and mint the clearance its
 * selection allowed.
 *
 * Admission is unconditional across the accepted set: selection withholds
 * clearance, never admission (U5). A part nobody checked still arrives and still
 * runs — it simply holds no standing grant and asks at use.
 */
export function acceptUnitInstallReview(
  deps: UnitInstallAcceptanceDeps,
  input: { units: readonly AcceptedUnit[]; origin: UnitAdmissionOrigin }
): void {
  const transaction = prepareUnitInstallReview(deps, input);
  transaction.committed();
}

/**
 * Receiver definitions the accepted set itself carries.
 *
 * A `workspace-service:` capability is classified when its provider is part of
 * the same decision; anything else is unreviewed, and therefore contextual and
 * headline (§6.1). Units reviewed together can see each other's declarations,
 * which is what keeps ordinary in-workspace service calls from turning into a
 * prompt on every first use.
 */
export function reviewedUserlandDefinitions(
  identities: readonly { authority: UnitAuthorityManifest }[]
): UserlandDefinitions {
  const definitions = new Map<string, UnitAuthorityManifest["provides"][number]>();
  for (const identity of identities) {
    for (const definition of identity.authority.provides) {
      definitions.set(`workspace-service:${definition.name}`, definition);
    }
  }
  return definitions;
}
