/**
 * P5a — the gad DO as an ASYNC PROVENANCE FOLLOWER of the protected-ref main.
 *
 * Pins the eviction-stage invariants:
 *  - the build/freshness path (ensureFresh → scan → advanceRef) COMPLETES and
 *    all build-facing reads work while the DO's ingest is failing — the DO is
 *    never a blocking dependency of builds; the follower catches up when the
 *    DO recovers;
 *  - per-repo recording is ordered (ref-transition chain reproduced in the
 *    DO's log) and independent across repos (one repo's dead queue never
 *    blocks another's);
 *  - the ref→DO reconciler heals a crash gap (ref advanced, provenance never
 *    recorded) both at attach and on demand from a lineage op;
 *  - lineage ops (push/merge — the `mainWorktreeHead` consumers) work after
 *    healing instead of failing on drift.
 *
 * Verified against the REAL gad-store DO (workerd test-utils), matching the
 * other workspaceVcs suites.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { attachLocalHostBridges, pushToMain } from "../../../src/server/vcsHost/testSupport.js";
import { GadWorkspaceDO } from "../../workers/gad-store/index.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";
import { VCS_MAIN_HEAD, logIdForRepo, vcsContextHead } from "../../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../../src/server/vcsHost/testSupport.js";
import { createRefService, type RefService } from "../../../src/server/services/refService.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

const USER = { id: "user", kind: "user" };
const text = (t: string) => ({ kind: "text" as const, text: t });
const FOO = "packages/foo";
const BAR = "panels/bar";

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

async function waitFor(predicate: () => Promise<boolean> | boolean, what = "condition") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} was not reached`);
}

describe("ProvenanceFollower — async provenance for the freshness path", () => {
  let root: string;
  let workspaceRoot: string;
  let refsPath: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;
  let refs: RefService;
  /** Fault injection: `(method, input) => true` rejects the DO call. */
  let failWhen: (method: string, input: unknown) => boolean;

  const write = async (rel: string, body: string) => {
    const abs = path.join(workspaceRoot, ...rel.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body);
  };

  function faultableCaller(): GadCaller {
    const base = callerFor(gad);
    return {
      call<T>(method: string, input: unknown): Promise<T> {
        if (failWhen(method, input)) {
          return Promise.reject(new Error(`injected DO fault: ${method}`));
        }
        return base.call<T>(method, input);
      },
    };
  }

  function newVcs(): WorkspaceVcs {
    return new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
      // Fast, bounded retries so tests observe stall + recovery quickly.
      followerRetry: { retryDelaysMs: [10, 20, 30], slowRetryMs: 40 },
    });
  }

  async function doMainState(repoPath: string): Promise<string | null> {
    const head = (await callerFor(gad).call<{ stateHash: string } | null>("resolveWorktreeHead", {
      logId: logIdForRepo(repoPath),
      head: VCS_MAIN_HEAD,
    })) as { stateHash: string } | null;
    return head?.stateHash ?? null;
  }

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gad-follower-"));
    workspaceRoot = path.join(root, "workspace");
    refsPath = path.join(root, "refs");
    await fsp.mkdir(workspaceRoot);
    await write(`${FOO}/package.json`, '{ "name": "@workspace/foo" }\n');
    await write(`${FOO}/index.ts`, "export const x = 1;\n");
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    // The in-process test DO has no RPC gateway; give computeMerge a local
    // content store over this test's blob dir (production uses blobstore.* RPC).
    // `refs` is re-created in restart simulations — hand the bridge a thunk.
    attachLocalHostBridges(gad.instance, { blobsDir: path.join(root, "blobs"), refs: () => refs });
    refs = createRefService({ statePath: refsPath, gate: async () => {} });
    failWhen = () => false;
    vcs = newVcs();
  });

  afterEach(async () => {
    vcs.provenanceFollower.stop();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("(a) freshness completes while DO ingest fails; the follower catches up on recovery", async () => {
    await vcs.attachGad(faultableCaller());
    const before = await vcs.ensureFresh();
    const refBefore = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(refBefore).toBeTruthy();
    expect(await doMainState(FOO)).toBe(refBefore);

    // The DO's ingest goes down; the working tree moves.
    failWhen = (method) => method === "ingestWorktreeState";
    await write(`${FOO}/index.ts`, "export const x = 2;\n");

    // The build/freshness path is unaffected: the scan advances the ref and
    // returns a workspace view immediately.
    const fresh = await vcs.ensureFresh();
    expect(fresh.stateHash).not.toBe(before.stateHash);
    const refAfter = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(refAfter).not.toBe(refBefore);

    // Every build-facing read resolves from the content store, DO-free.
    const file = await vcs.readFile(VCS_MAIN_HEAD, "index.ts", FOO);
    expect(file?.content).toMatchObject({ kind: "text", text: "export const x = 2;\n" });
    const unitHashes = await vcs.unitHashes(fresh.stateHash, [FOO]);
    expect(unitHashes[FOO]).toMatch(/^manifest:[0-9a-f]{64}$/);
    const listing = await vcs.listFiles(fresh.stateHash);
    expect(listing.map((f) => f.path)).toContain(`${FOO}/index.ts`);

    // The DO is (deliberately) behind — provenance lag, not build lag.
    expect(await doMainState(FOO)).toBe(refBefore);
    expect(vcs.provenanceFollower.pendingCount(FOO)).toBeGreaterThan(0);

    // A repeat freshness call during the outage stays green (unchanged scan).
    const again = await vcs.ensureFresh();
    expect(again.stateHash).toBe(fresh.stateHash);

    // Recovery: the follower drains and records the exact ref transition.
    failWhen = () => false;
    await waitFor(async () => (await doMainState(FOO)) === refAfter, "DO caught up to the ref");
    expect(vcs.provenanceFollower.pendingCount()).toBe(0);
    const log = await gad.instance.vcsLog(FOO, 3, VCS_MAIN_HEAD);
    expect(log[0]).toMatchObject({ summary: "workspace scan", outputStateHash: refAfter });
  });

  it("(c) per-repo ordering under concurrent scans; a dead repo queue never blocks another repo", async () => {
    await write(`${BAR}/package.json`, '{ "name": "@workspace-panels/bar" }\n');
    await write(`${BAR}/index.ts`, "export const b = 1;\n");
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    const fooV1 = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // Only FOO's ingests fail — BAR's recording must proceed independently.
    failWhen = (method, input) =>
      method === "ingestWorktreeState" && (input as { logId?: string }).logId === logIdForRepo(FOO);

    await write(`${FOO}/index.ts`, "export const x = 2;\n");
    await vcs.commitHead(VCS_MAIN_HEAD, { repoPath: FOO, summary: "scan v2" });
    const fooV2 = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    await write(`${FOO}/index.ts`, "export const x = 3;\n");
    await vcs.commitHead(VCS_MAIN_HEAD, { repoPath: FOO, summary: "scan v3" });
    const fooV3 = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    await write(`${BAR}/index.ts`, "export const b = 2;\n");
    await vcs.commitHead(VCS_MAIN_HEAD, { repoPath: BAR, summary: "bar scan" });
    const barV2 = await vcs.resolveHead(VCS_MAIN_HEAD, BAR);

    expect(vcs.provenanceFollower.pendingCount(FOO)).toBe(2);
    // BAR drains despite FOO's dead queue.
    await waitFor(async () => (await doMainState(BAR)) === barV2, "BAR recorded");
    expect(await doMainState(FOO)).toBe(fooV1);

    // FOO recovers: both transitions land, in ref order, with an unbroken
    // input→output chain.
    failWhen = () => false;
    await waitFor(async () => (await doMainState(FOO)) === fooV3, "FOO caught up");
    const events = (await callerFor(gad).call("readLog", {
      logId: logIdForRepo(FOO),
      head: VCS_MAIN_HEAD,
      limit: 0,
    })) as Array<{ payloadKind: string; payload: Record<string, unknown> }>;
    const transitions = events
      .filter((e) => e.payloadKind === "state.snapshot_ingested")
      .map((e) => ({
        input: e.payload["inputStateHash"],
        output: e.payload["outputStateHash"],
      }));
    expect(transitions.slice(-2)).toEqual([
      { input: fooV1, output: fooV2 },
      { input: fooV2, output: fooV3 },
    ]);
  });

  it("(b) attach heals a crash gap: ref advanced, provenance never recorded", async () => {
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    const before = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // Crash window: the ref advances, then the process dies before the
    // follower records (stop() models the death of the queue).
    vcs.provenanceFollower.stop();
    await write(`${FOO}/index.ts`, "export const x = 9;\n");
    await vcs.ensureFresh();
    const refValue = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(refValue).not.toBe(before);
    expect(await doMainState(FOO)).toBe(before); // the gap

    // "Restart": a fresh server over the same refs/blobs/workspace + DO.
    refs = createRefService({ statePath: refsPath, gate: async () => {} });
    const vcs2 = newVcs();
    await vcs2.attachGad(callerFor(gad));
    try {
      expect(await doMainState(FOO)).toBe(refValue);
      const log = await gad.instance.vcsLog(FOO, 3, VCS_MAIN_HEAD);
      // Attach-time heal is now GAD-OWNED (narrow-host P3): the crash gap had no
      // covering publish intent (the freshness follower was stopped), so the DO
      // heals it via a SYNTHETIC catch-up ingest of the ref's tree.
      expect(log[0]?.summary).toMatch(/synthetic catch-up .* to ref state/);
      expect(log[0]?.outputStateHash).toBe(refValue);
    } finally {
      vcs2.provenanceFollower.stop();
    }
  });

  it("(b+d) a lineage op heals drift on demand and proceeds (push over a crash gap)", async () => {
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    const before = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // Same crash gap as above, healed IN-PROCESS by the next lineage op
    // instead of an attach.
    vcs.provenanceFollower.stop();
    await write(`${FOO}/index.ts`, "export const x = 10;\n");
    await vcs.ensureFresh();
    const refValue = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(await doMainState(FOO)).toBe(before);

    refs = createRefService({ statePath: refsPath, gate: async () => {} });
    const vcs2 = newVcs();
    await gadAttachWithoutHealing(vcs2);
    try {
      // Precondition: the gap survived the (heal-suppressed) attach.
      expect(await doMainState(FOO)).toBe(before);

      // The lineage op: a real edit → commit → push. mainWorktreeHead heals
      // the DO to the ref before computing fast-forwardability.
      const head = vcsContextHead("after-gap");
      await vcs2.recordEdit({
        head,
        repoPath: FOO,
        actor: USER,
        edits: [{ kind: "write", path: "index.ts", content: text("export const x = 11;\n") }],
      });
      await vcs2.commit({ head, repoPath: FOO, message: "post-gap edit", actor: USER });
      const pushed = await pushToMain(gad, { repoPaths: [FOO], sourceHead: head, actor: USER });
      expect(pushed.status).toBe("pushed");

      // The DO now records the FULL lineage: healed ref value, then the push.
      const mainNow = await vcs2.resolveHead(VCS_MAIN_HEAD, FOO);
      expect(await doMainState(FOO)).toBe(mainNow);
      const log = await gad.instance.vcsLog(FOO, 5, VCS_MAIN_HEAD);
      expect(log.map((entry) => entry.outputStateHash)).toContain(refValue);
      expect(log[0]?.outputStateHash).toBe(mainNow);

      // And merges (the other mainWorktreeHead consumer) work post-heal.
      const merge = await vcs2.mergeHeads(head, VCS_MAIN_HEAD, { repoPath: FOO, actor: USER });
      expect(merge.status).toBe("up-to-date");
    } finally {
      vcs2.provenanceFollower.stop();
    }
  });

  /** Attach while suppressing the attach-time heal, so the on-demand healing
   *  path is what gets exercised. The attach heal is now the DO's
   *  `vcsHealPublishDrift` RPC (narrow-host P3), so suppression means
   *  no-op'ing that one call; every other call passes through. */
  async function gadAttachWithoutHealing(target: WorkspaceVcs): Promise<void> {
    const base = callerFor(gad);
    let suppress = true;
    await target.attachGad({
      call<T>(method: string, input: unknown): Promise<T> {
        if (suppress && method === "vcsHealPublishDrift") {
          return Promise.resolve({ pendingIntents: 0 } as T);
        }
        return base.call<T>(method, input);
      },
    });
    suppress = false;
  }
});
