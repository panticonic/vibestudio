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
 *  - when the direct record cannot land (DO down beyond retries / crash gap),
 *    the host's durable scan record replays with the original file list,
 *    parent, summary, and actor before attach/on-demand DO heal;
 *  - uncovered ref/DO drift still fails closed when neither a host scan record
 *    nor a DO publish intent carries the missing transition.
 *
 * Verified against the REAL gad-store DO (workerd test-utils), matching the
 * other workspaceVcs suites.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { attachLocalHostBridges } from "../../../src/server/vcsHost/testSupport.js";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;
type FaultDecision = boolean | Promise<void>;

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

describe("main provenance — direct per-repo recording + fail-closed drift", () => {
  let root: string;
  let workspaceRoot: string;
  let refsPath: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;
  let refs: RefService;
  /** Fault injection: `true` rejects the DO call; a Promise holds then replays it. */
  let failWhen: (method: string, input: unknown) => FaultDecision;

  const write = async (rel: string, body: string) => {
    const abs = path.join(workspaceRoot, ...rel.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body);
  };

  function faultableCaller(): GadCaller {
    const base = callerFor(gad);
    return {
      call<T>(method: string, input: unknown): Promise<T> {
        const decision = failWhen(method, input);
        if (decision === true) {
          return Promise.reject(new Error(`injected DO fault: ${method}`));
        }
        if (decision) {
          return decision.then(() => base.call<T>(method, input));
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
    // Recorded as the real transition (not an invented recovery commit).
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
    // The real transition landed — no recovery commit was needed.
    expect(log[0]?.summary).toBe("workspace scan");
    expect(log[0]?.outputStateHash).toBe(refAfter);
  });

  it("(backstop) freshness completes while a live provenance record is blocked, then catches up", async () => {
    await vcs.attachGad(faultableCaller());
    const before = await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const refBefore = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // The DO's ingest is blocked; the working tree moves.
    let blockIngest = true;
    const ingestBlocked = deferred();
    const releaseIngest = deferred();
    failWhen = (method) => {
      if (method !== "ingestWorktreeState" || !blockIngest) return false;
      ingestBlocked.resolve();
      return releaseIngest.promise;
    };
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

    // The direct record is still blocked; the DO is deliberately behind —
    // provenance lag, not build lag. A repeat freshness call during the outage
    // stays green.
    await ingestBlocked.promise;
    expect(await doMainState(FOO)).toBe(refBefore);
    const again = await vcs.ensureFresh();
    expect(again.stateHash).toBe(fresh.stateHash);

    // This is not no-intent drift: the live WorkspaceVcs instance still owns
    // the full queued transition, so once the DO accepts calls again the real
    // authored record lands without synthetic recovery.
    blockIngest = false;
    releaseIngest.resolve();
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

    // Independence: only FOO's ingest is blocked — BAR's recording proceeds
    // directly on its own per-repo chain.
    let blockFooIngest = true;
    const fooIngestBlocked = deferred();
    const releaseFooIngest = deferred();
    failWhen = (method, input) => {
      if (
        method !== "ingestWorktreeState" ||
        (input as { logId?: string }).logId !== logIdForRepo(FOO) ||
        !blockFooIngest
      ) {
        return false;
      }
      fooIngestBlocked.resolve();
      return releaseFooIngest.promise;
    };
    await write(`${FOO}/index.ts`, "export const x = 4;\n");
    await vcs.commitHead(VCS_MAIN_HEAD, { repoPath: FOO, summary: "scan v4" });
    await fooIngestBlocked.promise;
    await write(`${BAR}/index.ts`, "export const b = 2;\n");
    await vcs.commitHead(VCS_MAIN_HEAD, { repoPath: BAR, summary: "bar scan" });
    const barV2 = await vcs.resolveHead(VCS_MAIN_HEAD, BAR);

    // BAR's own direct record lands despite FOO's blocked record (separate
    // per-repo chains); FOO stays behind until its queued call is released.
    await waitFor(async () => (await doMainState(BAR)) === barV2, "BAR recorded");
    expect(await doMainState(FOO)).toBe(fooV3);

    // The live queued FOO transition still has full authored provenance. Once
    // the DO accepts the call, flush records it instead of fabricating a
    // ref-tree-only recovery commit.
    const fooV4 = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(fooV4).not.toBe(fooV3);
    blockFooIngest = false;
    releaseFooIngest.resolve();
    await vcs.flushMainProvenance();
    expect(await doMainState(FOO)).toBe(fooV4);
  });

  it("(b) attach replays a durable scan record after a ref-before-DO crash gap", async () => {
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const before = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // Crash window: the ref advances, but the direct record can never land (its
    // ingest is blocked, modelling a process that died before recording). The
    // durable host scan record survives under the host's context data.
    failWhen = (method) => method === "ingestWorktreeState";
    await write(`${FOO}/index.ts`, "export const x = 9;\n");
    await vcs.ensureFresh();
    const refValue = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(refValue).not.toBe(before);
    expect(await doMainState(FOO)).toBe(before); // the gap

    // "Restart": a fresh server over the same refs/blobs/workspace + DO, with a
    // healthy caller (its calls bypass the fault). Attach replays the host scan
    // record before the DO-owned publish-intent heal, so the real transition is
    // preserved instead of being treated as uncovered drift.
    refs = createRefService({ statePath: refsPath, gate: async () => {} });
    const vcs2 = newVcs();
    await vcs2.attachGad(callerFor(gad));
    expect(await doMainState(FOO)).toBe(refValue);
    const log = await gad.instance.vcsLog(FOO, 3, VCS_MAIN_HEAD);
    expect(log[0]).toMatchObject({ summary: "workspace scan", outputStateHash: refValue });
  });

  it("(b) rejects a stale initial durable scan record when the DO already has main lineage", async () => {
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const initialRef = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    if (!initialRef) throw new Error("test setup failed: initial main ref was not seeded");
    const initialFiles = gad.instance
      .listStateFiles({ stateHash: initialRef })
      .map((file) => ({
        path: String(file["path"]),
        contentHash: String(file["content_hash"]),
        size: 0,
        mode: Number(file["mode"]),
      }));

    await write(`${FOO}/index.ts`, "export const x = 12;\n");
    await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const currentRef = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    if (!currentRef) throw new Error("test setup failed: current main ref was not seeded");
    expect(currentRef).not.toBe(initialRef);
    expect(await doMainState(FOO)).toBe(currentRef);

    // Restart with a protected ref that still says the initial creation landed,
    // plus a stale durable first-main record. Before the guard, replay would
    // ingest that `prev:null` record on top of the DO's current main and rewind
    // the DO back to `initialRef`.
    refs = createRefService({
      statePath: path.join(root, "refs-stale-initial"),
      gate: async () => {},
    });
    await refs.seedMain({ repoPath: FOO, value: initialRef });
    const recordId = "00000000-0000-4000-8000-000000000001";
    const recordDir = path.join(root, ".contexts", ".main-provenance-records");
    await fsp.mkdir(recordDir, { recursive: true });
    await fsp.writeFile(
      path.join(recordDir, `${recordId}.json`),
      `${JSON.stringify(
        {
          version: 1,
          id: recordId,
          createdAt: Date.now(),
          repoPath: FOO,
          logId: logIdForRepo(FOO),
          prev: null,
          next: initialRef,
          files: initialFiles,
          actor: USER,
          summary: "stale initial scan",
        },
        null,
        2
      )}\n`
    );

    const vcs2 = newVcs();
    await expect(vcs2.attachGad(callerFor(gad))).rejects.toThrow(/no publish intent covers it/);
    expect(await doMainState(FOO)).toBe(currentRef);
  });

  it("(b+d) lineage ops replay a durable scan record before reading main", async () => {
    await vcs.attachGad(faultableCaller());
    await vcs.ensureFresh();
    await vcs.flushMainProvenance();
    const before = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);

    // Same gap, but in-process: the direct recorder exhausts its bounded
    // retries and leaves the durable host scan record for the next lineage op.
    let ingestAttempts = 0;
    failWhen = (method) => method === "ingestWorktreeState" && ++ingestAttempts <= 4;
    await write(`${FOO}/index.ts`, "export const x = 10;\n");
    await vcs.ensureFresh();
    const refValue = await vcs.resolveHead(VCS_MAIN_HEAD, FOO);
    expect(await doMainState(FOO)).toBe(before);
    await waitFor(() => ingestAttempts >= 4, "direct record exhausted");
    expect(await doMainState(FOO)).toBe(before);

    // The lineage op: a ctx edit pulls from main. mergeHeads drains/replays the
    // durable scan record before dispatching to the DO's merge semantics.
    const head = vcsContextHead("pull-after-gap");
    await vcs.recordEdit({
      head,
      repoPath: FOO,
      actor: USER,
      edits: [{ kind: "create", path: "local.ts", content: text("export const y = 1;\n") }],
    });
    await vcs.commit({ head, repoPath: FOO, message: "post-gap edit", actor: USER });
    const merged = await vcs.mergeHeads(head, VCS_MAIN_HEAD, { repoPath: FOO, actor: USER });
    expect(["merged", "up-to-date"]).toContain(merged.status);
    expect(await doMainState(FOO)).toBe(refValue);
    const log = await gad.instance.vcsLog(FOO, 3, VCS_MAIN_HEAD);
    expect(log.some((entry) => entry.outputStateHash === refValue)).toBe(true);
  });
});
