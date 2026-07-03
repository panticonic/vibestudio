/**
 * worktree service — the host disk-scan PRIMITIVE (`worktree.scan`). Verifies
 * the RPC composes DiskProjector.dirForRepoHead + WorktreeStore.localState into
 * a pure `{ stateHash, files }` scan whose state hash is byte-identical to a
 * direct `localState` on the same directory (no commit / ref / DO involvement).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { WorktreeStore } from "../vcsHost/worktreeStore.js";
import { DiskProjector } from "../vcsHost/diskProjector.js";
import { VCS_MAIN_HEAD } from "../vcsHost/paths.js";
import { createWorktreeService } from "./worktreeService.js";

const REPO = "packages/demo";

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
    const repoDir = path.join(root, "workspace", ...REPO.split("/"));
    await fsp.mkdir(path.join(repoDir, "sub"), { recursive: true });
    await fsp.writeFile(path.join(repoDir, "a.txt"), "A\n");
    await fsp.writeFile(path.join(repoDir, "sub/b.txt"), "B\n");

    const service = createWorktreeService({
      scan: async (repoPath, head) => {
        const dir = projector.dirForRepoHead(repoPath, head);
        const { stateHash, files } = await worktrees.localState(dir, { updateSidecar: true });
        return { stateHash, files };
      },
    });

    const result = (await service.handler({} as never, "scan", [REPO, VCS_MAIN_HEAD])) as {
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
    });
    await expect(service.handler({} as never, "nope", [])).rejects.toThrow(
      /Unknown worktree method/
    );
  });
});
