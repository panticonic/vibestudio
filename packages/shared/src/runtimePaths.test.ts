import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectInstalledRuntimeReadRoots,
  getExistingAppNodeModulesRoots,
  getInstalledNodeRuntime,
} from "./runtimePaths.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibestudio-runtime-roots-")));
  fixtures.push(root);
  return root;
}

function installRuntimeSelection(appRoot: string, version: string, digest: string) {
  const targetName = "linux-x64";
  const archive = `node-v${version}-linux-x64.tar.gz`;
  const directory = `${version}-${digest}`;
  const root = path.join(appRoot, "dist/node/releases", targetName, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ version, platform: "linux", arch: "x64" }));
  writeFileSync(
    path.join(root, "vibestudio-runtime.json"),
    JSON.stringify({ version: 1, nodeVersion: version, archive, archiveSha256: digest })
  );
  mkdirSync(path.join(appRoot, "dist/node/selected"), { recursive: true });
  writeFileSync(
    path.join(appRoot, "dist/node/selected", `${targetName}.json`),
    JSON.stringify({
      version: 1,
      platform: "linux",
      arch: "x64",
      nodeVersion: version,
      archive,
      archiveSha256: digest,
      directory,
    })
  );
  return root;
}

describe("installed Node runtime selection", () => {
  it("uses the selected immutable release and retains the first choice for the process lifetime", () => {
    const root = fixture();
    const appRoot = path.join(root, "app");
    const oldRuntime = installRuntimeSelection(appRoot, "22.23.2", "a".repeat(64));
    const first = getInstalledNodeRuntime(appRoot, "linux", "x64");
    expect(first.root).toBe(oldRuntime);
    expect(first.version).toBe("22.23.2");

    installRuntimeSelection(appRoot, "24.11.0", "b".repeat(64));
    expect(getInstalledNodeRuntime(appRoot, "linux", "x64")).toBe(first);
    expect(first.root).toBe(oldRuntime);
  });

  it("memoizes a physical installation across filesystem aliases", () => {
    const root = fixture();
    const appRoot = path.join(root, "app");
    const alias = path.join(root, "app-alias");
    const firstRuntime = installRuntimeSelection(appRoot, "22.23.2", "d".repeat(64));
    symlinkSync(appRoot, alias, "junction");

    const first = getInstalledNodeRuntime(appRoot, "linux", "x64");
    installRuntimeSelection(appRoot, "24.11.0", "e".repeat(64));
    expect(getInstalledNodeRuntime(alias, "linux", "x64")).toBe(first);
    expect(first.root).toBe(firstRuntime);
  });

  it("rejects selectors that escape the immutable target release directory", () => {
    const appRoot = path.join(fixture(), "app");
    mkdirSync(path.join(appRoot, "dist/node/selected"), { recursive: true });
    writeFileSync(
      path.join(appRoot, "dist/node/selected/linux-x64.json"),
      JSON.stringify({
        version: 1,
        platform: "linux",
        arch: "x64",
        nodeVersion: "24.11.0",
        archive: "node-v24.11.0-linux-x64.tar.gz",
        archiveSha256: "c".repeat(64),
        directory: "../legacy",
      })
    );
    expect(() => getInstalledNodeRuntime(appRoot, "linux", "x64")).toThrow(
      "Installed Node runtime selection does not match this host"
    );
  });
});

it("uses one physical dependency realm even when Electron exposes an ASAR alias", () => {
  const root = fixture();
  const appRoot = path.join(root, "app.asar");
  for (const directory of ["app.asar/node_modules", "app.asar.unpacked/node_modules"])
    mkdirSync(path.join(root, directory), { recursive: true });
  expect(getExistingAppNodeModulesRoots(appRoot)).toEqual([
    path.join(root, "app.asar.unpacked/node_modules"),
  ]);
});

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
