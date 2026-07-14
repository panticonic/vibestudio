import { z } from "zod";
import type { SchemaCoversType } from "@vibestudio/shared/schemaTypeGuard";
import type { VcsHeadAdvance, VcsWorkingAdvance } from "@vibestudio/shared/vcsEvents";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  buildDiagnosticSchema,
  repoBuildReportSchema,
  type BuildDiagnosticWire,
  type RepoBuildReportWire,
} from "./build.js";

const nullableString = z.string().nullable();

// Access descriptors shared across the read/write method groups carry
// documentation and safety metadata. The service policy is the enforced
// caller-kind gate.
//
// Reads are pure projections of GAD state (status/log/diff/readFile/
// resolveHead/recall). Writes are tracked WORKING edits (edit/revert) or head
// advances (commit/merge/push) through GAD — edit ≠ commit ≠ push.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const vcsFileStatusSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted"]),
});

export const vcsFileWriteContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("bytes"), base64: z.string() }),
]);
export type VcsFileWriteContent = z.infer<typeof vcsFileWriteContentSchema>;

export const vcsFileReadContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("bytes"), base64: z.string() }),
]);
export type VcsFileReadContent = z.infer<typeof vcsFileReadContentSchema>;

const vcsEditOpStrictSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replace"),
    path: z.string(),
    hunks: z.array(
      z.object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        oldText: z.string().optional(),
        newText: z.string(),
      })
    ),
  }),
  z.object({
    kind: z.literal("replaceText"),
    path: z.string(),
    oldText: z.string().min(1),
    newText: z.string(),
    all: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("write"),
    path: z.string(),
    content: vcsFileWriteContentSchema,
    mode: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("create"),
    path: z.string(),
    content: vcsFileWriteContentSchema,
    mode: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("delete"), path: z.string() }),
  z.object({ kind: z.literal("chmod"), path: z.string(), mode: z.number().int() }),
]);

/**
 * Normalize ergonomic edit shorthands → the strict discriminated union, so agents can write the
 * natural `{ path, content: "text" }` form rather than the verbose
 * `{ kind: "write", path, content: { kind: "text", text } }`:
 *  - a string `content` → `{ kind: "text", text }`
 *  - an omitted `kind` (when a `content` is present) → defaults to `"write"`
 *  - the conventional `"upsert"` spelling → `"write"` (create or overwrite)
 *  - `{ oldText, newText }` (with omitted or `replace` kind) → `replaceText`;
 *    the service resolves exact character spans against the current state
 * Genuinely-malformed edits (no `kind`, no `content`) pass through untouched so the discriminated
 * union still reports its precise discriminator error. The strict union is what serializes into
 * `help('vcs')` (zod-to-json-schema renders the inner schema of a preprocess), so discovery is
 * unchanged — the shorthand is an accepted superset, not a replacement.
 */
function normalizeVcsEditOp(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const e = raw as Record<string, unknown>;
  // Fail LOUD on a mis-keyed discriminator: an edit op has no `type` field, so `type` present
  // without `kind` is almost always a wrong-key mistake. Silently defaulting it to "write" (below)
  // would discard the intended op — e.g. `{ type: "replace", content }` would quietly become a
  // write. Surface the fix instead of guessing.
  if (e["kind"] === undefined && typeof e["type"] === "string") {
    throw new Error(
      `vcs edit op is missing "kind" but has type:"${e["type"]}" — edit ops are discriminated by ` +
        `"kind", not "type" (use { kind: "write" | "replace" | "create" | "delete" | "chmod", path, … }).`
    );
  }
  const asContent = (c: unknown) => (typeof c === "string" ? { kind: "text", text: c } : c);
  if (e["kind"] === undefined && typeof e["op"] === "string") {
    const opAliases: Record<string, "create" | "write" | "delete"> = {
      add: "create",
      create: "create",
      update: "write",
      write: "write",
      modify: "write",
      upsert: "write",
      remove: "delete",
      delete: "delete",
    };
    const kind = opAliases[e["op"].toLowerCase()];
    if (kind) {
      const { op: _op, ...rest } = e;
      return {
        ...rest,
        kind,
        ...(rest["content"] !== undefined ? { content: asContent(rest["content"]) } : {}),
      };
    }
  }
  if (e["kind"] === "upsert") {
    return { ...e, kind: "write", content: asContent(e["content"]) };
  }
  if (
    (e["kind"] === undefined || e["kind"] === "replace") &&
    e["hunks"] === undefined &&
    typeof e["oldText"] === "string" &&
    typeof e["newText"] === "string"
  ) {
    return { ...e, kind: "replaceText" };
  }
  if (e["kind"] === "write" || e["kind"] === "create") {
    return typeof e["content"] === "string" ? { ...e, content: asContent(e["content"]) } : raw;
  }
  if (e["kind"] === undefined && e["content"] !== undefined) {
    return { ...e, kind: "write", content: asContent(e["content"]) };
  }
  return raw;
}

export const vcsEditOpSchema = z.preprocess(normalizeVcsEditOp, vcsEditOpStrictSchema);
export type VcsEditOp = z.infer<typeof vcsEditOpStrictSchema>;

const vcsApplyEditsInputStrictSchema = z.object({
  clientEditId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Stable client-generated identity for an at-least-once edit batch. Retries with the same caller, head, repository, and ID return the original durable result; divergent reuse is rejected."
    ),
  baseStateHash: z
    .string()
    .optional()
    .describe(
      "Optimistic-concurrency base: the composed working state the edits were computed against (a `state:…` hash). Omit to apply against the head's current working state."
    ),
  edits: z
    .array(vcsEditOpSchema)
    .describe(
      'Ordered edit ops recorded as one working-set edit. Each op is discriminated by `kind` (replace/replaceText/write/create/delete/chmod). `upsert` is accepted as a write alias (create or overwrite); `{ path, content: "…" }` is shorthand for a write; `{ path, oldText, newText }` is shorthand for an exact, unique text replacement.'
    ),
  head: z
    .string()
    .optional()
    .describe(
      "Context head to edit. Omit for the caller's own context head; entity callers may only write their own `ctx:…` head."
    ),
  repoPath: z
    .string()
    .optional()
    .describe(
      "Repo the edits target (workspace-relative). When set, edit paths are repo-relative and route to that repo's log. Omit to route each edit by path → owning repo."
    ),
  invocationId: z
    .string()
    .optional()
    .describe(
      "Authoring agent tool-call id (the model tool-call / invocation that produced these edits). Recorded on each edit-op row as the edge into the agentic trajectory: file → edit → invocation → turn → session is then traversable (and survives commit). Self-asserted by the calling agent runtime, consistent with how trajectory events carry causality."
    ),
});

function normalizeVcsApplyEditsInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  if (input["edits"] === undefined && Array.isArray(input["fileEdits"])) {
    const { fileEdits, ...rest } = input;
    return { ...rest, edits: fileEdits };
  }
  return raw;
}

/** Accept the conventional/legacy `fileEdits:[{op:"add"|"update"|"remove"}]`
 * spelling at the boundary and normalize it to the canonical edits/kind form. */
export const vcsApplyEditsInputSchema = z.preprocess(
  normalizeVcsApplyEditsInput,
  vcsApplyEditsInputStrictSchema
);
export type VcsApplyEditsInput = z.infer<typeof vcsApplyEditsInputSchema>;

export const vcsMergeConflictSchema = z.object({
  path: z.string(),
  kind: z.enum(["content", "binary", "delete-vs-change", "mode"]),
});

/** One repo's slice of a multi-repo `vcs.edit` (see {@link vcsEditResultSchema}). */
export const vcsEditRepoResultSchema = z.object({
  repoPath: z.string(),
  /** The REPO-ROOTED working state hash — the CAS base for a follow-up edit. */
  stateHash: z.string(),
  editSeq: z.number().int().nonnegative(),
  changedPaths: z.array(z.string()),
});
export type VcsEditRepoResult = z.infer<typeof vcsEditRepoResultSchema>;

/** Result of `vcs.edit` — a tracked WORKING edit (no commit, no build). */
export const vcsEditResultSchema = z.object({
  head: z.string(),
  /**
   * The REPO-ROOTED working state hash (committed base + uncommitted ops)
   * projected to disk — the CAS base for a follow-up single-repo edit. ABSENT
   * on a multi-repo edit, which has no single repo-rooted state: use
   * `repos[].stateHash` per repo (and `contextStateHash` for the composed view).
   */
  stateHash: z.string().optional(),
  /**
   * The COMPOSED CONTEXT VIEW hash (multi-repo edits only) — a different
   * identity space from `stateHash`; never valid as a `baseStateHash` CAS base.
   */
  contextStateHash: z.string().optional(),
  /** Per-repo results (multi-repo edits only). */
  repos: z.array(vcsEditRepoResultSchema).optional(),
  committed: z.literal(false),
  status: z.literal("uncommitted"),
  /** The shared per-call edit sequence assigned to this edit's ops. */
  editSeq: z.number().int().nonnegative(),
  changedPaths: z.array(z.string()),
});
export type VcsEditResult = z.infer<typeof vcsEditResultSchema>;

/** Input to `vcs.commit` — fold a context's uncommitted edits into a snapshot. */
export const vcsCommitInputSchema = z.object({
  message: z.string().describe("Commit message (mandatory) recorded on the snapshot."),
  repoPaths: z
    .array(z.string())
    .optional()
    .describe(
      "Repos to commit (workspace-relative). Omit to commit every repo the caller's context has uncommitted edits (or a pending merge) in. Multi-repo commit is a non-atomic per-repo loop (atomicity is push's job); each repo reports its own status."
    ),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      "Workspace-relative paths to commit (the `git add <paths>` selector): ONLY working edits at these paths are sealed; everything else stays uncommitted. A path with no working edit is an error. Mutually exclusive with `exclude`."
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe(
      "Workspace-relative paths to leave UNCOMMITTED (the inverse of `git add`): commit everything tracked except these. Mutually exclusive with `paths`."
    ),
  head: z
    .string()
    .optional()
    .describe("Head to commit (default: the caller's own context head). `main` is rejected."),
  invocationId: z
    .string()
    .optional()
    .describe(
      "Authoring agent tool-call id (the model tool-call / invocation that sealed this commit). Recorded on the commit event so the commit itself — not only its edit ops — is attributable into the agentic trajectory. Self-asserted by the calling agent runtime, consistent with `vcs.edit`."
    ),
});
export type VcsCommitInput = z.infer<typeof vcsCommitInputSchema>;

/** An actor whose working edits were folded into a commit sealed by a
 *  DIFFERENT actor (shared context heads) — surfaced so the seal can print
 *  "includes edits by X" and provenance keeps both parties. */
export const vcsCommitCoAuthorSchema = z.object({
  id: z.string(),
  kind: z.string(),
  subject: z.object({ userId: z.string() }).partial().optional(),
});
export type VcsCommitCoAuthor = z.infer<typeof vcsCommitCoAuthorSchema>;

/**
 * Per-repo result of `vcs.commit`. Multi-repo commits NEVER throw mid-loop:
 * every targeted repo reports its own terminal status — `committed`,
 * `unchanged` (nothing to seal; not an error at this layer), or `refused`
 * (that repo's seal failed; see `refusedReason`) — so a partial outcome is
 * always fully visible.
 */
export const vcsCommitResultSchema = z.object({
  repoPath: z.string(),
  head: z.string(),
  stateHash: nullableString,
  eventId: nullableString,
  headHash: nullableString,
  editCount: z.number().int().nonnegative(),
  status: z.enum(["committed", "unchanged", "refused"]),
  /** Why the repo refused to commit (status "refused" only). */
  refusedReason: z.string().optional(),
  changedPaths: z.array(z.string()),
  /** Actors other than the committer whose working edits this commit sealed. */
  coAuthors: z.array(vcsCommitCoAuthorSchema).optional(),
});
export type VcsCommitResult = z.infer<typeof vcsCommitResultSchema>;

/** A persisted edit-op row (provenance) returned by the traversal reads. */
export const vcsEditOpRowSchema = z.object({
  id: z.number().int(),
  eventId: z.string(),
  committedEventId: nullableString,
  committedSeq: z.number().int().nullable(),
  editSeq: z.number().int().nullable(),
  outputStateHash: nullableString,
  ordinal: z.number().int(),
  kind: z.string(),
  path: z.string(),
  oldContentHash: nullableString,
  newContentHash: nullableString,
  mode: z.number().int().nullable(),
  actorId: nullableString,
  invocationId: nullableString,
  turnId: nullableString,
  createdAt: nullableString,
  // Wave 1 / U1 blame provenance: raw hunks_json (parsed by blame consumers),
  // snapshot-take + binary flags (both drive blame chain-restart semantics).
  hunksJson: nullableString,
  synthetic: z.boolean(),
  binary: z.boolean(),
});
export type VcsEditOpRow = z.infer<typeof vcsEditOpRowSchema>;

/** One contiguous line range attributed by `vcs.blameLines` (design §5.2). */
export const vcsBlameLineSchema = z.object({
  startLine: z.number().int(),
  endLine: z.number().int(),
  opId: z.number().int().nullable(),
  kind: nullableString,
  commitEventId: nullableString,
  commitMessage: nullableString,
  invocationId: nullableString,
  turnId: nullableString,
  actorId: nullableString,
  degraded: z.enum(["create", "binary", "synthetic", "older-than-log"]).nullable(),
  /** For `synthetic` import stops: the upstream git author of the last commit
   *  that touched the path, when the import recorded it. */
  importedAuthor: z
    .object({
      sha: z.string(),
      authorName: z.string().optional(),
      authorEmail: z.string().optional(),
    })
    .nullable(),
});
export type VcsBlameLine = z.infer<typeof vcsBlameLineSchema>;

/**
 * One rendered read-attachment / drill-down line (design §7.5): a bounded
 * `insight + handle`. `exception` sorts it first, above density (contradictions,
 * cross-session concurrency, main movements); `score` is the §6.1 rank (0 for
 * exceptions — they render regardless). USERLAND-dispatched result shape (the
 * gad-store DO's `provenanceForFile`/`provenanceForSession`/`provenanceForClaim`).
 */
export const vcsProvItemSchema = z.object({
  line: z.string(),
  handle: z.string(),
  kind: z.string(),
  exception: z.boolean(),
  score: z.number(),
});
export type VcsProvItem = z.infer<typeof vcsProvItemSchema>;

/** The §7.1 read-attachment / drill-down page. `total` is the full ranked list
 *  (exceptions + floored density); `suppressed` = the block signature was
 *  unchanged; `degraded` = the compute overran its budget and returned the hint. */
export const vcsProvenanceForFileResultSchema = z.object({
  items: z.array(vcsProvItemSchema),
  shown: z.number().int(),
  total: z.number().int(),
  nextCursor: z.string().optional(),
  suppressed: z.boolean(),
  degraded: z.boolean().optional(),
});
export type VcsProvenanceForFileResult = z.infer<typeof vcsProvenanceForFileResultSchema>;

/** The §7.6 session-orientation page (exceptions-first, then density-ranked). */
export const vcsProvenanceForSessionResultSchema = z.object({
  items: z.array(vcsProvItemSchema),
  shown: z.number().int(),
  total: z.number().int(),
  nextCursor: z.string().optional(),
});
export type VcsProvenanceForSessionResult = z.infer<typeof vcsProvenanceForSessionResultSchema>;

/** A commit on the source head not yet on the target (upstream-commit shape). */
export const vcsUpstreamCommitSchema = z.object({
  eventId: z.string(),
  message: z.string(),
  stateHash: z.string(),
  createdAt: nullableString,
});
export type VcsUpstreamCommit = z.infer<typeof vcsUpstreamCommitSchema>;

/** A commit DAG node (event-keyed) returned by `vcs.commitAncestors`. */
export const vcsCommitAncestorSchema = z.object({
  eventId: z.string(),
  stateHash: nullableString,
  parentEventIds: z.array(z.string()),
});
export type VcsCommitAncestor = z.infer<typeof vcsCommitAncestorSchema>;

/** A path-level delta (added/removed/changed path lists). */
export const vcsPathDeltaSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});
export type VcsPathDelta = z.infer<typeof vcsPathDeltaSchema>;

/** An in-progress merge parked on a head (conflicted, awaiting resolution). */
export const vcsPendingMergeInfoSchema = z.object({
  /** The head the merge is pulling in (e.g. `main`). */
  source: z.string(),
  /** Paths still carrying conflicts (in-file markers, or binary/mode/delete
   *  conflicts summarized in MERGE_CONFLICTS.md at the worktree root). */
  conflictPaths: z.array(z.string()),
  /** When the merge was parked (ISO), or null for merges parked before
   *  timestamps were recorded. */
  startedAt: nullableString,
});
export type VcsPendingMergeInfo = z.infer<typeof vcsPendingMergeInfoSchema>;

/**
 * Status is a GAD state-diff of a head against BOTH its baselines:
 * `committed` — the committed-but-unpushed delta (ctx committed head vs its
 * repo's `main`), and `working` — the uncommitted delta (working content vs
 * the committed head). Both enumerate paths; nothing is count-only. The
 * on-disk worktree is a disposable projection. `dirty` is true iff either
 * delta is non-empty. Status on `main` is always clean (it is the baseline).
 */
export const vcsStatusResultSchema = z.object({
  /** The committed ctx-head state (null: never forked / no commits). */
  committedStateHash: nullableString,
  /** The working state (committed head + uncommitted ops); equals
   *  `committedStateHash` when there are no working edits. */
  workingStateHash: nullableString,
  dirty: z.boolean(),
  /** Committed-but-unpushed delta: committed head vs the repo's `main`. */
  committed: vcsPathDeltaSchema,
  /** Uncommitted delta: working content vs the committed head. */
  working: vcsPathDeltaSchema,
  /** Count of UNCOMMITTED working edit ops (push rejects while > 0). */
  uncommitted: z.number().int().nonnegative(),
  /** `main` advanced past this head's merge-base — reconcile with vcs.merge
   *  (or vcs.rebaseContext) before push. */
  diverged: z.boolean(),
  /** `main` advanced but this head is a pure ancestor of it (nothing to push;
   *  merge/rebase only if you want the newer base). */
  behind: z.boolean(),
  /** The repo was deleted from the workspace (`main` archived/gone) — a push
   *  will be refused; restore it or drop the context. */
  deleted: z.boolean(),
  /** In-progress merge parked on this head, if any. Seal with vcs.commit
   *  after resolving, or vcs.abortMerge to drop it. */
  pendingMerge: vcsPendingMergeInfoSchema.nullable(),
});
export type VcsStatusResult = z.infer<typeof vcsStatusResultSchema>;

export const vcsLogEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  envelopeId: z.string(),
  actor: z.unknown(),
  summary: nullableString,
  outputStateHash: nullableString,
  appendedAt: z.string(),
});
export type VcsLogEntry = z.infer<typeof vcsLogEntrySchema>;

// ---------------------------------------------------------------------------
// Content diff (`vcs.diffContent`) — real hunks, not just name-status
// ---------------------------------------------------------------------------

export const vcsDiffHunkSchema = z.object({
  /** 1-based start line in the left (old) file; 0 for pure insertions. */
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  /** 1-based start line in the right (new) file; 0 for pure deletions. */
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  /** Unified-diff body lines: ` context`, `-removed`, `+added` (no headers). */
  lines: z.array(z.string()),
});
export type VcsDiffHunk = z.infer<typeof vcsDiffHunkSchema>;

export const vcsDiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "removed", "changed"]),
  /** Binary on either side — no hunks; sizes reported instead. */
  binary: z.boolean(),
  oldMode: z.number().int().nullable(),
  newMode: z.number().int().nullable(),
  oldSize: z.number().int().nullable(),
  newSize: z.number().int().nullable(),
  hunks: z.array(vcsDiffHunkSchema),
});
export type VcsDiffFile = z.infer<typeof vcsDiffFileSchema>;

export const vcsDiffContentInputSchema = z.object({
  repoPath: z
    .string()
    .optional()
    .describe(
      "Repo to diff (workspace-relative). Required unless explicit `left`/`right` states are given."
    ),
  head: z.string().optional().describe("Head to diff (default: the caller's own context head)."),
  scope: z
    .enum(["committed", "working", "all"])
    .optional()
    .describe(
      "`committed`: merge-base(main, head) → committed head (what a push would carry). " +
        "`working`: committed head → working content (what a commit would seal). " +
        "`all` (default): merge-base → working content (everything unpushed)."
    ),
  left: z
    .string()
    .optional()
    .describe("Explicit left `state:…` hash — overrides `scope` (pass with `right`)."),
  right: z.string().optional().describe("Explicit right `state:…` hash (pass with `left`)."),
  paths: z.array(z.string()).optional().describe("Limit the diff to these repo-relative paths."),
  contextLines: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Context lines per hunk (default 3)."),
});
export type VcsDiffContentInput = z.infer<typeof vcsDiffContentInputSchema>;

export const vcsDiffContentResultSchema = z.object({
  /** The resolved left/right state hashes actually diffed. */
  left: z.string(),
  right: z.string(),
  files: z.array(vcsDiffFileSchema),
  /** The whole diff as one unified-diff document (`--- a/… +++ b/…` per file). */
  unified: z.string(),
});
export type VcsDiffContentResult = z.infer<typeof vcsDiffContentResultSchema>;

export const vcsDiffResultSchema = z.object({
  added: z.array(z.unknown()),
  removed: z.array(z.unknown()),
  changed: z.array(z.unknown()),
});
export type VcsDiffResult = z.infer<typeof vcsDiffResultSchema>;

export const vcsResolveHeadResultSchema = z.object({
  head: z.string(),
  stateHash: nullableString,
});
export type VcsResolveHeadResult = z.infer<typeof vcsResolveHeadResultSchema>;

export const vcsWorkspaceViewResultSchema = z.object({
  stateHash: z
    .string()
    .describe(
      "Workspace-rooted composed state hash, suitable for build.getBuild's immutable ref argument."
    ),
});

export const vcsMergeResultSchema = z.object({
  status: z.enum(["up-to-date", "merged", "conflicted"]),
  stateHash: nullableString,
  conflicts: z.array(vcsMergeConflictSchema),
  /** Whether the reconcile was clean (a merge commit, no file resolution) or in
   *  conflict (markers in the context FS — resolve via vcs.edit then vcs.commit). */
  mergeable: z.enum(["clean", "conflict"]),
  /** The upstream (main) commits this reconcile pulled in. */
  upstreamCommits: z.array(vcsUpstreamCommitSchema),
  conflictPaths: z.array(z.string()).optional(),
});
export type VcsMergeResult = z.infer<typeof vcsMergeResultSchema>;

/**
 * Merge / pick SOURCE selector: the protected workspace `main`, or another
 * context's committed head (`{ contextId }` → `ctx:{contextId}`, which requires
 * cross-context read authorization). The merge/pick TARGET is always the
 * caller's own context head — a source is pulled INTO it, never the reverse.
 */
export const vcsMergeSourceSchema = z.union([
  z.literal("main"),
  z.object({ contextId: z.string(), ownerContextId: z.string().optional() }),
]);
export type VcsMergeSource = z.infer<typeof vcsMergeSourceSchema>;

/**
 * One repo's reconcile in the `vcs.merge` result array. Multi-repo merges
 * NEVER throw mid-loop: a repo whose merge cannot run (uncommitted edits,
 * deleted repo, source has no state there, …) reports status `refused` with
 * `refusedReason`, while the other repos' outcomes are still returned.
 */
export const vcsMergeRepoResultSchema = z.object({
  repoPath: z.string(),
  status: z.enum(["up-to-date", "merged", "conflicted", "refused"]),
  stateHash: nullableString,
  conflicts: z.array(vcsMergeConflictSchema),
  /** Whether the reconcile was clean (a merge commit, no file resolution) or in
   *  conflict (markers in the context FS — resolve via vcs.edit then vcs.commit). */
  mergeable: z.enum(["clean", "conflict"]),
  /** The upstream (source) commits this reconcile pulled in. */
  upstreamCommits: z.array(vcsUpstreamCommitSchema),
  conflictPaths: z.array(z.string()).optional(),
  /** Why the repo refused to merge (status "refused" only). */
  refusedReason: z.string().optional(),
});
export type VcsMergeRepoResult = z.infer<typeof vcsMergeRepoResultSchema>;

/** A single cherry-pick entry for `vcs.pick`: a whole COMMIT's patch (3-way
 *  applied on the target repo's head) or a source context's working content at
 *  specific PATHS (routed to their owning repos, injected as write ops). */
export const vcsPickSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit"),
    repoPath: z.string().describe("Repo whose log the commit lives on (workspace-relative)."),
    eventId: z.string().describe("The commit's log event id (its patch is 3-way applied)."),
  }),
  z.object({
    kind: z.literal("paths"),
    paths: z
      .array(z.string())
      .min(1)
      .describe(
        "Workspace-relative paths whose content is copied from the source context (routed to their owning repos). Requires source:{contextId}."
      ),
  }),
]);
export type VcsPick = z.infer<typeof vcsPickSchema>;

export const vcsPendingMergeSchema = z
  .object({
    theirsHead: z.string(),
    conflicts: z.array(vcsMergeConflictSchema),
    /** When the merge was parked (ISO), or null for pre-timestamp merges. */
    startedAt: nullableString,
  })
  .nullable();
export type VcsPendingMerge = z.infer<typeof vcsPendingMergeSchema>;

export const vcsFileContentSchema = z.object({
  content: vcsFileReadContentSchema,
  stateHash: z.string(),
  contentHash: z.string(),
  mode: z.number().int(),
  size: z.number().int().nonnegative(),
});
export type VcsFileContent = z.infer<typeof vcsFileContentSchema>;

export const vcsFileListEntrySchema = z.object({
  path: z.string(),
  contentHash: z.string(),
  mode: z.number().int(),
});
export type VcsFileListEntry = z.infer<typeof vcsFileListEntrySchema>;

const vcsHeadAdvanceActorSchema = z.object({ id: z.string(), kind: z.string() }).nullable();

export const vcsHeadAdvanceSchema = z.object({
  head: z.string(),
  stateHash: z.string(),
  /**
   * The advanced log's own state hash — the identity space of
   * `vcs.edit`/`vcs.commit`/`readFile`/`revert` return values. For a per-repo head this
   * is the subtree-rooted repo state and differs from `stateHash` (the composed
   * view); they are equal for whole-workspace heads. Clients correlating an RPC
   * result with this advance (self-echo / undo guards) must match on this.
   */
  repoStateHash: z.string(),
  sinceStateHash: nullableString,
  eventId: nullableString,
  headHash: nullableString,
  actor: vcsHeadAdvanceActorSchema,
  transitionKind: z.enum(["snapshot", "edit", "merge", "merge-resolution"]),
  changedPaths: z.array(z.string()),
  fileChanges: z.array(
    z.object({
      kind: z.enum(["added", "removed", "changed"]),
      path: z.string(),
      oldContentHash: nullableString,
      newContentHash: nullableString,
      oldMode: z.number().int().nullable(),
      newMode: z.number().int().nullable(),
    })
  ),
  editOps: z.array(
    z.object({
      kind: z.enum(["replace", "write", "create", "delete", "chmod"]),
      path: z.string(),
      oldContentHash: nullableString,
      newContentHash: nullableString,
      hunks: z.unknown().optional(),
      mode: z.number().int().nullable().optional(),
    })
  ),
});
const _vcsHeadAdvanceSchemaCoversType: SchemaCoversType<
  VcsHeadAdvance,
  z.infer<typeof vcsHeadAdvanceSchema>
> = true;
const _vcsHeadAdvanceSchemaOutputIsType: z.infer<typeof vcsHeadAdvanceSchema> extends VcsHeadAdvance
  ? true
  : false = true;
void _vcsHeadAdvanceSchemaCoversType;
void _vcsHeadAdvanceSchemaOutputIsType;

/**
 * A WORKING-content advance (`vcs.edit`) on a `ctx:*` head — broadcast on the
 * `vcs:working:{head}` topic, consumed via `subscribeWorking`. Deliberately
 * distinct from {@link vcsHeadAdvanceSchema}: an edit is NOT a state operation
 * (no commit, no build, not in vcs.log). Reactive views (and the editor undo
 * path, since `vcs.revert` is now a working edit) consume this to reflect
 * uncommitted edits; the build trigger ignores it.
 */
export const vcsWorkingAdvanceSchema = z.object({
  head: z.string(),
  repoPath: z.string().optional(),
  actor: vcsHeadAdvanceActorSchema,
  /** The working state hash (committed base + uncommitted ops) on disk. The
   *  self-echo / undo-correlation hash, analogous to head-advance repoStateHash. */
  stateHash: z.string(),
  /** The committed base the working content composes on. */
  baseStateHash: z.string(),
  /** The shared per-call edit sequence for this edit's ops. */
  editSeq: z.number().int().nonnegative(),
  /** Paths changed by this edit (workspace-relative). */
  changedPaths: z.array(z.string()),
});
const _vcsWorkingAdvanceSchemaCoversType: SchemaCoversType<
  VcsWorkingAdvance,
  z.infer<typeof vcsWorkingAdvanceSchema>
> = true;
const _vcsWorkingAdvanceSchemaOutputIsType: z.infer<
  typeof vcsWorkingAdvanceSchema
> extends VcsWorkingAdvance
  ? true
  : false = true;
void _vcsWorkingAdvanceSchemaCoversType;
void _vcsWorkingAdvanceSchemaOutputIsType;

export const vcsRecallInputSchema = z.object({
  query: z
    .string()
    .describe("Free-text query matched against indexed VCS memory (log summaries, file snippets)."),
  kinds: z
    .array(z.string())
    .optional()
    .describe("Restrict results to these memory entry kinds; omit to search across all kinds."),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Maximum number of results to return (1–50, default applied server-side)."),
  repoPaths: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict recall to these repos' indices (workspace-relative repo paths); omit to search across all repos."
    ),
  recallKeywords: z
    .array(z.string())
    .optional()
    .describe(
      "Optional steering keywords OR-appended to the query's FTS match to widen recall; never load-bearing (a bonus signal, not a filter)."
    ),
});
export type VcsRecallInput = z.infer<typeof vcsRecallInputSchema>;

// ---------------------------------------------------------------------------
// Userland push contract (per-repo + group) — DO `vcsPush`
// ---------------------------------------------------------------------------

export const vcsPushInputSchema = z.object({
  repoPaths: z
    .array(z.string())
    .min(1)
    .describe(
      "Repos to push (workspace-relative repo paths). Multiple repos push as one atomic, build-gated group — all heads advance or none do."
    ),
  sourceHead: z
    .string()
    .optional()
    .describe(
      "Head to push from into each repo's main (e.g. a `ctx:…` context head). Omit to push the caller's own context head."
    ),
  message: z
    .string()
    .optional()
    .describe("Optional log summary recorded on the pushed repo commit(s)."),
});
export type VcsPushInput = z.infer<typeof vcsPushInputSchema>;

/** Per-repo divergence in a rejected fast-forward-only push: `main` advanced past
 *  the ctx head's merge-base. Reconcile with an explicit vcs.merge. */
export const vcsRepoDivergenceSchema = z.object({
  repoPath: z.string(),
  base: nullableString,
  mainTip: nullableString,
  upstreamCommits: z.array(vcsUpstreamCommitSchema),
  mergeable: z.enum(["clean", "conflict"]),
  conflictPaths: z.array(z.string()).optional(),
});
export type VcsRepoDivergence = z.infer<typeof vcsRepoDivergenceSchema>;

// The build-report contract (`buildDiagnosticSchema` + `repoBuildReportSchema`)
// is the CANONICAL one from build.ts — `vcsPush`/`vcs.previewBuild` return
// exactly what the build service produces and validates (the SAME producer:
// buildV2's validateRepoPush). Re-exported here so `vcs.*` callers import it from
// one place; defining a parallel copy is what drifted (artifact-integrity
// optionality, diagnostic line/col nullability) and caused false return-
// validation failures. Single source of truth → no future drift.
export { buildDiagnosticSchema, repoBuildReportSchema };
export type BuildDiagnostic = BuildDiagnosticWire;
export type RepoBuildReport = RepoBuildReportWire;

export const vcsPushResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pushed"),
    repoPaths: z.array(z.string()),
    reports: z.array(repoBuildReportSchema),
  }),
  z.object({
    status: z.literal("up-to-date"),
    repoPaths: z.array(z.string()),
    reports: z.array(repoBuildReportSchema),
  }),
  z.object({
    status: z.literal("diverged"),
    divergences: z.array(vcsRepoDivergenceSchema),
  }),
  z.object({
    status: z.literal("build-failed"),
    reports: z.array(repoBuildReportSchema),
  }),
]);
export type VcsPushResult = z.infer<typeof vcsPushResultSchema>;

export const vcsPushStatusSchema = z.object({
  repoPath: z.string(),
  head: z.string(),
  headStateHash: nullableString,
  mainStateHash: nullableString,
  ahead: z.number().int().nonnegative(),
  /** Count of UNCOMMITTED working edits (push rejects while > 0). */
  uncommitted: z.number().int().nonnegative(),
  /** Paths carrying uncommitted working edits (commit or discard before push). */
  uncommittedPaths: z.array(z.string()),
  /** `main` diverged past this head's base (a true fork) — a fast-forward push
   *  is impossible without an explicit vcs.merge. NOT set when the head is
   *  merely a pure ancestor of main (that is `behind`). */
  diverged: z.boolean(),
  /** `main` advanced but this head is a pure ancestor of it — nothing to push,
   *  no merge needed. */
  behind: z.boolean(),
  /** The repo was deleted from the workspace (`main` archived/gone) — a push
   *  will be refused; restore it or drop/rebase the context. */
  deleted: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["added", "removed", "changed"]),
    })
  ),
});
export type VcsPushStatus = z.infer<typeof vcsPushStatusSchema>;

export const vcsRecallResultSchema = z.object({
  results: z.array(
    z.object({
      kind: z.string(),
      snippet: z.string(),
      score: z.number().nullable(),
      logId: nullableString,
      head: nullableString,
      eventId: nullableString,
      path: nullableString,
      contentHash: nullableString,
      anchor: z.record(z.unknown()).nullable(),
      actor: z.unknown(),
      appendedAt: nullableString,
    })
  ),
});
export type VcsRecallResult = z.infer<typeof vcsRecallResultSchema>;

/**
 * Per-repo scoping argument. The per-repo VCS has NO whole-tree log, so every
 * head-keyed operation must name its repo — `repoPath` is REQUIRED on the
 * methods whose core resolves a head (status/log/revert/merge/abortMerge/
 * pendingMerge/resolveHead): omitting it throws `per-repo VCS: a repoPath is
 * required` at runtime, so the schema forbids it at compile time.
 */
const repoPathArg = z
  .string()
  .describe(
    "Workspace-relative repo path (e.g. `panels/chat`, `projects/vault`, `meta`) scoping this operation to one repo's log/head."
  );

/**
 * Optional per-repo scoping for the path-routed / view-rooted reads
 * (readFile/listFiles): when omitted, the service routes by edit/file path to
 * the owning repo (readFile) or resolves the caller's composed workspace view
 * (listFiles), so a missing `repoPath` is a meaningful default, not a throw.
 */
const repoPathArgOptional = z
  .string()
  .optional()
  .describe(
    "Workspace-relative repo path scoping this read to one repo's head. Omit to route by path (readFile) or read the whole composed context view (listFiles)."
  );

/**
 * Optional cross-context read scope for the head-resolving reads
 * (status/readFile/listFiles/pendingMerge/contextStatus): when set, the read
 * resolves the NAMED context's `ctx:*` head instead of the caller's own. The
 * caller must OWN (lifecycle child) or have FORKED (lineage descendant) that
 * context per the runtime relationship registry — otherwise the read THROWS
 * (this is a deny gate, never a prompt). `ownerContextId` is a host-verified
 * owner-context hint for child tools such as subagent inspection; it is honored
 * only when the caller entity owns the recorded context edge. Omit to read the
 * caller's own head.
 */
const contextScopeArg = z
  .object({ contextId: z.string(), ownerContextId: z.string().optional() })
  .optional()
  .describe(
    "Inspect another context you own or forked (resolves that context's ctx:* head). Unauthorized cross-context reads throw."
  );

export const vcsReadFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Workspace-relative path, or a repo-relative path when repoPath is supplied. Bare paths use the workspace's declared defaultRepo."
      ),
    repoPath: repoPathArgOptional,
    ref: z.string().optional().describe("VCS ref; omit for the caller's current context head."),
    scope: contextScopeArg,
  })
  .strict();
export type VcsReadFileInput = z.infer<typeof vcsReadFileInputSchema>;

export const vcsListFilesInputSchema = z
  .object({
    repoPath: repoPathArgOptional,
    ref: z.string().optional().describe("VCS ref; omit for the caller's current context head."),
    scope: contextScopeArg,
  })
  .strict();
export type VcsListFilesInput = z.infer<typeof vcsListFilesInputSchema>;

// NOTE (P5c): the read/history traversals — commitEdits, fileHistory,
// commitAncestors, editsByActor, editsByTurn, editsByInvocation,
// blameLines — and the §6/§7 provenance surface — provenanceForFile,
// provenanceForSession, provenanceForClaim — are USERLAND-dispatched: they run
// in the gad-store DO behind the `vcs` manifest service (vibestudio.vcs.v1) and are
// called through `createDurableObjectServiceClient`, not this host service
// table. Their row/result schemas above (VcsEditOpRow, VcsBlameLine,
// VcsCommitAncestor, VcsLogEntry, VcsProvItem/VcsProvenanceForFileResult) remain
// the wire contract.
export const vcsMethods = defineServiceMethods({
  edit: {
    description:
      "Record a batch of file edits as UNCOMMITTED WORKING changes on the caller's context head — tracked durably with full provenance, but NOT a commit: no commit-log entry, no head advance, no build, and they never appear in vcs.log. Edits route to their owning repo by path; bare paths use the workspace's declared defaultRepo. Make deliberate milestones with vcs.commit. Edits target a `ctx:*` head; `main` advances only via push.",
    args: z.tuple([vcsApplyEditsInputSchema]),
    returns: vcsEditResultSchema,
    access: WRITE_ACCESS,
    examples: [
      {
        args: [
          {
            edits: [
              {
                kind: "write",
                path: "panels/chat/notes.md",
                content: { kind: "text", text: "# Notes\n" },
              },
            ],
          },
        ],
      },
    ],
  },
  commit: {
    description:
      "Fold the caller context's uncommitted working edits into ONE deliberate, messaged snapshot per repo, advancing each repo's context head and owning exactly those edits (queryable via commitEdits). `message` is mandatory. `paths` seals only the listed paths (`git add <paths>`); `exclude` seals everything except the listed paths. A repo with a pending merge commits the resolution — even with zero working edits (sealing a merge that needed no manual resolution). Multi-repo commits report a per-repo status (`committed`/`unchanged`/`refused`) and never throw away partial results. `main` is rejected (push only).",
    args: z.tuple([vcsCommitInputSchema]),
    returns: z.array(vcsCommitResultSchema),
    access: WRITE_ACCESS,
    examples: [{ args: [{ message: "Add notes panel" }] }],
  },
  discardEdits: {
    description:
      "Drop a repo's uncommitted working edits on the caller's context head AND clear any in-progress merge, restoring the committed head on disk (abort / stash-drop). To abort ONLY a pending merge while keeping other working edits, use vcs.abortMerge instead.",
    args: z.tuple([repoPathArg, z.string().optional()]),
    returns: z.object({ discarded: z.number().int().nonnegative(), stateHash: z.string() }),
    access: { ...WRITE_ACCESS, sensitivity: "destructive" },
    examples: [{ args: ["panels/chat"] }],
  },
  previewBuild: {
    description:
      "On-demand build of the caller context's WORKING content (committed head + uncommitted edits), scoped to specific repos or units. Does NOT touch the published EV baseline — builds happen authoritatively only at push. Use for a dev preview without committing.",
    args: z.tuple([
      z.object({
        repoPaths: z.array(z.string()).optional(),
        units: z.array(z.string()).optional(),
        head: z.string().optional(),
      }),
    ]),
    returns: z.array(repoBuildReportSchema),
    access: READ_ACCESS,
    examples: [{ args: [{ repoPaths: ["panels/chat"] }] }],
  },
  readFile: {
    description:
      "Read one file's content (text or base64 bytes), state/content hashes, and mode. The object address has one meaning on every transport: path is workspace-relative unless repoPath explicitly makes it repo-relative; ref defaults to the caller's current head; scope selects an owned/forked context. Bare paths use meta/vibestudio.yml defaultRepo and fail clearly when none is declared.",
    args: z.tuple([vcsReadFileInputSchema]),
    returns: vcsFileContentSchema.nullable(),
    access: READ_ACCESS,
    examples: [{ args: [{ path: "notes.md", repoPath: "panels/chat" }] }],
  },
  listFiles: {
    description:
      "List every file (path, content hash, mode) at a VCS ref. Omit the input/ref for the caller's composed current head; pass repoPath for a repo-relative listing; scope selects an owned/forked context.",
    args: z.tuple([vcsListFilesInputSchema.optional()]),
    returns: z.array(vcsFileListEntrySchema),
    access: READ_ACCESS,
  },
  revert: {
    description:
      "Undo a prior change by forward-applying its inverse patch onto the caller's head as an UNCOMMITTED WORKING edit — the head does NOT advance until you seal it with vcs.commit (and push it like any other change). Target the change by state hash or event id; when both are omitted, the latest commit on the repo head is reverted. Pass repoPath to revert on a specific repo's log.",
    args: z.tuple([
      z.object({
        stateHash: z
          .string()
          .optional()
          .describe("Target the change that produced this `state:…` hash."),
        eventId: z
          .string()
          .optional()
          .describe("Target the change by its log event id instead of a state hash."),
        head: z
          .string()
          .optional()
          .describe(
            "Head to revert on. Omit for the caller's own context head; entity callers may only write their own `ctx:…` head."
          ),
        repoPath: z
          .string()
          .describe("Repo to revert on (workspace-relative repo path). Required (per-repo VCS)."),
      }),
    ]),
    returns: vcsEditResultSchema,
    access: { ...WRITE_ACCESS, sensitivity: "destructive" },
    examples: [{ args: [{ eventId: "evt-123", repoPath: "panels/chat" }] }],
  },
  log: {
    description:
      "Recent commits for a repo head, newest first. Omit head for the caller's current context head. This host compatibility route matches the runtime vcs.log(repoPath, limit?, head?) surface.",
    args: z.tuple([repoPathArg, z.number().int().positive().optional(), z.string().optional()]),
    returns: z.array(vcsLogEntrySchema),
    access: READ_ACCESS,
    examples: [{ args: ["projects/default", 20] }],
  },
  status: {
    description:
      "Status of a repo's head against both baselines: committed changes relative to main and uncommitted working changes relative to the committed head, with path lists, divergence/behind state, deletion, and any pending merge. Not a filesystem scan. repoPath is required (per-repo VCS).",
    args: z.tuple([repoPathArg, z.string().optional(), contextScopeArg]),
    returns: vcsStatusResultSchema,
    access: READ_ACCESS,
    examples: [{ args: ["panels/chat"] }],
  },
  diff: {
    description:
      "Diff two GAD states by their `state:…` hashes, returning the added/removed/changed files between them (name-status only — use vcs.diffContent for hunks).",
    args: z.tuple([z.string(), z.string()]),
    returns: vcsDiffResultSchema,
    access: READ_ACCESS,
  },
  diffContent: {
    description:
      "CONTENT diff with real hunks and a unified-diff rendering — review what actually changed before committing or pushing. Scope `working` diffs the uncommitted edits (what a commit would seal), `committed` the unpushed commits (what a push would carry), `all` (default) everything unpushed; or pass explicit left/right `state:…` hashes. Binary files are flagged, never hunked.",
    args: z.tuple([vcsDiffContentInputSchema]),
    returns: vcsDiffContentResultSchema,
    access: READ_ACCESS,
    examples: [{ args: [{ repoPath: "panels/chat", scope: "working" }] }],
  },
  resolveHead: {
    description:
      'Resolve a ref to its head name and current `state:…` hash on a repo\'s log. Omit the ref for the caller\'s current context head; pass "main"/"ctx:…" for an explicit ref, and repoPath to scope to a repo.',
    args: z.tuple([z.string().optional(), repoPathArg]),
    returns: vcsResolveHeadResultSchema,
    access: READ_ACCESS,
    examples: [{ args: ["main", "packages/core"] }],
  },
  workspaceViewWithRepoAt: {
    description:
      "Compose a workspace-rooted state view with one repo replaced by a repo-rooted state hash (or removed when null). Use this to convert a repo state from vcs.log/vcs.commit/vcs.resolveHead into the immutable state ref that build.getBuild expects.",
    args: z.tuple([repoPathArg, nullableString]),
    returns: vcsWorkspaceViewResultSchema,
    access: READ_ACCESS,
    examples: [{ args: ["panels/chat", "state:abc123"] }],
  },
  merge: {
    description:
      "Reconcile divergence: pull a SOURCE (`main`, or a context you own/forked) INTO the caller's context head, producing a MERGE COMMIT per repo. Clean (no overlaps) commits with no file resolution; in-file conflicts materialize markers into the context filesystem — resolve via vcs.edit, then vcs.commit seals the merge. Commit-gated on BOTH sides: a repo with uncommitted edits on the source (or target) reports status `refused` (with the reason) while the other repos still merge — no mid-loop throw, no lost partial results. Omit repoPaths to reconcile every repo your context branch touches. Returns one result per repo. After merging main, the context head descends from main so push fast-forwards.",
    args: z.tuple([
      z.object({
        source: vcsMergeSourceSchema
          .optional()
          .describe(
            'Merge source: `"main"` (the protected workspace baseline) or `{ contextId }` for another context you own/forked. Omit for `"main"`.'
          ),
        repoPaths: z
          .array(z.string())
          .optional()
          .describe(
            "Repos to reconcile (workspace-relative). Omit to reconcile every repo the target context branch touches."
          ),
        head: z
          .string()
          .optional()
          .describe(
            "Target context head to merge into. Omit for the caller's own context head; entity callers may only merge their own `ctx:…` head."
          ),
      }),
    ]),
    returns: z.array(vcsMergeRepoResultSchema),
    access: { ...WRITE_ACCESS },
    examples: [{ args: [{ source: "main", repoPaths: ["panels/chat"] }] }],
  },
  pick: {
    description:
      "Cherry-pick selected changes from a SOURCE (`main`, or a context you own/forked) onto the caller's context head as UNCOMMITTED working edits (never a head advance): a `commit` pick 3-way-applies a whole commit's patch; a `paths` pick injects the source context's working content at specific paths (source must be `{ contextId }`). Review the result, then vcs.commit to seal it. Returns one working-edit result per repo touched.",
    args: z.tuple([
      z.object({
        source: vcsMergeSourceSchema.describe(
          'Pick source: `"main"` (commit picks only) or `{ contextId }` for a context you own/forked.'
        ),
        picks: z
          .array(vcsPickSchema)
          .min(1)
          .describe("The changes to pick: whole commits and/or path-level content injections."),
        head: z
          .string()
          .optional()
          .describe(
            "Target context head to pick onto. Omit for the caller's own context head; entity callers may only write their own `ctx:…` head."
          ),
      }),
    ]),
    returns: z.array(vcsEditResultSchema),
    access: { ...WRITE_ACCESS },
    examples: [
      {
        args: [
          {
            source: { contextId: "ctx_42" },
            picks: [{ kind: "paths", paths: ["panels/chat/x.ts"] }],
          },
        ],
      },
    ],
  },
  contextDiff: {
    description:
      "Diff a context you own or forked against a baseline — its `fork-base` (the state it inherited when forked; the default) or the current workspace `main` — returning the added/removed/changed files its branch introduced. The read is authorized against the runtime ownership/lineage registry; an unowned context throws.",
    args: z.tuple([
      z.object({
        contextId: z.string().describe("The context to diff (must be one you own or forked)."),
        ownerContextId: z
          .string()
          .optional()
          .describe(
            "Optional owner context for host-verified child-context reads such as subagent inspection."
          ),
        against: z
          .enum(["fork-base", "main"])
          .optional()
          .describe("Baseline to diff against — `fork-base` (default) or `main`."),
      }),
    ]),
    returns: vcsDiffResultSchema,
    access: READ_ACCESS,
    examples: [{ args: [{ contextId: "ctx_42", against: "fork-base" }] }],
  },
  abortMerge: {
    description:
      "Abort ONLY the pending (conflicted) merge on a repo's head, restoring its pre-merge tree; other uncommitted working edits are untouched (vcs.discardEdits drops everything, merge included). repoPath is required; omit head for the caller's own context head.",
    args: z.tuple([repoPathArg, z.string().optional()]),
    returns: z.object({ aborted: z.boolean() }),
    access: { ...WRITE_ACCESS },
    examples: [{ args: ["panels/chat"] }],
  },
  pendingMerge: {
    description:
      "Inspect a repo head's in-progress merge, if any: the source head being merged and its unresolved conflicts; null when no merge is pending. repoPath is required; omit head for the caller's own context head.",
    args: z.tuple([repoPathArg, z.string().optional(), contextScopeArg]),
    returns: vcsPendingMergeSchema,
    access: READ_ACCESS,
    examples: [{ args: ["panels/chat"] }],
  },
  pushStatus: {
    description:
      "How far each repo's head is ahead of that repo's main: the unpushed change count and per-file changes a push would carry.",
    args: z.tuple([z.array(z.string())]),
    returns: z.array(vcsPushStatusSchema),
    access: READ_ACCESS,
    examples: [{ args: [["panels/chat"]] }],
  },
  contextStatus: {
    description:
      "Summarize the repos where your full workspace context branch differs from main or needs attention. `forked` = your branch has a committed ctx head for this repo; `uncommitted` = it carries uncommitted WORKING edits (vcs.commit them, or vcs.discardEdits); `ahead` = the committed head has commits not yet in main (push them); `behind` = main advanced past your pinned base (rebase/merge to pick it up); `deleted` = the repo was removed from the workspace while your branch still references it — a push will be refused, so drop/rebase your context; `pendingMerge` = an in-progress merge is parked on this repo (resolve + vcs.commit to seal it, or vcs.abortMerge). Only repos with changes or drift are returned. Pass a context you own/forked to summarize ITS branch instead of your own.",
    args: z.tuple([contextScopeArg]),
    returns: z.array(
      z.object({
        repoPath: z.string(),
        forked: z.boolean(),
        uncommitted: z.boolean(),
        ahead: z.boolean(),
        behind: z.boolean(),
        deleted: z.boolean(),
        pendingMerge: vcsPendingMergeInfoSchema.nullable(),
      })
    ),
    access: READ_ACCESS,
  },
  rebaseContext: {
    description:
      "Pull the latest main into your context: 3-way merges main into each repo you've edited, then re-pins your context's base to the current workspace so unedited repos also advance to latest. Use when contextStatus shows repos `behind`. Returns each edited repo's merge status.",
    args: z.tuple([]),
    returns: z.object({
      repos: z.array(
        z.object({
          repoPath: z.string(),
          status: z.enum(["up-to-date", "merged", "conflicted"]),
        })
      ),
      baseView: z.string(),
    }),
    access: WRITE_ACCESS,
  },
  recall: {
    description:
      "Semantic recall over the workspace's VCS memory (log summaries, file snippets) matching a query; pass repoPaths to scope to selected repos. Returns ranked snippets with their head/event/path anchors.",
    args: z.tuple([vcsRecallInputSchema]),
    returns: vcsRecallResultSchema,
    access: READ_ACCESS,
    examples: [{ args: [{ query: "auth flow refactor", limit: 5 }] }],
  },
});
