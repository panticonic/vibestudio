import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPlatformLibrary, type BuilderSession } from "./builder.js";
import { createBuilderTestSession } from "./builderTestSession.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("buildPlatformLibrary", () => {
  let root: string;
  let previousSharedDerivedCacheDir: string | undefined;
  let session: BuilderSession;
  let closeSession: () => Promise<void>;

  async function openSession(appRoot: string, appNodeModules: readonly string[]): Promise<void> {
    await closeSession?.();
    const context = await createBuilderTestSession({
      appRoot,
      workspaceRoot: appRoot,
      stateRoot: path.join(root, "state"),
      appNodeModules,
      runNativeJob: runIsolatedBuildJob,
    });
    session = context.session;
    closeSession = context.close;
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-platform-library-"));
    previousSharedDerivedCacheDir = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = path.join(root, "derived-cache");
    await openSession(REPO_ROOT, [
      path.join(REPO_ROOT, "node_modules"),
      path.join(process.cwd(), "node_modules"),
    ]);
  });

  afterAll(async () => {
    await closeSession?.();
    if (previousSharedDerivedCacheDir === undefined) {
      delete process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    } else {
      process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = previousSharedDerivedCacheDir;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds package export subpaths without using the specifier as a cache path", async () => {
    const bundle = await buildPlatformLibrary(session, "@vibestudio/shared/shellSurface", []);

    await expect(session.store.primaryTextArtifactContent(bundle)).resolves.toContain(
      "validateShellSurfaceTarget"
    );
  });

  it("rebuilds an edited platform implementation without changing its package coordinates", async () => {
    await closeSession();
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
      await openSession(appRoot, [
        path.join(appRoot, "node_modules"),
        path.join(REPO_ROOT, "node_modules"),
      ]);
      return buildPlatformLibrary(session, "@vibestudio/probe", []);
    };
    const first = await build("first implementation");
    const second = await build("second implementation");
    expect(second.buildKey).not.toBe(first.buildKey);
    await expect(session.store.primaryTextArtifactContent(second)).resolves.toContain(
      "second implementation"
    );
    await expect(session.store.primaryTextArtifactContent(second)).resolves.not.toContain(
      "first implementation"
    );
  });
});
