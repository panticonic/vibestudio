/**
 * Main provenance is DO-OWNED (narrow-host boundary refactor Phase 3).
 *
 * The host-side freshness→main provenance reconciliation (the direct per-repo
 * recorder, the durable scan records, `commitMainHead`/`advanceMainRef`) is
 * GONE: `main` is a pure ref that advances ONLY through the gated, DO-driven
 * push path (`refs.updateMains`), and the gad-store DO records every main
 * transition SYNCHRONOUSLY in that publish path (write-ahead intent →
 * `refs.updateMains` → `completePublishIntent`). Out-of-band disk edits adopt
 * into the ACTIVE context head (Phase 2), never `main`.
 *
 * This suite pins the surviving provenance CONTRACT against the DO surface:
 *  - a push records the EXACT main transition in the DO's per-repo `main` log,
 *    attributed to the actor, with per-file edit ops (the blame vehicle);
 *  - successive pushes extend main lineage with event-keyed ancestry
 *    (`commitAncestors` first-parent chain: each main commit descends from the
 *    previous one);
 *  - `main` is a pure ref — a host-side `commitHead(main)` is rejected outright;
 *  - uncovered ref/DO drift (a ref advance with NO covering publish intent)
 *    still fails closed at the DO's publish-drift heal.
 *
 * Verified against the REAL gad-store DO (workerd test-utils), matching the
 * other workspaceVcs suites. Full-chain on-behalf-of token attribution is
 * covered by gatewayAttribution.test.ts; push orchestration / crash→heal by
 * doVcsPush.test.ts. This suite is the main-lineage/blame contract.
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

const USER = { id: "user", kind: "user" };
const FOO = "packages/foo";
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

describe("main provenance — DO-owned push lineage + fail-closed drift", () => {
  let root: string;
  let workspaceRoot: string;
  let refsPath: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;
  let refs: RefService;

  const doInstance = () =>
    gad.instance as unknown as {
      vcsPush: (a: unknown) => Promise<{ status: string; repoPaths?: string[] }>;
      vcsHealPublishDrift: (a: unknown) => Promise<unknown>;
      vcsLog: (
        repoPath: string,
        limit: number,
        head: string
      ) => Array<{ actor: unknown; summary: string | null; outputStateHash: string | null }>;
      commitAncestors: (a: {
        eventId: string;
        limit?: number;
      }) => Array<{ eventId: string; stateHash: string | null; parentEventIds: string[] }>;
      listCommitEdits: (a: { commitEventId: string }) => Array<Record<string, unknown>>;
      resolveWorktreeHeadInternal: (
        logId: string,
        head: string
      ) => { stateHash: string; commitEventId: string | null } | null;
    };

  const readMain = (repoPath: string): string | null => refs.readMain(repoPath)?.stateHash ?? null;
  const mainHead = (repoPath: string) =>
    doInstance().resolveWorktreeHeadInternal(logIdForRepo(repoPath), VCS_MAIN_HEAD);

  const seedCommit = async (
    ctxId: string,
    repoPath: string,
    file: string,
    body: string
  ): Promise<string> => {
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      repoPath,
      actor: USER,
      edits: [{ kind: "create", path: file, content: { kind: "text", text: body } }],
    });
    const committed = await vcs.commit({ head, repoPath, message: `commit ${file}`, actor: USER });
    expect(committed.status).toBe("committed");
    return committed.stateHash;
  };

  const editCommit = async (
    ctxId: string,
    repoPath: string,
    file: string,
    body: string
  ): Promise<string> => {
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      repoPath,
      actor: USER,
      edits: [{ kind: "write", path: file, content: { kind: "text", text: body } }],
    });
    const committed = await vcs.commit({ head, repoPath, message: `edit ${file}`, actor: USER });
    return committed.stateHash;
  };

  const push = (ctxId: string, repoPaths: string[], message?: string) =>
    doInstance().vcsPush({
      repoPaths,
      sourceHead: vcsContextHead(ctxId),
      actor: USER,
      ...(message ? { message } : {}),
    });

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gad-mainprov-"));
    workspaceRoot = path.join(root, "workspace");
    refsPath = path.join(root, "refs");
    await fsp.mkdir(workspaceRoot);
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    refs = createRefService({ statePath: refsPath, gate: async () => {} });
    // The in-process test DO has no RPC gateway: give it a local content-store /
    // ref / build bridge (production uses blobstore.*/refs.*/build.* RPC). The
    // build validator is an all-pass no-op, as in the other push suites.
    attachLocalHostBridges(gad.instance, {
      blobsDir: path.join(root, "blobs"),
      refs: () => refs,
      buildValidate: async () => [],
    });
    vcs = new WorkspaceVcs({
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
    await vcs.attachGad(callerFor(gad));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("a push records the exact main transition in the DO log, attributed with edit ops", async () => {
    const stateHash = await seedCommit("c1", FOO, "index.ts", "export const x = 1;\n");
    const result = await push("c1", [FOO], "publish foo");
    expect(result.status).toBe("pushed");

    // The protected ref moved and the DO's recorded main head is in lockstep —
    // no async host recorder, no lag.
    expect(readMain(FOO)).toBe(stateHash);
    const head = mainHead(FOO);
    expect(head?.stateHash).toBe(stateHash);
    expect(head?.commitEventId).toBeTruthy();

    // The DO's per-repo main log records the REAL transition (not a synthetic
    // recovery commit), attributed to the pushing actor.
    const log = doInstance().vcsLog(FOO, 3, VCS_MAIN_HEAD);
    expect(log[0]?.outputStateHash).toBe(stateHash);
    expect(log[0]?.summary).toBe("publish foo");
    expect(JSON.stringify(log[0]?.actor)).toContain("user");

    // Blame vehicle: the main commit carries per-file edit ops (the create of
    // index.ts), re-keyed at commit to this main event.
    const edits = doInstance().listCommitEdits({ commitEventId: head!.commitEventId! });
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.map((e) => String(e["path"]))).toContain("index.ts");
  });

  it("successive pushes extend main lineage with event-keyed ancestry", async () => {
    const v1 = await seedCommit("c1", FOO, "index.ts", "export const x = 1;\n");
    await push("c1", [FOO], "v1");
    const firstEventId = mainHead(FOO)!.commitEventId!;

    const v2 = await editCommit("c1", FOO, "index.ts", "export const x = 2;\n");
    await push("c1", [FOO], "v2");
    expect(v2).not.toBe(v1);
    expect(readMain(FOO)).toBe(v2);

    const secondEventId = mainHead(FOO)!.commitEventId!;
    expect(secondEventId).not.toBe(firstEventId);

    // Event-keyed ancestry: the second main commit descends (first parent) from
    // the first — a true lineage, walkable via commitAncestors.
    const ancestry = doInstance().commitAncestors({ eventId: secondEventId, limit: 10 });
    expect(ancestry[0]?.eventId).toBe(secondEventId);
    expect(ancestry[0]?.stateHash).toBe(v2);
    expect(ancestry[0]?.parentEventIds).toContain(firstEventId);
    // The first commit's output is the base the second extends.
    const first = ancestry.find((a) => a.eventId === firstEventId);
    expect(first?.stateHash).toBe(v1);
  });

  it("`main` is a pure ref — a host-side commit of main is rejected", async () => {
    await seedCommit("c1", FOO, "index.ts", "export const x = 1;\n");
    await expect(vcs.commitHead(VCS_MAIN_HEAD, { repoPath: FOO, summary: "scan" })).rejects.toThrow(
      /pure ref|advances only via push/i
    );
  });

  it("uncovered ref/DO drift (no publish intent) fails closed at the DO heal", async () => {
    // Establish a real main first.
    const stateHash = await seedCommit("c1", FOO, "index.ts", "export const x = 1;\n");
    await push("c1", [FOO]);
    expect(readMain(FOO)).toBe(stateHash);

    // Advance the protected ref out-of-band with NO covering publish intent —
    // the DO cannot reconstruct the missing authored transition from the ref
    // alone, so the heal must fail closed rather than fabricate provenance.
    const drifted = "state:" + "a".repeat(64);
    await refs.seedMain({ repoPath: "packages/orphan", value: drifted });
    await expect(doInstance().vcsHealPublishDrift({})).rejects.toThrow(
      /no publish intent covers it|drift/i
    );
  });
});
