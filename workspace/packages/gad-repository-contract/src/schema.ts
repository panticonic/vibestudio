import type {
  ContentStoreCodecId,
  ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";

/**
 * Frozen application schema version for the first Dolt-backed Gad repository.
 * This is an application contract: workerd only sees ordinary database rows
 * and typed artifact templates.
 */
export const GAD_REPOSITORY_SCHEMA_VERSION = 1 as const;
/** Private application codec whose numeric bytes spell `GDH1`. */
export const GAD_HUNK_CODEC_V1: ContentStoreCodecId = { number: 0x47444831, version: 1 };

declare const stableIdBrand: unique symbol;
type StableId<Kind extends string> = string & { readonly [stableIdBrand]: Kind };

export type GadFileId = StableId<"file">;
export type GadEditId = StableId<"edit">;
export type GadHunkId = StableId<"hunk">;
export type GadCommitIntentId = StableId<"commitIntent">;

const MAX_STABLE_ID_BYTES = 256;
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/u;

function asStableId<Kind extends string>(value: string, kind: Kind): StableId<Kind> {
  if (
    !STABLE_ID_RE.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_STABLE_ID_BYTES
  ) {
    throw new Error(
      `Invalid Gad ${kind} ID: expected 1-${MAX_STABLE_ID_BYTES} bytes of portable ASCII`
    );
  }
  return value as StableId<Kind>;
}

/** IDs are minted before dispatch; a database never allocates them from rowids or sequences. */
export const asGadFileId = (value: string): GadFileId => asStableId(value, "file");
export const asGadEditId = (value: string): GadEditId => asStableId(value, "edit");
export const asGadHunkId = (value: string): GadHunkId => asStableId(value, "hunk");
export const asGadCommitIntentId = (value: string): GadCommitIntentId =>
  asStableId(value, "commitIntent");

export type GadEditKindV1 = "replace" | "write" | "create" | "delete" | "chmod";

/** Authoritative current file row. `blobRef` is a declared strong external CAS edge. */
export interface GadFileRowV1 {
  fileId: GadFileId;
  path: string;
  blobRef: ContentStoreObjectRef;
  mode: number;
}

/**
 * Durable edit provenance. Null `commitIntentId` is working state; assigning
 * one deliberately admits this edit into exactly one user-visible commit.
 */
export interface GadEditRowV1 {
  editId: GadEditId;
  fileId: GadFileId;
  commitIntentId: GadCommitIntentId | null;
  invocationId: string | null;
  turnId: string | null;
  actorRef: string;
  ordinal: number;
  kind: GadEditKindV1;
  path: string;
  oldBlobRef: ContentStoreObjectRef | null;
  newBlobRef: ContentStoreObjectRef | null;
  binary: boolean;
  synthetic: boolean;
}

/** One provenance hunk. Large hunk bodies live in CAS and are explicit edges. */
export interface GadHunkRowV1 {
  hunkId: GadHunkId;
  editId: GadEditId;
  ordinal: number;
  start: number;
  end: number;
  bodyRef: ContentStoreObjectRef;
  origin: "ours" | "theirs" | "resolved" | null;
  theirsStart: number | null;
  theirsEnd: number | null;
}

export interface GadCommitIntentRowV1 {
  commitIntentId: GadCommitIntentId;
  operation: "commit" | "merge" | "cherryPick" | "revert" | "rebase" | "import";
  message: string;
  actorRef: string;
  invocationId: string | null;
  turnId: string | null;
  logicalTime: string;
  groupId: string | null;
  rebasedFromIntentId: GadCommitIntentId | null;
}

/**
 * The only v1 SQL columns interpreted as external object references. Each
 * entry names a complete exact-ref tuple; adding another ref-bearing column
 * requires a schema/extractor version bump.
 */
export const GAD_EXTERNAL_REF_COLUMNS_V1 = [
  {
    table: "vcs_files",
    field: "blobRef",
    columns: [
      "blob_store_id",
      "blob_codec_number",
      "blob_codec_version",
      "blob_hash_algorithm",
      "blob_digest",
    ],
  },
  {
    table: "vcs_edit_ops",
    field: "oldBlobRef",
    columns: [
      "old_blob_store_id",
      "old_blob_codec_number",
      "old_blob_codec_version",
      "old_blob_hash_algorithm",
      "old_blob_digest",
    ],
  },
  {
    table: "vcs_edit_ops",
    field: "newBlobRef",
    columns: [
      "new_blob_store_id",
      "new_blob_codec_number",
      "new_blob_codec_version",
      "new_blob_hash_algorithm",
      "new_blob_digest",
    ],
  },
  {
    table: "vcs_edit_hunks",
    field: "bodyRef",
    columns: [
      "body_store_id",
      "body_codec_number",
      "body_codec_version",
      "body_hash_algorithm",
      "body_digest",
    ],
  },
] as const;

/**
 * Reference DDL for imports and the first reducer. Heads, context pointers,
 * publication state, caches, and branch-local sequences are intentionally
 * absent from the mergeable repository.
 */
export const GAD_REPOSITORY_SCHEMA_SQL_V1 = `
CREATE TABLE vcs_files (
  file_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  blob_store_id BLOB NOT NULL,
  blob_codec_number INTEGER NOT NULL,
  blob_codec_version INTEGER NOT NULL,
  blob_hash_algorithm INTEGER NOT NULL,
  blob_digest BLOB NOT NULL,
  mode INTEGER NOT NULL
);
CREATE TABLE vcs_edit_ops (
  edit_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  commit_intent_id TEXT,
  invocation_id TEXT,
  turn_id TEXT,
  actor_ref TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  old_blob_store_id BLOB,
  old_blob_codec_number INTEGER,
  old_blob_codec_version INTEGER,
  old_blob_hash_algorithm INTEGER,
  old_blob_digest BLOB,
  new_blob_store_id BLOB,
  new_blob_codec_number INTEGER,
  new_blob_codec_version INTEGER,
  new_blob_hash_algorithm INTEGER,
  new_blob_digest BLOB,
  binary INTEGER NOT NULL,
  synthetic INTEGER NOT NULL
);
CREATE TABLE vcs_edit_hunks (
  hunk_id TEXT PRIMARY KEY,
  edit_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  body_store_id BLOB NOT NULL,
  body_codec_number INTEGER NOT NULL,
  body_codec_version INTEGER NOT NULL,
  body_hash_algorithm INTEGER NOT NULL,
  body_digest BLOB NOT NULL,
  origin TEXT,
  theirs_start INTEGER,
  theirs_end INTEGER,
  UNIQUE (edit_id, ordinal)
);
CREATE TABLE vcs_commit_intents (
  commit_intent_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  message TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  invocation_id TEXT,
  turn_id TEXT,
  logical_time TEXT NOT NULL,
  group_id TEXT,
  rebased_from_intent_id TEXT
);`.trim();

export interface GadWorkingEditSetV1 {
  edits: readonly GadEditRowV1[];
  hunks: readonly GadHunkRowV1[];
  /** User-visible commit intents; physical working-snapshot commits never appear here. */
  commitIntents: readonly GadCommitIntentRowV1[];
}

export interface GadSelectedCommitPlanV1 {
  intent: GadCommitIntentRowV1;
  selectedEdits: GadEditRowV1[];
  selectedHunks: GadHunkRowV1[];
  residualWorkingEdits: GadEditRowV1[];
  residualWorkingHunks: GadHunkRowV1[];
}

/**
 * Contract-level partition for a deliberate commit. File-state replay remains
 * the reducer/edit-engine's job; this function freezes the provenance rule
 * that excluded edits stay working and working snapshots are not user commits.
 */
export function planSelectedCommitV1(
  working: GadWorkingEditSetV1,
  selectedEditIds: readonly GadEditId[],
  intent: GadCommitIntentRowV1
): GadSelectedCommitPlanV1 {
  if (selectedEditIds.length === 0) throw new Error("A user commit must select at least one edit");
  if (intent.operation !== "commit") {
    throw new Error(`Selected edit commits require a commit intent, got ${intent.operation}`);
  }
  if (working.commitIntents.some((row) => row.commitIntentId === intent.commitIntentId)) {
    throw new Error(`Duplicate commit intent ${intent.commitIntentId}`);
  }
  const selected = new Set(selectedEditIds);
  if (selected.size !== selectedEditIds.length) throw new Error("Duplicate selected edit ID");
  const byId = new Map(working.edits.map((edit) => [edit.editId, edit]));
  if (byId.size !== working.edits.length) throw new Error("Duplicate working edit ID");
  if (working.edits.some((edit) => edit.commitIntentId !== null)) {
    throw new Error("A working edit set may only contain uncommitted edits");
  }
  const hunkIds = new Set(working.hunks.map((hunk) => hunk.hunkId));
  if (hunkIds.size !== working.hunks.length) throw new Error("Duplicate working hunk ID");
  for (const hunk of working.hunks) {
    if (!byId.has(hunk.editId)) throw new Error(`Hunk references unknown edit: ${hunk.editId}`);
  }
  for (const editId of selected) {
    const edit = byId.get(editId);
    if (!edit) throw new Error(`Selected edit does not exist: ${editId}`);
    if (edit.commitIntentId !== null)
      throw new Error(`Selected edit is already committed: ${editId}`);
  }

  const editOrder = (left: GadEditRowV1, right: GadEditRowV1): number =>
    left.ordinal - right.ordinal ||
    (left.editId < right.editId ? -1 : left.editId > right.editId ? 1 : 0);
  const hunkOrder = (left: GadHunkRowV1, right: GadHunkRowV1): number =>
    left.ordinal - right.ordinal ||
    (left.hunkId < right.hunkId ? -1 : left.hunkId > right.hunkId ? 1 : 0);
  const selectedEdits = working.edits
    .filter((edit) => selected.has(edit.editId))
    .map((edit) => ({ ...edit, commitIntentId: intent.commitIntentId }))
    .sort(editOrder);
  const residualWorkingEdits = working.edits
    .filter((edit) => !selected.has(edit.editId))
    .sort(editOrder);
  const selectedHunks = working.hunks.filter((hunk) => selected.has(hunk.editId)).sort(hunkOrder);
  const residualWorkingHunks = working.hunks
    .filter((hunk) => !selected.has(hunk.editId))
    .sort(hunkOrder);

  return {
    intent,
    selectedEdits,
    selectedHunks,
    residualWorkingEdits,
    residualWorkingHunks,
  };
}
