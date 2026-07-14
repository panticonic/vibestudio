import type {
  ContentStoreCodecId,
  ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";
import type {
  GadCanonicalObjectRefV1,
  GadCommitIntentRowV1,
  GadEditId,
  GadEditRowV1,
  GadFileId,
  GadFileRowV1,
  GadHunkRowV1,
  GadRepositoryManifestTemplateV1,
  GadWorkingSnapshotManifestTemplateV1,
} from "@workspace/gad-repository-contract";
import type { EditOp } from "@workspace/vcs-engine";

export const GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION = 1 as const;
export const GAD_REPOSITORY_INPUT_NAME = "repository" as const;
export const GAD_WORKING_INPUT_NAME = "working" as const;
export const GAD_REPOSITORY_OUTPUT_NAME = "repository" as const;
export const GAD_WORKING_OUTPUT_NAME = "working" as const;

declare const doltCommitHashBrand: unique symbol;
export type GadDoltCommitHash = string & { readonly [doltCommitHashBrand]: true };

const DOLT_COMMIT_HASH_RE = /^(?!0{40}$)[0-9a-f]{40}$/u;

/** The pinned DoltLite integration exposes exact non-null 40-character lowercase hex hashes. */
export function asGadDoltCommitHash(value: string): GadDoltCommitHash {
  if (!DOLT_COMMIT_HASH_RE.test(value)) {
    throw new Error("Invalid exact Dolt commit hash");
  }
  return value as GadDoltCommitHash;
}

export interface GadRepositoryDatabaseRefV1 {
  kind: "gad.repositoryDatabase";
  database: GadCanonicalObjectRefV1;
  commitHash: GadDoltCommitHash;
}

export interface GadWorkingDatabaseRefV1 {
  kind: "gad.workingDatabase";
  database: GadCanonicalObjectRefV1;
  committedBase: GadRepositoryDatabaseRefV1;
}

export interface GadNamedRepositoryInputV1 {
  logicalName: typeof GAD_REPOSITORY_INPUT_NAME;
  sqlAlias: "repository_in";
  ref: GadRepositoryDatabaseRefV1;
}

export interface GadNamedWorkingInputV1 {
  logicalName: typeof GAD_WORKING_INPUT_NAME;
  sqlAlias: "working_in";
  ref: GadWorkingDatabaseRefV1;
}

export interface GadNamedMergeInputV1 {
  logicalName: string;
  sqlAlias: string;
  ref: GadRepositoryDatabaseRefV1;
}

export interface GadRepositoryReducerInputsV1 {
  repository: GadNamedRepositoryInputV1 | null;
  working: GadNamedWorkingInputV1 | null;
  merges: readonly GadNamedMergeInputV1[];
}

export const GAD_REPOSITORY_REDUCER_OUTPUTS_V1 = {
  repository: { logicalName: GAD_REPOSITORY_OUTPUT_NAME, sqlAlias: "repository_out" },
  working: { logicalName: GAD_WORKING_OUTPUT_NAME, sqlAlias: "working_out" },
} as const;

export interface GadRepositoryImageV1 {
  schemaVersion: 1;
  files: GadFileRowV1[];
  edits: GadEditRowV1[];
  hunks: GadHunkRowV1[];
  commitIntents: GadCommitIntentRowV1[];
  headCommitIntentId: GadCommitIntentRowV1["commitIntentId"] | null;
}

export interface GadWorkingImageV1 {
  schemaVersion: 1;
  files: GadFileRowV1[];
  edits: GadEditRowV1[];
  hunks: GadHunkRowV1[];
  status: "clean" | "dirty" | "pendingMerge";
  pendingMerge: GadPendingMergeV1 | null;
}

export interface GadPendingMergeV1 {
  mergeIntent: GadCommitIntentRowV1;
  ours: GadRepositoryDatabaseRefV1;
  theirs: GadRepositoryDatabaseRefV1;
  baseCommitHash: GadDoltCommitHash | null;
  conflicts: GadMergeConflictV1[];
}

export interface GadReducerEditOperationV1 {
  editId: GadEditId;
  /** Required only when this edit creates a previously-untracked path. */
  newFileId?: GadFileId;
  operation: EditOp;
}

export interface GadEditProvenanceV1 {
  actorRef: string;
  invocationId: string | null;
  turnId: string | null;
}

export type GadMergeResolutionV1 =
  | { path: string; choice: "ours" | "theirs" }
  | { path: string; choice: "content"; text: string; mode?: number };

export interface GadMergeConflictV1 {
  path: string;
  kind: "content" | "binary" | "delete-vs-change" | "mode" | "row" | "schema";
}

export interface GadImportOperationV1 {
  kind: "import";
  fixtureName: string;
  repository: GadRepositoryImageV1;
  working: GadWorkingImageV1 | null;
  expectedWorktreeRoot?: ContentStoreObjectRef;
}

export interface GadEditOperationV1 {
  kind: "edit";
  edits: readonly GadReducerEditOperationV1[];
  provenance: GadEditProvenanceV1;
  expectedWorktreeRoot?: ContentStoreObjectRef;
}

export interface GadCommitSelectedOperationV1 {
  kind: "commitSelected";
  selectedEditIds: readonly GadEditId[];
  intent: GadCommitIntentRowV1;
  expectedWorktreeRoot?: ContentStoreObjectRef;
}

export interface GadMergeStepV1 {
  inputName: string;
  intent: GadCommitIntentRowV1;
  resolutions: readonly GadMergeResolutionV1[];
}

export interface GadMergeSequentialOperationV1 {
  kind: "mergeSequential";
  steps: readonly GadMergeStepV1[];
  expectedWorktreeRoot?: ContentStoreObjectRef;
}

export type GadRepositoryReducerOperationV1 =
  | GadImportOperationV1
  | GadEditOperationV1
  | GadCommitSelectedOperationV1
  | GadMergeSequentialOperationV1;

export interface GadPublicationIntentV1 {
  targetRef: string;
  expected: GadRepositoryDatabaseRefV1 | null;
  reason: string;
}

export interface GadRepositoryReducerRequestV1 {
  protocolVersion: typeof GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION;
  inputs: GadRepositoryReducerInputsV1;
  operation: GadRepositoryReducerOperationV1;
  publication: GadPublicationIntentV1 | null;
}

export interface GadFinalizeRepositoryRequestV1 {
  outputName: typeof GAD_REPOSITORY_OUTPUT_NAME;
  source: GadRepositoryDatabaseRefV1 | null;
  image: GadRepositoryImageV1;
  parents: readonly GadDoltCommitHash[];
  intent: GadCommitIntentRowV1;
  physicalPurpose: "import" | "commit" | "merge";
}

export interface GadFinalizeWorkingRequestV1 {
  outputName: typeof GAD_WORKING_OUTPUT_NAME;
  source: GadWorkingDatabaseRefV1 | null;
  committedBase: GadRepositoryDatabaseRefV1;
  image: GadWorkingImageV1;
}

export interface GadExactMergeAdapterRequestV1 {
  ours: GadRepositoryDatabaseRefV1;
  oursImage: GadRepositoryImageV1;
  theirs: GadRepositoryDatabaseRefV1;
  intent: GadCommitIntentRowV1;
  resolutions: readonly GadMergeResolutionV1[];
}

export interface GadExactMergeAdapterResultV1 {
  status: "clean" | "conflicted" | "up-to-date" | "fast-forward";
  baseCommitHash: GadDoltCommitHash | null;
  parents: readonly GadDoltCommitHash[];
  image: GadRepositoryImageV1;
  provisionalWorking: GadWorkingImageV1 | null;
  conflicts: GadMergeConflictV1[];
}

/**
 * Host seam for a future workerd reducer binding. Every database operation consumes exact immutable
 * refs and creates a new immutable output. Mutable branches/heads/publication are intentionally not
 * representable by this interface.
 */
export interface GadRepositoryReducerHostAdapterV1 {
  /** Configured exact CAS store used when an empty repository has no file row from which to derive it. */
  getContentStoreId(): Uint8Array;
  readExactObject(object: ContentStoreObjectRef): Promise<Uint8Array | null>;
  putExactObject(codec: ContentStoreCodecId, bytes: Uint8Array): Promise<ContentStoreObjectRef>;
  loadRepository(ref: GadRepositoryDatabaseRefV1): Promise<GadRepositoryImageV1>;
  loadWorking(ref: GadWorkingDatabaseRefV1): Promise<GadWorkingImageV1>;
  finalizeRepository(
    request: GadFinalizeRepositoryRequestV1
  ): Promise<GadRepositoryDatabaseRefV1>;
  finalizeWorking(request: GadFinalizeWorkingRequestV1): Promise<GadWorkingDatabaseRefV1>;
  mergeExact(request: GadExactMergeAdapterRequestV1): Promise<GadExactMergeAdapterResultV1>;
}

export interface GadRepositoryPublicationRequestV1 {
  kind: "gad.repositoryPublicationRequest";
  targetRef: string;
  expected: GadRepositoryDatabaseRefV1 | null;
  outputName: typeof GAD_REPOSITORY_OUTPUT_NAME;
  repository: GadRepositoryDatabaseRefV1;
  reason: string;
}

export interface GadRepositoryReducerResultV1 {
  protocolVersion: 1;
  repository: GadRepositoryDatabaseRefV1;
  working: GadWorkingDatabaseRefV1 | null;
  repositoryManifest: GadRepositoryManifestTemplateV1;
  workingManifest: GadWorkingSnapshotManifestTemplateV1 | null;
  publicationRequest: GadRepositoryPublicationRequestV1 | null;
  mergeResults: Array<{
    inputName: string;
    status: GadExactMergeAdapterResultV1["status"];
    baseCommitHash: GadDoltCommitHash | null;
    conflicts: GadMergeConflictV1[];
  }>;
}
