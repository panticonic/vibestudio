import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectInstalledRuntimeReadRoots } from "./runtimePaths.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-roots-")));
  fixtures.push(root);
  return root;
}

describe("installed runtime directory admission", () => {
  it.runIf(process.platform !== "win32")(
    "recognizes Darwin shared-cache images without admitting nonexistent filesystem roots",
    () => {
      const images = [
        "/System/Library/Frameworks/VibestudioFixture.framework/Versions/A/VibestudioFixture",
        "/usr/lib/libVibestudioFixture.dylib",
      ];
      expect(collectInstalledRuntimeReadRoots(images, "darwin")).toEqual([]);
      expect(() => collectInstalledRuntimeReadRoots(images, "linux")).toThrow(/ENOENT/);
      expect(() =>
        collectInstalledRuntimeReadRoots([path.join(fixture(), "missing.dylib")], "darwin")
      ).toThrow(/ENOENT/);
    }
  );
  it("retains intermediate loader aliases and physical directory roots", () => {
    const root = fixture();
    for (const directory of ["links", "opt", "store/runtime/bin", "store/runtime/lib"])
      mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, "store/runtime/bin/loader"), "installed loader");
    symlinkSync(path.join(root, "store/runtime"), path.join(root, "opt/runtime"), "junction");
    symlinkSync("../opt/runtime/bin/loader", path.join(root, "links/loader"), "file");
    const roots = collectInstalledRuntimeReadRoots([path.join(root, "links/loader")]);
    expect(roots).toEqual(
      [
        path.join(root, "links"),
        path.join(root, "opt/runtime/bin"),
        path.join(root, "store/runtime/bin"),
      ].sort()
    );
    expect(roots).not.toContain(root);
  });

  it("deduplicates libraries and executable directories without admitting their installation parent", () => {
    const root = fixture();
    mkdirSync(path.join(root, "bin"));
    mkdirSync(path.join(root, "lib"));
    const files = ["bin/runtime", "lib/a", "lib/b"].map((relative) => path.join(root, relative));
    for (const file of files) writeFileSync(file, "runtime");
    expect(collectInstalledRuntimeReadRoots([...files, files[0]!])).toEqual([
      path.join(root, "bin"),
      path.join(root, "lib"),
    ]);
  });

  it("rejects relative paths, directories, broken links and cycles", () => {
    const root = fixture();
    expect(() => collectInstalledRuntimeReadRoots(["relative"])).toThrow("absolute");
    expect(() => collectInstalledRuntimeReadRoots([root])).toThrow("not a file");
    symlinkSync("missing", path.join(root, "broken"), "file");
    expect(() => collectInstalledRuntimeReadRoots([path.join(root, "broken")])).toThrow();
    symlinkSync("b", path.join(root, "a"), "file");
    symlinkSync("a", path.join(root, "b"), "file");
    expect(() => collectInstalledRuntimeReadRoots([path.join(root, "a")])).toThrow("cycle");
    expect(() => collectInstalledRuntimeReadRoots([path.parse(root).root])).toThrow(
      "filesystem root"
    );
  });
});
