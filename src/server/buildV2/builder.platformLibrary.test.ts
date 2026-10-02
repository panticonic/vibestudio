import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";

import { primaryTextArtifactContent } from "./buildStore.js";
import { buildPlatformLibrary, closeBuilder, initBuilder } from "./builder.js";
import { setBuildRootConfig } from "./effectiveVersion.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("buildPlatformLibrary", () => {
  let root: string;
  let previousSharedDerivedCacheDir: string | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-platform-library-"));
    previousSharedDerivedCacheDir = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = path.join(root, "derived-cache");
    setUserDataPath(path.join(root, "state"));
    initBuilder(path.join(REPO_ROOT, "node_modules"), REPO_ROOT, runIsolatedBuildJob);
    await setBuildRootConfig({ appRoot: REPO_ROOT });
  });

  afterAll(async () => {
    await closeBuilder();
    await setBuildRootConfig(null);
    if (previousSharedDerivedCacheDir === undefined) {
      delete process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    } else {
      process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = previousSharedDerivedCacheDir;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds package export subpaths without using the specifier as a cache path", async () => {
    const bundle = await buildPlatformLibrary("@vibestudio/shared/shellSurface", []);

    expect(primaryTextArtifactContent(bundle)).toContain("validateShellSurfaceTarget");
  });

  it("rebuilds an edited platform implementation without changing its package coordinates", async () => {
    const appRoot = path.join(root, "host");
    const packageRoot = path.join(appRoot, "packages/probe");
    const installedRoot = path.join(appRoot, "node_modules/@vibestudio");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.mkdirSync(installedRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, "package.json"), '{"name":"host","private":true}');
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      '{"name":"@vibestudio/probe","version":"1.0.0","main":"index.js"}'
    );
    fs.symlinkSync(packageRoot, path.join(installedRoot, "probe"), "junction");
    const source = path.join(packageRoot, "index.js");
    const build = async (value: string) => {
      fs.writeFileSync(source, `module.exports = ${JSON.stringify(value)};`);
      await setBuildRootConfig({ appRoot });
      initBuilder(path.join(appRoot, "node_modules"), appRoot, runIsolatedBuildJob);
      return buildPlatformLibrary("@vibestudio/probe", []);
    };
    const first = await build("first implementation");
    const second = await build("second implementation");
    expect(second.buildKey).not.toBe(first.buildKey);
    expect(primaryTextArtifactContent(second)).toContain("second implementation");
    expect(primaryTextArtifactContent(second)).not.toContain("first implementation");
  });
});
