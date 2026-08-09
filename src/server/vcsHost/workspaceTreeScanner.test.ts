import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTreeScanner } from "./workspaceTreeScanner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function sourceRoot(unit: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tree-scanner-"));
  roots.push(root);
  const unitRoot = path.join(root, "panels", unit);
  await fs.mkdir(unitRoot, { recursive: true });
  await fs.writeFile(
    path.join(unitRoot, "package.json"),
    `${JSON.stringify({
      name: `@fixture/${unit}`,
      private: true,
      vibestudio: { title: unit },
    })}\n`
  );
  return root;
}

describe("WorkspaceTreeScanner", () => {
  it("scans the exact async semantic projection instead of a checkout captured at construction", async () => {
    const first = await sourceRoot("first");
    const second = await sourceRoot("external-seed");
    let current = first;
    const provide = vi.fn(async () => current);
    const scanner = new WorkspaceTreeScanner(provide);

    expect(JSON.stringify(await scanner.getSourceTree())).toContain("panels/first");
    expect(JSON.stringify(await scanner.getSourceTree())).toContain("panels/first");
    expect(provide).toHaveBeenCalledTimes(1);
    current = second;
    scanner.invalidate();
    const refreshed = JSON.stringify(await scanner.getSourceTree());

    expect(refreshed).toContain("panels/external-seed");
    expect(refreshed).not.toContain("panels/first");
    expect(provide).toHaveBeenCalledTimes(2);
  });

  it("shares one scan between concurrent callers", async () => {
    const root = await sourceRoot("shared");
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provide = vi.fn(async () => {
      await ready;
      return root;
    });
    const scanner = new WorkspaceTreeScanner(provide);

    const first = scanner.getSourceTree();
    const second = scanner.getSourceTree();
    expect(provide).toHaveBeenCalledTimes(1);
    release();

    await expect(first).resolves.toEqual(await second);
    expect(provide).toHaveBeenCalledTimes(1);
  });

  it("does not cache an old scan that finishes after invalidation", async () => {
    const oldRoot = await sourceRoot("old");
    const newRoot = await sourceRoot("new");
    let current = oldRoot;
    let releaseOld!: () => void;
    const oldReady = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const provide = vi.fn(async () => {
      const selected = current;
      if (selected === oldRoot) await oldReady;
      return selected;
    });
    const scanner = new WorkspaceTreeScanner(provide);

    const oldScan = scanner.getSourceTree();
    current = newRoot;
    scanner.invalidate();
    const newScan = scanner.getSourceTree();

    expect(JSON.stringify(await newScan)).toContain("panels/new");
    releaseOld();
    expect(JSON.stringify(await oldScan)).toContain("panels/old");
    expect(JSON.stringify(await scanner.getSourceTree())).toContain("panels/new");
    expect(provide).toHaveBeenCalledTimes(2);
  });
});
