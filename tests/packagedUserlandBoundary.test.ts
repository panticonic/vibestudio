import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPackage } from "@electron/asar";
import { describe, expect, it } from "vitest";
import { afterPack } from "../scripts/check-electron-package-boundary.mjs";
import {
  assertNoBundledUserlandPaths,
  assertNoBundledUserlandSource,
} from "../scripts/packaged-userland-boundary.mjs";

describe("packaged host/userland boundary", () => {
  it("accepts host artifacts and the exact external Base pointer", () => {
    expect(() =>
      assertNoBundledUserlandPaths(
        [
          "dist/server.mjs",
          "packages/workspace/dist/index.js",
          "build-resources/base-template-release.json",
        ],
        "test package"
      )
    ).not.toThrow();
  });

  it.each([
    "workspace/meta/vibestudio.yml",
    "panels/chat/package.json",
    "skills/system-testing/SKILL.md",
    "extensions/template-composer/package.json",
  ])("rejects bundled external-Base source at %s", (entry) => {
    expect(() => assertNoBundledUserlandPaths([entry], "test package")).toThrow(
      /bundled workspace\/Base source/u
    );
  });

  it("walks a staged tree instead of trusting packaging configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-package-boundary-"));
    try {
      fs.mkdirSync(path.join(root, "workspace", "meta"), { recursive: true });
      fs.writeFileSync(path.join(root, "workspace", "meta", "vibestudio.yml"), "systemEpoch: 59\n");
      expect(() => assertNoBundledUserlandSource(root, "staged package")).toThrow(
        /workspace\/meta\/vibestudio\.yml/u
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("inspects the actual Electron ASAR produced by the packaging hook", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-electron-boundary-"));
    const app = path.join(root, "app");
    const resources = path.join(root, "out", "resources");
    const unpackedModules = path.join(resources, "app.asar.unpacked", "node_modules");
    const nativeArtifact = {
      "darwin-arm64": ["@number0", "iroh-darwin-arm64", "iroh.darwin-arm64.node"],
      "linux-x64": ["@number0", "iroh-linux-x64-gnu", "iroh.linux-x64-gnu.node"],
      "linux-arm64": ["@number0", "iroh-linux-arm64-gnu", "iroh.linux-arm64-gnu.node"],
      "win32-x64": ["@number0", "iroh-win32-x64-msvc", "iroh.win32-x64-msvc.node"],
      "win32-arm64": ["@number0", "iroh-win32-arm64-msvc", "iroh.win32-arm64-msvc.node"],
    }[`${process.platform}-${process.arch}`];
    if (!nativeArtifact) throw new Error("test host is not a retained Electron target");
    try {
      fs.mkdirSync(path.join(app, "dist"), { recursive: true });
      fs.mkdirSync(resources, { recursive: true });
      const binding = path.join(unpackedModules, "@number0", "iroh", "index.js");
      const artifact = path.join(unpackedModules, ...nativeArtifact);
      fs.mkdirSync(path.dirname(binding), { recursive: true });
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(binding, "module.exports = {};\n");
      fs.writeFileSync(artifact, "native binding fixture\n");
      fs.writeFileSync(path.join(app, "dist", "main.cjs"), "module.exports = {};\n");
      await createPackage(app, path.join(resources, "app.asar"));
      const context = {
        appOutDir: path.join(root, "out"),
        arch: process.arch,
        electronPlatformName: process.platform,
      };
      await expect(afterPack(context)).resolves.toBeUndefined();

      fs.mkdirSync(path.join(app, "workspace", "meta"), { recursive: true });
      fs.writeFileSync(path.join(app, "workspace", "meta", "vibestudio.yml"), "systemEpoch: 59\n");
      await createPackage(app, path.join(resources, "app.asar"));
      await expect(afterPack(context)).rejects.toThrow(/workspace\/meta\/vibestudio\.yml/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
