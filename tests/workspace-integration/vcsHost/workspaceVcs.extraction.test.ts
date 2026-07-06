/**
 * Dev extraction e2e (Phase-2 revision §3) — THE regression guard.
 *
 * With `extractMainToSource` enabled (dev source dir configured), a push to
 * `main` must project the new main state OUT to the source dir at
 * `workspaceRoot/{repoPath}`, so a change authored in a context flows back into
 * the real monorepo checkout. This is the flow Phase 2 broke by deleting the
 * `main → workspace/` export. `main` stays a pure ref for all VCS logic — the
 * export is a dedicated, write-only, gated bridge (never a checkout mapping).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { attachLocalHostBridges, pushToMain } from "../../../src/server/vcsHost/testSupport.js";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";
import { vcsContextHead } from "../../../src/server/vcsHost/paths.js";
import type { GadCaller } from "../../../src/server/vcsHost/testSupport.js";
import { createRefService } from "../../../src/server/services/refService.js";

type TestGad = Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;

const USER = { id: "user", kind: "user" };
const text = (t: string) => ({ kind: "text" as const, text: t });

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

describe("WorkspaceVcs dev extraction (main → source dir)", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-extract-"));
    workspaceRoot = path.join(root, "source");
    await fsp.mkdir(path.join(workspaceRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "packages/foo/index.ts"), "export const x = 1;\n");
    await fsp.mkdir(path.join(workspaceRoot, "meta"), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "meta/vibestudio.yml"), "name: test\n");

    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const refs = createRefService({ statePath: path.join(root, "refs"), gate: async () => {} });
    attachLocalHostBridges(gad.instance, { blobsDir: path.join(root, "blobs"), refs });
    vcs = new WorkspaceVcs({
      workspaceId: "test-ws",
      blobsDir: path.join(root, "blobs"),
      workspaceRoot,
      contextsRoot: path.join(root, ".contexts"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
      extractMainToSource: true, // dev source dir configured
    });
    await vcs.attachGad(callerFor(gad));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("edit in a context → commit → push to main projects the change OUT to workspaceRoot/{repoPath}", async () => {
    const ctxId = "author";
    const head = vcsContextHead(ctxId);
    await vcs.recordEdit({
      head,
      actor: USER,
      repoPath: "packages/foo",
      edits: [{ kind: "write", path: "index.ts", content: text("export const x = 2;\n") }],
    });
    await vcs.commit({ head, repoPath: "packages/foo", message: "bump x", actor: USER });

    // The source dir is untouched by a ctx commit — only a push to main extracts.
    expect(await fsp.readFile(path.join(workspaceRoot, "packages/foo/index.ts"), "utf8")).toBe(
      "export const x = 1;\n"
    );

    const pushed = await pushToMain(gad, {
      repoPaths: ["packages/foo"],
      sourceHead: head,
      actor: USER,
    });
    expect(pushed.status).toBe("pushed");

    // The onMainsUpdated reaction is async (fires off refs.onRefsChanged); wait
    // for the extraction to settle.
    await vcs.ensureFresh();
    await new Promise((r) => setTimeout(r, 50));

    // The change now appears on disk in the source dir — extracted from main.
    expect(await fsp.readFile(path.join(workspaceRoot, "packages/foo/index.ts"), "utf8")).toBe(
      "export const x = 2;\n"
    );
  });

  it("does NOT extract when the gate is off (production ephemeral workspace)", async () => {
    const gatedOffRoot = path.join(root, "source-off");
    await fsp.mkdir(path.join(gatedOffRoot, "packages/foo"), { recursive: true });
    await fsp.writeFile(path.join(gatedOffRoot, "packages/foo/index.ts"), "export const x = 1;\n");
    const refs = createRefService({ statePath: path.join(root, "refs-off"), gate: async () => {} });
    const gadOff = await createTestDO(GadWorkspaceDO, { __objectKey: "gadOff" });
    attachLocalHostBridges(gadOff.instance, { blobsDir: path.join(root, "blobs-off"), refs });
    const vcsOff = new WorkspaceVcs({
      workspaceId: "test-ws",
      blobsDir: path.join(root, "blobs-off"),
      workspaceRoot: gatedOffRoot,
      contextsRoot: path.join(root, ".contexts-off"),
      buildSourcesRoot: path.join(root, "build-sources-off"),
      refs,
      // extractMainToSource omitted → off
    });
    await vcsOff.attachGad(callerFor(gadOff));

    const head = vcsContextHead("author");
    await vcsOff.recordEdit({
      head,
      actor: USER,
      repoPath: "packages/foo",
      edits: [{ kind: "write", path: "index.ts", content: text("export const x = 9;\n") }],
    });
    await vcsOff.commit({ head, repoPath: "packages/foo", message: "bump", actor: USER });
    expect(
      (await pushToMain(gadOff, { repoPaths: ["packages/foo"], sourceHead: head, actor: USER }))
        .status
    ).toBe("pushed");
    await vcsOff.ensureFresh();
    await new Promise((r) => setTimeout(r, 50));

    // Gate off: the source dir is never written by a main advance.
    expect(await fsp.readFile(path.join(gatedOffRoot, "packages/foo/index.ts"), "utf8")).toBe(
      "export const x = 1;\n"
    );
  });
});
