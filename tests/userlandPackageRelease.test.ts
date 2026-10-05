import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { installUserlandPackageRelease } from "../scripts/lib/userland-package-release.js";
import { getInstalledNodeRuntime } from "../packages/shared/src/runtimePaths.js";

const appRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  fs.mkdirSync(path.join(appRoot, ".cache"), { recursive: true });
  const root = fs.mkdtempSync(path.join(appRoot, ".cache", "package-release-fixture-"));
  roots.push(root);
  const artifacts = ["a", "b"].map((name) => {
    const directory = path.join(root, name);
    fs.mkdirSync(path.join(directory, "package"), { recursive: true });
    const dependencies = name === "a" ? { "@vibestudio-test/release-b": "1.0.0" } : {};
    const manifest = {
      name: `@vibestudio-test/release-${name}`,
      version: "1.0.0",
      dependencies,
      scripts: { install: "node -e \"throw new Error('Lifecycle scripts must not execute')\"" },
    };
    fs.writeFileSync(path.join(directory, "package", "package.json"), JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(directory, "package", "index.js"),
      name === "a"
        ? "module.exports = require('@vibestudio-test/release-b');"
        : "module.exports = 'packed closure';"
    );
    const filename = `${name}.tgz`;
    execFileSync("tar", ["-czf", path.join(root, filename), "-C", directory, "package"]);
    const bytes = fs.readFileSync(path.join(root, filename));
    return {
      name: manifest.name,
      version: manifest.version,
      dependencies,
      filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
  });
  const releaseFile = path.join(root, "release.json");
  fs.writeFileSync(releaseFile, JSON.stringify({ artifacts }));
  return { root, artifacts, releaseFile };
}
describe("packed userland release validation", () => {
  it("installs the complete packed closure without running lifecycle scripts and retires its own install", () => {
    const f = fixture();
    const projection = installUserlandPackageRelease({
      appRoot,
      releaseFile: f.releaseFile,
      dependencies: { "@vibestudio-test/release-a": "1.0.0" },
      overrides: {},
    });
    try {
      const runtime = getInstalledNodeRuntime(appRoot);
      expect(
        execFileSync(
          runtime.executable,
          ["-e", "process.stdout.write(require('@vibestudio-test/release-a'))"],
          { cwd: path.dirname(projection.nodeModulesDir), encoding: "utf8" }
        )
      ).toBe("packed closure");
    } finally {
      projection.release();
    }
    expect(fs.existsSync(projection.nodeModulesDir)).toBe(false);
    expect(fs.existsSync(f.releaseFile)).toBe(true);
  });
  it("refuses changed archive bytes before invoking npm", () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.root, "a.tgz"), "changed");
    expect(() =>
      installUserlandPackageRelease({
        appRoot,
        releaseFile: f.releaseFile,
        dependencies: { "@vibestudio-test/release-a": "1.0.0" },
        overrides: {},
      })
    ).toThrow("integrity mismatch");
  });
  it("refuses a release version outside the declared dependency contract", () => {
    const f = fixture();
    expect(() =>
      installUserlandPackageRelease({
        appRoot,
        releaseFile: f.releaseFile,
        dependencies: { "@vibestudio-test/release-a": "2.0.0" },
        overrides: {},
      })
    ).toThrow("does not satisfy");
  });
});
