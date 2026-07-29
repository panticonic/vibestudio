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
    current = second;
    scanner.invalidate();
    const refreshed = JSON.stringify(await scanner.getSourceTree());

    expect(refreshed).toContain("panels/external-seed");
    expect(refreshed).not.toContain("panels/first");
    expect(provide).toHaveBeenCalledTimes(2);
  });
});
