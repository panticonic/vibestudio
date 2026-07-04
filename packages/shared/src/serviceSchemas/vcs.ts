import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";
import {
  buildDiagnosticSchema,
  repoBuildReportSchema,
  type BuildDiagnosticWire,
  type RepoBuildReportWire,
} from "./build.js";

const nullableString = z.string().nullable();

// Access descriptors shared across the read/write method groups. The legacy
// caller-kind gate stays on the service `policy` (allowed: shell/panel/app/
// server/worker/do/extension), so these carry only doc/safety metadata
// (sensitivity) and deliberately OMIT `callers`.
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

export const vcsApplyEditsInputSchema = z.object({
  baseStateHash: z
    .string()
    .optional()
    .describe(
      "Optimistic-concurrency base: the composed working state the edits were computed against (a `state:…` hash). Omit to apply against the head's current working state."
    ),
  edits: z
    .array(vcsEditOpSchema)
    .describe(
      'Ordered edit ops recorded as one working-set edit. Each op is discriminated by `kind` (replace/write/create/delete/chmod); `{ path, content: "…" }` is accepted shorthand for a write.'
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
export type VcsApplyEditsInput = z.infer<typeof vcsApplyEditsInputSchema>;

export const vcsMergeConflictSchema = z.object({
  path: z.string(),
  kind: z.enum(["content", "binary", "delete-vs-change", "mode"]),
});

/** Result of `vcs.edit` — a tracked WORKING edit (no commit, no build). */
export const vcsEditResultSchema = z.object({
  head: z.string(),
  /** The working state hash (committed base + uncommitted ops) projected to disk. */
  stateHash: z.string(),
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
      "Repos to commit (workspace-relative). Omit to commit every repo the caller's context has uncommitted edits in. Multi-repo commit is a non-atomic per-repo loop (atomicity is push's job)."
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe(
      "Workspace-relative paths to leave UNCOMMITTED (the inverse of `git add`): commit everything tracked except these."
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

/** Per-repo result of `vcs.commit`. */
export const vcsCommitResultSchema = z.object({
  repoPath: z.string(),
  head: z.string(),
  stateHash: z.string(),
  eventId: nullableString,
  headHash: nullableString,
  editCount: z.number().int().nonnegative(),
  status: z.enum(["committed", "unchanged"]),
  changedPaths: z.array(z.string()),
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
});
export type VcsEditOpRow = z.infer<typeof vcsEditOpRowSchema>;

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

/**
 * Status is a GAD state-diff of a head against its publish baseline (`main`):
 * the committed-but-unpushed changes, plus `uncommitted` (the count of WORKING
 * edits not yet committed). The on-disk worktree is a disposable projection. The
 * `dirty` flag is true iff the head is ahead of `main` OR has uncommitted edits.
 * Status on `main` is always clean (it is the baseline).
 */
export const vcsStatusResultSchema = z.object({
  stateHash: nullableString,
  dirty: z.boolean(),
  /** Count of UNCOMMITTED working edits on this head (push rejects while > 0). */
  uncommitted: z.number().int().nonnegative(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
  /** The repo was deleted from the workspace (`main` archived/gone) — a push
   *  will be refused; restore it or drop the context. */
  deleted: z.boolean(),
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
  z.object({ contextId: z.string() }),
]);
export type VcsMergeSource = z.infer<typeof vcsMergeSourceSchema>;

/** One repo's reconcile in the `vcs.merge` result array (merge loops repos). */
export const vcsMergeRepoResultSchema = vcsMergeResultSchema.extend({
  repoPath: z.string(),
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
export type VcsHeadAdvance = z.infer<typeof vcsHeadAdvanceSchema>;

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
export type VcsWorkingAdvance = z.infer<typeof vcsWorkingAdvanceSchema>;

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
  /** `main` diverged past this head's base — a fast-forward push is impossible
   *  without an explicit vcs.merge. */
  diverged: z.boolean(),
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

export const vcsDeleteRepoResultSchema = z.object({
  repoPath: z.string(),
  /** True when a `main` head existed and was archived (false would be a no-op,
   *  but the service rejects missing repos before reaching here). */
  archived: z.boolean(),
  /** The non-`main` head the history was moved to (restorable), or null. */
  archiveHead: nullableString,
  /** Workspace-relative paths removed from main by the deletion. */
  removedPaths: z.array(z.string()),
  /** Live repos that depended on the deleted one (non-empty only under force). */
  dependents: z.array(z.string()),
  /** The composed workspace view AFTER removal. */
  stateHash: z.string(),
});
export type VcsDeleteRepoResult = z.infer<typeof vcsDeleteRepoResultSchema>;

export const vcsRestoreRepoResultSchema = z.object({
  repoPath: z.string(),
  /** True when an archived head was found and re-pointed at main. */
  restored: z.boolean(),
  /** The archive head the repo was recovered from, or null. */
  fromArchiveHead: nullableString,
  /** Workspace-relative paths re-added to main by the restore. */
  restoredPaths: z.array(z.string()),
  /** The composed workspace view AFTER restoration. */
  stateHash: z.string(),
});
export type VcsRestoreRepoResult = z.infer<typeof vcsRestoreRepoResultSchema>;

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
 * (this is a deny gate, never a prompt). Omit to read the caller's own head.
 */
const contextScopeArg = z
  .object({ contextId: z.string() })
  .optional()
  .describe(
    "Inspect another context you own or forked (resolves that context's ctx:* head). Unauthorized cross-context reads throw."
  );

// NOTE (P5c): the read/history traversals — commitEdits, fileHistory,
// commitAncestors, editsByActor, editsByTurn, editsByInvocation, log — are
// USERLAND-dispatched: they run in the gad-store DO behind the `vcs` manifest
// service (vibez1.vcs.v1) and are called through
// `createDurableObjectServiceClient`, not this host service table. Their row
// schemas above (VcsEditOpRow, VcsCommitAncestor, VcsLogEntry) remain the wire
// contract.
export const vcsMethods = defineServiceMethods({
  edit: {
    description:
      "Record a batch of file edits as UNCOMMITTED WORKING changes on the caller's context head — tracked durably with full provenance, but NOT a commit: no commit-log entry, no head advance, no build, and they never appear in vcs.log. Edits route to their owning repo by path. Make deliberate milestones with vcs.commit. Edits target a `ctx:*` head; `main` advances only via push.",
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
      "Fold the caller context's uncommitted working edits into ONE deliberate, messaged snapshot per repo, advancing each repo's context head and owning exactly those edits (queryable via commitEdits). `message` is mandatory. `exclude` leaves listed paths uncommitted (the inverse of `git add`). A repo with a pending merge commits the resolution. `main` is rejected (push only).",
    args: z.tuple([vcsCommitInputSchema]),
    returns: z.array(vcsCommitResultSchema),
    access: WRITE_ACCESS,
    examples: [{ args: [{ message: "Add notes panel" }] }],
  },
  discardEdits: {
    description:
      "Drop a repo's uncommitted working edits on the caller's context head AND clear any in-progress merge, restoring the committed head on disk (abort / stash-drop).",
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
      "Read one file's content (text or base64 bytes) at a VCS ref, with its state/content hashes and mode; returns null if the path is absent. Empty ref ⇒ the caller's current head. Pass repoPath to read from a specific repo's head (path repo-relative).",
    args: z.tuple([z.string(), z.string(), repoPathArgOptional, contextScopeArg]),
    returns: vcsFileContentSchema.nullable(),
    access: READ_ACCESS,
    examples: [{ args: ["", "notes.md", "panels/chat"] }],
  },
  listFiles: {
    description:
      "List every file (path, content hash, mode) at a VCS ref; omit the ref for the caller's current head. Pass repoPath to list a single repo's head.",
    args: z.tuple([z.string().optional(), repoPathArgOptional, contextScopeArg]),
    returns: z.array(vcsFileListEntrySchema),
    access: READ_ACCESS,
  },
  revert: {
    description:
      "Undo a prior change by forward-applying its inverse patch onto the caller's head, advancing it; target the change by state hash or event id. Pass repoPath to revert on a specific repo's log.",
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
  status: {
    description:
      "Unpushed changes on a repo's head relative to that repo's main: the added/removed/changed paths plus the head state and whether it is ahead of main. Not a filesystem scan. repoPath is required (per-repo VCS).",
    args: z.tuple([repoPathArg, z.string().optional(), contextScopeArg]),
    returns: vcsStatusResultSchema,
    access: READ_ACCESS,
    examples: [{ args: ["panels/chat"] }],
  },
  diff: {
    description:
      "Diff two GAD states by their `state:…` hashes, returning the added/removed/changed files between them.",
    args: z.tuple([z.string(), z.string()]),
    returns: vcsDiffResultSchema,
    access: READ_ACCESS,
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
      "Reconcile divergence: pull a SOURCE (`main`, or a context you own/forked) INTO the caller's context head, producing a MERGE COMMIT per repo. Clean (no overlaps) commits with no file resolution; in-file conflicts materialize markers into the context filesystem — resolve via vcs.edit, then vcs.commit seals the merge. Commit-gated on BOTH sides: uncommitted edits on the source (or target) are rejected before any merge. Omit repoPaths to reconcile every repo your context branch touches. Returns one result per repo. After merging main, the context head descends from main so push fast-forwards.",
    args: z.tuple([
      z.object({
        source: vcsMergeSourceSchema.describe(
          'Merge source: `"main"` (the protected workspace baseline) or `{ contextId }` for another context you own/forked.'
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
          { source: { contextId: "ctx_42" }, picks: [{ kind: "paths", paths: ["panels/chat/x.ts"] }] },
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
      "Abort a pending (conflicted) merge on a repo's head, restoring its pre-merge tree; this is itself a head write. repoPath is required; omit head for the caller's own context head.",
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
  forkRepo: {
    description:
      "Fork a repo to a new path, preserving history: the new repo's log descends from the source's lineage (its `log` shows the inherited commits), so you can edit on top of the forked history. The package.json `name` leaf is rewritten to the new path so the fork is build-valid; deeper renames (component/class names) are yours to make, then push.",
    args: z.tuple([
      z.string().describe("Source repo path, e.g. panels/chat"),
      z.string().describe("Destination repo path, e.g. panels/mychat"),
    ]),
    returns: z.object({
      repoPath: z.string(),
      head: z.string(),
      inherited: z.number().describe("Number of commits inherited from the source's history."),
      stateHash: z.string(),
    }),
    access: { ...WRITE_ACCESS, sensitivity: "admin" },
    examples: [{ args: ["panels/chat", "panels/mychat"] }],
  },
  deleteRepo: {
    description:
      "SEVERE, global-state action: permanently remove a whole repo from the workspace. Distinct from edits — it archives the repo's history (moved to a recoverable archive head) and drops the repo from workspace main, deleting its working tree. Requires explicit user approval every time (a dedicated per-repo deletion grant that the ordinary write grant never covers). REFUSES if other repos depend on this one unless `force` is set (their builds will break). Rejects the `meta` repo and any path with no committed main.",
    args: z.tuple([
      z.object({
        repoPath: z.string().describe("Workspace-relative repo path to delete, e.g. panels/old"),
        force: z
          .boolean()
          .optional()
          .describe("Delete even when other repos depend on this one (their builds may break)."),
      }),
    ]),
    returns: vcsDeleteRepoResultSchema,
    access: { ...WRITE_ACCESS, sensitivity: "destructive" },
    examples: [{ args: [{ repoPath: "panels/old" }] }],
  },
  restoreRepo: {
    description:
      "Recover a previously deleted repo by re-pointing its main at its archived history. FAILS if a different repo now occupies that path (re-created since the deletion) rather than clobbering it, and if there is nothing archived to restore. Requires user approval (re-adds the repo to workspace main).",
    args: z.tuple([
      z.object({
        repoPath: z.string().describe("Workspace-relative repo path to restore, e.g. panels/old"),
      }),
    ]),
    returns: vcsRestoreRepoResultSchema,
    access: { ...WRITE_ACCESS, sensitivity: "admin" },
    examples: [{ args: [{ repoPath: "panels/old" }] }],
  },
  contextStatus: {
    description:
      "Summarize the repos where your full workspace context branch differs from main or needs attention. `forked` = your branch has a committed ctx head for this repo; `uncommitted` = it carries uncommitted WORKING edits (vcs.commit them, or vcs.discardEdits); `ahead` = the committed head has commits not yet in main (push them); `behind` = main advanced past your pinned base (rebase/merge to pick it up); `deleted` = the repo was removed from the workspace (vcs.deleteRepo) while your branch still references it — a push will be refused, so drop/rebase your context or restore the repo. Only repos with changes or drift are returned. Pass a context you own/forked to summarize ITS branch instead of your own.",
    args: z.tuple([contextScopeArg]),
    returns: z.array(
      z.object({
        repoPath: z.string(),
        forked: z.boolean(),
        uncommitted: z.boolean(),
        ahead: z.boolean(),
        behind: z.boolean(),
        deleted: z.boolean(),
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
