/**
 * Tool-side adapter over the server's `vcs.*` RPC surface. The file-editing
 * tools (`edit`, `write`) record UNCOMMITTED working edits through GAD's
 * edit-first `vcs.edit` rather than writing the working tree directly — disk is
 * a projection of the head, never written behind GAD's back. Deliberate
 * milestones are sealed with `vcs.commit`, and `main` advances only via
 * `vcs.push`.
 */

import {
  createVcsUserlandClient,
  type RpcCallerLike,
} from "@vibez1/shared/userlandServiceRpc";

import { resolveToCwd } from "./path-utils.js";

/**
 * Convert a user-supplied path (relative or absolute) to a GAD path that is
 * relative to the head root. The tool's `cwd` IS the head root, so the GAD path
 * is the path *relative to* cwd — not `cwd + path`. Works for any cwd (not just
 * "/") and rejects paths that escape the root.
 */
export function toVcsPath(path: string, cwd: string): string {
  const abs = resolveToCwd(path, cwd);
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (abs === cwd || `${abs}/` === root) return "";
  if (!abs.startsWith(root)) {
    throw new Error(`Path escapes the workspace root: ${path}`);
  }
  return abs.slice(root.length);
}

export type ToolVcsEditOp =
  | {
      kind: "replace";
      path: string;
      hunks: Array<{ start: number; end: number; oldText?: string; newText: string }>;
    }
  | { kind: "write"; path: string; content: ToolVcsFileWriteContent; mode?: number }
  | { kind: "create"; path: string; content: ToolVcsFileWriteContent; mode?: number }
  | { kind: "delete"; path: string }
  | { kind: "chmod"; path: string; mode: number };

export type ToolVcsFileWriteContent =
  | { kind: "text"; text: string }
  | { kind: "bytes"; base64: string };

export type ToolVcsFileReadContent =
  | { kind: "text"; text: string }
  | { kind: "bytes"; base64: string };

/** Result of `vcs.edit` — a tracked UNCOMMITTED working edit (no commit, no build). */
export interface ToolVcsEditResult {
  head: string;
  stateHash: string;
  committed: false;
  status: "uncommitted";
  editSeq: number;
  changedPaths: string[];
}

/** Per-repo result of `vcs.commit`. */
export interface ToolVcsCommitResult {
  repoPath: string;
  head: string;
  stateHash: string;
  eventId: string | null;
  headHash: string | null;
  editCount: number;
  status: "committed" | "unchanged";
  changedPaths: string[];
}

/** Result of `vcs.push` (discriminated by status). */
export type ToolVcsPushResult =
  | { status: "pushed"; repoPaths: string[]; reports: unknown[] }
  | { status: "up-to-date"; repoPaths: string[]; reports: unknown[] }
  | { status: "diverged"; divergences: unknown[] }
  | { status: "build-failed"; reports: unknown[] };

/** Per-repo result of `vcs.merge` — one reconcile commit pulling a source into
 *  the caller's context head. */
export interface ToolVcsMergeResult {
  repoPath: string;
  status: "up-to-date" | "merged" | "conflicted";
  stateHash: string | null;
  conflicts: Array<{ path: string; kind: string }>;
  mergeable: "clean" | "conflict";
  upstreamCommits: Array<{ eventId: string; message: string; stateHash: string }>;
  conflictPaths?: string[];
}

/** Merge/pick SOURCE selector — `"main"` or another context you own/forked. */
export type ToolVcsSource = "main" | { contextId: string };

/** A single `vcs.pick` entry: a whole commit's patch or path-level injection. */
export type ToolVcsPick =
  | { kind: "commit"; repoPath: string; eventId: string }
  | { kind: "paths"; paths: string[] };

/** Result of `vcs.contextDiff` — files a context's branch introduced. */
export interface ToolVcsDiffResult {
  added: unknown[];
  removed: unknown[];
  changed: unknown[];
}

export interface ToolVcs {
  /** Read a file at the caller's head: content + the state hash to pin. */
  readFile(path: string): Promise<{ content: ToolVcsFileReadContent; stateHash: string } | null>;
  /**
   * Record edit ops as UNCOMMITTED working changes on the caller's head (server
   * resolves head + actor). NOT a commit: no head advance, no build. Seal with
   * {@link ToolVcs.commit}.
   */
  edit(input: {
    baseStateHash?: string;
    edits: ToolVcsEditOp[];
    repoPath?: string;
    /** Authoring tool-call id — the edge from these edits into the agentic
     *  trajectory (file → edit → invocation → turn → session). The edit/write
     *  tools pass their `toolCallId`. */
    invocationId?: string;
  }): Promise<ToolVcsEditResult>;
  /** Fold the caller's uncommitted working edits into a messaged snapshot per repo. */
  commit(input: {
    message: string;
    repoPaths?: string[];
    exclude?: string[];
    /** Authoring tool-call id — the commit event's causality edge (T1). Stamped
     *  mechanically by {@link withInvocationId}; callers do not hand-pass it. */
    invocationId?: string;
  }): Promise<ToolVcsCommitResult[]>;
  /** Build-gate one or more repos' committed snapshots into `main` (atomic group). */
  push(input: { repoPaths: string[]; message?: string }): Promise<ToolVcsPushResult>;
  /** Reconcile a source (`main`, or a context you own/forked) INTO the caller's
   *  context head; one merge commit per repo. Omit repoPaths to reconcile every
   *  repo the context branch touches. */
  merge(input: {
    source: ToolVcsSource;
    repoPaths?: string[];
  }): Promise<ToolVcsMergeResult[]>;
  /** Cherry-pick selected changes from a source onto the caller's head as
   *  uncommitted working edits (one result per repo touched). */
  pick(input: { source: ToolVcsSource; picks: ToolVcsPick[] }): Promise<ToolVcsEditResult[]>;
  /** Diff a context you own/forked against its `fork-base` (default) or `main`. */
  contextDiff(input: {
    contextId: string;
    against?: "fork-base" | "main";
  }): Promise<ToolVcsDiffResult>;
  /** Drop a repo's uncommitted working edits + any pending merge on the caller's head. */
  discardEdits(repoPath: string): Promise<{ discarded: number; stateHash: string }>;
}

/**
 * T2 seam — mechanical invocation stamping for the ToolVcs adapter.
 *
 * Every file-mutating tool call must carry the authoring `invocationId` (the
 * tool-call id) so the edit/commit rows anchor the native provenance edge
 * (file → edit → invocation → turn → session). Rather than have each tool
 * hand-pass `invocationId: toolCallId` on every vcs call (easy to forget in a
 * new tool), tools wrap their shared adapter ONCE at the top of `execute` with
 * this binder — `withInvocationId(vcs, toolCallId)` — and the stamp is injected
 * into every write call automatically.
 *
 * Why a per-call binding rather than a fully-ambient stamp: local-tool
 * invocations dispatch CONCURRENTLY (the driver runs a turn's due invocation
 * effects in one `Promise.all`, so parallel tool calls interleave their awaits).
 * A single mutable "current invocation" on the shared adapter would race and
 * mis-attribute an edit to another in-flight call's invocation — and edit→
 * invocation is a native, integrity-covered edge (blame, §5), not a soft
 * signal. The `toolCallId` is the one race-safe per-call channel (an `execute`
 * argument), so the binder derives from it. An explicit `invocationId` on the
 * input still wins (callers that already resolved one are not overridden).
 */
export function withInvocationId(vcs: ToolVcs, invocationId: string): ToolVcs {
  return {
    // Write calls get the stamp injected (unless the caller already resolved one).
    edit: (input) => vcs.edit(input.invocationId ? input : { ...input, invocationId }),
    commit: (input) => vcs.commit(input.invocationId ? input : { ...input, invocationId }),
    // Everything else delegates unchanged (explicit rather than a spread, so a
    // class-instance adapter whose methods live on the prototype stays whole).
    readFile: (path) => vcs.readFile(path),
    push: (input) => vcs.push(input),
    merge: (input) => vcs.merge(input),
    pick: (input) => vcs.pick(input),
    contextDiff: (input) => vcs.contextDiff(input),
    discardEdits: (repoPath) => vcs.discardEdits(repoPath),
  };
}

/** Build a {@link ToolVcs} from a main-RPC call function. `pushRoute` supplies
 *  the USERLAND dispatch for `push` (P3 flip): the build-gated main advance runs
 *  in the gad-store DO's `vcsPush`, reached via the `vcs` manifest service on a
 *  target-capable rpc — never the host `vcs.push` service. Client-side routing
 *  is load-bearing (the relay mints the on-behalf-of invocation token with the
 *  originating caller only on a direct DO call). Userland dispatch has no
 *  caller-context resolution, so the caller supplies its own `sourceHead`. */
export function createToolVcs(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>,
  pushRoute?: { rpc: RpcCallerLike; sourceHead: string | (() => string) }
): ToolVcs {
  return {
    readFile: (path) =>
      callMain<{ content: ToolVcsFileReadContent; stateHash: string } | null>("vcs.readFile", [
        "",
        path,
      ]),
    edit: (input) => callMain<ToolVcsEditResult>("vcs.edit", [input]),
    commit: (input) => callMain<ToolVcsCommitResult[]>("vcs.commit", [input]),
    push: (input) => {
      if (!pushRoute) {
        throw new Error(
          "vcs.push is userland-dispatched (P3): createToolVcs needs a pushRoute (target-capable rpc + sourceHead)"
        );
      }
      // Resolve the source head LAZILY at push time — the caller's context
      // (subscription) may not exist while the tool surface is merely built.
      const sourceHead =
        typeof pushRoute.sourceHead === "function" ? pushRoute.sourceHead() : pushRoute.sourceHead;
      return createVcsUserlandClient(pushRoute.rpc).call<ToolVcsPushResult>("vcsPush", {
        repoPaths: input.repoPaths,
        sourceHead,
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
    },
    merge: (input) => callMain<ToolVcsMergeResult[]>("vcs.merge", [input]),
    pick: (input) => callMain<ToolVcsEditResult[]>("vcs.pick", [input]),
    contextDiff: (input) => callMain<ToolVcsDiffResult>("vcs.contextDiff", [input]),
    discardEdits: (repoPath) =>
      callMain<{ discarded: number; stateHash: string }>("vcs.discardEdits", [repoPath]),
  };
}
