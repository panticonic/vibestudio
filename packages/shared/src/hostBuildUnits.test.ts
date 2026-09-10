import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHostBuildUnitInventory,
  isHostBuildUnitSource,
  parseHostBuildUnitInventory,
  unitSourceDigest,
} from "./hostBuildUnits.js";

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-build-units-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

const shipped = {
  "apps/shell/package.json": '{"name":"shell"}',
  "apps/shell/src/main.ts": "export const shell = 1;\n",
  "extensions/other/index.ts": "export const other = 1;\n",
};

function inventoryFor(root: string, options: { vouchesWholeTree?: boolean } = {}) {
  return buildHostBuildUnitInventory({
    root,
    unitRepoPaths: ["apps/shell", "extensions/other"],
    templateUrl: "git+https://example.test/base.git",
    commit: "a".repeat(40),
    ...options,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("host build unit provenance", () => {
  it("recognises a unit the designated template shipped", () => {
    const root = tree(shipped);
    expect(
      isHostBuildUnitSource({
        inventory: inventoryFor(root),
        repoPath: "apps/shell",
        unitDir: path.join(root, "apps/shell"),
      })
    ).toBe(true);
  });

  it("stops recognising a unit once its source is edited", () => {
    const root = tree(shipped);
    const inventory = inventoryFor(root);
    fs.writeFileSync(path.join(root, "apps/shell/src/main.ts"), "export const shell = 2;\n");
    expect(
      isHostBuildUnitSource({
        inventory,
        repoPath: "apps/shell",
        unitDir: path.join(root, "apps/shell"),
      })
    ).toBe(false);
  });

  it("notices a file added to a unit, not only a file changed", () => {
    const root = tree(shipped);
    const inventory = inventoryFor(root);
    fs.writeFileSync(path.join(root, "apps/shell/extra.ts"), "export const extra = 1;\n");
    expect(
      isHostBuildUnitSource({
        inventory,
        repoPath: "apps/shell",
        unitDir: path.join(root, "apps/shell"),
      })
    ).toBe(false);
  });

  it("claims nothing when the workspace came from no designated template", () => {
    // A workspace someone made themselves has no inventory at all, and a
    // third-party template cannot obtain one however its files are arranged.
    const root = tree(shipped);
    expect(
      isHostBuildUnitSource({
        inventory: null,
        repoPath: "apps/shell",
        unitDir: path.join(root, "apps/shell"),
      })
    ).toBe(false);
  });

  it("refuses a unit the inventory never recorded", () => {
    const root = tree({ ...shipped, "apps/impostor/package.json": '{"name":"shell"}' });
    expect(
      isHostBuildUnitSource({
        inventory: inventoryFor(root),
        repoPath: "apps/impostor",
        unitDir: path.join(root, "apps/impostor"),
      })
    ).toBe(false);
  });

  it("vouches for a whole checkout the host designated for development", () => {
    const root = tree(shipped);
    const inventory = inventoryFor(root, { vouchesWholeTree: true });
    fs.writeFileSync(path.join(root, "apps/shell/src/main.ts"), "// edited all morning\n");
    expect(
      isHostBuildUnitSource({
        inventory,
        repoPath: "apps/shell",
        unitDir: path.join(root, "apps/shell"),
      })
    ).toBe(true);
  });

  it("ignores build output and checkouts, which differ between machines", () => {
    const root = tree(shipped);
    const before = unitSourceDigest(path.join(root, "apps/shell"));
    fs.mkdirSync(path.join(root, "apps/shell/node_modules/dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps/shell/node_modules/dep/index.js"), "1");
    fs.mkdirSync(path.join(root, "apps/shell/.cache"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps/shell/.cache/build"), "2");
    expect(unitSourceDigest(path.join(root, "apps/shell"))).toBe(before);
  });

  it("accepts a repo path however the caller spells it", () => {
    const root = tree(shipped);
    const inventory = inventoryFor(root);
    for (const spelling of ["apps/shell", "/apps/shell", "workspace/apps/shell", "apps/shell/"]) {
      expect(
        isHostBuildUnitSource({
          inventory,
          repoPath: spelling,
          unitDir: path.join(root, "apps/shell"),
        })
      ).toBe(true);
    }
  });

  it("rejects an inventory it cannot read as one", () => {
    expect(parseHostBuildUnitInventory({ version: "something-else", units: {} })).toBeNull();
    expect(parseHostBuildUnitInventory(null)).toBeNull();
    const root = tree(shipped);
    expect(
      parseHostBuildUnitInventory(JSON.parse(JSON.stringify(inventoryFor(root))))
    ).not.toBeNull();
  });
});
