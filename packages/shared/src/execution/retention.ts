import { canonicalJson } from "@vibestudio/content-addressing";
import { domainHash, parseSha256, type Sha256 } from "./identity.js";

export type ExecutionOwnerKind =
  | "runtime-entity"
  | "panel-history"
  | "app-generation"
  | "extension-generation"
  | "terminal-app"
  | "runtime-image"
  | "eval-run"
  | "development-run"
  | "product-seed";

export type ExecutionRootReason =
  | "active"
  | "pinned"
  | "rollback"
  | "in-flight"
  | "retained-result";

export interface ExecutionSourceContentRoot {
  readonly repoPath: string | null;
  readonly stateHash: string;
}

export type ExecutionSourceStateRef =
  | { readonly kind: "event"; readonly eventId: string }
  | { readonly kind: "application"; readonly applicationId: string }
  | { readonly kind: "bootstrap-snapshot"; readonly snapshotHash: string };

interface ExecutionSourceIdentityBaseV1 {
  readonly workspaceId: string;
  readonly effectiveVersion: Sha256;
  readonly contentRoots: readonly ExecutionSourceContentRoot[];
  readonly sourceClosureDigest: Sha256;
}

export type ExecutionSourceIdentityV1 =
  | (ExecutionSourceIdentityBaseV1 & {
      readonly kind: "workspace";
      readonly state: ExecutionSourceStateRef;
    })
  | (ExecutionSourceIdentityBaseV1 & {
      readonly kind: "product-seed";
      readonly state: null;
    });

/** Complete immutable identity used by every authoritative executable owner. */
export interface ExecutionArtifactRefV1 {
  readonly version: 1;
  readonly sourceState: ExecutionSourceIdentityV1;
  readonly recipeDigest: Sha256;
  readonly buildKey: Sha256;
  readonly artifactDigest: Sha256;
  readonly executionDigest: Sha256;
}

export interface ExecutionRoot {
  readonly owner: ExecutionOwnerKind;
  readonly ownerId: string;
  readonly reason: ExecutionRootReason;
  readonly artifact: ExecutionArtifactRefV1;
}

export interface ExecutionRootProvider {
  readonly id: string;
  readonly mandatory: boolean;
  snapshotRoots(epoch: number): Promise<readonly ExecutionRoot[]>;
}

export interface ExecutionPublicationArtifact {
  readonly buildKey: string;
  readonly executionDigest: string;
}

export interface ExecutionPublication {
  readonly owner: ExecutionOwnerKind;
  readonly ownerId: string;
  readonly artifacts: readonly ExecutionPublicationArtifact[];
}

export interface ExecutionPublicationReservation {
  readonly reservationId: string;
  readonly epoch: number;
}

/**
 * Portable owner-publication interlock.
 *
 * reserve() is durable before the owner write starts; finalize() is durable
 * only after that owner's atomic write is visible. A caller must deliberately
 * leave an ambiguous reservation open on failure so restart reconciliation is
 * conservative.
 */
export interface ExecutionPublicationPort {
  reserve(publication: ExecutionPublication): ExecutionPublicationReservation;
  finalize(reservation: ExecutionPublicationReservation): void;
}

export function publishExecutionOwner<T>(
  port: ExecutionPublicationPort | undefined,
  publication: ExecutionPublication,
  atomicOwnerWrite: () => T
): T {
  if (!port || publication.artifacts.length === 0) return atomicOwnerWrite();
  const reservation = port.reserve(publication);
  const result = atomicOwnerWrite();
  port.finalize(reservation);
  return result;
}

export async function publishExecutionOwnerAsync<T>(
  port: ExecutionPublicationPort | undefined,
  publication: ExecutionPublication,
  atomicOwnerWrite: () => Promise<T>
): Promise<T> {
  if (!port || publication.artifacts.length === 0) return atomicOwnerWrite();
  const reservation = port.reserve(publication);
  const result = await atomicOwnerWrite();
  port.finalize(reservation);
  return result;
}

const STATE_HASH = /^state:[0-9a-f]{64}$/u;

function canonicalExecutionSourceState(
  state: ExecutionSourceStateRef,
  contentRoots: readonly ExecutionSourceContentRoot[]
): ExecutionSourceStateRef {
  switch (state.kind) {
    case "event":
      if (!state.eventId) throw new Error("Execution event source identity is required");
      return { kind: "event", eventId: state.eventId };
    case "application":
      if (!state.applicationId) {
        throw new Error("Execution application source identity is required");
      }
      return { kind: "application", applicationId: state.applicationId };
    case "bootstrap-snapshot":
      if (!STATE_HASH.test(state.snapshotHash)) {
        throw new Error("Execution bootstrap snapshot is not a canonical state hash");
      }
      if (contentRoots.some((root) => root.stateHash !== state.snapshotHash)) {
        throw new Error("Execution bootstrap snapshot does not match its content roots");
      }
      return { kind: "bootstrap-snapshot", snapshotHash: state.snapshotHash };
    default:
      throw new Error("Unsupported workspace execution source state");
  }
}

export function canonicalExecutionSourceRoots(
  roots: readonly ExecutionSourceContentRoot[]
): readonly ExecutionSourceContentRoot[] {
  const unique = new Map<string, ExecutionSourceContentRoot>();
  for (const root of roots) {
    if (!STATE_HASH.test(root.stateHash)) {
      throw new Error(`Execution source root is not a canonical state hash: ${root.stateHash}`);
    }
    if (root.repoPath !== null && (!root.repoPath || root.repoPath.includes("\0"))) {
      throw new Error("Execution source root has an invalid repository path");
    }
    const key = `${root.repoPath ?? ""}\0${root.stateHash}`;
    unique.set(key, { repoPath: root.repoPath, stateHash: root.stateHash });
  }
  const canonical = [...unique.values()].sort(
    (left, right) =>
      (left.repoPath ?? "").localeCompare(right.repoPath ?? "") ||
      left.stateHash.localeCompare(right.stateHash)
  );
  if (canonical.length === 0) {
    throw new Error("Reconstructible execution identity requires at least one content root");
  }
  return canonical;
}

export function executionSourceClosureDigest(roots: readonly ExecutionSourceContentRoot[]): Sha256 {
  return domainHash(
    "vibestudio/execution-source/v1",
    canonicalJson(canonicalExecutionSourceRoots(roots))
  );
}

export type UnsignedExecutionArtifactRefV1 = Omit<ExecutionArtifactRefV1, "executionDigest">;

/**
 * Producer-neutral executable identity.
 *
 * The commitment deliberately includes the complete semantic/content source
 * identity and keeps recipe identity independent from the artifact locator.
 * BuildV2, development runs, eval imports, and product seeds therefore share
 * one verifier without pretending they use the same build recipe.
 */
export function executionArtifactDigest(ref: UnsignedExecutionArtifactRefV1): Sha256 {
  const contentRoots = canonicalExecutionSourceRoots(ref.sourceState.contentRoots);
  const sourceState: ExecutionSourceIdentityV1 =
    ref.sourceState.kind === "workspace"
      ? {
          kind: "workspace",
          workspaceId: ref.sourceState.workspaceId,
          effectiveVersion: parseSha256(
            ref.sourceState.effectiveVersion,
            "execution source effective version"
          ),
          state: canonicalExecutionSourceState(ref.sourceState.state, contentRoots),
          contentRoots,
          sourceClosureDigest: parseSha256(
            ref.sourceState.sourceClosureDigest,
            "execution source closure digest"
          ),
        }
      : {
          kind: "product-seed",
          workspaceId: ref.sourceState.workspaceId,
          effectiveVersion: parseSha256(
            ref.sourceState.effectiveVersion,
            "execution source effective version"
          ),
          state: null,
          contentRoots,
          sourceClosureDigest: parseSha256(
            ref.sourceState.sourceClosureDigest,
            "execution source closure digest"
          ),
        };
  return domainHash(
    "vibestudio/execution-artifact/v1",
    canonicalJson({
      version: 1,
      sourceState,
      recipeDigest: parseSha256(ref.recipeDigest, "execution recipe digest"),
      buildKey: parseSha256(ref.buildKey, "execution build key"),
      artifactDigest: parseSha256(ref.artifactDigest, "execution artifact digest"),
    })
  );
}

/** Verify the complete ref at every durable/provider boundary. */
export function verifyExecutionArtifactRef(ref: ExecutionArtifactRefV1): ExecutionArtifactRefV1 {
  if (ref.version !== 1) throw new Error(`Unsupported execution artifact ref version`);
  const contentRoots = canonicalExecutionSourceRoots(ref.sourceState.contentRoots);
  if (!ref.sourceState.workspaceId) throw new Error("Execution source workspaceId is required");
  if (ref.sourceState.kind === "workspace" && !ref.sourceState.state) {
    throw new Error("Workspace execution source state is required");
  }
  if (
    ref.sourceState.kind === "product-seed" &&
    contentRoots.some((root) => root.repoPath !== null)
  ) {
    throw new Error("Product-seed execution content roots cannot name a workspace repository");
  }
  const expectedClosure = executionSourceClosureDigest(contentRoots);
  const sourceClosureDigest = parseSha256(
    ref.sourceState.sourceClosureDigest,
    "execution source closure digest"
  );
  if (sourceClosureDigest !== expectedClosure) {
    throw new Error("Execution source closure digest does not match its content roots");
  }
  const effectiveVersion = parseSha256(
    ref.sourceState.effectiveVersion,
    "execution source effective version"
  );
  const recipeDigest = parseSha256(ref.recipeDigest, "execution recipe digest");
  const buildKey = parseSha256(ref.buildKey, "execution build key");
  const artifactDigest = parseSha256(ref.artifactDigest, "execution artifact digest");
  const executionDigest = parseSha256(ref.executionDigest, "execution digest");
  const sourceState: ExecutionSourceIdentityV1 =
    ref.sourceState.kind === "workspace"
      ? {
          kind: "workspace",
          workspaceId: ref.sourceState.workspaceId,
          effectiveVersion,
          state: canonicalExecutionSourceState(ref.sourceState.state, contentRoots),
          contentRoots,
          sourceClosureDigest,
        }
      : {
          kind: "product-seed",
          workspaceId: ref.sourceState.workspaceId,
          effectiveVersion,
          state: null,
          contentRoots,
          sourceClosureDigest,
        };
  const expectedExecutionDigest = executionArtifactDigest({
    version: 1,
    sourceState,
    recipeDigest,
    buildKey,
    artifactDigest,
  });
  if (executionDigest !== expectedExecutionDigest) {
    throw new Error("Execution digest does not match its source, recipe, build, and artifact");
  }
  return {
    version: 1,
    sourceState,
    recipeDigest,
    buildKey,
    artifactDigest,
    executionDigest,
  };
}
