import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostRefBasisDigest } from "@vibestudio/shared/vcs/publication";
import { ensureLayout, mirrorWorktreeTree, putBytes } from "../services/blobstoreService.js";
import { createProtectedRefStore } from "../services/protectedRefStore.js";
import { WorkspaceVcs } from "./workspaceVcs.js";

describe("WorkspaceVcs protected publication notification", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await fsp.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("emits the complete CAS batch even when source mirroring fails", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vcs-publication-"));
    const blobsDir = path.join(root, "blobs");
    const workspaceRoot = path.join(root, "source");
    ensureLayout(blobsDir);
    await fsp.mkdir(workspaceRoot, { recursive: true });
    // A file where the repository parent directory belongs forces the
    // non-authoritative source mirror to fail after notification.
    await fsp.writeFile(path.join(workspaceRoot, "packages"), "blocked\n");
    const contentHash = (await putBytes(blobsDir, Buffer.from("published\n"))).digest;
    const stateHash = (
      await mirrorWorktreeTree(blobsDir, [{ path: "index.ts", contentHash, mode: 0o100644 }])
    ).stateHash;
    const refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async () => undefined,
    });
    const vcs = new WorkspaceVcs({
      workspaceId: "workspace:test",
      blobsDir,
      workspaceRoot,
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
      buildSourcesRoot: path.join(root, "build-sources"),
      extractMainToSource: true,
      refs,
    });
    await vcs.attachGad({ call: async () => undefined as never });
    const listener = vi.fn();
    vcs.onProtectedPublication(listener);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await refs.updateMains({
      entries: [{ repoPath: "packages/app", expectedOld: null, next: stateHash }],
      evidence: {
        publicationId: "publication:test",
        previousEventId: "event:genesis",
        publishedEventId: "event:test",
        hostRefsBasisDigest: hostRefBasisDigest([]),
      },
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: "publication:test",
        resultHostRefsBasisDigest: hostRefBasisDigest([
          { repoPath: "packages/app", contentRoot: stateHash },
        ]),
        changedPaths: ["packages/app/index.ts"],
        repositories: [
          expect.objectContaining({
            repoPath: "packages/app",
            previousStateHash: null,
            nextStateHash: stateHash,
            fileChanges: [
              {
                kind: "added",
                path: "packages/app/index.ts",
                oldContentHash: null,
                newContentHash: contentHash,
                oldExecutable: null,
                newExecutable: false,
              },
            ],
          }),
        ],
      })
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("protected publication source mirror failed"),
      expect.anything()
    );
  });
});
