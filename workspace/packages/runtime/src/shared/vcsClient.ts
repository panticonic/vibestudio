/**
 * GAD-native workspace version control client. Host RPC methods are derived
 * from the shared `vcsMethods` schema; history reads and push are routed to the
 * userland `vcs` service.
 */

import {
  vcsMethods,
  type VcsCommitAncestor,
  type VcsEditOpRow,
  type VcsHeadAdvance,
  type VcsLogEntry,
  type VcsPushInput,
  type VcsPushResult,
  type VcsWorkingAdvance,
} from "@vibez1/shared/serviceSchemas/vcs";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibez1/shared/typedServiceClient";
import { createVcsUserlandClient, type RpcCallerLike } from "@vibez1/shared/userlandServiceRpc";

export type {
  VcsApplyEditsInput,
  VcsEditResult,
  VcsCommitInput,
  VcsCommitResult,
  VcsEditOpRow,
  VcsCommitAncestor,
  VcsRepoDivergence,
  VcsUpstreamCommit,
  VcsDiffResult,
  VcsEditOp,
  VcsFileContent,
  VcsFileListEntry,
  VcsFileReadContent,
  VcsFileWriteContent,
  VcsHeadAdvance,
  VcsLogEntry,
  VcsMergeResult,
  VcsPendingMerge,
  VcsPushResult,
  VcsPushStatus,
  VcsRecallInput,
  VcsRecallResult,
  VcsResolveHeadResult,
  VcsStatusResult,
  VcsWorkingAdvance,
} from "@vibez1/shared/serviceSchemas/vcs";

/** Minimal event-capable rpc surface (method form -> param bivariance, so the
 * runtime rpc client is assignable). */
export interface VcsEventRpc {
  on(event: string, listener: (ev: { payload: unknown }) => void): () => void;
}

export type VcsRpcClient = TypedServiceClient<typeof vcsMethods>;

/**
 * The read/history traversals — USERLAND-dispatched (P5c): they run in the
 * gad-store DO behind the `vcs` manifest service (vibez1.vcs.v1), resolved
 * through `workers.resolveService`, not the host `vcs.*` service. Same
 * caller-facing signatures as before the move.
 */
export interface VcsHistoryClient {
  /** The edit-ops a commit owns (commit → its edits), in replay order. */
  commitEdits(repoPath: string, target: { eventId: string }): Promise<VcsEditOpRow[]>;
  /** File history / blame in commit-lineage order (+ uncommitted tail). */
  fileHistory(
    repoPath: string,
    path: string,
    head?: string,
    limit?: number
  ): Promise<VcsEditOpRow[]>;
  /** Walk a commit's ancestry in the event-keyed commit DAG. */
  commitAncestors(repoPath: string, eventId: string, limit?: number): Promise<VcsCommitAncestor[]>;
  /** Edits authored by an actor (author provenance). */
  editsByActor(actorId: string, limit?: number): Promise<VcsEditOpRow[]>;
  /** Edits authored in an agent turn (causal provenance). */
  editsByTurn(turnId: string): Promise<VcsEditOpRow[]>;
  /** Edits authored in a single tool-call invocation (causal provenance). */
  editsByInvocation(invocationId: string): Promise<VcsEditOpRow[]>;
  /** Commit log for a repo head, newest first. `head` defaults to `main` —
   *  userland dispatch carries no caller-context defaulting; pass your ctx
   *  head explicitly to read it. */
  log(repoPath: string, limit?: number, head?: string): Promise<VcsLogEntry[]>;
}

export type VcsClient = VcsRpcClient &
  VcsHistoryClient & {
    /**
     * Publish one or more repos from this runtime's context head to main. This is
     * userland-dispatched to the gad-store DO's `vcsPush`, not host `vcs.push`.
     */
    push(input: VcsPushInput): Promise<VcsPushResult>;
    forkRepo(
      fromPath: string,
      toPath: string
    ): Promise<{
      repoPath: string;
      head: string;
      inherited: number;
      stateHash: string;
    }>;
    deleteRepo(input: { repoPath: string; force?: boolean }): Promise<unknown>;
    restoreRepo(input: { repoPath: string }): Promise<unknown>;
    /**
     * Subscribe to head advances (commits by any actor on `head`). Fires on each
     * advance with the previous/new state, producing event, actor, file-level
     * delta, and authored edit intent when available. Returns an unsubscribe.
     */
    subscribeHead(head: string, onAdvance: (advance: VcsHeadAdvance) => void): () => void;
    /**
     * Subscribe to UNCOMMITTED working-content advances (`vcs.edit`, incl.
     * `vcs.revert`) on `head`. Distinct from {@link subscribeHead}: working edits
     * are not commits (no log entry, no build). Reactive editors consume this to
     * reflect uncommitted edits and to apply a revert (now a working edit) into
     * the view. Returns an unsubscribe.
     */
    subscribeWorking(head: string, onAdvance: (advance: VcsWorkingAdvance) => void): () => void;
  };

export function createVcsClient(
  callMain: <T>(method: string, ...args: unknown[]) => Promise<T>,
  /** Event-capable rpc; when it also exposes `.call` (the full runtime rpc
   *  client), the history traversals dispatch to the userland `vcs` service. */
  events?: VcsEventRpc & Partial<RpcCallerLike>,
  /** Client-side defaults for the userland-dispatched methods. Userland
   *  dispatch carries no host-side caller-context resolution, so the runtime
   *  supplies its OWN context head here (e.g. `ctx:<contextId>`) to keep
   *  `vcs.log()` reading the caller's branch by default. */
  defaults?: { logHead?: string; pushSourceHead?: string }
): VcsClient {
  const rpcClient = createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    callMain(`vcs.${method}`, ...args)
  ) as VcsRpcClient;
  // History/read traversals are userland-dispatched (gad-store DO): resolved
  // lazily on first use through workers.resolveService.
  const userland =
    events && typeof events.call === "function"
      ? createVcsUserlandClient(events as RpcCallerLike)
      : null;
  const userlandCall = <T>(method: string, ...args: unknown[]): Promise<T> => {
    if (!userland) {
      return Promise.reject(
        new Error(`vcs.${method} is userland-dispatched and needs a target-capable rpc client`)
      );
    }
    return userland.call<T>(method, ...args);
  };
  const history: VcsHistoryClient = {
    commitEdits: (repoPath, target) => userlandCall("vcsCommitEdits", repoPath, target.eventId),
    fileHistory: (repoPath, path, head, limit) =>
      userlandCall("vcsFileHistory", repoPath, path, head ?? null, limit ?? null),
    commitAncestors: (repoPath, eventId, limit) =>
      userlandCall("vcsCommitAncestors", repoPath, eventId, limit ?? null),
    editsByActor: (actorId, limit) => userlandCall("vcsEditsByActor", actorId, limit ?? null),
    editsByTurn: (turnId) => userlandCall("vcsEditsByTurn", turnId),
    editsByInvocation: (invocationId) => userlandCall("vcsEditsByInvocation", invocationId),
    log: (repoPath, limit, head) =>
      userlandCall("vcsLog", repoPath, limit ?? null, head ?? defaults?.logHead ?? null),
  };
  return {
    ...rpcClient,
    ...history,
    // Push is USERLAND-dispatched (P3 flip): the build-gated main advance runs
    // in the gad-store DO's `vcsPush`, reached via the `vcs` manifest service —
    // NOT the host `vcs.push` service. Client-side routing is mandatory: the
    // relay mints the on-behalf-of invocation token keyed on the DO target with
    // the ORIGINATING caller, which a host-service forward would erase. Userland
    // dispatch has no caller-context resolution, so the source ctx head comes
    // from `defaults.pushSourceHead` (this runtime's own `ctx:<contextId>`).
    push(input) {
      return userlandCall("vcsPush", {
        repoPaths: input.repoPaths,
        sourceHead: input.sourceHead ?? defaults?.pushSourceHead,
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
    },
    // Lifecycle sagas are USERLAND-dispatched (narrow-host boundary refactor
    // Phase 4): fork/delete/restore run in the gad-store DO (`vcsForkRepo` /
    // `vcsDeleteRepo` / `vcsRestoreRepo`), NOT the host `vcs.*` service. Direct
    // DO dispatch is mandatory so the relay mints the on-behalf-of token that
    // attributes the severe deletion/restore approval prompt to the ORIGINATING
    // caller (a host forward would erase it, D3).
    forkRepo(fromPath: string, toPath: string) {
      return userlandCall("vcsForkRepo", { fromPath, toPath });
    },
    deleteRepo(input: { repoPath: string; force?: boolean }) {
      return userlandCall("vcsDeleteRepo", input);
    },
    restoreRepo(input: { repoPath: string }) {
      return userlandCall("vcsRestoreRepo", input);
    },
    subscribeHead(head, onAdvance) {
      if (!events?.on) throw new Error("vcs.subscribeHead requires an event-capable rpc");
      const topic = `vcs:head:${head}`;
      const off = events.on(`event:${topic}`, (ev) => onAdvance(ev.payload as VcsHeadAdvance));
      void callMain("events.subscribe", topic).catch(() => {});
      // Pair the server-side subscription with an unsubscribe on teardown.
      // A DO push-subscriber persists (no socket to reap it), so an un-torn-down
      // `events.subscribe` would leak and keep the server pushing to a corpse.
      return () => {
        off();
        void callMain("events.unsubscribe", topic).catch(() => {});
      };
    },
    subscribeWorking(head, onAdvance) {
      if (!events?.on) throw new Error("vcs.subscribeWorking requires an event-capable rpc");
      const topic = `vcs:working:${head}`;
      const off = events.on(`event:${topic}`, (ev) => onAdvance(ev.payload as VcsWorkingAdvance));
      void callMain("events.subscribe", topic).catch(() => {});
      return () => {
        off();
        void callMain("events.unsubscribe", topic).catch(() => {});
      };
    },
  };
}
