import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm, access, cp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitForNativeJob } from "./nativeWorkspaceJob.js";
import { startNativeWorkspaceRuntime } from "./nativeWorkspaceRuntime.js";
import { build } from "esbuild";

it("runs the production disk receiver under its platform execution contract", async () => {
  // An Electron-hosted invocation still launches the installed standalone Node
  // runtime used by the production disk receiver.
  if (process.env["ELECTRON_RUN_AS_NODE"] === "1")
    expect(process.versions["electron"]).toBeTruthy();
  const root = await mkdtemp(path.join(tmpdir(), "native-workspace-receiver-"));
  const statePath = path.join(root, "state");
  const sourceRoot = path.join(statePath, "source");
  const scratchRoot = path.join(statePath, "scratch", "contexts");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(root, "host-canary"), "host secret");
  await writeFile(path.join(sourceRoot, "source.txt"), "immutable source");
  const checkout = path.join(root, "local-template");
  await mkdir(checkout);
  await writeFile(path.join(checkout, "template.txt"), "local candidate");
  const pin = {
    url: "git+https://example.test/examples.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
  };
  vi.stubEnv("VIBESTUDIO_WORKSPACE_SOURCES", JSON.stringify([{ pin, checkout }]));
  const probe = path.join(sourceRoot, "template-probe.cjs");
  await writeFile(
    probe,
    `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const { execFileSync } = require('node:child_process');
    (async () => {
      assert.equal(process.env.VIBESTUDIO_WORKSPACE_SOURCES, undefined);
      if (process.platform !== 'win32') {
        await assert.rejects(fs.readFile(${JSON.stringify(checkout + "/template.txt")}, 'utf8'));
      }
      // Native test adapters spawn their engine as another Node child. It
      // inherits the workspace's OS boundary without a Node permission list.
      execFileSync(process.execPath, ['-e', ${JSON.stringify(`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        assert.equal(fs.readFileSync(${JSON.stringify(path.join(sourceRoot, "source.txt"))}, 'utf8'), 'immutable source');
        const canary = ${JSON.stringify(path.join(root, "host-canary"))};
        if (process.platform === 'win32') assert.equal(fs.readFileSync(canary, 'utf8'), 'host secret');
        else assert.throws(() => fs.readFileSync(canary));
      `)}], { env: {}, stdio: 'pipe' });
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  );
  let runtime: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>> | undefined;
  try {
    runtime = await startNativeWorkspaceRuntime({
      workspaceId: "fixture",
      statePath,
      sourceRoot,
      scratchRoot,
      buildsRoot: path.join(statePath, "builds"),
      appRoot: process.cwd(),
    });
    await waitForNativeJob(runtime.fork(probe, {}));
    const scope = {
      root: scratchRoot,
      panelId: "fixture",
      ownerCallerIds: ["fixture"],
      exposeHostPaths: false,
    };
    await runtime.disk.call(scope, "writeFile", ["note.txt", "private scratch"]);
    expect(await runtime.disk.call(scope, "readFile", ["note.txt", "utf8"])).toBe(
      "private scratch"
    );
    expect(
      await runtime.disk.call({ ...scope, root: sourceRoot }, "readFile", ["source.txt", "utf8"])
    ).toBe("immutable source");
    const delegatedScope = {
      ...scope,
      panelId: "extension:fixture:chain:agent",
      ownerCallerIds: ["fixture-extension", "fixture-agent"],
    };
    const opened = (await runtime.disk.call(delegatedScope, "open", ["note.txt", "r"])) as {
      handleId: number;
    };
    await runtime.disk.closeCaller("fixture-agent");
    await expect(
      runtime.disk.call(delegatedScope, "handleStat", [opened.handleId])
    ).rejects.toThrow(/Invalid file handle/);
    if (process.platform === "win32") {
      // This platform deliberately runs workspace code as the normal host user.
      await runtime.disk.call({ ...scope, root: sourceRoot }, "writeFile", [
        "source.txt",
        "modified",
      ]);
      expect(await runtime.disk.call({ ...scope, root }, "readFile", ["host-canary", "utf8"])).toBe(
        "host secret"
      );
      await runtime.disk.call({ ...scope, root }, "writeFile", ["host-canary", "host write"]);
      expect(await readFile(path.join(root, "host-canary"), "utf8")).toBe("host write");
    } else {
      await expect(
        runtime.disk.call({ ...scope, root: sourceRoot }, "writeFile", ["source.txt", "modified"])
      ).rejects.toThrow();
      // Even a forged scope cannot make the worker perform a host disk read.
      await expect(
        runtime.disk.call({ ...scope, root }, "readFile", ["host-canary", "utf8"])
      ).rejects.toThrow();
    }
  } finally {
    vi.unstubAllEnvs();
    const stopped = await runtime?.stop();
    if (stopped) expect(stopped.launcherExited).toBe(true);
    await runtime?.retireStorage();
    await rm(root, { recursive: true, force: true });
  }
});

it("runs bundled typechecking with admitted workspace-package dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-workspace-typecheck-"));
  const statePath = path.join(root, "state");
  const sourceRoot = path.join(statePath, "source");
  await mkdir(sourceRoot, { recursive: true });
  const source = `import { answer } from "@vibestudio/fixture-sdk";
import type { Sha256 } from "@vibestudio/shared/execution/contracts";
import type { UnitRegistryEntryBase } from "@vibestudio/unit-host/types";
const result: number = answer;
const digest = "a".repeat(64) as Sha256;
declare const entry: UnitRegistryEntryBase;
void result;
void digest;
void entry;
process.env.NODE_ENV;
`;
  await writeFile(path.join(sourceRoot, "index.ts"), source);
  const dependencies = path.join(root, "acquired-dependencies");
  const dependency = path.join(dependencies, "typed-dependency");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    path.join(dependency, "package.json"),
    JSON.stringify({
      name: "typed-dependency",
      version: "1.0.0",
      types: "index.d.ts",
      exports: { ".": { types: "./index.d.ts", default: "./index.d.ts" } },
    })
  );
  await writeFile(path.join(dependency, "index.d.ts"), "export declare const answer: number;\n");
  const sdk = path.join(root, "installed-sdk");
  await mkdir(path.join(sdk, "types"), { recursive: true });
  await writeFile(
    path.join(sdk, "package.json"),
    JSON.stringify({
      name: "@vibestudio/fixture-sdk",
      exports: { ".": { types: "./types/index.ts", default: "./types/index.ts" } },
    })
  );
  const sdkSource = [
    'import { answer } from "typed-dependency";',
    "export { answer };",
    "export const ownerAnswer: string = answer;",
    "",
  ].join("\n");
  await writeFile(path.join(sdk, "types", "index.ts"), sdkSource);
  const sdkNodeModules = path.join(root, "fixture-sdk-node_modules");
  const sdkTypedDependency = path.join(sdkNodeModules, "typed-dependency");
  await mkdir(sdkTypedDependency, { recursive: true });
  await writeFile(
    path.join(sdkTypedDependency, "package.json"),
    JSON.stringify({
      name: "typed-dependency",
      version: "2.0.0",
      types: "index.d.ts",
      exports: { ".": { types: "./index.d.ts", default: "./index.d.ts" } },
    })
  );
  await writeFile(
    path.join(sdkTypedDependency, "index.d.ts"),
    "export declare const answer: string;\n"
  );
  await writeFile(path.join(sdk, ".npmrc"), "host-only package-manager input");
  const unrelatedOwner = path.join(root, "unrelated-node-owner");
  const unrelatedOwnerNodeModules = path.join(root, "unrelated-node-owner-node_modules");
  let runtime: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>> | undefined;
  let admitted: string | undefined;
  try {
    await mkdir(unrelatedOwner, { recursive: true });
    await writeFile(
      path.join(unrelatedOwner, "package.json"),
      JSON.stringify({ name: "@vibestudio/unrelated-node-owner", types: "index.d.ts" })
    );
    await writeFile(path.join(unrelatedOwner, "index.d.ts"), "export interface Marker {}\n");
    await mkdir(path.join(unrelatedOwnerNodeModules, "@types"), { recursive: true });
    await cp(
      path.resolve("node_modules/@types/node"),
      path.join(unrelatedOwnerNodeModules, "@types/node"),
      { recursive: true }
    );
    const bundled = await build({
      stdin: {
        contents: 'export { TypeCheckService } from "@vibestudio/typecheck";',
        resolveDir: process.cwd(),
        sourcefile: "typecheck-job.ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      banner: {
        js: 'import { createRequire as __vibestudioCreateRequire } from "node:module"; import { fileURLToPath as __vibestudioFileURLToPath } from "node:url"; import { dirname as __vibestudioDirname } from "node:path"; const require = __vibestudioCreateRequire(import.meta.url); const __filename = __vibestudioFileURLToPath(import.meta.url); const __dirname = __vibestudioDirname(__filename);',
      },
    });
    runtime = await startNativeWorkspaceRuntime({
      workspaceId: "typecheck-fixture",
      statePath,
      sourceRoot,
      scratchRoot: path.join(statePath, "scratch", "contexts"),
      buildsRoot: path.join(statePath, "builds"),
      appRoot: process.cwd(),
    });
    const concurrentAdmissions = await Promise.all([
      runtime.admitDependencies({
        key: "fixture-dependencies",
        nodeModulesDir: dependencies,
        workspacePackages: {
          "@vibestudio/fixture-sdk": sdk,
          "@vibestudio/shared": path.resolve("packages/shared"),
          "@vibestudio/unit-host": path.resolve("packages/unit-host"),
          "@vibestudio/unrelated-node-owner": unrelatedOwner,
        },
        workspacePackageNodeModules: {
          "@vibestudio/fixture-sdk": sdkNodeModules,
          "@vibestudio/unrelated-node-owner": unrelatedOwnerNodeModules,
        },
      }),
      runtime.admitDependencies({
        key: "fixture-dependencies",
        nodeModulesDir: dependencies,
        workspacePackages: {
          "@vibestudio/fixture-sdk": sdk,
          "@vibestudio/shared": path.resolve("packages/shared"),
          "@vibestudio/unit-host": path.resolve("packages/unit-host"),
          "@vibestudio/unrelated-node-owner": unrelatedOwner,
        },
        workspacePackageNodeModules: {
          "@vibestudio/fixture-sdk": sdkNodeModules,
          "@vibestudio/unrelated-node-owner": unrelatedOwnerNodeModules,
        },
      }),
    ]);
    expect(concurrentAdmissions[0]).toBe(concurrentAdmissions[1]);
    const resources = concurrentAdmissions[0]!;
    admitted = resources.nodeModulesPaths[0]!;
    const sdkResource = resources.workspacePackages["@vibestudio/fixture-sdk"]!;
    await expect(access(path.join(sdkResource, ".npmrc"))).rejects.toThrow();
    await writeFile(path.join(sdk, "types", "index.ts"), "export const answer: number = 42;\n");
    expect(await readFile(path.join(sdkResource, "types", "index.ts"), "utf8")).toBe(sdkSource);
    await runtime.runJob({
      dependencies: "",
      bundle: bundled.outputFiles[0]!.text,
      script: `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import { TypeCheckService } from './bundle.js';
        assert.equal(process.env.VIBESTUDIO_APP_ROOT, undefined);
        if (process.platform !== 'win32') {
          assert.throws(() => fs.readFileSync(${JSON.stringify(path.join(dependency, "index.d.ts"))}));
          assert.throws(() => fs.writeFileSync(${JSON.stringify(path.join(admitted, "typed-dependency", "index.d.ts"))}, 'mutated'));
        }
        const fileIdentity = file => path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
        const service = new TypeCheckService({panelPath: ${JSON.stringify(sourceRoot)}, nodeModulesPaths: [${JSON.stringify(admitted)}], workspaceContext: {
          monorepoRoot: ${JSON.stringify(sourceRoot)}, packages: new Map(Object.entries(${JSON.stringify(resources.workspacePackages)}).map(([name, dir]) => [name, {
            name, dir, packageJson: JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8')),
          }]))
        }, disableTsconfigDiscovery: true});
        try {
          service.updateFile('index.ts', ${JSON.stringify(source)});
          const result = service.check();
          const expectedRootFile = path.join(fs.realpathSync(${JSON.stringify(path.join(statePath, "scratch", "home"))}), "index.ts");
          const rootFileCandidates = result.diagnostics
            .filter(diagnostic => diagnostic.code === 2322)
            .map(diagnostic => ({
              file: diagnostic.file,
              identity: diagnostic.file ? fileIdentity(diagnostic.file) : undefined,
            }));
          const rootAssignment = result.diagnostics.find(diagnostic =>
            diagnostic.code === 2322 && diagnostic.file && fileIdentity(diagnostic.file) === expectedRootFile
          );
          assert(rootAssignment, JSON.stringify({ expectedRootFile, rootFileCandidates, diagnostics: result.diagnostics.map(({ code, message, file }) => ({ code, message, file })) }));
          assert(!result.diagnostics.some(diagnostic =>
            diagnostic.code === 2322 && diagnostic.file && fileIdentity(diagnostic.file) === fileIdentity(${JSON.stringify(path.join(sdkResource, "types", "index.ts"))})
          ), JSON.stringify(result.diagnostics.map(({ code, message, file }) => ({ code, message, file }))));
          const missingProcess = result.diagnostics.find(diagnostic =>
            /Cannot find name 'process'/.test(diagnostic.message)
          );
          assert(missingProcess, JSON.stringify(result.diagnostics.map(({ code, message, file }) => ({ code, message, file }))));
          assert.equal(
            result.diagnostics.length,
            2,
            JSON.stringify(result.diagnostics.map(({ code, message, file }) => ({ code, message, file })))
          );
          assert.equal(result.diagnostics.filter(diagnostic => diagnostic.code === 2307).length, 0);
          assert(!result.diagnostics.some(diagnostic => diagnostic.message.includes('global type')));
        } finally { service.dispose(); }
      `,
    });
  } finally {
    const stopped = await runtime?.stop();
    if (stopped) expect(stopped.launcherExited).toBe(true);
    if (admitted) await expect(access(admitted)).rejects.toThrow();
    await runtime?.retireStorage();
    await rm(root, { recursive: true, force: true });
  }
});

it("materializes independent dependency realms for workspace package owners", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-workspace-owner-deps-"));
  const statePath = path.join(root, "state");
  const sourceRoot = path.join(statePath, "source");
  const engine = path.join(root, "packages", "typecheck");
  const transform = path.join(root, "packages", "svelte-type-source");
  const engineDependencies = path.join(root, "owners", "typecheck", "node_modules");
  const transformDependencies = path.join(root, "owners", "svelte-type-source", "node_modules");
  let runtime: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>> | undefined;
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(engine, { recursive: true });
    await writeFile(
      path.join(engine, "package.json"),
      JSON.stringify({
        name: "@vibestudio/typecheck",
        version: "0.1.0",
        type: "module",
        exports: { ".": "./index.js" },
      })
    );
    await writeFile(
      path.join(engine, "index.js"),
      "import { Project } from 'typescript/unstable/sync'; export const hasProject = typeof Project === 'function';\n"
    );
    await mkdir(transform, { recursive: true });
    await writeFile(
      path.join(transform, "package.json"),
      JSON.stringify({
        name: "@vibestudio/svelte-type-source",
        version: "0.1.0",
        main: "./index.cjs",
        exports: { ".": "./index.cjs" },
      })
    );
    await writeFile(
      path.join(transform, "index.cjs"),
      "const ts = require('typescript'); module.exports = { version: ts.version, hasCreateSourceFile: typeof ts.createSourceFile === 'function' };\n"
    );
    await mkdir(engineDependencies, { recursive: true });
    await mkdir(transformDependencies, { recursive: true });
    const typecheckTypescript = await realpath(path.resolve("node_modules/typescript"));
    const transformTypescript = await realpath(
      path.resolve("packages/svelte-type-source/node_modules/typescript")
    );
    const canonicalTypeScriptManifest = JSON.parse(
      await readFile(path.join(typecheckTypescript, "package.json"), "utf8")
    ) as { imports?: unknown };
    await cp(typecheckTypescript, path.join(engineDependencies, "typescript"), {
      recursive: true,
    });
    await cp(transformTypescript, path.join(transformDependencies, "typescript"), {
      recursive: true,
    });
    runtime = await startNativeWorkspaceRuntime({
      workspaceId: "owner-dependency-fixture",
      statePath,
      sourceRoot,
      scratchRoot: path.join(statePath, "scratch", "contexts"),
      buildsRoot: path.join(statePath, "builds"),
      appRoot: process.cwd(),
    });
    const resources = await runtime.admitDependencies({
      key: "workspace-package-owner-realms",
      nodeModulesDir: "",
      workspacePackages: {
        "@vibestudio/typecheck": engine,
        "@vibestudio/svelte-type-source": transform,
      },
      workspacePackageNodeModules: {
        "@vibestudio/typecheck": engineDependencies,
        "@vibestudio/svelte-type-source": transformDependencies,
      },
    });
    const admittedTypeScriptManifest = JSON.parse(
      await readFile(
        path.join(
          resources.workspacePackages["@vibestudio/typecheck"]!,
          "node_modules",
          "typescript",
          "package.json"
        ),
        "utf8"
      )
    ) as { imports?: unknown };
    expect(canonicalTypeScriptManifest.imports).toBeDefined();
    expect(admittedTypeScriptManifest.imports).toEqual(canonicalTypeScriptManifest.imports);
    await runtime.runJob({
      dependencies: "",
      bundle: "",
      script: `
        import { createRequire } from 'node:module';
        import { pathToFileURL } from 'node:url';
        import path from 'node:path';
        const require = createRequire(import.meta.url);
        const assert = require('node:assert/strict');
        const enginePath = ${JSON.stringify(path.join(resources.workspacePackages["@vibestudio/typecheck"]!, "index.js"))};
        const enginePackageRoot = ${JSON.stringify(path.join(resources.workspacePackages["@vibestudio/typecheck"]!, "node_modules", "typescript"))};
        const expectedTypeScriptImports = ${JSON.stringify(canonicalTypeScriptManifest.imports)};
        const engineTypeScriptManifest = JSON.parse(require('node:fs').readFileSync(path.join(enginePackageRoot, 'package.json'), 'utf8'));
        assert.deepEqual(engineTypeScriptManifest.imports, expectedTypeScriptImports, JSON.stringify({ enginePath, enginePackageRoot, expectedTypeScriptImports, actualImports: engineTypeScriptManifest.imports }));
        let engine;
        try {
          engine = await import(pathToFileURL(enginePath));
        } catch (error) {
          const resolvedTypeScriptEntry = require.resolve('typescript', { paths: [${JSON.stringify(resources.workspacePackages["@vibestudio/typecheck"]!)}] });
          throw new Error(JSON.stringify({ enginePath, enginePackageRoot, resolvedTypeScriptEntry, expectedTypeScriptImports, actualImports: engineTypeScriptManifest.imports, cause: String(error) }), { cause: error });
        }
        const transform = require(${JSON.stringify(resources.workspacePackages["@vibestudio/svelte-type-source"]!)});
        assert.equal(engine.hasProject, true);
        assert.equal(transform.version, '6.0.3');
        assert.equal(transform.hasCreateSourceFile, true);
        assert.notEqual(require.resolve('typescript', { paths: [${JSON.stringify(resources.workspacePackages["@vibestudio/typecheck"]!)}] }), require.resolve('typescript', { paths: [${JSON.stringify(resources.workspacePackages["@vibestudio/svelte-type-source"]!)}] }));
      `,
    });
  } finally {
    if (!runtime) {
      await rm(root, { recursive: true, force: true });
    } else {
      const stopped = await runtime.stop();
      if (stopped.launcherExited) {
        await runtime.retireStorage();
        await rm(root, { recursive: true, force: true });
      }
      expect(stopped.launcherExited).toBe(true);
    }
  }
});
