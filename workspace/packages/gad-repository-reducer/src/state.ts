import {
  cloneObjectRef,
  sameObjectRef,
  type ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";
import {
  asGadCommitIntentId,
  asGadEditId,
  asGadFileId,
  asGadHunkId,
  contentStoreObjectRefFromCanonicalV1,
  extractGadExternalObjectManifestV1,
  projectGadFilesToVibeWorktreeV1,
  type GadCommitIntentRowV1,
  type GadEditRowV1,
  type GadFileRowV1,
  type GadHunkRowV1,
  type GadWorktreeProjectionV1,
} from "@workspace/gad-repository-contract";
import type {
  GadRepositoryDatabaseRefV1,
  GadRepositoryImageV1,
  GadRepositoryReducerHostAdapterV1,
  GadWorkingDatabaseRefV1,
  GadWorkingImageV1,
} from "./types.js";

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const cloneFile = (file: GadFileRowV1): GadFileRowV1 => ({
  ...file,
  blobRef: cloneObjectRef(file.blobRef),
});

const cloneEdit = (edit: GadEditRowV1): GadEditRowV1 => ({
  ...edit,
  oldBlobRef: edit.oldBlobRef ? cloneObjectRef(edit.oldBlobRef) : null,
  newBlobRef: edit.newBlobRef ? cloneObjectRef(edit.newBlobRef) : null,
});

const cloneHunk = (hunk: GadHunkRowV1): GadHunkRowV1 => ({
  ...hunk,
  bodyRef: cloneObjectRef(hunk.bodyRef),
});

const cloneIntent = (intent: GadCommitIntentRowV1): GadCommitIntentRowV1 => ({ ...intent });

export function cloneRepositoryImageV1(image: GadRepositoryImageV1): GadRepositoryImageV1 {
  return {
    schemaVersion: 1,
    files: image.files.map(cloneFile),
    edits: image.edits.map(cloneEdit),
    hunks: image.hunks.map(cloneHunk),
    commitIntents: image.commitIntents.map(cloneIntent),
    headCommitIntentId: image.headCommitIntentId,
  };
}

export function cloneWorkingImageV1(image: GadWorkingImageV1): GadWorkingImageV1 {
  return {
    schemaVersion: 1,
    files: image.files.map(cloneFile),
    edits: image.edits.map(cloneEdit),
    hunks: image.hunks.map(cloneHunk),
    status: image.status,
    pendingMerge: image.pendingMerge
      ? {
          ...image.pendingMerge,
          mergeIntent: cloneIntent(image.pendingMerge.mergeIntent),
          ours: cloneRepositoryRefV1(image.pendingMerge.ours),
          theirs: cloneRepositoryRefV1(image.pendingMerge.theirs),
          conflicts: image.pendingMerge.conflicts.map((conflict) => ({ ...conflict })),
        }
      : null,
  };
}

export function cloneRepositoryRefV1(
  ref: GadRepositoryDatabaseRefV1
): GadRepositoryDatabaseRefV1 {
  return {
    kind: "gad.repositoryDatabase",
    database: { ...ref.database },
    commitHash: ref.commitHash,
  };
}

export function cloneWorkingRefV1(ref: GadWorkingDatabaseRefV1): GadWorkingDatabaseRefV1 {
  return {
    kind: "gad.workingDatabase",
    database: { ...ref.database },
    committedBase: cloneRepositoryRefV1(ref.committedBase),
  };
}

function requireUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    seen.add(id);
  }
}

function normalizeRows(input: {
  files: readonly GadFileRowV1[];
  edits: readonly GadEditRowV1[];
  hunks: readonly GadHunkRowV1[];
}): { files: GadFileRowV1[]; edits: GadEditRowV1[]; hunks: GadHunkRowV1[] } {
  const files = input.files.map(cloneFile).sort((left, right) => compareText(left.path, right.path));
  const edits = input.edits
    .map(cloneEdit)
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal || compareText(left.editId, right.editId)
    );
  const hunks = input.hunks
    .map(cloneHunk)
    .sort(
      (left, right) =>
        compareText(left.editId, right.editId) ||
        left.ordinal - right.ordinal ||
        compareText(left.hunkId, right.hunkId)
    );
  requireUnique(files, (file) => file.fileId, "Gad file ID");
  requireUnique(files, (file) => file.path, "Gad file path");
  requireUnique(edits, (edit) => edit.editId, "Gad edit ID");
  requireUnique(hunks, (hunk) => hunk.hunkId, "Gad hunk ID");
  const editIds = new Set(edits.map((edit) => edit.editId));
  for (const file of files) asGadFileId(file.fileId);
  for (const edit of edits) {
    asGadEditId(edit.editId);
  }
  for (const hunk of hunks) {
    asGadHunkId(hunk.hunkId);
    if (!editIds.has(hunk.editId)) throw new Error(`Gad hunk references missing edit: ${hunk.editId}`);
  }
  return { files, edits, hunks };
}

export function normalizeRepositoryImageV1(image: GadRepositoryImageV1): GadRepositoryImageV1 {
  if (image.schemaVersion !== 1) throw new Error("Unsupported Gad repository image version");
  const rows = normalizeRows(image);
  const commitIntents = image.commitIntents
    .map(cloneIntent)
    .sort((left, right) => compareText(left.commitIntentId, right.commitIntentId));
  requireUnique(commitIntents, (intent) => intent.commitIntentId, "Gad commit intent ID");
  const intentIds = new Set(commitIntents.map((intent) => intent.commitIntentId));
  for (const intent of commitIntents) asGadCommitIntentId(intent.commitIntentId);
  for (const edit of rows.edits) {
    if (edit.commitIntentId === null || !intentIds.has(edit.commitIntentId)) {
      throw new Error(`Committed repository edit lacks a known intent: ${edit.editId}`);
    }
  }
  if (image.headCommitIntentId !== null && !intentIds.has(image.headCommitIntentId)) {
    throw new Error(`Unknown Gad head commit intent: ${image.headCommitIntentId}`);
  }
  return { schemaVersion: 1, ...rows, commitIntents, headCommitIntentId: image.headCommitIntentId };
}

export function normalizeWorkingImageV1(image: GadWorkingImageV1): GadWorkingImageV1 {
  if (image.schemaVersion !== 1) throw new Error("Unsupported Gad working image version");
  const rows = normalizeRows(image);
  for (const edit of rows.edits) {
    if (edit.commitIntentId !== null) {
      throw new Error(`Working Gad edit is already assigned to a commit: ${edit.editId}`);
    }
  }
  if ((image.status === "pendingMerge") !== (image.pendingMerge !== null)) {
    throw new Error("Pending-merge status and record must agree");
  }
  if (image.status === "clean" && rows.edits.length > 0) {
    throw new Error("A clean Gad working image cannot contain edits");
  }
  return {
    schemaVersion: 1,
    ...rows,
    status: image.status,
    pendingMerge: image.pendingMerge
      ? {
          ...image.pendingMerge,
          conflicts: [...image.pendingMerge.conflicts].sort((left, right) =>
            compareText(left.path, right.path) || compareText(left.kind, right.kind)
          ),
        }
      : null,
  };
}

export async function verifyImageExternalObjectsV1(
  host: GadRepositoryReducerHostAdapterV1,
  image: Pick<GadRepositoryImageV1, "files" | "edits" | "hunks">
): Promise<void> {
  const manifest = extractGadExternalObjectManifestV1(image);
  for (const entry of manifest.entries) {
    const value = await host.readExactObject(entry.object);
    if (value === null) {
      const source = entry.sources[0];
      throw new Error(
        `Missing Gad external object${source ? ` for ${source.table}.${source.field}[${source.rowId}]` : ""}`
      );
    }
  }
}

export async function finalizeProjectionV1(
  host: GadRepositoryReducerHostAdapterV1,
  files: readonly GadFileRowV1[],
  expected?: ContentStoreObjectRef
): Promise<GadWorktreeProjectionV1> {
  const projection = projectGadFilesToVibeWorktreeV1(files, {
    emptyStoreId: host.getContentStoreId(),
  });
  if (expected && !sameObjectRef(projection.rootObject, expected)) {
    throw new Error("Gad worktree projection mismatch");
  }
  for (const object of projection.objects) {
    const admitted = await host.putExactObject(object.object.codec, object.bytes);
    if (!sameObjectRef(admitted, object.object)) {
      throw new Error("Gad host returned the wrong exact projection object");
    }
  }
  return projection;
}

export function sameRepositoryDatabaseRefV1(
  left: GadRepositoryDatabaseRefV1,
  right: GadRepositoryDatabaseRefV1
): boolean {
  return (
    left.commitHash === right.commitHash &&
    sameObjectRef(
      contentStoreObjectRefFromCanonicalV1(left.database),
      contentStoreObjectRefFromCanonicalV1(right.database)
    )
  );
}
