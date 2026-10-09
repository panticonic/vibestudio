/** Portable execution identity and artifact contracts. */

/** Full SHA-256 values are the only executable/security identifiers. */
export interface Sha256Brand { readonly __sha256: unique symbol }
export type Sha256 = string & Sha256Brand;

export interface SourceRevisionRef {
  repoPath: string;
  sourceEv: Sha256;
  stateHash: Sha256;
}

export type CanonicalBuildValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalBuildValue[]
  | { readonly [key: string]: CanonicalBuildValue };

export type CanonicalBuildOptions = Readonly<Record<string, CanonicalBuildValue>>;

export interface ToolchainManifestRef {
  digest: Sha256;
  components: Readonly<Record<string, Sha256>>;
}

export interface LockedDependencyGraphRef {
  digest: Sha256;
}

export interface BuildRecipe {
  target: string;
  platform: string;
  architecture: string;
  abi: string | null;
  options: CanonicalBuildOptions;
  toolchain: ToolchainManifestRef;
  dependencyGraph: LockedDependencyGraphRef;
  /** Exact builder/plugin code, separate from the tool binaries it invokes. */
  builderDigest: Sha256;
  /** Names and values of the non-secret environment admitted to the build. */
  declaredEnvironment: Readonly<Record<string, string>>;
}

export type ExecutionSelector =
  | { kind: "head"; repoPath: string; head: "main" | { contextId: string } }
  | { kind: "state"; repoPath: string; stateHash: Sha256 }
  | { kind: "artifact"; executionDigest: Sha256 };

export type SelectorPolicy = ExecutionSelector;

export type AdoptionPolicy =
  | { kind: "next-request" }
  | { kind: "cache-invalidation" }
  | { kind: "queued-user-action"; action: string }
  | { kind: "mobile-install" }
  | { kind: "process-restart" };

export interface ArtifactManifestEntry {
  path: string;
  role: string;
  size: number;
  mode: 0o644 | 0o755;
  contentType: string;
  digest: Sha256;
}

export interface ArtifactManifest {
  version: 1;
  source: SourceRevisionRef;
  recipeDigest: Sha256;
  buildKey: Sha256;
  entries: readonly ArtifactManifestEntry[];
}

export interface ArtifactBundleEntry {
  path: string;
  role: string;
  mode: 0o644 | 0o755;
  contentType: string;
  bytes: Uint8Array;
}

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
