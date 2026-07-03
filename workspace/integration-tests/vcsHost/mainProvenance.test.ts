/**
 * P5a — the gad DO as an ASYNC PROVENANCE recorder of the protected-ref main,
 * via a DIRECT per-repo-ordered ingest (the ProvenanceFollower class is gone).
 *
 * Pins the eviction-stage invariants:
 *  - the build/freshness path (ensureFresh → scan → advanceRef) COMPLETES and
 *    all build-facing reads work while the DO's ingest is failing — the DO is
 *    never a blocking dependency of builds;
 *  - the normal path (DO up) records the EXACT ref transition directly, in ref
 *    order per repo, independent across repos;
 *  - a transient DO failure is retried inline and the record still lands;
 *  - when the direct record cannot land (DO down beyond retries / crash gap /
 *    pre-attach advance), the DO's publish-drift heal is the single backstop —
 *    at attach (synthetic catch-up) or on demand from a lineage op;
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

async function waitFor(predicate: () => Promise<boolean> | boolean, what = "condition") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} was not reached`);
}

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

describe("main provenance — direct per-repo recording + heal backstop", () => {
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
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gad-mainprov-"));
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
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("(happy) the direct record lands the exact ref transition when the DO is up", async () => {
    await vcs.attachGad(faultableCaller());
    const before = await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const refBefore = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(refBefore).toBeTruthy();
    expect(await doMainState(FOO)).toBe(refBefore);

    await write(`${FOO}/index.ts`, "export const x = 2;\n");
    const fresh = await vcs.ensureFresh();
    expect(fresh.stateHash).not.toBe(before.stateHash);
    await vcs.flushMainProvenance();

    const refAfter = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(refAfter).not.toBe(refBefore);
    expect(await doMainState(FOO)).toBe(refAfter);
    const log = await gad.instance.vcsLog(FOO, 3, VCS_MAIN_HEAD);
    // Recorded as the real transition (not a synthetic catch-up).
    expect(log[0]).toMatchObject({ summary: "workspace scan", outputStateHash: refAfter });
  });

  it("(retry) a transient DO ingest failure is retried inline and the record still lands", async () => {
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    await vcs.flushMainProvenance();

    // Fail the FIRST ingest attempt only; the inline bounded retry recovers.
    let ingestAttempts = 0;
    failWhen = (method) => method === "ingestWorktreeState" && ++ingestAttempts <= 1;
    await write(`${FOO}/index.ts`, "export const x = 2;\n");
    await vcs.ensureFresh();
    await vcs.flushMainProvenance();

    const refAfter = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(await doMainState(FOO)).toBe(refAfter);
    expect(ingestAttempts).toBeGreaterThan(1); // it retried
    const log = await gad.instance.vcsLog(FOO, 3, VCS_MAIN_HEAD);
    // The real transition landed — no synthetic catch-up was needed.
    expect(log[0]?.summary).toBe("workspace scan");
    expect(log[0]?.outputStateHash).toBe(refAfter);
  });

  it("(backstop) freshness completes while the DO is down; a later heal catches the DO up", async () => {
    await vcs.attachGad(faultableCaller());
    const before = await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const refBefore = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // The DO's ingest goes down for good; the working tree moves.
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

    // The direct record gave up; the DO is (deliberately) behind — provenance
    // lag, not build lag. A repeat freshness call during the outage stays green.
    expect(await doMainState(FOO)).toBe(refBefore);
    const again = await vcs.ensureFresh();
    expect(again.stateHash).toBe(fresh.stateHash);

    // Recovery: with the DO back, the publish-drift heal (the backstop) catches
    // the recorded lineage up to the ref.
    failWhen = () => false;
    await vcs.flushMainProvenance();
    expect(await doMainState(FOO)).toBe(refAfter);
  });

  it("(ordering) direct records apply in ref order per repo, and one repo never blocks another", async () => {
    await write(`${BAR}/package.json`, '{ "name": "@workspace-panels/bar" }\n');
    await write(`${BAR}/index.ts`, "export const b = 1;\n");
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const fooV1 = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // Happy-path ordering: three FOO scans record directly, chained in ref order.
    await write(`${FOO}/index.ts`, "export const x = 2;\n");
    await vcs.commitHead(VCS_MAIN_HEAD, { repoPath: FOO, summary: "scan v2" });
    const fooV2 = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    await write(`${FOO}/index.ts`, "export const x = 3;\n");
    await vcs.commitHead(VCS_MAIN_HEAD, { repoPath: FOO, summary: "scan v3" });
    const fooV3 = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    await vcs.flushMainProvenance();
    expect(await doMainState(FOO)).toBe(fooV3);
    const events = (await callerFor(gad).call("readLog", {
      logId: logIdForRepo(FOO),
      head: VCS_MAIN_HEAD,
      limit: 0,
    })) as Array<{ payloadKind: string; payload: Record<string, unknown> }>;
    const transitions = events
      .filter((e) => e.payloadKind === "state.snapshot_ingested")
      .map((e) => ({ input: e.payload["inputStateHash"], output: e.payload["outputStateHash"] }));
    expect(transitions.slice(-2)).toEqual([
      { input: fooV1, output: fooV2 },
      { input: fooV2, output: fooV3 },
    ]);

    // Independence: only FOO's ingests fail — BAR's recording proceeds directly.
    failWhen = (method, input) =>
      method === "ingestWorktreeState" && (input as { logId?: string }).logId === logIdForRepo(FOO);
    await write(`${FOO}/index.ts`, "export const x = 4;\n");
    await vcs.commitHead(VCS_MAIN_HEAD, { repoPath: FOO, summary: "scan v4" });
    await write(`${BAR}/index.ts`, "export const b = 2;\n");
    await vcs.commitHead(VCS_MAIN_HEAD, { repoPath: BAR, summary: "bar scan" });
    const barV2 = await vcs.resolveHead(VCS_MAIN_HEAD, BAR);

    // BAR's own direct record lands despite FOO's dead record (separate per-repo
    // chains); FOO stays behind (its record fails, no heal yet).
    await waitFor(async () => (await doMainState(BAR)) === barV2, "BAR recorded");
    expect(await doMainState(FOO)).toBe(fooV3);

    // FOO recovers via the heal backstop.
    failWhen = () => false;
    await vcs.flushMainProvenance();
    const fooV4 = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(await doMainState(FOO)).toBe(fooV4);
  });

  it("(b) attach heals a crash gap: ref advanced, provenance never recorded", async () => {
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const before = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // Crash window: the ref advances, but the direct record can never land (its
    // ingest is blocked, modelling a process that died before recording). The
    // fault stays on so the original server's background record never revives.
    failWhen = (method) => method === "ingestWorktreeState";
    await write(`${FOO}/index.ts`, "export const x = 9;\n");
    await vcs.ensureFresh();
    const refValue = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(refValue).not.toBe(before);
    expect(await doMainState(FOO)).toBe(before); // the gap

    // "Restart": a fresh server over the same refs/blobs/workspace + DO, with a
    // healthy caller (its calls bypass the fault). Attach's GAD-OWNED
    // publish-drift heal (narrow-host P3) closes the gap: no covering publish
    // intent existed, so it uses a SYNTHETIC catch-up ingest of the ref's tree.
    refs = createRefService({ statePath: refsPath, gate: async () => {} });
    const vcs2 = newVcs();
    await vcs2.attachGad(callerFor(gad));
    expect(await doMainState(FOO)).toBe(refValue);
    const log = await gad.instance.vcsLog(FOO, 3, VCS_MAIN_HEAD);
    expect(log[0]?.summary).toMatch(/synthetic catch-up .* to ref state/);
    expect(log[0]?.outputStateHash).toBe(refValue);
  });

  it("(b+d) a lineage op heals drift on demand and proceeds (push over a crash gap)", async () => {
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const before = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // Same crash gap, healed IN-PROCESS by the next lineage op instead of an
    // attach. The fault stays on so the original server's record never revives
    // (vcs2's caller bypasses the fault entirely).
    failWhen = (method) => method === "ingestWorktreeState";
    await write(`${FOO}/index.ts`, "export const x = 10;\n");
    await vcs.ensureFresh();
    const refValue = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(await doMainState(FOO)).toBe(before);

    refs = createRefService({ statePath: refsPath, gate: async () => {} });
    const vcs2 = newVcs();
    await gadAttachWithoutHealing(vcs2);
    // Precondition: the gap survived the (heal-suppressed) attach.
    expect(await doMainState(FOO)).toBe(before);

    // The lineage op: a real edit → commit → push. mainWorktreeHead heals the
    // DO to the ref before computing fast-forwardability.
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
  });

  /** Attach while suppressing the attach-time heal, so the on-demand healing
   *  path is what gets exercised. The attach heal is the DO's
   *  `vcsHealPublishDrift` RPC (narrow-host P3), so suppression means no-op'ing
   *  that one call; every other call passes through. */
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
