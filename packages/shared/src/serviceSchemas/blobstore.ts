/**
 * blobstore service method schemas — per-workspace content-addressable blob
 * storage. Pure-data wire contract shared by the server registration and
 * typed clients.
 */

import { z } from "zod";
import type { ServicePolicy, MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";
import { STATE_HASH_RE, TREE_HASH_RE } from "../contentTree/treeObjects.js";

export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const PREFIX_RE = /^[0-9a-f]{0,64}$/;
/** Either tree-object address form: `manifest:<hex>` (a directory node) or
 *  `state:<hex>` (a root pointer, gad state-hash compatible). */
export const TREE_REF_RE = /^(manifest|state):[0-9a-f]{64}$/;

export const BLOBSTORE_READ_POLICY: ServicePolicy = {
  allowed: ["panel", "app", "worker", "do", "shell", "server", "extension"],
};
export const BLOBSTORE_ADMIN_POLICY: ServicePolicy = { allowed: ["shell", "server"] };

// Access descriptors shared across the read/write/admin method groups. Caller-kind
// policy remains declared on `policy`; these descriptors carry sensitivity metadata
// for docs and read-only enforcement.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const ADMIN_READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const ADMIN_DESTRUCTIVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};

export const DigestSchema = z.string().regex(DIGEST_RE);
export const Base64Schema = z.string().refine((value) => {
  try {
    return (
      Buffer.from(value, "base64").toString("base64").replace(/=+$/u, "") ===
      value.replace(/=+$/u, "")
    );
  } catch {
    return false;
  }
}, "Invalid base64 payload");
export const ListOptsSchema = z
  .object({
    prefix: z.string().regex(PREFIX_RE).optional(),
    limit: z.number().int().positive().max(100_000).optional(),
  })
  .optional();
export const ListArgsSchema = z.union([z.tuple([]), z.tuple([ListOptsSchema])]);

// ---------------------------------------------------------------------------
// Tree objects (immutable content-addressed file trees in the same CAS)
// ---------------------------------------------------------------------------

export const TreeHashSchema = z.string().regex(TREE_HASH_RE);
export const StateHashSchema = z.string().regex(STATE_HASH_RE);
/** A tree reference: `manifest:<hex>` node hash or `state:<hex>` root pointer. */
export const TreeRefSchema = z.string().regex(TREE_REF_RE);

/** One directory-node entry — the exact gad manifest-hash entry shape, so tree
 *  hashes stay byte-compatible with existing gad manifest/state hashes. */
export const TreeEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    name: z.string().min(1),
    kind: z.literal("file"),
    contentHash: DigestSchema,
    /** Git-style mode: 33188 regular, 33261 executable. */
    mode: z.union([z.literal(33188), z.literal(33261)]),
  }),
  z.object({
    name: z.string().min(1),
    kind: z.literal("dir"),
    childHash: TreeHashSchema,
  }),
]);

/** Recursive listing entry: a tree-relative path plus its content address. */
export const TreeListEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    path: z.string(),
    kind: z.literal("file"),
    contentHash: DigestSchema,
    mode: z.number().int(),
  }),
  z.object({ path: z.string(), kind: z.literal("dir"), treeHash: TreeHashSchema }),
]);

export const TreeFileStatSchema = z.object({
  contentHash: DigestSchema,
  mode: z.number().int(),
});

export const PutTreeOptsSchema = z
  .object({
    /** Also store a `state:` root-pointer object for this node and return its
     *  stateHash — marks the node as a tree ROOT resolvable by state hash. */
    root: z.boolean().optional(),
  })
  .optional();

export const ListTreeOptsSchema = z
  .object({
    /** Tree-relative path to list under ("" or omitted = whole tree). */
    prefix: z.string().optional(),
    limit: z.number().int().positive().max(100_000).optional(),
  })
  .optional();

export const DiffTreesResultSchema = z.object({
  added: z.array(z.object({ path: z.string(), contentHash: DigestSchema, mode: z.number().int() })),
  removed: z.array(
    z.object({ path: z.string(), contentHash: DigestSchema, mode: z.number().int() })
  ),
  changed: z.array(
    z.object({
      path: z.string(),
      fromContentHash: DigestSchema,
      toContentHash: DigestSchema,
      fromMode: z.number().int(),
      toMode: z.number().int(),
    })
  ),
});

export const blobstoreMethods = defineServiceMethods({
  has: {
    description: "Whether a blob with this content digest exists in the workspace store.",
    args: z.tuple([DigestSchema]),
    returns: z.boolean(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
    examples: [
      {
        args: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
        returns: false,
      },
    ],
  },
  stat: {
    description: "Size (bytes) and last-modified time of a blob, or null if it does not exist.",
    args: z.tuple([DigestSchema]),
    returns: z.object({ size: z.number(), mtime: z.number() }).nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  putText: {
    description:
      "Store a UTF-8 string; returns its content digest + byte size. Content-addressed, so identical text always yields the same digest (idempotent).",
    args: z.tuple([z.string()]),
    returns: z.object({ digest: z.string(), size: z.number() }),
    policy: BLOBSTORE_READ_POLICY,
    access: WRITE_ACCESS,
    examples: [{ args: ["hello world"] }],
  },
  getText: {
    description: "Full UTF-8 text of a blob, or null if absent.",
    args: z.tuple([DigestSchema]),
    returns: z.string().nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  getRange: {
    description:
      "UTF-8 text slice. offset/length are BYTES (so they compose with stat.size); the returned string is UTF-8-decoded, so partial codepoints at slice boundaries become U+FFFD replacement chars. Use getRangeBytes for a raw binary slice.",
    args: z.tuple([DigestSchema, z.number().int().nonnegative(), z.number().int().positive()]),
    returns: z.string().nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  getRangeBytes: {
    description:
      "Raw byte slice, base64-encoded on the wire so binary blobs (PDFs, images) round-trip intact. Decode with Buffer.from(result.bytesBase64, 'base64').",
    args: z.tuple([DigestSchema, z.number().int().nonnegative(), z.number().int().positive()]),
    returns: z.object({ bytesBase64: z.string() }).nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  grep: {
    description:
      "Search a blob's text for a regex pattern; returns matching lines with optional surrounding context, or null if the blob is absent.",
    args: z.tuple([
      DigestSchema,
      z.string(),
      z
        .object({
          caseInsensitive: z.boolean().optional(),
          contextLines: z.number().int().nonnegative().max(10).optional(),
          maxMatches: z.number().int().positive().max(500).optional(),
        })
        .optional(),
    ]),
    returns: z
      .array(
        z.object({
          lineNumber: z.number(),
          line: z.string(),
          before: z.array(z.string()),
          after: z.array(z.string()),
        })
      )
      .nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  putBase64: {
    description:
      "Store raw bytes from exactly one base64 string; returns content digest + byte size (idempotent by content). The blobstore stores bytes only: do not pass MIME/options metadata, and instead carry it alongside the returned digest.",
    args: z.tuple([Base64Schema]),
    returns: z.object({ digest: z.string(), size: z.number() }),
    policy: BLOBSTORE_READ_POLICY,
    access: WRITE_ACCESS,
    examples: [{ args: ["iVBORw0KGgo="] }],
  },
  getBase64: {
    description: "Full blob contents as a base64 string, or null if absent.",
    args: z.tuple([DigestSchema]),
    returns: z.string().nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  putTree: {
    description:
      "Store one immutable directory node (tree object) in the CAS from its entries; returns its `manifest:` tree hash (gad-manifest compatible). Every referenced child must already exist in the store — file contentHash blobs and dir childHash tree nodes are verified, so a tree hash can never be claimed while its objects are missing. Pass {root:true} to also store a `state:` root pointer and get the gad-compatible stateHash back. Idempotent by content. Build deep trees bottom-up (children before parents).",
    args: z.tuple([z.array(TreeEntrySchema).max(100_000), PutTreeOptsSchema]),
    returns: z.object({ treeHash: TreeHashSchema, stateHash: StateHashSchema.optional() }),
    policy: BLOBSTORE_READ_POLICY,
    access: WRITE_ACCESS,
    examples: [{ args: [[], { root: true }] }],
  },
  getTree: {
    description:
      "Entries of a tree object (one directory node), or null if absent. Accepts a `manifest:` node hash or a `state:` root pointer (resolved to its root node).",
    args: z.tuple([TreeRefSchema]),
    returns: z.array(TreeEntrySchema).nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  listTree: {
    description:
      "Recursive listing of a tree: every file (contentHash+mode) and directory (treeHash) under an optional prefix path, sorted by path. Returns null if the root tree object is absent.",
    args: z.union([z.tuple([TreeRefSchema]), z.tuple([TreeRefSchema, ListTreeOptsSchema])]),
    returns: z.array(TreeListEntrySchema).nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  readFileAtTree: {
    description:
      "Resolve a tree-relative file path to its content digest and mode, or null if the path is absent or not a file. Read the bytes via the ordinary blob APIs.",
    args: z.tuple([TreeRefSchema, z.string().min(1)]),
    returns: TreeFileStatSchema.nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  diffTrees: {
    description:
      "Authoritative diff between two trees: added/removed/changed file paths, computed by Merkle walk (identical subtree hashes are skipped wholesale). Throws if either tree's objects are missing from the store.",
    args: z.tuple([TreeRefSchema, TreeRefSchema]),
    returns: DiffTreesResultSchema,
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  materializeTree: {
    description:
      "Project a tree onto disk at outDir (absolute path): hardlinks non-executable files from the CAS (copies executables so chmod never touches the shared CAS inode). Existing files with matching size are trusted and skipped. Admin-only — writes outside the store.",
    args: z.tuple([
      TreeRefSchema,
      z.string().min(1),
      z.object({ link: z.boolean().optional() }).optional(),
    ]),
    returns: z.object({ written: z.number(), unchanged: z.number() }),
    policy: BLOBSTORE_ADMIN_POLICY,
    access: WRITE_ACCESS,
  },
  delete: {
    description: "Delete a blob by digest; returns true if it existed. Destructive, admin-only.",
    args: z.tuple([DigestSchema]),
    returns: z.boolean(),
    policy: BLOBSTORE_ADMIN_POLICY,
    access: ADMIN_DESTRUCTIVE_ACCESS,
  },
  list: {
    description:
      "List blob digests, optionally filtered by hex prefix and capped by limit. Admin-only.",
    args: ListArgsSchema,
    returns: z.array(z.string()),
    policy: BLOBSTORE_ADMIN_POLICY,
    access: ADMIN_READ_ACCESS,
  },
});
