/**
 * forkRepo (history-preserving) against a real gad-store DO. Split out of the
 * former workspaceVcs.push.test.ts when the host push pipeline was deleted
 * (narrow-host P3): the push scenarios moved to the DO suite
 * (tests/workspace-integration/doVcsPush.test.ts); forkRepo stays a host lifecycle
 * responsibility (P4). Main is seeded via the real edit → commit → push flow,
 * now driven through the DO's vcsPush (`pushToMain`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { attachLocalHostBridges, pushToMain } from "../../../src/server/vcsHost/testSupport.js";
import { GadWorkspaceDO } from "../../../workspace/workers/gad-store/index.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";
import { VCS_MAIN_HEAD } from "../../../src/server/vcsHost/paths.js";
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
const text = (value: string) => ({ kind: "text" as const, text: value });

describe("WorkspaceVcs.forkRepo (history-preserving)", () => {
  let root: string;
  let workspaceRoot: string;
  let vcs: WorkspaceVcs;
  let gad: TestGad;
  let refs: ReturnType<typeof createRefService>;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "gadvcs-fork-"));
    workspaceRoot = path.join(root, "workspace");
    await fsp.mkdir(workspaceRoot);
    gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    refs = createRefService({ statePath: path.join(root, "refs"), gate: async () => {} });
    attachLocalHostBridges(gad.instance, { blobsDir: path.join(root, "blobs"), refs });
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

  // Seed panels/chat's main with a real commit so it has history to fork —
  // via the real edit → commit → push flow (push through the DO executor).
  async function seedChat(): Promise<void> {
    await vcs.recordEdit({
      head: "ctx:seed",
      actor: USER,
      repoPath: "panels/chat",
      edits: [
        {
          kind: "create",
          path: "package.json",
          content: text(`{\n  "name": "@workspace-panels/chat",\n  "vibez1": {}\n}\n`),
        },
        { kind: "create", path: "index.tsx", content: text("export const Chat = () => null;\n") },
      ],
    });
    await vcs.commit({
      head: "ctx:seed",
      repoPath: "panels/chat",
      message: "seed chat",
      actor: USER,
    });
    await pushToMain(gad, { repoPaths: ["panels/chat"], sourceHead: "ctx:seed", actor: USER });
  }

  it("forks a repo to a new path, preserving history and rewriting the package name", async () => {
    await seedChat();

    const fork = await vcs.forkRepo("panels/chat", "panels/mychat");

    expect(fork.repoPath).toBe("panels/mychat");
    expect(fork.inherited).toBeGreaterThanOrEqual(1);
    // New repo's main exists and inherits the source tree.
    expect(await vcs.resolveHead(VCS_MAIN_HEAD, "panels/mychat")).toBeTruthy();
    const idx = await vcs.readFile(VCS_MAIN_HEAD, "index.tsx", "panels/mychat");
    expect(idx?.content).toMatchObject({ kind: "text", text: expect.stringContaining("Chat") });
    // package.json name leaf rewritten to the new path (build-valid, no collision).
    const pkg = await vcs.readFile(VCS_MAIN_HEAD, "package.json", "panels/mychat");
    expect(pkg?.content).toMatchObject({
      kind: "text",
      text: expect.stringContaining("@workspace-panels/mychat"),
    });
    // The fork's log carries inherited history plus the rename commit.
    const log = await gad.instance.vcsLog("panels/mychat", 100, VCS_MAIN_HEAD);
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects forking onto an existing repo", async () => {
    await seedChat();
    await vcs.forkRepo("panels/chat", "panels/mychat");
    await expect(vcs.forkRepo("panels/chat", "panels/mychat")).rejects.toThrow(/already exists/);
  });

  it("rejects a taxonomy-invalid destination before creating any destination ref or files", async () => {
    await seedChat();

    await expect(vcs.forkRepo("panels/chat", "packages")).rejects.toThrow(
      /Invalid workspace repo path/
    );

    expect(refs.listMains().map((record) => record.repoPath)).not.toContain("packages");
    await expect(fsp.access(path.join(workspaceRoot, "packages"))).rejects.toThrow();
  });

  it("rejects forking from a repo with no history", async () => {
    await expect(vcs.forkRepo("panels/ghost", "panels/clone")).rejects.toThrow(/no history/);
  });
});
