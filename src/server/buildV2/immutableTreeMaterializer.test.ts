import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeImmutableTree } from "./immutableTreeMaterializer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
  );
});

describe("materializeImmutableTree", () => {
  it("projects files as hardlinks and preserves dependency symlinks", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "immutable-tree-"));
    roots.push(root);
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.promises.mkdir(path.join(source, "package", "nested"), { recursive: true });
    await Promise.all([
      fs.promises.writeFile(path.join(source, "package", "index.js"), "export default true;\n"),
      fs.promises.writeFile(path.join(source, "package", "nested", "value.txt"), "value\n"),
      fs.promises.symlink("package", path.join(source, "alias")),
    ]);

    await materializeImmutableTree(source, target);

    const [sourceStat, targetStat, aliasStat] = await Promise.all([
      fs.promises.stat(path.join(source, "package", "index.js")),
      fs.promises.stat(path.join(target, "package", "index.js")),
      fs.promises.lstat(path.join(target, "alias")),
    ]);
    expect(targetStat.ino).toBe(sourceStat.ino);
    expect(aliasStat.isSymbolicLink()).toBe(true);
    await expect(fs.promises.readlink(path.join(target, "alias"))).resolves.toBe("package");
    await expect(
      fs.promises.readFile(path.join(target, "package", "nested", "value.txt"), "utf8")
    ).resolves.toBe("value\n");
  });
});
