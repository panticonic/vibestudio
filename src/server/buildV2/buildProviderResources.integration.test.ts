import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareBuildProviderResources } from "./buildProviderResources.js";
import { materializeImmutableTree } from "./immutableTreeMaterializer.js";
import { startNativeWorkspaceRuntime } from "../nativeWorkspaceRuntime.js";
import { waitForNativeJob } from "../nativeWorkspaceJob.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("admits a complete native provider input without granting host sources or caches", async () => {
  root = await mkdtemp(path.join(tmpdir(), "provider-resources-"));
  const statePath = path.join(root, "workspace", "state");
  const sourceRoot = path.join(statePath, "build-sources", "immutable-state");
  const app = path.join(sourceRoot, "apps", "mobile");
  const shared = path.join(sourceRoot, "packages", "shared");
  const platform = path.join(root, "host-projection", "platform-module");
  const dependencies = path.join(root, "shared-npm-cache", "node_modules");
  const context = path.join(statePath, "contexts");
  const sibling = path.join(root, "sibling-workspace", "secret.txt");
  for (const dir of [app, shared, platform, dependencies, context, path.dirname(sibling)])
    await mkdir(dir, { recursive: true });
  await writeFile(path.join(app, "native-module-policy.json"), '{"blockedImports":{}}');
  await writeFile(path.join(shared, "index.js"), "module.exports = 7;");
  await writeFile(path.join(platform, "index.js"), "module.exports = 8;");
  await writeFile(path.join(dependencies, "package.js"), "module.exports = 9;");
  await writeFile(sibling, "secret");
  const buildsRoot = path.join(statePath, "builds");
  const resources = await prepareBuildProviderResources({
    buildsRoot,
    sourceRoot,
    materialize: materializeImmutableTree,
    input: {
      target: "react-native",
      unitName: "@workspace-apps/mobile",
      sourcePath: app,
      effectiveVersion: "a".repeat(64),
      manifest: {},
      dependencyProjection: {
        nodeModulesPath: dependencies,
        modules: {
          "@workspace-apps/mobile": app,
          "@workspace/shared": shared,
          "@platform/module": platform,
        },
      },
    },
  });
  let runtime: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>> | undefined;
  try {
    const input = resources.input;
    // All provider-visible paths fit the existing read-only builds resource.
    for (const file of [
      input.sourcePath,
      input.dependencyProjection.nodeModulesPath!,
      ...Object.values(input.dependencyProjection.modules),
    ]) {
      expect(file.startsWith(buildsRoot + path.sep)).toBe(true);
    }
    const probe = path.join(context, "probe.cjs");
    await writeFile(
      probe,
      `
      const assert = require('node:assert/strict');
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const input = ${JSON.stringify(input)};
      (async () => {
        const policy = path.join(input.sourcePath, 'native-module-policy.json');
        assert.deepEqual(JSON.parse(await fs.readFile(policy, 'utf8')), {blockedImports:{}});
        assert.equal(require(path.join(input.sourcePath, '../../packages/shared/index.js')), 7);
        assert.equal(require(path.join(input.dependencyProjection.modules['@platform/module'], 'index.js')), 8);
        assert.equal(require(path.join(input.dependencyProjection.nodeModulesPath, 'package.js')), 9);
        if (process.platform !== 'win32') {
          await assert.rejects(fs.writeFile(policy, 'tampered'));
          for (const file of ${JSON.stringify([path.join(app, "native-module-policy.json"), path.join(dependencies, "package.js"), sibling])}) {
            await assert.rejects(fs.readFile(file));
          }
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `
    );
    runtime = await startNativeWorkspaceRuntime({
      workspaceId: "provider-test",
      statePath,
      sourceRoot: context,
      scratchRoot: path.join(statePath, "scratch", "contexts"),
      buildsRoot,
      appRoot: process.cwd(),
    });
    await waitForNativeJob(runtime.fork(probe, {}));
  } finally {
    if (runtime) expect((await runtime.stop()).launcherExited).toBe(true);
    await resources.dispose();
  }
  expect(await readdir(path.join(buildsRoot, ".provider-inputs"))).toEqual([]);
});

it("cleans incomplete input publication on materialization failure", async () => {
  root = await mkdtemp(path.join(tmpdir(), "provider-resources-failure-"));
  const buildsRoot = path.join(root, "builds");
  await expect(
    prepareBuildProviderResources({
      buildsRoot,
      sourceRoot: root,
      input: {
        target: "react-native",
        unitName: "app",
        sourcePath: path.join(root, "missing"),
        effectiveVersion: "a",
        manifest: {},
        dependencyProjection: { nodeModulesPath: null, modules: {} },
      },
      materialize: materializeImmutableTree,
    })
  ).rejects.toThrow();
  expect(await readdir(path.join(buildsRoot, ".provider-inputs"))).toEqual([]);
});
