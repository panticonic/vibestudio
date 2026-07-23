import type { UnitBatchEntry } from "@vibestudio/shared/approvals";
import type { CapabilityPresentationResolver } from "@vibestudio/shared/authorityPresentation";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import {
  authorityReviewFromPackageJson,
  type UnitChangeApprovalProvider,
} from "@vibestudio/unit-host";
import type { BuildSystemV2, BuildUnitIdentityResolution } from "../buildV2/index.js";
import type {
  UnitVersionApprovalIdentity,
  UnitVersionApprovalStore,
} from "./unitVersionApprovalStore.js";

const REVIEWED_RUNTIME_KINDS = ["panel", "worker"] as const;

/**
 * Adds browser panels and workerd units to the protected-main review. Native
 * apps/extensions have activation-owning providers; panels/workers are admitted
 * by the accepted protected publication itself, but must present the same
 * exact-version manifest delta in that one decision.
 */
export interface BuildUnitChangeApprovalProvider extends UnitChangeApprovalProvider<UnitBatchEntry> {
  startupApproval(): Promise<{ units: UnitBatchEntry[]; identityKeys: string[] }>;
}

export function createBuildUnitChangeApprovalProvider(deps: {
  getBuildSystem(): BuildSystemV2;
  readWorkspaceFileAtState(stateHash: string, path: string): Promise<string | null>;
  describeCapability: CapabilityPresentationResolver;
  approvalStore: UnitVersionApprovalStore;
}): BuildUnitChangeApprovalProvider {
  const pendingIdentities = new Map<string, UnitVersionApprovalIdentity>();

  const reviewIdentity = async (
    candidate: BuildUnitIdentityResolution,
    previous: BuildUnitIdentityResolution | null
  ): Promise<{ unit: UnitBatchEntry; identityKey: string } | null> => {
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
      vibestudio?: { displayName?: unknown };
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
      : { requests: [], evalCeilings: [] };
    const authority = authorityReviewFromPackageJson(
      packageJsonSource,
      candidate.unitName,
      {
        requests: previousAuthority.requests,
        evalCeilings: previousAuthority.evalCeilings,
      },
      deps.describeCapability,
      candidate.kind
    );
    const approvalIdentity: UnitVersionApprovalIdentity = {
      repoPath: candidate.unitPath,
      effectiveVersion: candidate.effectiveVersion,
      authority: {
        requests: authority.requests,
        evalCeilings: authority.evalCeilings,
      },
    };
    if (!previous && deps.approvalStore.has(approvalIdentity)) return null;

    const identityKey = `workspace-unit:${sha256Canonical({
      kind: candidate.kind,
      name: candidate.unitName,
      source: candidate.unitPath,
      effectiveVersion: candidate.effectiveVersion,
      dependencyEvs: candidate.dependencyEvs,
      externalDeps: candidate.externalDeps,
      authority: {
        requests: authority.requests,
        evalCeilings: authority.evalCeilings,
      },
    })}`;
    pendingIdentities.set(identityKey, approvalIdentity);
    return {
      unit: {
        unitKind: candidate.kind,
        unitName: candidate.unitName,
        displayName:
          typeof parsed.vibestudio?.displayName === "string"
            ? parsed.vibestudio.displayName
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
    async unitChangeApprovalForCommit(
      stateHash: string
    ): Promise<{ units: UnitBatchEntry[]; identityKeys: string[] }> {
      const buildSystem = deps.getBuildSystem();
      const [candidateIdentities, currentIdentities] = await Promise.all([
        buildSystem.listBuildUnitIdentities(stateHash, REVIEWED_RUNTIME_KINDS),
        buildSystem.listBuildUnitIdentities(undefined, REVIEWED_RUNTIME_KINDS),
      ]);
      const currentByName = new Map(
        currentIdentities.map((identity) => [identity.unitName, identity])
      );
      const units: UnitBatchEntry[] = [];
      const identityKeys: string[] = [];

      for (const candidate of candidateIdentities) {
        const current = currentByName.get(candidate.unitName);
        if (current && identityFingerprint(current) === identityFingerprint(candidate)) continue;
        const review = await reviewIdentity(candidate, current ?? null);
        if (!review) continue;
        units.push(review.unit);
        identityKeys.push(review.identityKey);
      }
      return { units, identityKeys };
    },

    async startupApproval(): Promise<{ units: UnitBatchEntry[]; identityKeys: string[] }> {
      const currentIdentities = await deps
        .getBuildSystem()
        .listBuildUnitIdentities(undefined, REVIEWED_RUNTIME_KINDS);
      const units: UnitBatchEntry[] = [];
      const identityKeys: string[] = [];
      for (const candidate of currentIdentities) {
        const review = await reviewIdentity(candidate, null);
        if (!review) continue;
        units.push(review.unit);
        identityKeys.push(review.identityKey);
      }
      return { units, identityKeys };
    },

    acceptPreapprovedTrust(keys: Iterable<string>) {
      const accepted: Array<[string, UnitVersionApprovalIdentity]> = [];
      for (const key of keys) {
        const identity = pendingIdentities.get(key);
        if (!identity) continue;
        accepted.push([key, identity]);
      }
      deps.approvalStore.approveMany(accepted.map(([, identity]) => identity));
      for (const [key] of accepted) pendingIdentities.delete(key);
    },
  };
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
