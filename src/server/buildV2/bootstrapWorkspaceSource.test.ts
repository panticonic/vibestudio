import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectTreeReachableDigests,
  ensureLayout,
  mirrorWorktreeTree,
  putBootstrapBytes,
} from "../services/blobstoreService.js";
import { BootstrapWorkspaceSource } from "./bootstrapWorkspaceSource.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("BootstrapWorkspaceSource execution identity", () => {
  it("exposes only the exact sealed snapshot as executable source state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-workspace-source-"));
    temporaryRoots.push(root);
    await fs.writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "@workspace/root", private: true }, null, 2)}\n`
    );
    const source = new BootstrapWorkspaceSource("workspace:test", root);
    const snapshot = await source.seal();
    const { stateHash } = snapshot;

    expect(source.executionStateForContent(stateHash)).toEqual({
      kind: "bootstrap-snapshot",
      snapshotHash: stateHash,
    });
    expect(source.executionStateForContent(`state:${"0".repeat(64)}`)).toBeNull();
  });

  it("mirrors the sealed execution source exactly once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-workspace-source-"));
    temporaryRoots.push(root);
    await fs.writeFile(path.join(root, "package.json"), '{"name":"@workspace/root"}\n');
    const putFile = vi.fn(async (bytes: Buffer) => ({
      digest: createHash("sha256").update(bytes).digest("hex"),
    }));
    const putTree = vi.fn(async () => {});
    const source = new BootstrapWorkspaceSource("workspace:test", root, { putFile, putTree });

    const first = await source.seal();
    await source.seal();
    await first.assertUnchanged();

    expect(putFile).toHaveBeenCalledOnce();
    expect(putTree).toHaveBeenCalledOnce();
    expect(putTree).toHaveBeenCalledWith(
      [expect.objectContaining({ path: "package.json" })],
      first.stateHash
    );
  });

  it("makes the sealed execution source reconstructible by content GC", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-workspace-source-"));
    temporaryRoots.push(root);
    const sourceRoot = path.join(root, "source");
    const blobsDir = path.join(root, "blobs");
    await fs.mkdir(sourceRoot);
    ensureLayout(blobsDir);
    await fs.writeFile(path.join(sourceRoot, "package.json"), '{"name":"@workspace/root"}\n');
    const source = new BootstrapWorkspaceSource("workspace:test", sourceRoot, {
      putFile: (bytes) => putBootstrapBytes(blobsDir, bytes),
      putTree: async (files, stateHash) => {
        await mirrorWorktreeTree(blobsDir, [...files], { expectStateHash: stateHash });
      },
    });

    const snapshot = await source.seal();

    await expect(collectTreeReachableDigests(blobsDir, snapshot.stateHash)).resolves.not.toBeNull();
  });

  it("keeps the sealed state addressable after the live source is published", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-workspace-source-"));
    temporaryRoots.push(root);
    await fs.writeFile(path.join(root, "package.json"), '{"name":"@workspace/root"}\n');
    const source = new BootstrapWorkspaceSource("workspace:test", root);
    const snapshot = await source.seal();

    await fs.writeFile(path.join(root, "package.json"), '{"name":"@workspace/published"}\n');

    await expect(snapshot.assertUnchanged()).rejects.toThrow(
      "Bootstrap workspace source changed while its provider was being built"
    );
    await expect(source.ensureFresh()).rejects.toThrow(
      "Bootstrap workspace source changed after it was sealed"
    );
  });

  it("fails closed when the sealed checkout changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-workspace-source-"));
    temporaryRoots.push(root);
    await fs.writeFile(path.join(root, "package.json"), '{"name":"@workspace/root"}\n');
    const source = new BootstrapWorkspaceSource("workspace:test", root);
    await source.seal();
    await fs.writeFile(path.join(root, "package.json"), '{"name":"@workspace/changed"}\n');

    await expect(source.ensureFresh()).rejects.toThrow(
      "Bootstrap workspace source changed after it was sealed"
    );
  });

  it("includes build-output directories in the sealed source identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-workspace-source-"));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, "workers", "provider", "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "workers", "provider", "package.json"), "{}\n");
    await fs.writeFile(
      path.join(root, "workers", "provider", "dist", "index.js"),
      "export default 1;\n"
    );
    const source = new BootstrapWorkspaceSource("workspace:test", root);
    await source.ensureFresh();

    await fs.writeFile(
      path.join(root, "workers", "provider", "dist", "index.js"),
      "export default 2;\n"
    );

    await expect((await source.seal()).assertUnchanged()).rejects.toThrow(
      "Bootstrap workspace source changed while its provider was being built"
    );
  });

  it("excludes repository metadata from the workspace content identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-workspace-source-"));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, "packages", "example", ".git"), { recursive: true });
    await fs.writeFile(path.join(root, "packages", "example", "package.json"), "{}\n");
    await fs.writeFile(path.join(root, "packages", "example", ".git", "HEAD"), "ref: main\n");
    const source = new BootstrapWorkspaceSource("workspace:test", root);
    const snapshot = await source.seal();

    await fs.writeFile(path.join(root, "packages", "example", ".git", "HEAD"), "ref: other\n");

    await expect(snapshot.assertUnchanged()).resolves.toBeUndefined();
    await expect(source.ensureFresh()).resolves.toEqual({ stateHash: snapshot.stateHash });
  });
});
