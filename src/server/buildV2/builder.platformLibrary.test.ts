import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";

import { buildPlatformLibrary, closeBuilder, initBuilder } from "./builder.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("buildPlatformLibrary", () => {
  let root: string;
  let previousSharedDerivedCacheDir: string | undefined;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-platform-library-"));
    previousSharedDerivedCacheDir = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = path.join(root, "derived-cache");
    setUserDataPath(path.join(root, "state"));
    initBuilder(path.join(REPO_ROOT, "node_modules"), REPO_ROOT);
  });

  afterAll(async () => {
    await closeBuilder();
    if (previousSharedDerivedCacheDir === undefined) {
      delete process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    } else {
      process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = previousSharedDerivedCacheDir;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds package export subpaths without using the specifier as a cache path", async () => {
    const bundle = await buildPlatformLibrary("@vibestudio/shared/shellSurface", []);

    expect(bundle).toContain("validateShellSurfaceTarget");
  });
});
