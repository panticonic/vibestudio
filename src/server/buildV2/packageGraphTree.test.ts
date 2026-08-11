import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureLayout, putBytes, putTree } from "../services/blobstoreService.js";
import { discoverPackageGraphAtTree } from "./packageGraphTree.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CAS package graph discovery", () => {
  it("reads unit manifests without traversing their source trees", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibestudio-package-graph-tree-"));
    temporaryDirectories.push(root);
    const blobsDir = path.join(root, "blobs");
    ensureLayout(blobsDir);
    const store = async (text: string) => (await putBytes(blobsDir, Buffer.from(text))).digest;

    const packageJson = await store(
      JSON.stringify({
        name: "@workspace/core",
        dependencies: { zod: "^3.24.1" },
      })
    );
    const source = await store("export const value = 1;\n");
    const sourceTree = (
      await putTree(blobsDir, [
        { name: "index.ts", kind: "file", contentHash: source, mode: 33188 },
      ])
    ).treeHash;
    const packageTree = (
      await putTree(blobsDir, [
        { name: "package.json", kind: "file", contentHash: packageJson, mode: 33188 },
        { name: "src", kind: "dir", childHash: sourceTree },
      ])
    ).treeHash;
    const packagesTree = (
      await putTree(blobsDir, [{ name: "core", kind: "dir", childHash: packageTree }])
    ).treeHash;
    const workspace = await putTree(
      blobsDir,
      [{ name: "packages", kind: "dir", childHash: packagesTree }],
      { root: true }
    );

    const graph = await discoverPackageGraphAtTree(blobsDir, workspace.stateHash!, root);
    expect(graph.allNodes()).toMatchObject([
      {
        name: "@workspace/core",
        relativePath: "packages/core",
        kind: "package",
        dependencies: { zod: "^3.24.1" },
      },
    ]);
  });
});
