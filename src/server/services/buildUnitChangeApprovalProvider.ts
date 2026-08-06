import type { ReviewedUnit } from "@vibestudio/shared/approvals";
import type { CapabilityPresentationResolver } from "@vibestudio/shared/authorityPresentation";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import {
  authorityReviewFromPackageJson,
  type UnitChangeApprovalProvider,
  type UnitChangeReview,
} from "@vibestudio/unit-host";
import type { BuildSystemV2, BuildUnitIdentityResolution } from "../buildV2/index.js";
import type { UnitAuthorityRequest } from "@vibestudio/shared/authorityManifest";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  prepareUnitInstallReview,
  type UnitInstallAcceptanceTransaction,
} from "./unitInstallAcceptance.js";
import type {
  UnitAdmissionIdentity,
  UnitAdmissionOrigin,
  UnitAdmissionStore,
} from "./unitAdmissionStore.js";
import type { UnitInstallSourceOrigin } from "@vibestudio/shared/authority/unitInstallReview";

const REVIEWED_RUNTIME_KINDS = ["panel", "worker"] as const;

/**
 * Adds browser panels and workerd units to the protected-main review. Native
 * apps/extensions have activation-owning providers; panels/workers are admitted
 * by the accepted protected publication itself, but must present the same
 * exact-version manifest delta in that one decision.
 */
export interface BuildUnitChangeApprovalProvider extends UnitChangeApprovalProvider<ReviewedUnit> {
  /**
   * Every panel and worker the live workspace view currently contains that holds
   * no admission yet.
   *
   * This is the creation review's input (§7.1) — the units the root template
   * landed through the one publication that is not gated, because at the moment
   * it runs there is no workspace yet and nobody to ask.
   *
   * It answers "what is still owed a review?" directly, rather than sitting
   * behind a marker that says one is owed. A marker cannot describe a workspace
   * that arrived by any other route — the first boot after a cutover that
   * discarded the admission file has no marker and is owed the whole list — and
   * the emptiness of the admission store cannot stand in for it either, because
   * host-build units are admitted from their seed records before this runs. The
   * set itself is the only thing that is true in every case, and on a workspace
   * that owes nothing it is empty and costs one index lookup per unit.
   *
   * "Owed" means never reviewed at any version, not unadmitted at the current
   * one — see the filter below for why the difference is the whole point.
   */
  creationReview(): Promise<UnitChangeReview<ReviewedUnit>>;
}

export function createBuildUnitChangeApprovalProvider(deps: {
  getBuildSystem(): BuildSystemV2;
  readWorkspaceFileAtState(stateHash: string, path: string): Promise<string | null>;
  describeCapability: CapabilityPresentationResolver;
  admissionStore: UnitAdmissionStore;
  /** Absent only in tests that exercise admission bookkeeping on its own. */
  grantStore?: CapabilityGrantStore;
  /**
   * What the user checked, carried from the review that accepted it. An absent
   * entry means this unit was never put to the user — a code-only update (U7)
   * carries no row of its own — and is answered from what its outgoing version
   * already held, or by the one-click slate when there is no outgoing version.
   */
  selections?: {
    leaseMany(identityKeys: Iterable<string>): {
      selections: ReadonlyMap<string, readonly string[]>;
      committed(): void;
      failed(): void;
    };
  };
  /** The human whose decision this was, for Permissions and audit. */
  decidedBy?: () => string;
  issuedBy?: () => string;
}): BuildUnitChangeApprovalProvider {
  const pendingIdentities = new Map<string, PendingIdentity>();

  const reviewIdentity = async (
    candidate: BuildUnitIdentityResolution,
    previous: BuildUnitIdentityResolution | null
  ): Promise<{
    unit: ReviewedUnit;
    identityKey: string;
    previousRequests: readonly UnitAuthorityRequest[] | null;
    /** Only the code identity moved; the declared authority is byte-identical. */
    authorityUnchanged: boolean;
  } | null> => {
    if (candidate.kind !== "panel" && candidate.kind !== "worker") {
      throw new Error(`Unexpected reviewed runtime kind: ${candidate.kind}`);
    }
    const packageJsonSource = await requirePackageJson(
      deps,
      candidate.stateHash,
      `${candidate.unitPath}/package.json`,
      candidate.unitName
    );
    const parsed = JSON.parse(packageJsonSource) as {
      name?: unknown;
      version?: unknown;
      vibestudio?: { displayName?: unknown; title?: unknown };
    };
    if (parsed.name !== candidate.unitName) {
      throw new Error(`Candidate package name does not match ${candidate.unitName}`);
    }

    const previousAuthority = previous
      ? authorityReviewFromPackageJson(
          await requirePackageJson(
            deps,
            previous.stateHash,
            `${previous.unitPath}/package.json`,
            previous.unitName
          ),
          previous.unitName
        )
      : { requests: [], provides: [] };
    const authority = authorityReviewFromPackageJson(
      packageJsonSource,
      candidate.unitName,
      {
        requests: previousAuthority.requests,
        provides: previousAuthority.provides,
      },
      deps.describeCapability,
      candidate.kind
    );
    const approvalIdentity: UnitAdmissionIdentity = {
      repoPath: candidate.unitPath,
      effectiveVersion: candidate.effectiveVersion,
      authority: {
        requests: authority.requests,
        provides: authority.provides,
      },
    };
    // A prepared publication may have completed admission before its ref write
    // failed. Exact identity is the durable deduplication key in every case;
    // never ask for the same decision again just because this is an update.
    if (deps.admissionStore.has(approvalIdentity)) return null;

    const identityKey = `workspace-unit:${sha256Canonical({
      kind: candidate.kind,
      name: candidate.unitName,
      source: candidate.unitPath,
      effectiveVersion: candidate.effectiveVersion,
      dependencyEvs: candidate.dependencyEvs,
      externalDeps: candidate.externalDeps,
      authority: {
        requests: authority.requests,
        provides: authority.provides,
      },
    })}`;
    pendingIdentities.set(identityKey, {
      identity: approvalIdentity,
      ...(previous
        ? {
            previous: {
              repoPath: previous.unitPath,
              effectiveVersion: previous.effectiveVersion,
            },
          }
        : {}),
    });
    return {
      previousRequests: previous ? previousAuthority.requests : null,
      // U7: a change that alters a unit's DECLARED AUTHORITY is reviewed; a
      // change that alters only its code identity is admitted by the accepting
      // decision without a row of its own.
      authorityUnchanged:
        previous !== null &&
        sha256Canonical({
          requests: previousAuthority.requests,
          provides: previousAuthority.provides,
        }) ===
          sha256Canonical({
            requests: authority.requests,
            provides: authority.provides,
          }),
      unit: {
        unitKind: candidate.kind,
        unitName: candidate.unitName,
        displayName:
          typeof parsed.vibestudio?.displayName === "string"
            ? parsed.vibestudio.displayName
            : typeof parsed.vibestudio?.title === "string"
              ? parsed.vibestudio.title
              : candidate.unitName,
        version: typeof parsed.version === "string" ? parsed.version : null,
        source: { kind: "workspace-repo", repo: candidate.unitPath, ref: "main" },
        ev: candidate.effectiveVersion,
        capabilities: [],
        authority,
        dependencyEvs: candidate.dependencyEvs,
        externalDeps: candidate.externalDeps,
        integrity: null,
      },
      identityKey,
    };
  };

  return {
    async unitChangeApprovalForCommit(stateHash: string): Promise<UnitChangeReview<ReviewedUnit>> {
      const buildSystem = deps.getBuildSystem();
      const [candidateIdentities, currentIdentities] = await Promise.all([
        buildSystem.listBuildUnitIdentities(stateHash, REVIEWED_RUNTIME_KINDS),
        buildSystem.listBuildUnitIdentities(undefined, REVIEWED_RUNTIME_KINDS),
      ]);
      const currentByName = new Map(
        currentIdentities.map((identity) => [identity.unitName, identity])
      );
      const units: ReviewedUnit[] = [];
      const identityKeys: string[] = [];
      const previousRequests = new Map<string, readonly UnitAuthorityRequest[]>();
      const identityKeysByRepo = new Map<string, string>();
      let unchangedCount = 0;

      for (const candidate of candidateIdentities) {
        const current = currentByName.get(candidate.unitName);
        if (current && identityFingerprint(current) === identityFingerprint(candidate)) continue;
        const review = await reviewIdentity(candidate, current ?? null);
        if (!review) continue;
        // Admitted either way — the accepting decision covers every unit the
        // publication lands. Only a declared-authority change earns a row.
        identityKeys.push(review.identityKey);
        identityKeysByRepo.set(candidate.unitPath, review.identityKey);
        if (review.authorityUnchanged) {
          unchangedCount += 1;
          continue;
        }
        units.push(review.unit);
        if (review.previousRequests)
          previousRequests.set(candidate.unitPath, review.previousRequests);
      }
      return { units, identityKeys, unchangedCount, previousRequests, identityKeysByRepo };
    },

    async creationReview(): Promise<UnitChangeReview<ReviewedUnit>> {
      const currentIdentities = await deps
        .getBuildSystem()
        .listBuildUnitIdentities(undefined, REVIEWED_RUNTIME_KINDS);
      const units: ReviewedUnit[] = [];
      const identityKeys: string[] = [];
      const identityKeysByRepo = new Map<string, string>();
      for (const candidate of currentIdentities) {
        // A part this workspace has NEVER reviewed, at any version.
        //
        // Deliberately not "unadmitted at this exact version". An effective
        // version commits `dependencyEvs`, so bumping one shared package
        // cascades a new EV across every unit that depends on it — a host
        // upgrade moves the whole workspace at once. Keyed on the exact
        // version, this would greet a user who upgraded with `Welcome — here's
        // what's in your workspace` and all fifty-three parts, which is the
        // card §5.4 and U7 exist to delete. A part whose EV moved has been
        // reviewed; what changed about it is a differential question, and
        // `unitChangeApprovalForCommit` is what answers it.
        if (deps.admissionStore.latestAdmittedVersion(candidate.unitPath) !== null) continue;
        const review = await reviewIdentity(candidate, null);
        if (!review) continue;
        units.push(review.unit);
        identityKeys.push(review.identityKey);
        identityKeysByRepo.set(candidate.unitPath, review.identityKey);
      }
      return { units, identityKeys, unchangedCount: 0, identityKeysByRepo };
    },

    preparePreapprovedTrust(
      keys: Iterable<string>,
      origin: UnitAdmissionOrigin = "publication",
      allowNow?: ReadonlyMap<string, readonly string[]>,
      sourceOrigins?: ReadonlyMap<string, UnitInstallSourceOrigin | null>
    ):
      | {
          committed(): void;
          failed(error: unknown): void;
        }
      | undefined {
      const accepted: Array<[string, PendingIdentity]> = [];
      for (const key of keys) {
        const identity = pendingIdentities.get(key);
        if (!identity) continue;
        accepted.push([key, identity]);
      }
      if (accepted.length === 0) return;
      // A review that offered per-permission choices hands its selection over
      // here. A decision that offered none — trusted chrome, an ordinary
      // publication, and every unit U7 admitted without a row — leaves its key
      // unanswered, which acceptance reads as "carry what this unit already
      // held" for an update and "the whole slate" for a first arrival. It must
      // not read as the full slate for both, or an EV-only update would hand
      // back the permissions the user unchecked at install (§7.3).
      const selectionLease =
        allowNow === undefined
          ? deps.selections?.leaseMany(accepted.map(([key]) => key))
          : undefined;
      const selected = allowNow ?? selectionLease?.selections;
      const acceptanceInput = {
        origin,
        units: accepted.map(([key, pending]) => ({
          identity: pending.identity,
          ...(pending.previous ? { previous: pending.previous } : {}),
          ...(selected?.has(key) ? { clearedRowKeys: selected.get(key)! } : {}),
          ...(sourceOrigins?.has(pending.identity.repoPath)
            ? { sourceOrigin: sourceOrigins.get(pending.identity.repoPath) ?? null }
            : {}),
        })),
      } satisfies Parameters<typeof prepareUnitInstallReview>[1];
      let transaction: UnitInstallAcceptanceTransaction;
      try {
        transaction = prepareUnitInstallReview(deps, acceptanceInput);
      } catch (error) {
        selectionLease?.failed();
        throw error;
      }
      let settled = false;
      return {
        committed: () => {
          if (settled) return;
          transaction.committed();
          selectionLease?.committed();
          for (const [key] of accepted) pendingIdentities.delete(key);
          settled = true;
        },
        failed: (error) => {
          if (settled) return;
          try {
            transaction.failed(error);
          } finally {
            selectionLease?.failed();
            settled = true;
          }
        },
      };
    },

    acceptPreapprovedTrust(
      keys: Iterable<string>,
      origin: UnitAdmissionOrigin = "publication",
      allowNow?: ReadonlyMap<string, readonly string[]>,
      sourceOrigins?: ReadonlyMap<string, UnitInstallSourceOrigin | null>
    ) {
      const prepare = this.preparePreapprovedTrust;
      const preparation = prepare?.(
        keys,
        origin as "workspace-creation" | "template-install" | "publication" | "chrome",
        allowNow,
        sourceOrigins
      );
      preparation?.committed();
    },
  };
}

/**
 * A unit awaiting the decision that will admit it, with the version it replaces.
 * The outgoing version is needed at acceptance so its clearance retires in the
 * same transaction that mints the new one.
 */
interface PendingIdentity {
  identity: UnitAdmissionIdentity;
  previous?: { repoPath: string; effectiveVersion: string };
}

function identityFingerprint(identity: BuildUnitIdentityResolution): string {
  return sha256Canonical({
    kind: identity.kind,
    name: identity.unitName,
    source: identity.unitPath,
    effectiveVersion: identity.effectiveVersion,
    dependencyEvs: identity.dependencyEvs,
    externalDeps: identity.externalDeps,
  });
}

async function requirePackageJson(
  deps: {
    readWorkspaceFileAtState(stateHash: string, path: string): Promise<string | null>;
  },
  stateHash: string,
  path: string,
  unitName: string
): Promise<string> {
  const source = await deps.readWorkspaceFileAtState(stateHash, path);
  if (!source) throw new Error(`Current manifest for ${unitName} is missing at ${path}`);
  return source;
}
