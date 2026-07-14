import {
  bytesFromHex,
  bytesToHex,
  type ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { normalizeWorkspaceRepoPath } from "@workspace/vcs-engine";
import type { GadCommitIntentId } from "./schema.js";

export interface GadCanonicalObjectRefV1 {
  storeIdHex: string;
  codecNumber: number;
  codecVersion: number;
  hashAlgorithm: number;
  digestHex: string;
}

const LOWER_HEX_RE = /^(?:[0-9a-f]{2})+$/u;

function validateCanonicalObjectRefV1(object: GadCanonicalObjectRefV1): void {
  if (!LOWER_HEX_RE.test(object.storeIdHex)) throw new Error("Invalid canonical store ID");
  if (!LOWER_HEX_RE.test(object.digestHex)) throw new Error("Invalid canonical object digest");
  for (const [field, value] of [
    ["codec number", object.codecNumber],
    ["codec version", object.codecVersion],
    ["hash algorithm", object.hashAlgorithm],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid canonical object ${field}`);
    }
  }
}

export function canonicalizeGadObjectRefV1(object: ContentStoreObjectRef): GadCanonicalObjectRefV1 {
  if (object.storeId.byteLength === 0 || object.contentId.digest.byteLength === 0) {
    throw new Error("Canonical object refs require non-empty store and digest bytes");
  }
  const canonical = {
    storeIdHex: bytesToHex(object.storeId),
    codecNumber: object.codec.number,
    codecVersion: object.codec.version,
    hashAlgorithm: object.contentId.algorithm,
    digestHex: bytesToHex(object.contentId.digest),
  };
  validateCanonicalObjectRefV1(canonical);
  return canonical;
}

export function contentStoreObjectRefFromCanonicalV1(
  object: GadCanonicalObjectRefV1
): ContentStoreObjectRef {
  validateCanonicalObjectRefV1(object);
  return {
    storeId: bytesFromHex(object.storeIdHex),
    codec: { number: object.codecNumber, version: object.codecVersion },
    contentId: {
      algorithm: object.hashAlgorithm,
      digest: bytesFromHex(object.digestHex),
    },
  };
}

export interface GadDatabaseOutputTargetV1 {
  kind: "databaseOutput";
  outputName: string;
}

export type GadArtifactTargetV1 =
  | { kind: "artifactTemplate"; artifactName: string }
  | { kind: "exactArtifact"; object: GadCanonicalObjectRefV1 };

export interface GadRepositoryManifestTemplateV1 {
  kind: "gad.repository";
  schemaVersion: 1;
  database: GadDatabaseOutputTargetV1;
  history: GadArtifactTargetV1;
  currentExternalObjects: GadArtifactTargetV1;
  worktreeTree: GadCanonicalObjectRefV1;
  headCommitIntentId: GadCommitIntentId | null;
}

export interface GadWorkingSnapshotManifestTemplateV1 {
  kind: "gad.workingSnapshot";
  schemaVersion: 1;
  database: GadDatabaseOutputTargetV1;
  committedBase: GadArtifactTargetV1;
  status: "clean" | "dirty" | "pendingMerge";
  externalObjects: GadArtifactTargetV1;
  worktreeTree: GadCanonicalObjectRefV1;
}

export type GadContextRepoOverrideV1 =
  | { repoPath: string; state: "deleted" }
  | {
      repoPath: string;
      state: "present";
      committed: GadArtifactTargetV1;
      working: GadArtifactTargetV1 | null;
    };

export interface GadContextManifestTemplateV1 {
  kind: "gad.context";
  schemaVersion: 1;
  contextId: string;
  parentContextId: string | null;
  forkPointManifestId: string | null;
  baseRepositories: GadArtifactTargetV1;
  /** Canonical repo-path order, represented as an array rather than a JS map. */
  overrides: GadContextRepoOverrideV1[];
}

const BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

function validateDatabaseTarget(target: GadDatabaseOutputTargetV1): void {
  if (!BINDING_NAME_RE.test(target.outputName)) {
    throw new Error(`Invalid database output name: ${target.outputName}`);
  }
}

function validateArtifactTarget(target: GadArtifactTargetV1): void {
  if (target.kind === "artifactTemplate" && !BINDING_NAME_RE.test(target.artifactName)) {
    throw new Error(`Invalid artifact template name: ${target.artifactName}`);
  }
  if (target.kind === "exactArtifact") validateCanonicalObjectRefV1(target.object);
}

export function createGadRepositoryManifestTemplateV1(
  input: Omit<GadRepositoryManifestTemplateV1, "kind" | "schemaVersion">
): GadRepositoryManifestTemplateV1 {
  validateDatabaseTarget(input.database);
  validateArtifactTarget(input.history);
  validateArtifactTarget(input.currentExternalObjects);
  validateCanonicalObjectRefV1(input.worktreeTree);
  return { kind: "gad.repository", schemaVersion: 1, ...input };
}

export function createGadWorkingSnapshotManifestTemplateV1(
  input: Omit<GadWorkingSnapshotManifestTemplateV1, "kind" | "schemaVersion">
): GadWorkingSnapshotManifestTemplateV1 {
  validateDatabaseTarget(input.database);
  validateArtifactTarget(input.committedBase);
  validateArtifactTarget(input.externalObjects);
  validateCanonicalObjectRefV1(input.worktreeTree);
  return { kind: "gad.workingSnapshot", schemaVersion: 1, ...input };
}

export function createGadContextManifestTemplateV1(
  input: Omit<GadContextManifestTemplateV1, "kind" | "schemaVersion" | "overrides"> & {
    overrides: readonly GadContextRepoOverrideV1[];
  }
): GadContextManifestTemplateV1 {
  validateArtifactTarget(input.baseRepositories);
  const seen = new Set<string>();
  const overrides = [...input.overrides].sort((left, right) =>
    left.repoPath < right.repoPath ? -1 : left.repoPath > right.repoPath ? 1 : 0
  );
  for (const override of overrides) {
    normalizeWorkspaceRepoPath(override.repoPath);
    if (seen.has(override.repoPath))
      throw new Error(`Duplicate context repository: ${override.repoPath}`);
    seen.add(override.repoPath);
    if (override.state === "present") {
      validateArtifactTarget(override.committed);
      if (override.working) validateArtifactTarget(override.working);
    }
  }
  return {
    kind: "gad.context",
    schemaVersion: 1,
    contextId: input.contextId,
    parentContextId: input.parentContextId,
    forkPointManifestId: input.forkPointManifestId,
    baseRepositories: input.baseRepositories,
    overrides,
  };
}

/** Canonical bytes consumed by the generic typed-artifact template boundary. */
export function encodeGadManifestTemplateV1(
  manifest:
    | GadRepositoryManifestTemplateV1
    | GadWorkingSnapshotManifestTemplateV1
    | GadContextManifestTemplateV1
): Uint8Array {
  return new TextEncoder().encode(canonicalJson(manifest));
}
