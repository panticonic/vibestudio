/**
 * Attach-time crash-window heal wiring (narrow-host P3). The host reconciler
 * `reconcileMainProvenanceFromRefs` was deleted; `attachGad` now drives the
 * DO's `vcsHealPublishDrift` RPC. Ref advances covered by a parked publish
 * intent are completed with full provenance; a main ref that is AHEAD of the
 * DO's recorded lineage with NO covering publish intent fails loudly instead of
 * inventing a catch-up commit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { attachLocalHostBridges } from "../../../src/server/vcsHost/testSupport.js";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";
import { VCS_MAIN_HEAD, vcsContextHead, logIdForRepo } from "../../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../../src/server/vcsHost/testSupport.js";
import { createRefService } from "../../../src/server/services/refService.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

function callerFor(gad: TestGad): GadCaller {
  return {
    async call<T>(method: string, input: unknown): Promise<T> {
      const instance = gad.instance as unknown as Record<string, (arg: unknown) => unknown>;
      const fn = instance[method];
      if (typeof fn !== "function") throw new Error(`no such gad method: ${method}`);
      return (await fn.call(gad.instance, input)) as T;
    },
  };
}

const USER = { id: "user", kind: "user" };
const REPO = "packages/a";
const text = (t: string) => ({ kind: "text" as const, text: t });

describe("WorkspaceVcs attach-time publish-drift heal (DO-owned)", () => {
  let root: string;
  let gad: TestGad;
  let refs: ReturnType<typeof createRefService>;

  const doInstance = () =>
    gad.instance as unknown as {
      resolveWorktreeHeadInternal: (l: string, h: string) => { stateHash: string } | null;
      vcsLog: (
        repo: string,
        limit: number,
        head: string
      ) => Promise<Array<{ summary?: string | null; outputStateHash?: string | null }>>;
      vcsPush: (i: unknown) => Promise<{ status: string }>;
    };

  function newVcs(): WorkspaceVcs {
    return new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot: path.join(root, "workspace"),
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
  }

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-attach-heal-"));
    await fsp.mkdir(path.join(root, "workspace"));
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    refs = createRefService({ statePath: path.join(root, "refs"), gate: async () => {} });
    attachLocalHostBridges(gad.instance, { blobsDir: path.join(root, "blobs"), refs: () => refs });
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("rejects a ref that ran ahead of the DO with no covering publish intent", async () => {
    const vcs = newVcs();
    await vcs.attachGad(callerFor(gad));

    // main = v1 through the ordinary DO push (DO records the lineage).
    const c1 = vcsContextHead("c1");
    await vcs.recordEdit({
      head: c1,
      repoPath: REPO,
      actor: USER,
      edits: [{ kind: "create", path: "a.txt", content: text("v1\n") }],
    });
    await vcs.commit({ head: c1, repoPath: REPO, message: "v1", actor: USER });
    expect((await doInstance().vcsPush({ repoPaths: [REPO], sourceHead: c1, actor: USER })).status).toBe(
      "pushed"
    );
    const v1 = refs.readMain(REPO)!.stateHash;
    // The DO recorded v1.
    expect(doInstance().resolveWorktreeHeadInternal(logIdForRepo(REPO), VCS_MAIN_HEAD)?.stateHash).toBe(
      v1
    );

    // Commit v2 on a ctx (its tree is mirrored to the CAS) but do NOT push it.
    const c2 = vcsContextHead("c2");
    await vcs.recordEdit({
      head: c2,
      repoPath: REPO,
      actor: USER,
      edits: [{ kind: "write", path: "a.txt", content: text("v2\n") }],
    });
    await vcs.commit({ head: c2, repoPath: REPO, message: "v2", actor: USER });
    const v2 = (await vcs.resolveHead(c2, REPO))!;
    expect(v2).not.toBe(v1);

    // Crash window: advance the protected ref to v2 directly (a system advance),
    // WITHOUT the DO recording provenance and WITHOUT a publish intent — the
    // exact drift attach must now reject.
    await refs.updateMains({
      entries: [{ repoPath: REPO, expectedOld: v1, next: v2 }],
      operation: "push",
      reason: "simulate crash-window ref advance",
      writer: "test:crash",
      gateContext: { kind: "system" },
    });
    // Precondition: the DO's recorded main still lags at v1.
    expect(doInstance().resolveWorktreeHeadInternal(logIdForRepo(REPO), VCS_MAIN_HEAD)?.stateHash).toBe(
      v1
    );

    // Re-attach a fresh host over the same refs + DO: attachGad drives
    // vcsHealPublishDrift, which fails closed because no publish intent carries
    // the missing parent/hunk/attribution data.
    const vcs2 = newVcs();
    await expect(vcs2.attachGad(callerFor(gad))).rejects.toThrow(/no publish intent covers it/);

    expect(doInstance().resolveWorktreeHeadInternal(logIdForRepo(REPO), VCS_MAIN_HEAD)?.stateHash).toBe(
      v1
    );
    const log = await doInstance().vcsLog(REPO, 3, VCS_MAIN_HEAD);
    expect(log[0]?.outputStateHash).toBe(v1);
  });
});
