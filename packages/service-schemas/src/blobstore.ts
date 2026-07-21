/**
 * blobstore service method schemas — per-workspace content-addressable blob
 * storage. Pure-data wire contract shared by the server registration and
 * typed clients.
 */

import { z } from "zod";
import type {
  ServiceAuthorityPolicy,
  MethodAccessDescriptor,
} from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { STATE_HASH_RE, TREE_HASH_RE } from "@vibestudio/shared/contentTree/treeObjects";
import { isValidTreeEntryName, splitTreePath } from "@vibestudio/content-addressing";

export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const PREFIX_RE = /^[0-9a-f]{0,64}$/;
/** Either tree-object address form: `manifest:<hex>` (a directory node) or
 *  `state:<hex>` (a root pointer, gad state-hash compatible). */
export const TREE_REF_RE = /^(manifest|state):[0-9a-f]{64}$/;

export const BLOBSTORE_READ_POLICY: ServiceAuthorityPolicy = {
  principals: ["code", "user", "host"],
};
export const BLOBSTORE_ADMIN_POLICY: ServiceAuthorityPolicy = { principals: ["user", "host"] };

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
export const TreeEntryNameSchema = z
  .string()
  .refine(isValidTreeEntryName, "Invalid or overlong tree entry name");
export const TreeRelativePathSchema = z.string().refine((value) => {
  try {
    splitTreePath(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid or overlong tree-relative path");
export const NonEmptyTreeRelativePathSchema = TreeRelativePathSchema.refine(
  (value) => value.length > 0,
  "Tree path must not be empty"
);

/** One directory-node entry — the exact gad manifest-hash entry shape, so tree
 *  hashes stay byte-compatible with existing gad manifest/state hashes. */
export const TreeEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    name: TreeEntryNameSchema,
    kind: z.literal("file"),
    contentHash: DigestSchema,
    /** Git-style mode: 33188 regular, 33261 executable. */
    mode: z.union([z.literal(33188), z.literal(33261)]),
  }),
  z.object({
    name: TreeEntryNameSchema,
    kind: z.literal("dir"),
    childHash: TreeHashSchema,
  }),
]);

/** Recursive listing entry: a tree-relative path plus its content address. */
export const TreeListEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    path: NonEmptyTreeRelativePathSchema,
    kind: z.literal("file"),
    contentHash: DigestSchema,
    mode: z.number().int(),
  }),
  z.object({
    path: NonEmptyTreeRelativePathSchema,
    kind: z.literal("dir"),
    treeHash: TreeHashSchema,
  }),
]);

/** Deterministic order of the recursive Merkle walk. Directory entries precede
 * their children and every directory node is visited in canonical codepoint
 * name order. The order is named and returned as part of the page basis so a
 * cursor can never silently cross into a differently ordered projection. */
export const TREE_LIST_ORDER = "tree-preorder-v1" as const;
export const TreeListOrderSchema = z.literal(TREE_LIST_ORDER);
/** A cursor carries one canonical <=4095-byte projected path plus fixed-size
 * hashes; base64url expansion stays below this wire bound. */
export const TREE_LIST_CURSOR_MAX_CHARS = 6_144;
export const TreeListCursorSchema = z.string().min(1).max(TREE_LIST_CURSOR_MAX_CHARS);

export const TreeListBasisSchema = z.object({
  /** Exact immutable reference requested by the caller. */
  ref: TreeRefSchema,
  /** Resolved root manifest. This additionally binds `state:` pointers. */
  rootTreeHash: TreeHashSchema,
  /** Normalized tree-relative prefix (empty means the complete tree). */
  prefix: TreeRelativePathSchema,
  order: TreeListOrderSchema,
});

export const TreeListPageSchema = z.intersection(
  z.object({
    basis: TreeListBasisSchema,
    entries: z.array(TreeListEntrySchema),
  }),
  z.discriminatedUnion("completeness", [
    z.object({ completeness: z.literal("complete") }),
    z.object({
      completeness: z.literal("continuation"),
      nextCursor: TreeListCursorSchema,
    }),
  ])
);

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

export const ListTreeRequestSchema = z.object({
  /** Tree-relative path to list under ("" or omitted = whole tree). */
  prefix: TreeRelativePathSchema.optional(),
  /** Page size only. Reaching it produces an explicit continuation, never a
   * partial result presented as a complete tree. */
  limit: z.number().int().positive().max(10_000).optional(),
  /** Opaque, content-addressed last-key continuation returned by this method. */
  cursor: TreeListCursorSchema.optional(),
});

export const DiffTreesResultSchema = z
  .object({
    added: z
      .array(
        z.object({
          path: NonEmptyTreeRelativePathSchema,
          contentHash: DigestSchema,
          mode: z.number().int(),
        })
      )
      .max(100_000),
    removed: z
      .array(
        z.object({
          path: NonEmptyTreeRelativePathSchema,
          contentHash: DigestSchema,
          mode: z.number().int(),
        })
      )
      .max(100_000),
    changed: z
      .array(
        z.object({
          path: NonEmptyTreeRelativePathSchema,
          fromContentHash: DigestSchema,
          toContentHash: DigestSchema,
          fromMode: z.number().int(),
          toMode: z.number().int(),
        })
      )
      .max(100_000),
  })
  .superRefine((diff, ctx) => {
    if (diff.added.length + diff.removed.length + diff.changed.length > 100_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Tree diff exceeds the explicit 100000-entry admission bound",
      });
    }
  });

export const blobstoreMethods = defineServiceMethods({
  has: {
    description: "Whether a blob with this content digest exists in the workspace store.",
    args: z.tuple([DigestSchema]),
    returns: z.boolean(),
    authority: BLOBSTORE_READ_POLICY,
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
    authority: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  putText: {
    description:
      "Store a UTF-8 string; returns its content digest + byte size. Content-addressed, so identical text always yields the same digest (idempotent).",
    args: z.tuple([z.string()]),
    returns: z.object({ digest: z.string(), size: z.number() }),
    authority: BLOBSTORE_READ_POLICY,
    access: WRITE_ACCESS,
    examples: [{ args: ["hello world"] }],
  },
  getText: {
    description: "Full UTF-8 text of a blob, or null if absent.",
    args: z.tuple([DigestSchema]),
    returns: z.string().nullable(),
    authority: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  getRange: {
    description:
      "UTF-8 text slice. offset/length are BYTES (so they compose with stat.size); the returned string is UTF-8-decoded, so partial codepoints at slice boundaries become U+FFFD replacement chars. Use getRangeBytes for a raw binary slice.",
    args: z.tuple([DigestSchema, z.number().int().nonnegative(), z.number().int().positive()]),
    returns: z.string().nullable(),
    authority: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  getRangeBytes: {
    description:
      "Raw byte slice, base64-encoded on the wire so binary blobs (PDFs, images) round-trip intact. Decode with Buffer.from(result.bytesBase64, 'base64').",
    args: z.tuple([DigestSchema, z.number().int().nonnegative(), z.number().int().positive()]),
    returns: z.object({ bytesBase64: z.string() }).nullable(),
    authority: BLOBSTORE_READ_POLICY,
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
    authority: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  putBase64: {
    description:
      "Store raw bytes from exactly one base64 string; returns content digest + byte size (idempotent by content). The blobstore stores bytes only: do not pass MIME/options metadata, and instead carry it alongside the returned digest.",
    args: z.tuple([Base64Schema]),
    returns: z.object({ digest: z.string(), size: z.number() }),
    authority: BLOBSTORE_READ_POLICY,
    access: WRITE_ACCESS,
    examples: [{ args: ["iVBORw0KGgo="] }],
  },
  getBase64: {
    description: "Full blob contents as a base64 string, or null if absent.",
    args: z.tuple([DigestSchema]),
    returns: z.string().nullable(),
    authority: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  putTree: {
    description:
      "Store one immutable directory node in the content-addressed store and return its tree hash. Every referenced file blob and child tree must already exist, so a tree hash cannot name missing objects. Pass {root:true} to also store a content-state root pointer. Content states are build/projection inputs, never semantic revision or ancestry identities. Idempotent by content; build deep trees bottom-up.",
    args: z.tuple([z.array(TreeEntrySchema).max(100_000), PutTreeOptsSchema]),
    returns: z.object({ treeHash: TreeHashSchema, stateHash: StateHashSchema.optional() }),
    authority: BLOBSTORE_READ_POLICY,
    access: WRITE_ACCESS,
    examples: [{ args: [[], { root: true }] }],
  },
  getTree: {
    description:
      "Entries of a tree object (one directory node), or null if absent. Accepts a `manifest:` node hash or a `state:` root pointer (resolved to its root node).",
    args: z.tuple([TreeRefSchema]),
    returns: z.array(TreeEntrySchema).nullable(),
    authority: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  listTree: {
    description:
      "Exact keyset-paged recursive listing of an immutable tree. Each page is bound to the requested ref, resolved root manifest, normalized prefix, and canonical tree-preorder. A continuation names the last emitted path; cursor/basis mismatches and missing interior objects fail loudly. Returns null only when the requested root object is absent.",
    args: z.tuple([TreeRefSchema, ListTreeRequestSchema]),
    returns: TreeListPageSchema.nullable(),
    authority: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  readFileAtTree: {
    description:
      "Resolve a tree-relative file path to its content digest and mode, or null if the path is absent or not a file. Read the bytes via the ordinary blob APIs.",
    args: z.tuple([TreeRefSchema, NonEmptyTreeRelativePathSchema]),
    returns: TreeFileStatSchema.nullable(),
    authority: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  diffTrees: {
    description:
      "Bounded authoritative diff for host admission checks: added/removed/changed file paths, computed by Merkle walk (identical subtree hashes are skipped wholesale). Throws if either tree's objects are missing or the change set exceeds 100000 entries; semantic/user-facing comparison uses its exact paged projection.",
    args: z.tuple([TreeRefSchema, TreeRefSchema]),
    returns: DiffTreesResultSchema,
    authority: BLOBSTORE_READ_POLICY,
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
    authority: BLOBSTORE_ADMIN_POLICY,
    access: WRITE_ACCESS,
  },
  delete: {
    description: "Delete a blob by digest; returns true if it existed. Destructive, admin-only.",
    args: z.tuple([DigestSchema]),
    returns: z.boolean(),
    authority: BLOBSTORE_ADMIN_POLICY,
    access: ADMIN_DESTRUCTIVE_ACCESS,
  },
  list: {
    description:
      "List blob digests, optionally filtered by hex prefix and capped by limit. Admin-only.",
    args: ListArgsSchema,
    returns: z.array(z.string()),
    authority: BLOBSTORE_ADMIN_POLICY,
    access: ADMIN_READ_ACCESS,
  },
});
