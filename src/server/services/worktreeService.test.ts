/**
 * worktree service — the host disk-scan PRIMITIVE (`worktree.scan`). Verifies
 * the RPC composes DiskProjector.dirForRepoHead + WorktreeStore.localState into
 * a pure `{ stateHash, files }` scan whose state hash is byte-identical to a
 * direct `localState` on the same directory (no commit / ref / DO involvement).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

import { WorktreeStore } from "../vcsHost/worktreeStore.js";
import { DiskProjector } from "../vcsHost/diskProjector.js";
import { vcsContextHead } from "../vcsHost/paths.js";
import { createWorktreeService } from "./worktreeService.js";

const CTX_HEAD = vcsContextHead("demo");

const REPO = "packages/demo";
const WRITER_ID = "do:workers/gad-store:GadStore:vcs";
const writerCtx = { caller: createVerifiedCaller(WRITER_ID, "do") } as never;
const shellCtx = { caller: createVerifiedCaller("shell:dev", "shell") } as never;

describe("worktree.scan primitive", () => {
  let root: string;
  let blobsDir: string;
  let worktrees: WorktreeStore;
  let projector: DiskProjector;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "worktree-scan-"));
    blobsDir = path.join(root, "blobs");
    await fsp.mkdir(path.join(root, "workspace"), { recursive: true });
    // The scan primitive is DO-free: a throwing gad caller enforces that.
    worktrees = new WorktreeStore({
      blobsDir,
      gad: {
        call: () => {
          throw new Error("the disk-scan primitive must not consult the gad store");
        },
      },
    });
    projector = new DiskProjector({
      worktrees,
      workspaceRoot: path.join(root, "workspace"),
      contextsRoot: path.join(root, ".contexts"),
    });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("returns a stateHash byte-identical to a direct localState on the same dir", async () => {
    // Only `ctx:*` heads have a checkout (under `.contexts/<id>/<repo>`); `main`
    // is a pure ref. The scan targets a context head here.
    const repoDir = path.join(root, ".contexts", "demo", ...REPO.split("/"));
    await fsp.mkdir(path.join(repoDir, "sub"), { recursive: true });
    await fsp.writeFile(path.join(repoDir, "a.txt"), "A\n");
    await fsp.writeFile(path.join(repoDir, "sub/b.txt"), "B\n");

    const service = createWorktreeService({
      scan: async (repoPath, head) => {
        const dir = projector.dirForRepoHead(repoPath, head);
        const { stateHash, files } = await worktrees.localState(dir, { updateSidecar: true });
        return { stateHash, files };
      },
      project: async (_repoPath, _head, stateHash) => ({ stateHash }),
      dependentRepos: async () => [],
      getVcsWriterIdentity: () => WRITER_ID,
    });

    const result = (await service.handler(writerCtx, "scan", [REPO, CTX_HEAD])) as {
      stateHash: string;
      files: Array<{ path: string; contentHash: string; size: number; mode: number }>;
    };

    // Direct localState on the resolved dir — the authority the RPC must match.
    const direct = await worktrees.localState(repoDir, { updateSidecar: true });

    expect(result.stateHash).toBe(direct.stateHash);
    expect(result.stateHash).toMatch(/^state:[0-9a-f]{64}$/);
    expect(result.files.map((f) => f.path)).toEqual(["a.txt", "sub/b.txt"]);
    // The scan returns exactly localState's file shape (path/contentHash/size/mode).
    expect(result.files).toEqual(
      direct.files.map((f) => ({
        path: f.path,
        contentHash: f.contentHash,
        size: f.size,
        mode: f.mode,
      }))
    );
  });

  it("rejects an unknown method", async () => {
    const service = createWorktreeService({
      scan: async () => ({ stateHash: "state:" + "0".repeat(64), files: [] }),
      project: async (_repoPath, _head, stateHash) => ({ stateHash }),
      dependentRepos: async () => [],
      getVcsWriterIdentity: () => WRITER_ID,
    });
    await expect(service.handler(shellCtx, "nope", [])).rejects.toThrow(/Unknown worktree method/);
  });

  it("allows shell callers for host-side diagnostics", async () => {
    const service = createWorktreeService({
      scan: async () => ({ stateHash: "state:" + "0".repeat(64), files: [] }),
      project: async (_repoPath, _head, stateHash) => ({ stateHash }),
      dependentRepos: async () => [],
      getVcsWriterIdentity: () => WRITER_ID,
    });

    await expect(service.handler(shellCtx, "dependentRepos", [REPO])).resolves.toEqual([]);
  });

  it("rejects non-writer DO callers before reaching disk primitives", async () => {
    const scan = vi.fn(async () => ({ stateHash: "state:" + "0".repeat(64), files: [] }));
    const service = createWorktreeService({
      scan,
      project: async (_repoPath, _head, stateHash) => ({ stateHash }),
      dependentRepos: async () => [],
      getVcsWriterIdentity: () => WRITER_ID,
    });
    const foreignDoCtx = {
      caller: createVerifiedCaller("do:workers/other:Other:vcs", "do"),
    } as never;

    await expect(service.handler(foreignDoCtx, "scan", [REPO, CTX_HEAD])).rejects.toThrow(
      /restricted to the workspace VCS store DO/
    );
    expect(scan).not.toHaveBeenCalled();
  });
});
