/**
 * Test-only support for vcsHost integration tests.
 *
 * Production reaches these capabilities through host services. In-process DO
 * tests use this bridge to wire the gad-store instance directly to the local
 * content store and protected-ref service fixtures.
 */

import type { ManifestHashEntry } from "@vibestudio/shared/contentTree/worktreeHash";
import { collectTreeFiles } from "./worktreeStore.js";
import { getBytes, getTree, putBytes, putTree } from "../services/blobstoreService.js";
import type { ProtectedRefStore } from "../services/protectedRefStore.js";
import type { RepoBuildReport } from "../buildV2/index.js";
import type { VcsGadCaller } from "./gadCaller.js";

export type GadCaller = VcsGadCaller;

/**
 * Advance one or more repos' `main` through the gad-store DO's `vcsPush` — the
 * production push path (host `WorkspaceVcs.push` was deleted in narrow-host P3).
 * In-process test driver: the DO gates via the `buildStore` bridge and the
 * ProtectedRefStore gate (both wired by {@link attachLocalHostBridges}); `mainAdvance`
 * / `getBuildSystem` no longer exist. Result is the canonical `vcsPushResult`.
 */
export function pushToMain(
  gad: { call<T>(method: string, input: unknown): Promise<T> },
  input: {
    repoPaths: string[];
    sourceHead: string;
    message?: string;
    actor?: { id: string; kind: string };
  }
): Promise<import("@vibestudio/service-schemas/vcs").VcsPushResult> {
  return gad.call("vcsPush", input);
}

type RefsLike = Pick<
  ProtectedRefStore,
  "readMain" | "listMains" | "updateMains" | "listMainRefLog"
>;

/** A stub build validator for the DO push gate — returns per-repo reports.
 *  Defaults to "no required failures" so the gate passes. */
type BuildValidateLike = (input: {
  viewHash: string;
  repoPaths: string[];
  baseViewHash?: string;
}) => Promise<RepoBuildReport[]>;

/** Shadow `contentStore()` / `refsStore()` / `buildStore()` on a test DO
 *  instance with local implementations over the test's blob dir + (optional)
 *  ProtectedRefStore. `refs` may be a thunk so tests that re-create their ProtectedRefStore
 *  (restart simulations) keep the bridge pointed at the CURRENT instance. */
export function attachLocalHostBridges(
  instance: object,
  opts: {
    blobsDir: string;
    refs?: RefsLike | (() => RefsLike | undefined);
    /** DO push build gate — omit for a no-op (all-pass) validator. */
    buildValidate?: BuildValidateLike;
    /** Per-`updateMains` gate context. In production the host RPC layer
     *  (`refsRpcService.ts`) resolves the on-behalf-of token and attaches a
     *  `{ kind: "caller", … }` context; in-process tests bypass that layer, so
     *  a suite exercising the approval gate supplies the context here. Omit to
     *  leave it unset (the ProtectedRefStore fixture's own gate — usually a no-op —
     *  stands in for approval). The host CAS is now semantics-free (Phase 5), so
     *  the context no longer carries an operation. */
    gateContext?: () => unknown;
    /** Disk-projection + build-graph primitives the DO's delete/restore/fork
     *  sagas drive (`worktree.project` / `worktree.dependentRepos`). In
     *  production these are host RPCs; in-process tests wire them to the real
     *  `WorkspaceVcs.projectWorktree` / `WorkspaceRepositories.deletionDependents`.
     *  Defaults are inert
     *  (projection no-op, no dependents) for suites that never delete/restore. */
    worktree?: {
      project?: (
        repoPath: string,
        head: string,
        stateHash: string
      ) => Promise<{ stateHash: string }>;
      dependentRepos?: (repoPath: string) => Promise<string[]>;
    };
  }
): void {
  const { blobsDir } = opts;
  const currentRefs = (): RefsLike | undefined =>
    typeof opts.refs === "function" ? opts.refs() : opts.refs;
  const store = {
    async listTree(
      ref: string,
      listOpts?: { prefix?: string; limit?: number }
    ): Promise<Array<{ path: string; kind: string; contentHash: string; mode: number }> | null> {
      const files = await collectTreeFiles(blobsDir, ref);
      if (files === null) return null;
      const prefix = listOpts?.prefix;
      const within = (p: string): boolean => !prefix || p === prefix || p.startsWith(`${prefix}/`);
      return files
        .filter((file) => within(file.path))
        .map((file) => ({
          path: file.path,
          kind: "file",
          contentHash: file.contentHash,
          mode: file.mode,
        }));
    },
    async getTree(ref: string): Promise<unknown | null> {
      return await getTree(blobsDir, ref);
    },
    async getBase64(digest: string): Promise<string | null> {
      const bytes = await getBytes(blobsDir, digest);
      return bytes ? bytes.toString("base64") : null;
    },
    async putBase64(bytesBase64: string): Promise<{ digest: string; size: number }> {
      const { digest, size } = await putBytes(blobsDir, Buffer.from(bytesBase64, "base64"));
      return { digest, size };
    },
    async putTree(
      entries: ManifestHashEntry[],
      putOpts?: { root?: boolean }
    ): Promise<{ treeHash: string; stateHash?: string }> {
      return await putTree(blobsDir, entries, putOpts);
    },
  };
  Object.defineProperty(instance, "contentStore", { value: () => store, configurable: true });
  const refsStore = {
    async readMain(repoPath: string): Promise<{ stateHash: string } | null> {
      const record = currentRefs()?.readMain(repoPath) ?? null;
      return record ? { stateHash: record.stateHash } : null;
    },
    async listMains(): Promise<Array<{ repoPath: string; stateHash: string }>> {
      return (currentRefs()?.listMains() ?? []).map((record) => ({
        repoPath: record.repoPath,
        stateHash: record.stateHash,
      }));
    },
    // P3/P5: the single-writer group CAS. In-process tests bypass the RPC-layer
    // token resolution — the ProtectedRefStore's own gate (a no-op in fixtures) stands
    // in for approval, and on-behalf-of is not resolved here (no `writer`/
    // `onBehalfOf`). The DO still passes `operation`/`reason`; forward them so
    // the ProtectedRefStore records a faithful main-ref log row (§2). Returns
    // `{repoPath, stateHash, seq}` per entry.
    async updateMains(input: {
      entries: Array<{ repoPath: string; expectedOld: string | null; next: string | null }>;
      operation: "push" | "import" | "delete" | "restore" | "seed";
      reason?: string;
      invocationToken?: string;
    }): Promise<{ updated: Array<{ repoPath: string; stateHash: string | null; seq: number }> }> {
      const refs = currentRefs();
      if (!refs) throw new Error("attachLocalHostBridges: no ProtectedRefStore for updateMains");
      const gateContext = opts.gateContext?.();
      return refs.updateMains({
        entries: input.entries,
        ...(gateContext !== undefined ? { gateContext } : {}),
        operation: input.operation,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
    },
    async listMainRefLog(
      repoPath: string,
      sinceId?: number
    ): Promise<
      Array<{
        id: number;
        operation: string;
        old: string | null;
        new: string | null;
        writer: string | null;
        onBehalfOf: unknown;
        reason: string | null;
        createdAt: number;
      }>
    > {
      return (currentRefs()?.listMainRefLog(repoPath, sinceId) ?? []).map((row) => ({
        id: row.id,
        operation: row.operation,
        old: row.old,
        new: row.new,
        writer: row.writer,
        onBehalfOf: row.onBehalfOf,
        reason: row.reason,
        createdAt: row.createdAt,
      }));
    },
  };
  Object.defineProperty(instance, "refsStore", { value: () => refsStore, configurable: true });
  const worktreeStore = {
    scan: () => {
      throw new Error("attachLocalHostBridges: worktree.scan is not wired for this test");
    },
    project: (repoPath: string, head: string, stateHash: string) =>
      opts.worktree?.project?.(repoPath, head, stateHash) ?? Promise.resolve({ stateHash }),
    dependentRepos: (repoPath: string) =>
      opts.worktree?.dependentRepos?.(repoPath) ?? Promise.resolve([]),
  };
  Object.defineProperty(instance, "worktreeStore", {
    value: () => worktreeStore,
    configurable: true,
  });
  const buildStore = {
    validate: (input: { viewHash: string; repoPaths: string[]; baseViewHash?: string }) =>
      opts.buildValidate ? opts.buildValidate(input) : Promise.resolve([] as RepoBuildReport[]),
  };
  Object.defineProperty(instance, "buildStore", { value: () => buildStore, configurable: true });
}
