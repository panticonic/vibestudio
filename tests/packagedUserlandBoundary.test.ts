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
    try {
      fs.mkdirSync(path.join(app, "dist"), { recursive: true });
      fs.mkdirSync(resources, { recursive: true });
      fs.writeFileSync(path.join(app, "dist", "main.cjs"), "module.exports = {};\n");
      await createPackage(app, path.join(resources, "app.asar"));
      await expect(afterPack({ appOutDir: path.join(root, "out") })).resolves.toBeUndefined();

      fs.mkdirSync(path.join(app, "workspace", "meta"), { recursive: true });
      fs.writeFileSync(path.join(app, "workspace", "meta", "vibestudio.yml"), "systemEpoch: 59\n");
      await createPackage(app, path.join(resources, "app.asar"));
      await expect(afterPack({ appOutDir: path.join(root, "out") })).rejects.toThrow(
        /workspace\/meta\/vibestudio\.yml/u
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
