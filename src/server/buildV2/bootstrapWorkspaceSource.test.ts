import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    const { stateHash } = await source.ensureFresh();

    expect(source.executionStateForContent(stateHash)).toEqual({
      kind: "bootstrap-snapshot",
      snapshotHash: stateHash,
    });
    expect(source.executionStateForContent(`state:${"0".repeat(64)}`)).toBeNull();
  });

  it("fails closed when the sealed checkout changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-workspace-source-"));
    temporaryRoots.push(root);
    await fs.writeFile(path.join(root, "package.json"), '{"name":"@workspace/root"}\n');
    const source = new BootstrapWorkspaceSource("workspace:test", root);
    await source.ensureFresh();
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

    await expect(source.assertUnchanged()).rejects.toThrow(
      "Bootstrap workspace source changed while its provider was being built"
    );
  });
});
