import {
  SHA2_256_HASH_ALGORITHM,
  bytesToHex,
  sameObjectRef,
  type ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";
import {
  VIBE_BLOB_CODEC,
} from "@vibestudio/shared/contentStore/vibeContentCodecs";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import {
  GAD_HUNK_CODEC_V1,
  asGadEditId,
  asGadHunkId,
  canonicalizeGadObjectRefV1,
  type GadCommitIntentRowV1,
  type GadEditRowV1,
  type GadFileRowV1,
  type GadHunkRowV1,
} from "@workspace/gad-repository-contract";
import { MergeEngine, decodeUtf8Text, type MergeHunk } from "@workspace/vcs-engine";
import { cloneRepositoryImageV1 } from "./state.js";
import type {
  GadExactMergeAdapterResultV1,
  GadMergeResolutionV1,
  GadRepositoryDatabaseRefV1,
  GadRepositoryImageV1,
  GadRepositoryReducerHostAdapterV1,
} from "./types.js";

export interface GadPortableMergeOperandV1 {
  ref: GadRepositoryDatabaseRefV1;
  image: GadRepositoryImageV1;
}

export interface GadPortableExactMergeInputV1 {
  base: GadPortableMergeOperandV1 | null;
  ours: GadPortableMergeOperandV1;
  theirs: GadPortableMergeOperandV1;
  intent: GadCommitIntentRowV1;
  resolutions: readonly GadMergeResolutionV1[];
}

type ExactObjectIo = Pick<
  GadRepositoryReducerHostAdapterV1,
  "getContentStoreId" | "readExactObject" | "putExactObject"
>;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function fileMap(image: GadRepositoryImageV1): Map<string, GadFileRowV1> {
  return new Map(image.files.map((file) => [file.path, file]));
}

function sameCodec(
  left: ContentStoreObjectRef["codec"],
  right: ContentStoreObjectRef["codec"]
): boolean {
  return left.number === right.number && left.version === right.version;
}

function canonicalEdit(edit: GadEditRowV1): unknown {
  return {
    ...edit,
    oldBlobRef: edit.oldBlobRef ? canonicalizeGadObjectRefV1(edit.oldBlobRef) : null,
    newBlobRef: edit.newBlobRef ? canonicalizeGadObjectRefV1(edit.newBlobRef) : null,
  };
}

function canonicalHunk(hunk: GadHunkRowV1): unknown {
  return { ...hunk, bodyRef: canonicalizeGadObjectRefV1(hunk.bodyRef) };
}

function mergeRows<T>(
  ours: readonly T[],
  theirs: readonly T[],
  key: (row: T) => string,
  canonical: (row: T) => unknown,
  label: string
): T[] {
  const result = new Map<string, T>();
  const encodings = new Map<string, string>();
  for (const row of [...ours, ...theirs]) {
    const id = key(row);
    const encoding = canonicalJson(canonical(row));
    const previous = encodings.get(id);
    if (previous !== undefined && previous !== encoding) {
      throw new Error(`Conflicting Gad ${label} identity during merge: ${id}`);
    }
    encodings.set(id, encoding);
    result.set(id, row);
  }
  return [...result.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, row]) => row);
}

/**
 * Portable Gad merge driver used behind `GadRepositoryReducerHostAdapterV1.mergeExact()` in tests
 * and by non-native hosts. A native Dolt host supplies the exact base/operands, then may use this
 * driver for Gad file-row conflicts before creating the native merge commit.
 */
export async function computePortableGadExactMergeV1(
  input: GadPortableExactMergeInputV1,
  io: ExactObjectIo
): Promise<GadExactMergeAdapterResultV1> {
  if (input.intent.operation !== "merge") throw new Error("A Gad merge requires a merge intent");
  const resolutionByPath = new Map<string, GadMergeResolutionV1>();
  for (const resolution of input.resolutions) {
    if (resolutionByPath.has(resolution.path)) {
      throw new Error(`Duplicate Gad merge resolution: ${resolution.path}`);
    }
    resolutionByPath.set(resolution.path, resolution);
  }

  const baseFiles = input.base ? fileMap(input.base.image) : new Map<string, GadFileRowV1>();
  const oursFiles = fileMap(input.ours.image);
  const theirsFiles = fileMap(input.theirs.image);
  const allFiles = [...baseFiles.values(), ...oursFiles.values(), ...theirsFiles.values()];
  const storeId = allFiles[0]?.blobRef.storeId.slice() ?? io.getContentStoreId().slice();
  if (storeId.byteLength === 0) throw new Error("Portable Gad merge requires a content store");
  const exactByDigest = new Map<string, ContentStoreObjectRef>();
  for (const file of allFiles) {
    if (
      bytesToHex(file.blobRef.storeId) !== bytesToHex(storeId) ||
      !sameCodec(file.blobRef.codec, VIBE_BLOB_CODEC) ||
      file.blobRef.contentId.algorithm !== SHA2_256_HASH_ALGORITHM
    ) {
      throw new Error("Portable Gad merge operands must use one frozen Vibe blob store/codec");
    }
    exactByDigest.set(bytesToHex(file.blobRef.contentId.digest), file.blobRef);
  }

  const states = new Map<string, GadRepositoryImageV1>([
    ["ours", input.ours.image],
    ["theirs", input.theirs.image],
  ]);
  let baseState: string | null = null;
  if (input.base) {
    if (input.base.ref.commitHash === input.ours.ref.commitHash) baseState = "ours";
    else if (input.base.ref.commitHash === input.theirs.ref.commitHash) baseState = "theirs";
    else {
      baseState = "base";
      states.set(baseState, input.base.image);
    }
  }
  const merge = new MergeEngine({
    listStateFiles: async (stateHash) => {
      const image = states.get(stateHash);
      if (!image) throw new Error(`Unknown portable Gad merge state: ${stateHash}`);
      return image.files.map((file) => ({
        path: file.path,
        contentHash: bytesToHex(file.blobRef.contentId.digest),
        mode: file.mode,
      }));
    },
    getMergeBase: async () => (input.base ? "base" : null),
    readBlob: async (digest) => {
      const object = exactByDigest.get(digest);
      return object ? await io.readExactObject(object) : null;
    },
    writeBlob: async (value) => {
      const object = await io.putExactObject(VIBE_BLOB_CODEC, value);
      if (
        bytesToHex(object.storeId) !== bytesToHex(storeId) ||
        !sameCodec(object.codec, VIBE_BLOB_CODEC) ||
        object.contentId.algorithm !== SHA2_256_HASH_ALGORITHM
      ) {
        throw new Error("Gad merge host returned a non-canonical blob reference");
      }
      const digest = bytesToHex(object.contentId.digest);
      exactByDigest.set(digest, object);
      return { digest, size: value.byteLength };
    },
  });
  const computation = await merge.compute3(
    { base: baseState, ours: "ours", theirs: "theirs" },
    { ours: input.ours.ref.commitHash, theirs: input.theirs.ref.commitHash }
  );

  if (computation.status === "up-to-date") {
    if (resolutionByPath.size > 0) throw new Error("Up-to-date merge has no conflicts to resolve");
    return {
      status: "up-to-date",
      baseCommitHash: input.base?.ref.commitHash ?? null,
      parents: [input.ours.ref.commitHash],
      image: cloneRepositoryImageV1(input.ours.image),
      provisionalWorking: null,
      conflicts: [],
    };
  }
  if (computation.status === "fast-forward") {
    if (resolutionByPath.size > 0) throw new Error("Fast-forward merge has no conflicts to resolve");
    return {
      status: "fast-forward",
      baseCommitHash: input.base?.ref.commitHash ?? null,
      parents: [input.theirs.ref.commitHash],
      image: cloneRepositoryImageV1(input.theirs.image),
      provisionalWorking: null,
      conflicts: [],
    };
  }

  const merged = new Map(
    computation.files.map((file) => [
      file.path,
      { path: file.path, contentHash: file.contentHash, mode: file.mode, hunks: file.hunks },
    ])
  );
  const conflictPaths = new Set(computation.conflicts.map((conflict) => conflict.path));
  for (const path of conflictPaths) {
    const resolution = resolutionByPath.get(path);
    if (!resolution) continue;
    if (resolution.choice === "content") {
      const object = await io.putExactObject(VIBE_BLOB_CODEC, new TextEncoder().encode(resolution.text));
      if (
        bytesToHex(object.storeId) !== bytesToHex(storeId) ||
        !sameCodec(object.codec, VIBE_BLOB_CODEC) ||
        object.contentId.algorithm !== SHA2_256_HASH_ALGORITHM
      ) {
        throw new Error("Gad merge host returned a non-canonical resolution blob");
      }
      const prior = oursFiles.get(path) ?? theirsFiles.get(path) ?? baseFiles.get(path);
      if (!prior) throw new Error(`Content resolution names an unknown path: ${path}`);
      const oursAtPath = oursFiles.get(path);
      const oldBytes = oursAtPath
        ? await io.readExactObject(oursAtPath.blobRef)
        : new Uint8Array();
      const oldText = oldBytes ? decodeUtf8Text(oldBytes) : null;
      merged.set(path, {
        path,
        contentHash: bytesToHex(object.contentId.digest),
        mode: resolution.mode ?? prior.mode,
        hunks: [
          {
            start: 0,
            end: oldText?.length ?? 0,
            newText: resolution.text,
            origin: "resolved",
          },
        ],
      });
      exactByDigest.set(bytesToHex(object.contentId.digest), object);
    } else {
      const chosen = (resolution.choice === "ours" ? oursFiles : theirsFiles).get(path);
      if (chosen) {
        merged.set(path, {
          path,
          contentHash: bytesToHex(chosen.blobRef.contentId.digest),
          mode: chosen.mode,
          hunks: undefined,
        });
      } else {
        merged.delete(path);
      }
    }
  }
  for (const path of resolutionByPath.keys()) {
    if (!conflictPaths.has(path)) throw new Error(`Resolution names a non-conflicting path: ${path}`);
  }
  const unresolved = computation.conflicts
    .filter((conflict) => !resolutionByPath.has(conflict.path))
    .map((conflict) => ({ ...conflict }))
    .sort((left, right) => compareText(left.path, right.path) || compareText(left.kind, right.kind));

  const resultFiles: GadFileRowV1[] = [];
  for (const file of [...merged.values()].sort((left, right) => compareText(left.path, right.path))) {
    const identity = oursFiles.get(file.path) ?? theirsFiles.get(file.path) ?? baseFiles.get(file.path);
    if (!identity) throw new Error(`Merged Gad path has no stable file identity: ${file.path}`);
    const object = exactByDigest.get(file.contentHash);
    if (!object) throw new Error(`Merged Gad blob is not an exact admitted object: ${file.contentHash}`);
    resultFiles.push({
      fileId: identity.fileId,
      path: file.path,
      blobRef: object,
      mode: file.mode,
    });
  }

  const newEdits: GadEditRowV1[] = [];
  const newHunks: GadHunkRowV1[] = [];
  const resultByPath = new Map(resultFiles.map((file) => [file.path, file]));
  const changedPaths = [...new Set([...oursFiles.keys(), ...resultByPath.keys()])]
    .filter((path) => {
      const ours = oursFiles.get(path);
      const result = resultByPath.get(path);
      return (
        (ours?.mode ?? null) !== (result?.mode ?? null) ||
        !(
          ours &&
          result &&
          sameObjectRef(ours.blobRef, result.blobRef)
        )
      );
    })
    .sort(compareText);
  for (const [ordinal, path] of changedPaths.entries()) {
    const before = oursFiles.get(path);
    const after = resultByPath.get(path);
    const editId = asGadEditId(`${input.intent.commitIntentId}:merge:${ordinal}`);
    const mergeFile = merged.get(path);
    const hasStructuredHunks = (mergeFile?.hunks?.length ?? 0) > 0;
    const identity = after ?? before;
    if (!identity) throw new Error(`Changed Gad path lacks a stable identity: ${path}`);
    newEdits.push({
      editId,
      fileId: identity.fileId,
      commitIntentId: unresolved.length === 0 ? input.intent.commitIntentId : null,
      invocationId: input.intent.invocationId,
      turnId: input.intent.turnId,
      actorRef: input.intent.actorRef,
      ordinal,
      kind: before ? (after ? "write" : "delete") : "create",
      path,
      oldBlobRef: before?.blobRef ?? null,
      newBlobRef: after?.blobRef ?? null,
      binary: false,
      synthetic: !hasStructuredHunks,
    });
    const structuredHunks = mergeFile?.hunks ?? [];
    for (const [hunkOrdinal, hunkValue] of structuredHunks.entries()) {
      const hunk = hunkValue as MergeHunk;
      const body = new TextEncoder().encode(canonicalJson(hunk));
      const bodyRef = await io.putExactObject(GAD_HUNK_CODEC_V1, body);
      if (!sameCodec(bodyRef.codec, GAD_HUNK_CODEC_V1)) {
        throw new Error("Gad merge host returned the wrong hunk codec");
      }
      newHunks.push({
        hunkId: asGadHunkId(`${editId}:hunk:${hunkOrdinal}`),
        editId,
        ordinal: hunkOrdinal,
        start: hunk.start,
        end: hunk.end,
        bodyRef,
        origin: hunk.origin,
        theirsStart: hunk.theirsStart ?? null,
        theirsEnd: hunk.theirsEnd ?? null,
      });
    }
  }

  const baseCommitHash = input.base?.ref.commitHash ?? null;
  if (unresolved.length > 0) {
    return {
      status: "conflicted",
      baseCommitHash,
      parents: [input.ours.ref.commitHash, input.theirs.ref.commitHash],
      image: cloneRepositoryImageV1(input.ours.image),
      provisionalWorking: {
        schemaVersion: 1,
        files: resultFiles,
        edits: newEdits,
        hunks: newHunks,
        status: "pendingMerge",
        pendingMerge: {
          mergeIntent: { ...input.intent },
          ours: input.ours.ref,
          theirs: input.theirs.ref,
          baseCommitHash,
          conflicts: unresolved,
        },
      },
      conflicts: unresolved,
    };
  }

  return {
    status: "clean",
    baseCommitHash,
    parents: [input.ours.ref.commitHash, input.theirs.ref.commitHash],
    image: {
      schemaVersion: 1,
      files: resultFiles,
      edits: [
        ...mergeRows(
          input.ours.image.edits,
          input.theirs.image.edits,
          (edit) => edit.editId,
          canonicalEdit,
          "edit"
        ),
        ...newEdits,
      ],
      hunks: [
        ...mergeRows(
          input.ours.image.hunks,
          input.theirs.image.hunks,
          (hunk) => hunk.hunkId,
          canonicalHunk,
          "hunk"
        ),
        ...newHunks,
      ],
      commitIntents: [
        ...mergeRows(
          input.ours.image.commitIntents,
          input.theirs.image.commitIntents,
          (intent) => intent.commitIntentId,
          (intent) => intent,
          "commit intent"
        ),
        { ...input.intent },
      ],
      headCommitIntentId: input.intent.commitIntentId,
    },
    provisionalWorking: null,
    conflicts: [],
  };
}
