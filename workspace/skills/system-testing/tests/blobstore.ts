import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  noIncompleteInvocations,
  requireEvalEvidence,
} from "./_helpers.js";

function checked(
  result: Parameters<typeof finalMessageHasAll>[0],
  tokens: string[],
  evidence: readonly string[]
) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  const pending = noIncompleteInvocations(result);
  if (!pending.passed) return pending;
  return requireEvalEvidence(result, evidence);
}

export const blobstoreTests: TestCase[] = [
  {
    name: "blob-text-roundtrip-grep",
    description: "Store text content-addressably, read a range back, and grep it",
    category: "blobstore",
    prompt:
      "Store a multi-line text document in the workspace content-addressable blob store, read the full text and a byte range back, and search inside the stored blob for a marker line without re-reading the whole file yourself. Finish with BLOB_TEXT_OK, BLOB_RANGE_OK, and BLOB_GREP_OK.",
    validate: (result) =>
      checked(result, ["BLOB_TEXT_OK", "BLOB_RANGE_OK", "BLOB_GREP_OK"], ["blobstore"]),
  },
  {
    name: "blob-binary-roundtrip",
    description: "Store binary data in the blob store and verify the bytes round-trip",
    category: "blobstore",
    prompt:
      "Store a small piece of binary data in the workspace blob store and verify the exact bytes come back. Finish with BLOB_BINARY_OK and bytes:<count>.",
    validate: (result) => checked(result, ["BLOB_BINARY_OK", "bytes:"], ["blobstore"]),
  },
  {
    name: "blob-tree-lifecycle",
    description: "Build, list, diff, and materialize an immutable blob file tree",
    category: "blobstore",
    prompt:
      "Build a small immutable file tree in the blob store from a few files, list its contents, read one file out of it, produce a second tree with one changed file and report the difference between the trees, then materialize one tree into your sandbox filesystem and confirm the files landed. Finish with BLOB_TREE_OK, BLOB_TREE_DIFF_OK, and materialized:<file-count>.",
    validate: (result) =>
      checked(
        result,
        ["BLOB_TREE_OK", "BLOB_TREE_DIFF_OK", "materialized:"],
        ["blobstore"]
      ),
  },
];
