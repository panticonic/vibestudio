/**
 * fs service method schemas — filesystem operations sandboxed to the caller's
 * context folder for context-bound callers. An unchained extension granted the
 * explicit `host-fs-access` capability is the deliberate unrestricted-host
 * exception. Pure-data wire contract shared by the server registration and
 * typed clients.
 *
 * Caller-kind argument conventions (handled inside FsService):
 * - panel/app/worker/do callers: context resolved from the EntityCache.
 * - extension callers: chained caller context (or explicit host-fs capability).
 * - server/shell callers: explicit contextId as the first argument.
 *
 * `chown` is deliberately absent. `symlink` is restricted to context-local
 * scratch and rewrites targets to contained relative paths; traversal remains
 * checked again whenever another fs method follows the link.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/servicePolicy";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

// Access descriptors shared across the read / write / destructive method
// groups. The caller-kind gate stays on the service-level `policy` (see
// fsServiceDef.ts); these descriptors add the doc/safety metadata that drives
// the fuzzer and the capability catalog. `callers` is intentionally omitted so
// `policy.allowed` remains the single enforced gate.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const DESTRUCTIVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};

export const fsBinaryEnvelopeSchema = z.object({
  __bin: z.literal(true).describe("Discriminant marking this object as a base64 binary payload."),
  data: z.string().describe("The file/buffer bytes, base64-encoded for JSON-RPC transport."),
});

export type FsBinaryEnvelope = z.infer<typeof fsBinaryEnvelopeSchema>;

const fsDataSchema = z.union([z.string(), fsBinaryEnvelopeSchema]);
const fsReadEncodingSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { encoding?: unknown }).encoding
      : value,
  z.string()
);
const voidSchema = z.void();
const statSchema = z.object({
  isFile: z.boolean().describe("True if the entry is a regular file."),
  isDirectory: z.boolean().describe("True if the entry is a directory."),
  isSymbolicLink: z.boolean().describe("True if the entry is a symbolic link."),
  size: z.number().describe("Size in bytes."),
  mtime: z.string().describe("Last-modified time as an ISO-8601 string."),
  ctime: z.string().describe("Last status-change time as an ISO-8601 string."),
  mode: z.number().describe("Unix mode bits (file type + permissions)."),
});
const direntSchema = z.object({
  name: z
    .string()
    .describe("Entry name; basename for flat listings, root-relative path for recursive ones."),
  _isFile: z.boolean().describe("True if the entry is a regular file."),
  _isDirectory: z.boolean().describe("True if the entry is a directory."),
  _isSymbolicLink: z.boolean().describe("True if the entry is a symbolic link."),
});
const grepOptionsSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory or single file to search, relative to the context root (default '/')."),
  glob: z
    .string()
    .optional()
    .describe("Gitignore-style glob filter for candidate files (basename match when slash-free)."),
  caseInsensitive: z.boolean().optional().describe("Match case-insensitively (default false)."),
  contextLines: z
    .number()
    .optional()
    .describe("Lines of surrounding context before/after each match (clamped to 10)."),
  maxMatches: z
    .number()
    .optional()
    .describe("Stop after this many matches (default 200, hard cap 1000)."),
});
const grepResultSchema = z.object({
  matches: z
    .array(
      z.object({
        file: z.string().describe("Context-root-relative path of the file containing the match."),
        lineNumber: z.number().describe("1-based line number of the match within the file."),
        line: z.string().describe("Full text of the matching line."),
        before: z.array(z.string()).describe("Context lines immediately preceding the match."),
        after: z.array(z.string()).describe("Context lines immediately following the match."),
      })
    )
    .describe("Matching lines, in file/line order, capped at maxMatches."),
  matchCount: z.number().describe("Number of matches returned (length of `matches`)."),
  truncated: z.boolean().describe("True if the match limit was hit and results were cut short."),
});
const globOptionsSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory to search, relative to the context root (default '/')."),
});
const readdirOptionsSchema = z.object({
  withFileTypes: z
    .boolean()
    .optional()
    .describe("Return Dirent-shaped entries with type flags instead of bare name strings."),
  recursive: z
    .boolean()
    .optional()
    .describe("Recurse into subdirectories, reporting root-relative paths."),
});
const mkdirOptionsSchema = z.object({
  recursive: z
    .boolean()
    .optional()
    .describe("Create missing parent directories (and don't error if the target exists)."),
});
const rmOptionsSchema = z.object({
  recursive: z.boolean().optional().describe("Remove directories and their contents recursively."),
  force: z.boolean().optional().describe("Ignore missing paths instead of throwing ENOENT."),
});

export type FsStatWire = z.infer<typeof statSchema>;
export type FsDirentWire = z.infer<typeof direntSchema>;
export type FsGrepResult = z.infer<typeof grepResultSchema>;

export const fsMethods = defineServiceMethods({
  // File content
  readFile: {
    description:
      'Read a file\'s contents. Overloaded: with an encoding string (or Node-style `{ encoding: "utf8" }`) the bytes are decoded and returned as a string; without one, raw bytes are returned base64-encoded in a binary envelope. (Server/shell callers prepend a contextId as the first argument.)',
    args: z.union([
      z.tuple([z.string(), fsReadEncodingSchema.optional()]),
      z.tuple([z.string(), z.string(), fsReadEncodingSchema.optional()]),
    ]),
    returns: z.union([z.string(), fsBinaryEnvelopeSchema]),
    access: READ_ACCESS,
    examples: [
      { args: ["/notes/todo.md", "utf8"] },
      { args: ["/notes/todo.md", { encoding: "utf8" }] },
      { args: ["/assets/logo.png"] },
    ],
  },
  writeFile: {
    description:
      "Write data to a file, replacing existing contents and creating missing parent directories. Paths are relative to a context-bound caller's root even when they start with '/'. For such callers, a valid workspace-repo file becomes a GAD working edit; platform-ignored paths and paths outside reserved workspace source roots are context-local scratch writes. Routed paths under reserved roots must use canonical casing and valid repo shape. Data may be a UTF-8 string or a base64 binary envelope.",
    args: z.union([
      z.tuple([z.string(), fsDataSchema]),
      z.tuple([z.string(), z.string(), fsDataSchema]),
    ]),
    returns: voidSchema,
    access: WRITE_ACCESS,
    examples: [
      { args: [".tmp/todo.md", "buy milk\n"] },
      { args: ["projects/demo/notes/todo.md", "buy milk\n"] },
    ],
  },
  appendFile: {
    description:
      "Append data to the end of a context-root-relative file, creating the file and missing parent directories when absent. For context-bound callers, a valid workspace-repo file becomes a GAD working edit; platform-ignored paths and paths outside reserved workspace source roots remain context-local scratch. Routed paths under reserved roots must use canonical casing and valid repo shape. Data may be a UTF-8 string or a base64 binary envelope.",
    args: z.union([
      z.tuple([z.string(), fsDataSchema]),
      z.tuple([z.string(), z.string(), fsDataSchema]),
    ]),
    returns: voidSchema,
    access: WRITE_ACCESS,
    examples: [{ args: ["/logs/run.log", "done\n"] }],
  },
  // Directories
  readdir: {
    description:
      "List the entries of a directory; returns bare name strings, or Dirent-shaped objects with type flags when `withFileTypes` is set, optionally recursing into subdirectories.",
    args: z.union([
      z.tuple([z.string(), readdirOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), readdirOptionsSchema.optional()]),
    ]),
    returns: z.union([z.array(z.string()), z.array(direntSchema)]),
    access: READ_ACCESS,
    examples: [{ args: ["/"] }, { args: ["/src", { withFileTypes: true, recursive: true }] }],
  },
  mkdir: {
    description:
      "Create a directory directly on the context filesystem projection (not as a GAD working edit); with `recursive` it creates missing parents and returns the first-created path relative to the context root, otherwise returns undefined.",
    args: z.union([
      z.tuple([z.string(), mkdirOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), mkdirOptionsSchema.optional()]),
    ]),
    returns: z.string().optional(),
    access: WRITE_ACCESS,
    examples: [{ args: ["/a/b/c", { recursive: true }] }],
  },
  rmdir: {
    description:
      "Remove a directory. For context-bound callers, a valid workspace-repo path routes subtree removal through GAD; a scratch directory is removed directly and throws if it is not empty.",
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: voidSchema,
    access: DESTRUCTIVE_ACCESS,
  },
  rm: {
    description:
      "Remove a file or directory; `recursive` deletes a directory's contents and `force` suppresses errors for missing paths. For context-bound callers, a valid workspace-repo path routes the removal through GAD; scratch paths are removed directly.",
    args: z.union([
      z.tuple([z.string(), rmOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), rmOptionsSchema.optional()]),
    ]),
    returns: voidSchema,
    access: DESTRUCTIVE_ACCESS,
    examples: [{ args: ["/build", { recursive: true, force: true }] }],
  },
  // Stat / metadata
  stat: {
    description:
      "Return metadata (type flags, size, mtime/ctime, mode) for a path, following symlinks to their target.",
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: statSchema,
    access: READ_ACCESS,
  },
  lstat: {
    description:
      "Like stat, but reports on the symlink itself rather than following it to its target.",
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: statSchema,
    access: READ_ACCESS,
  },
  exists: {
    description: "Return whether a path exists and is accessible to the caller.",
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: z.boolean(),
    access: READ_ACCESS,
  },
  access: {
    description:
      "Test a path's accessibility against the given fs.constants mode bits; resolves on success, throws on failure.",
    args: z.union([
      z.tuple([z.string(), z.number().optional()]),
      z.tuple([z.string(), z.string(), z.number().optional()]),
    ]),
    returns: voidSchema,
    access: READ_ACCESS,
  },
  // File manipulation
  unlink: {
    description:
      "Delete a single file (not a directory). For context-bound callers, a valid workspace-repo path routes the deletion through GAD; a scratch path is deleted directly.",
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: voidSchema,
    access: DESTRUCTIVE_ACCESS,
  },
  copyFile: {
    description:
      "Copy a file between context-root-relative paths, overwriting the destination. For context-bound callers, a valid workspace-repo destination becomes a GAD working edit; a platform-ignored destination or one outside reserved workspace source roots stays context-local scratch. Routed destinations under reserved roots must use canonical casing and valid repo shape.",
    args: z.union([
      z.tuple([z.string(), z.string()]),
      z.tuple([z.string(), z.string(), z.string()]),
    ]),
    returns: voidSchema,
    access: WRITE_ACCESS,
    examples: [{ args: [".tmp/a.txt", ".tmp/b.txt"] }],
  },
  rename: {
    description:
      "Move or rename a context-root-relative file or directory. For context-bound callers, scratch-to-scratch renames are direct; scratch-to-repo and repo-to-repo moves become GAD working edits. Moving a tracked repo path out to scratch is rejected so source state cannot bypass VCS. Routed endpoints under reserved workspace source roots must use canonical casing and valid repo shape.",
    args: z.union([
      z.tuple([z.string(), z.string()]),
      z.tuple([z.string(), z.string(), z.string()]),
    ]),
    returns: voidSchema,
    access: WRITE_ACCESS,
    examples: [
      { args: ["/.tmp/tmp-ab12", "/.tmp/todo.md"] },
      { args: ["/.tmp/tmp-ab12", "/projects/demo/notes/todo.md"] },
    ],
  },
  realpath: {
    description:
      "Resolve a path to its canonical form, returning it relative to the context root (sandboxed callers) or as an absolute host path (unrestricted callers).",
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: z.string(),
    access: READ_ACCESS,
  },
  ensureMaterialized: {
    description:
      "Materialize the given workspace path(s)/repo(s) (or 'all') into the context working folder. Context folders are SPARSE — only what is materialized exists on disk — so call this for the narrowest scope you need (a repo path like 'panels/chat', a section like 'panels', or specific paths) before reading them OUTSIDE the fs.* API (e.g. a grep/find subprocess). fs.* reads materialize on demand automatically.",
    args: z.tuple([z.union([z.string(), z.array(z.string()), z.literal("all")])]),
    returns: voidSchema,
    access: READ_ACCESS,
  },
  truncate: {
    description:
      "Truncate (or zero-extend) a file to the given byte length (default 0). For context-bound callers, a valid workspace-repo file routes through GAD; a scratch file is changed directly.",
    args: z.union([
      z.tuple([z.string(), z.number().optional()]),
      z.tuple([z.string(), z.string(), z.number().optional()]),
    ]),
    returns: voidSchema,
    access: WRITE_ACCESS,
    examples: [{ args: ["/logs/run.log", 0] }],
  },
  readlink: {
    description:
      "Read a symlink's target; absolute targets are relativized to the context root to avoid leaking host paths.",
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: z.string(),
    access: READ_ACCESS,
  },
  symlink: {
    description:
      "Create a symbolic link inside context-local scratch. Both the link and its resolved target must remain inside the caller's context root; absolute-looking targets are interpreted relative to that virtual root and stored as contained relative targets. Workspace-repo link paths are rejected because GAD does not represent symlink entries.",
    args: z.union([
      z.tuple([z.string(), z.string(), z.enum(["file", "dir", "junction"]).optional()]),
      z.tuple([z.string(), z.string(), z.string(), z.enum(["file", "dir", "junction"]).optional()]),
    ]),
    returns: voidSchema,
    access: WRITE_ACCESS,
    examples: [{ args: ["/.tmp/target.txt", "/.tmp/target-link.txt", "file"] }],
  },
  chmod: {
    description:
      "Change a path's Unix permission bits (mode). For context-bound callers, a valid workspace-repo file routes through GAD; a scratch path is changed directly.",
    args: z.union([
      z.tuple([z.string(), z.number()]),
      z.tuple([z.string(), z.string(), z.number()]),
    ]),
    returns: voidSchema,
    access: WRITE_ACCESS,
    examples: [{ args: ["/run.sh", 493] }],
  },
  utimes: {
    description:
      "Set a path's access and modification timestamps (seconds since the epoch) directly on the context filesystem projection; this does not create a GAD working edit.",
    args: z.union([
      z.tuple([z.string(), z.number(), z.number()]),
      z.tuple([z.string(), z.string(), z.number(), z.number()]),
    ]),
    returns: voidSchema,
    access: WRITE_ACCESS,
  },
  // Search
  grep: {
    description:
      "Search file contents under the context root for a regex pattern (the first argument), returning matching lines with optional context; uses ripgrep when available with a pure-JS fallback, skipping .git, node_modules, symlinks, and binary files.",
    args: z.union([
      z.tuple([z.string(), grepOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), grepOptionsSchema.optional()]),
    ]),
    returns: grepResultSchema,
    access: READ_ACCESS,
    examples: [{ args: ["TODO", { glob: "*.ts", contextLines: 2 }] }],
  },
  glob: {
    description:
      "Find files whose path matches a glob pattern (the first argument) under the context root, returned newest-first by mtime; skips .git, node_modules, and symlinks.",
    args: z.union([
      z.tuple([z.string(), globOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), globOptionsSchema.optional()]),
    ]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
    examples: [{ args: ["**/*.test.ts"] }],
  },
  // File handles
  open: {
    description:
      "Open a file with the given flags (default 'r') and optional mode, returning a server-tracked handleId for subsequent handleRead/handleWrite/handleStat/handleClose calls; handles are caller-scoped and auto-close after 5 minutes idle. For context-bound callers, write-capable flags are supported for scratch paths only and are rejected for GAD-tracked workspace-repo paths.",
    args: z.union([
      z.tuple([z.string(), z.string().optional(), z.number().optional()]),
      z.tuple([z.string(), z.string(), z.string().optional(), z.number().optional()]),
    ]),
    returns: z.object({
      handleId: z.number().describe("Server-tracked handle id for this open file."),
    }),
    access: {
      sensitivity: "write",
    },
    examples: [{ args: ["/data.bin", "r"] }],
  },
  handleRead: {
    description:
      "Read up to `length` bytes from an open handle at the given position (null reads from the current offset), returning the bytes base64-encoded plus the count actually read.",
    args: z.union([
      z.tuple([z.number(), z.number(), z.number().nullable()]),
      z.tuple([z.string(), z.number(), z.number(), z.number().nullable()]),
    ]),
    returns: z.object({
      bytesRead: z.number().describe("Number of bytes actually read into the buffer."),
      buffer: fsBinaryEnvelopeSchema.describe("The bytes read, base64-encoded."),
    }),
    access: READ_ACCESS,
    examples: [{ args: [1, 4096, null] }],
  },
  handleWrite: {
    description:
      "Write data (UTF-8 string or base64 binary envelope) to a write-capable handle at the given position (null uses the current offset), returning the byte count written. Context-bound callers cannot open GAD-tracked workspace-repo paths with write-capable flags, so their handle writes are scratch-only.",
    args: z.union([
      z.tuple([z.number(), fsDataSchema, z.number().nullable()]),
      z.tuple([z.string(), z.number(), fsDataSchema, z.number().nullable()]),
    ]),
    returns: z.object({ bytesWritten: z.number().describe("Number of bytes written.") }),
    access: WRITE_ACCESS,
  },
  handleClose: {
    description:
      "Close an open file handle and release its server-side resources; a no-op if the handle is already gone.",
    args: z.union([z.tuple([z.number()]), z.tuple([z.string(), z.number()])]),
    returns: voidSchema,
    access: {
      sensitivity: "write",
    },
  },
  handleStat: {
    description:
      "Return metadata (type flags, size, mtime/ctime, mode) for the file behind an open handle.",
    args: z.union([z.tuple([z.number()]), z.tuple([z.string(), z.number()])]),
    returns: statSchema,
    access: READ_ACCESS,
  },
  // Tmp files
  mktemp: {
    description:
      "Create the context's `.tmp/` directory if needed and return a fresh, unused root-relative scratch path under it (preferred for write-to-temp-then-rename patterns). The file itself is not created, the prefix is sanitized, and the path is not a tracked edit/VCS destination.",
    args: z.union([z.tuple([z.string().optional()]), z.tuple([z.string(), z.string().optional()])]),
    returns: z.string(),
    access: {
      sensitivity: "write",
    },
    examples: [{ args: ["edit"] }],
  },
});
