import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeSealedTree } from "./removeSealedTree.js";

const roots: string[] = [];

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-sealed-tree-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const dir of [path.join(root, "home", ".vibestudio-toolchain"), root]) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // Already removed by the test.
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("removeSealedTree", () => {
  it("removes a tree whose projected toolchain was never unsealed", () => {
    const root = tree();
    const sealed = path.join(root, "home", ".vibestudio-toolchain");
    fs.mkdirSync(sealed, { recursive: true });
    fs.writeFileSync(path.join(sealed, "claude-code"), "tool bytes");
    fs.mkdirSync(path.join(root, "workspaces", "system"), { recursive: true });
    fs.writeFileSync(path.join(root, "workspaces", "system", "state.db"), "state");
    // A session that is killed rather than retired leaves this seal behind.
    fs.chmodSync(path.join(sealed, "claude-code"), 0o500);
    fs.chmodSync(sealed, 0o500);

    expect(() => fs.rmSync(root, { recursive: true, force: true })).toThrow(
      expect.objectContaining({ code: "EACCES" })
    );
    expect(fs.existsSync(root)).toBe(true);

    removeSealedTree(root);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("removes several sealed directories in one pass", () => {
    const root = tree();
    for (const name of ["one", "two", "three"]) {
      const sealed = path.join(root, "native-sessions", name, "home", ".vibestudio-toolchain");
      fs.mkdirSync(sealed, { recursive: true });
      fs.writeFileSync(path.join(sealed, "claude-code"), name);
      fs.chmodSync(sealed, 0o500);
    }

    removeSealedTree(root);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("is a no-op for a tree that is already gone", () => {
    const root = tree();
    fs.rmSync(root, { recursive: true, force: true });
    expect(() => removeSealedTree(root)).not.toThrow();
  });

  it("surfaces a refusal it cannot resolve instead of looping", () => {
    const root = tree();
    fs.mkdirSync(path.join(root, "child"), { recursive: true });
    let attempts = 0;
    const refusal = Object.assign(new Error("permission denied"), {
      code: "EACCES",
      path: path.join(root, "child"),
    });
    expect(() =>
      removeSealedTree(root, {
        rmSync: (() => {
          attempts += 1;
          throw refusal;
        }) as unknown as typeof fs.rmSync,
      })
    ).toThrow(refusal);
    // One attempt, one unseal, one final attempt — never an unbounded retry.
    expect(attempts).toBe(2);
  });
});
