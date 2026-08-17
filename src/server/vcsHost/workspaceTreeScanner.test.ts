import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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

async function unitWithIcon(icon: string, body: string, iconPath = "assets/icon.svg") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tree-scanner-icon-"));
  roots.push(root);
  const unitRoot = path.join(root, "panels", "iconic");
  await fs.mkdir(path.join(unitRoot, path.dirname(iconPath)), { recursive: true });
  await fs.writeFile(path.join(unitRoot, iconPath), body);
  await fs.writeFile(
    path.join(unitRoot, "package.json"),
    `${JSON.stringify({
      name: "@fixture/iconic",
      private: true,
      vibestudio: { title: "Iconic", icon },
    })}\n`
  );
  return root;
}

async function launchableOf(root: string) {
  const tree = await new WorkspaceTreeScanner(root).getSourceTree();
  const found: { icon?: string; iconVersion?: string }[] = [];
  const walk = (
    nodes: { launchable?: { icon?: string; iconVersion?: string }; children?: unknown[] }[]
  ) => {
    for (const node of nodes) {
      if (node.launchable) found.push(node.launchable);
      if (Array.isArray(node.children)) walk(node.children as typeof nodes);
    }
  };
  walk(tree.children as Parameters<typeof walk>[0]);
  return found[0];
}

describe("WorkspaceTreeScanner unit icons", () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

  it("names a unit-relative icon by its content", async () => {
    // Without this the icon route must answer `private, no-cache`, and a remote
    // client re-fetches every unit's icon on every launcher render.
    const launchable = await launchableOf(await unitWithIcon("./assets/icon.svg", SVG));
    expect(launchable?.iconVersion).toBe(
      createHash("sha256").update(SVG).digest("hex").slice(0, 16)
    );
  });

  it("gives a different version when the icon's bytes change", async () => {
    const first = await launchableOf(await unitWithIcon("./assets/icon.svg", SVG));
    const second = await launchableOf(
      await unitWithIcon("./assets/icon.svg", `${SVG}<!-- edited -->`)
    );
    expect(second?.iconVersion).not.toBe(first?.iconVersion);
  });

  it("leaves an icon it cannot read unversioned rather than guessing", async () => {
    // No version means the URL keeps revalidating, which is correct — the
    // failure mode to avoid is an immutable URL for content we never hashed.
    const launchable = await launchableOf(await unitWithIcon("./assets/missing.svg", SVG));
    expect(launchable?.icon).toBe("./assets/missing.svg");
    expect(launchable?.iconVersion).toBeUndefined();
  });

  it("does not version an icon that is not unit-relative", async () => {
    const launchable = await launchableOf(await unitWithIcon("data:image/svg+xml;base64,AAA", SVG));
    expect(launchable?.iconVersion).toBeUndefined();
  });

  it("refuses to read an icon path that escapes its unit", async () => {
    const launchable = await launchableOf(await unitWithIcon("./../../secret.svg", SVG));
    expect(launchable?.iconVersion).toBeUndefined();
  });
});

describe("WorkspaceTreeScanner", () => {
  it("does not materialize the source projection before the first consumer asks", async () => {
    const root = await sourceRoot("lazy");
    const provide = vi.fn(async () => root);

    const scanner = new WorkspaceTreeScanner(provide);

    expect(provide).not.toHaveBeenCalled();
    expect(JSON.stringify(await scanner.getSourceTree())).toContain("panels/lazy");
    expect(provide).toHaveBeenCalledTimes(1);
  });

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
