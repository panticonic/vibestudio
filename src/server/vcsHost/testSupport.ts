/**
 * Test-only support for vcsHost integration tests.
 *
 * Production reaches these capabilities through host services. In-process DO
 * tests use this bridge to wire the gad-store instance directly to the local
 * content store and protected-ref service fixtures.
 */

import type { ManifestHashEntry } from "@vibez1/shared/contentTree/worktreeHash";
import { collectTreeFiles } from "./worktreeStore.js";
import { getBytes, getTree, putBytes, putTree } from "../services/blobstoreService.js";
import type { RefService } from "../services/refService.js";
import type { RepoBuildReport } from "../buildV2/index.js";

export interface GadCaller {
  call<T = unknown>(method: string, input: unknown): Promise<T>;
}

/**
 * Advance one or more repos' `main` through the gad-store DO's `vcsPush` — the
 * production push path (host `WorkspaceVcs.push` was deleted in narrow-host P3).
 * In-process test driver: the DO gates via the `buildStore` bridge and the
 * RefService gate (both wired by {@link attachLocalHostBridges}); `mainAdvance`
 * / `getBuildSystem` no longer exist. Result is the canonical `vcsPushResult`.
 */
export function pushToMain(
  gad: { instance: unknown },
  input: {
    repoPaths: string[];
    sourceHead: string;
    message?: string;
    actor?: { id: string; kind: string };
  }
): Promise<import("@vibez1/shared/serviceSchemas/vcs").VcsPushResult> {
  const instance = gad.instance as {
    vcsPush: (i: unknown) => Promise<import("@vibez1/shared/serviceSchemas/vcs").VcsPushResult>;
  };
  return instance.vcsPush(input);
}

type RefsLike = Pick<RefService, "readMain" | "listMains" | "updateMains">;

/** A stub build validator for the DO push gate — returns per-repo reports.
 *  Defaults to "no required failures" so the gate passes. */
type BuildValidateLike = (input: {
  viewHash: string;
  repoPaths: string[];
  baseViewHash?: string;
}) => Promise<RepoBuildReport[]>;

/** Shadow `contentStore()` / `refsStore()` / `buildStore()` on a test DO
 *  instance with local implementations over the test's blob dir + (optional)
 *  RefService. `refs` may be a thunk so tests that re-create their RefService
 *  (restart simulations) keep the bridge pointed at the CURRENT instance. */
export function attachLocalHostBridges(
  instance: object,
  opts: {
    blobsDir: string;
    refs?: RefsLike | (() => RefsLike | undefined);
    /** DO push build gate — omit for a no-op (all-pass) validator. */
    buildValidate?: BuildValidateLike;
    /** Per-`updateMains` gate context. In production the host RPC layer
     *  (`refsService.ts`) resolves the on-behalf-of token and attaches a
     *  `{ kind: "caller", … }` context; in-process tests bypass that layer, so
     *  a suite exercising the approval gate supplies the context here. Omit to
     *  leave it unset (the RefService fixture's own gate — usually a no-op —
     *  stands in for approval). The host CAS is now semantics-free (Phase 5), so
     *  the context no longer carries an operation. */
    gateContext?: () => unknown;
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
    // token resolution — the RefService's own gate (a no-op in fixtures) stands
    // in for approval; on-behalf-of is not exercised here. The host RefService
    // is now a semantics-free CAS (Phase 5): `operation`/`reason`/`writer`/`seq`
    // and the movement log are gone, so the bridge forwards only `entries`
    // (+ an optional test-supplied gate context) and returns
    // `{repoPath, stateHash}` pairs. The DO still PASSES `operation`/`reason` in
    // its call shape (committed userland); those extra props are simply ignored.
    async updateMains(input: {
      entries: Array<{ repoPath: string; expectedOld: string | null; next: string | null }>;
      invocationToken?: string;
    }): Promise<{ updated: Array<{ repoPath: string; stateHash: string | null }> }> {
      const refs = currentRefs();
      if (!refs) throw new Error("attachLocalHostBridges: no RefService for updateMains");
      const gateContext = opts.gateContext?.();
      return refs.updateMains({
        entries: input.entries,
        ...(gateContext !== undefined ? { gateContext } : {}),
      });
    },
  };
  Object.defineProperty(instance, "refsStore", { value: () => refsStore, configurable: true });
  const buildStore = {
    validate: (input: { viewHash: string; repoPaths: string[]; baseViewHash?: string }) =>
      opts.buildValidate ? opts.buildValidate(input) : Promise.resolve([] as RepoBuildReport[]),
  };
  Object.defineProperty(instance, "buildStore", { value: () => buildStore, configurable: true });
}
