import {
  bytesToHex,
  cloneObjectRef,
  objectRefKey,
  type ContentStoreObjectRef,
} from "@vibestudio/shared/contentStore/exactContentStore";
import type { GadEditRowV1, GadFileRowV1, GadHunkRowV1 } from "./schema.js";

export interface GadExternalReferenceSourceV1 {
  table: "vcs_files" | "vcs_edit_ops" | "vcs_edit_hunks";
  rowId: string;
  field: "blobRef" | "oldBlobRef" | "newBlobRef" | "bodyRef";
}

export interface GadExternalObjectEntryV1 {
  object: ContentStoreObjectRef;
  sources: GadExternalReferenceSourceV1[];
}

export interface GadExternalObjectManifestV1 {
  kind: "gad.externalObjects";
  schemaVersion: 1;
  extractorVersion: 1;
  /** Deduplicated and sorted by the full exact-ref tuple. */
  entries: GadExternalObjectEntryV1[];
}

function validateExactRef(ref: ContentStoreObjectRef, source: string): void {
  if (ref.storeId.byteLength === 0) throw new Error(`${source}: empty content-store ID`);
  if (!Number.isSafeInteger(ref.codec.number) || ref.codec.number < 0) {
    throw new Error(`${source}: invalid codec number`);
  }
  if (!Number.isSafeInteger(ref.codec.version) || ref.codec.version < 0) {
    throw new Error(`${source}: invalid codec version`);
  }
  if (!Number.isSafeInteger(ref.contentId.algorithm) || ref.contentId.algorithm < 0) {
    throw new Error(`${source}: invalid hash algorithm`);
  }
  if (ref.contentId.digest.byteLength === 0) throw new Error(`${source}: empty digest`);
  // Force byte traversal so exotic/mutating array-like values cannot become manifest input.
  bytesToHex(ref.storeId);
  bytesToHex(ref.contentId.digest);
}

/**
 * Trusted v1 extractor. Callers provide authoritative typed rows, never a
 * caller-authored root list; every declared ref-bearing field is scanned.
 */
export function extractGadExternalObjectManifestV1(input: {
  files: readonly GadFileRowV1[];
  edits: readonly GadEditRowV1[];
  hunks: readonly GadHunkRowV1[];
}): GadExternalObjectManifestV1 {
  const entries = new Map<string, GadExternalObjectEntryV1>();
  const add = (object: ContentStoreObjectRef, source: GadExternalReferenceSourceV1): void => {
    validateExactRef(object, `${source.table}.${source.field}[${source.rowId}]`);
    const key = objectRefKey(object);
    let entry = entries.get(key);
    if (!entry) {
      entry = { object: cloneObjectRef(object), sources: [] };
      entries.set(key, entry);
    }
    entry.sources.push(source);
  };

  for (const file of input.files) {
    add(file.blobRef, { table: "vcs_files", rowId: file.fileId, field: "blobRef" });
  }
  for (const edit of input.edits) {
    if (edit.oldBlobRef) {
      add(edit.oldBlobRef, {
        table: "vcs_edit_ops",
        rowId: edit.editId,
        field: "oldBlobRef",
      });
    }
    if (edit.newBlobRef) {
      add(edit.newBlobRef, {
        table: "vcs_edit_ops",
        rowId: edit.editId,
        field: "newBlobRef",
      });
    }
  }
  for (const hunk of input.hunks) {
    add(hunk.bodyRef, {
      table: "vcs_edit_hunks",
      rowId: hunk.hunkId,
      field: "bodyRef",
    });
  }

  const sorted = [...entries.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, entry]) => ({
      ...entry,
      sources: entry.sources.sort((left, right) => {
        const leftKey = `${left.table}\u0000${left.rowId}\u0000${left.field}`;
        const rightKey = `${right.table}\u0000${right.rowId}\u0000${right.field}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    }));

  return {
    kind: "gad.externalObjects",
    schemaVersion: 1,
    extractorVersion: 1,
    entries: sorted,
  };
}
