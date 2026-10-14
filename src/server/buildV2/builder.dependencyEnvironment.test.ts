import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { composePreparedDependencyPlugins as composePlugins } from "./preparedDependencyPlugins.js";
import {
  prepareDependencyResolution,
  preparedDependencyDirectoryIdentity,
} from "./preparedDependencyResolution.js";
import { collectExternalDependencyClosure } from "./externalDeps.js";
import { unownedPeerRefusal } from "./dependencyAudit.js";
import { PackageGraph, type GraphNode } from "./packageGraph.js";
import { createTsExtensionPlugin } from "./builder.js";

/** Exercise the preparation boundary as well as ordinary native compilation. */
function composePreparedDependencyPlugins(
  plugins: readonly esbuild.Plugin[],
  nodePaths: readonly string[],
  sourceRoots: readonly string[],
  externals: readonly string[] = []
): esbuild.Plugin[] {
  const names: string[] = [];
  for (const root of nodePaths) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@") && entry.isDirectory())
        names.push(
          ...fs.readdirSync(path.join(root, entry.name)).map((name) => `${entry.name}/${name}`)
        );
      else if (entry.isDirectory() || entry.isSymbolicLink()) names.push(entry.name);
    }
  }
  return composePlugins(
    plugins,
    nodePaths,
    sourceRoots,
    externals,
    prepareDependencyResolution(nodePaths, names)
  );
}

function writePackage(nodeModules: string, name: string, marker: string): void {
  const root = path.join(nodeModules, ...name.split("/"));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js" })
  );
  fs.writeFileSync(
    path.join(root, "index.js"),
    `export const marker = ${JSON.stringify(marker)};\n`
  );
}

describe("dependency-environment resolver", () => {
  it("reads admitted package manifests once per compilation and refreshes changed declarations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-resolver-manifests-"));
    const read = vi.spyOn(fs, "readFileSync");
    const exists = vi.spyOn(fs, "existsSync");
    try {
      const source = path.join(root, "source");
      const modules = path.join(root, "prepared", "node_modules");
      fs.mkdirSync(source, { recursive: true });
      writePackage(modules, "owner", "prepared");
      const owner = path.join(modules, "owner");
      const manifestPath = path.join(owner, "package.json");
      const manifest = {
        name: "owner",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
        optionalDependencies: { "missing-peer": "1.0.0" },
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const imports: string[] = [];
      for (let index = 0; index < 32; index++) {
        fs.writeFileSync(
          path.join(owner, `module-${index}.js`),
          `export const value${index} = () => import("missing-peer");`
        );
        imports.push(`export { value${index} } from "./module-${index}.js";`);
      }
      fs.writeFileSync(path.join(owner, "index.js"), imports.join("\n"));
      const entry = path.join(source, "entry.js");
      fs.writeFileSync(entry, 'export * from "owner";');
      const options: esbuild.BuildOptions = {
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        write: false,
        logLevel: "silent",
        nodePaths: [modules],
        plugins: composePreparedDependencyPlugins([], [modules], [source]),
      };
      await esbuild.build(options);
      expect(read.mock.calls.filter(([file]) => file === manifestPath)).toHaveLength(1);
      expect(
        exists.mock.calls.filter(([file]) => file === manifestPath).length
      ).toBeLessThanOrEqual(2);
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, optionalDependencies: {} }));
      await expect(
        esbuild.build({
          ...options,
          plugins: composePreparedDependencyPlugins([], [modules], [source]),
        })
      ).rejects.toThrow("missing-peer");
      expect(read.mock.calls.filter(([file]) => file === manifestPath)).toHaveLength(2);
    } finally {
      read.mockRestore();
      exists.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not perform filesystem identity checks while compiling source imports", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-resolver-identities-"));
    const realpath = vi.spyOn(fs.realpathSync, "native");
    try {
      const entry = path.join(root, "entry.js");
      const imports: string[] = [];
      for (let index = 0; index < 32; index++) {
        fs.writeFileSync(path.join(root, `module-${index}.js`), `export const value = ${index};`);
        imports.push(`export { value as value${index} } from "./module-${index}.js";`);
      }
      fs.writeFileSync(entry, imports.join("\n"));
      const options: esbuild.BuildOptions = {
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        write: false,
        logLevel: "silent",
        plugins: composePreparedDependencyPlugins([], [], [root]),
      };
      const first = await esbuild.build(options);
      expect(first.outputFiles![0]!.text).toContain("value31");
      const rootReads = () =>
        realpath.mock.calls.filter(([candidate]) => candidate === root).length;
      expect(rootReads()).toBe(0);
      await esbuild.build(options);
      expect(rootReads()).toBe(0);
    } finally {
      realpath.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("shares module identity between rewritten and default-resolved source imports", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-source-identity-"));
    try {
      const entry = path.join(root, "entry.ts");
      fs.writeFileSync(path.join(root, "context.tsx"), "export const context = {};\n");
      fs.writeFileSync(
        entry,
        'import { context as provider } from "./context.js";\n' +
          'import { context as consumer } from "./context";\n' +
          "export const sameContext = provider === consumer;\n"
      );
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        write: false,
        logLevel: "silent",
        plugins: composePreparedDependencyPlugins([createTsExtensionPlugin(root)], [], [root]),
      });
      const module = { exports: {} as { sameContext?: boolean } };
      new Function("module", "exports", result.outputFiles[0]!.text)(module, module.exports);
      expect(module.exports.sameContext).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses stable native identities in the exact build working directory and retains physical diagnostics", async () => {
    const build = async (prefix: string) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      const source = path.join(root, "source");
      const entry = path.join(source, "entry.js");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(entry, 'export const marker = "stable";\n');
      const result = await esbuild.build({
        absWorkingDir: source,
        entryPoints: [entry],
        bundle: true,
        format: "cjs",
        platform: "node",
        write: false,
        logLevel: "silent",
        plugins: composePreparedDependencyPlugins([], [], [source]),
      });
      return { root, source, entry, result };
    };

    const first = await build("vibestudio-prepared-source-first-");
    const second = await build("vibestudio-prepared-source-second-");
    try {
      expect(first.result.outputFiles[0]?.text).toBe(second.result.outputFiles[0]?.text);

      const broken = path.join(first.source, "broken.js");
      fs.writeFileSync(broken, "const broken = );\n");
      const failure = await esbuild
        .build({
          absWorkingDir: first.source,
          entryPoints: [broken],
          bundle: true,
          write: false,
          logLevel: "silent",
          plugins: composePreparedDependencyPlugins([], [], [first.source]),
        })
        .catch((error: unknown) => error as esbuild.BuildFailure);
      expect(path.resolve(first.source, failure.errors[0]?.location?.file ?? "")).toBe(broken);
    } finally {
      fs.rmSync(first.root, { recursive: true, force: true });
      fs.rmSync(second.root, { recursive: true, force: true });
    }
  });

  it("assigns duplicate package roots identities from their owner, not discovery order", async () => {
    const build = async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-duplicate-package-roots-"));
      const source = path.join(root, "source");
      const firstModules = path.join(root, "first", "node_modules");
      const secondModules = path.join(root, "second", "node_modules");
      const writeModule = (base: string, name: string, contents: string) => {
        const directory = path.join(base, ...name.split("/"));
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "package.json"),
          JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js" })
        );
        fs.writeFileSync(path.join(directory, "index.js"), contents);
      };
      fs.mkdirSync(source, { recursive: true });
      writeModule(firstModules, "left", 'export { marker } from "duplicate";\n');
      writeModule(
        path.join(firstModules, "left", "node_modules"),
        "duplicate",
        'export const marker = "first";\n'
      );
      writeModule(secondModules, "right", 'export { marker } from "duplicate";\n');
      writeModule(
        path.join(secondModules, "right", "node_modules"),
        "duplicate",
        'export const marker = "second";\n'
      );
      const entry = path.join(source, "entry.js");
      fs.writeFileSync(
        entry,
        'import { marker as left } from "left"; import { marker as right } from "right"; export { left, right };\n'
      );
      const result = await esbuild.build({
        absWorkingDir: root,
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        plugins: composePreparedDependencyPlugins([], [firstModules, secondModules], [source]),
      });
      return { root, output: result.outputFiles[0]?.text };
    };

    const first = await build();
    const second = await build();
    try {
      expect(first.output).toBe(second.output);
      expect(first.output).toContain('"first"');
      expect(first.output).toContain('"second"');
    } finally {
      fs.rmSync(first.root, { recursive: true, force: true });
      fs.rmSync(second.root, { recursive: true, force: true });
    }
  });

  it("preserves global plugin callbacks and resolves imports from owned virtual modules", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-virtual-runtime-module-"));
    try {
      const preparedRoot = path.join(root, "prepared");
      const modules = path.join(preparedRoot, "node_modules");
      const runtime = path.join(modules, "@workspace", "runtime");
      fs.mkdirSync(preparedRoot, { recursive: true });
      fs.writeFileSync(
        path.join(preparedRoot, "package.json"),
        JSON.stringify({ dependencies: { "@workspace/runtime": "workspace:*" } })
      );
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(
        path.join(runtime, "package.json"),
        JSON.stringify({
          name: "@workspace/runtime",
          type: "module",
          exports: "./index.js",
        })
      );
      fs.writeFileSync(
        path.join(runtime, "index.js"),
        'export const marker = "prepared runtime";\n'
      );
      const entry = path.join(preparedRoot, "entry.js");
      fs.writeFileSync(entry, 'export { marker } from "fs";\n');
      let loadInput: { namespace: string; path: string } | undefined;
      const virtualFsPlugin: esbuild.Plugin = {
        name: "virtual-fs-test",
        setup(build) {
          build.onResolve({ filter: /^fs$/ }, () => ({
            path: "fs",
            namespace: "workspace-fs-shim",
          }));
          build.onLoad({ filter: /.*/, namespace: "workspace-fs-shim" }, (args) => {
            loadInput = { namespace: args.namespace, path: args.path };
            return {
              contents: 'export { marker } from "@workspace/runtime";\n',
              loader: "js",
              resolveDir: preparedRoot,
            };
          });
        },
      };
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        plugins: composePreparedDependencyPlugins([virtualFsPlugin], [modules], [preparedRoot]),
      });
      expect(loadInput).toEqual({ namespace: "workspace-fs-shim", path: "fs" });
      expect(result.outputFiles[0]?.text).toContain("prepared runtime");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    "matches owned dependency roots through a filesystem alias (guarded=%s)",
    async (guarded) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-aliased-dependency-"));
      const alias = `${root}-alias`;
      try {
        fs.symlinkSync(root, alias, "junction");
        const modules = path.join(root, "node_modules");
        writePackage(modules, "owner", "owned");
        const owner = path.join(modules, "owner");
        fs.writeFileSync(
          path.join(owner, "package.json"),
          JSON.stringify({
            name: "owner",
            version: "1.0.0",
            type: "module",
            exports: "./index.js",
          })
        );
        fs.writeFileSync(
          path.join(owner, "index.js"),
          guarded
            ? 'export function run() { try { return require("missing-vibestudio-optional-helper"); } catch { return "optional helper absent"; } }'
            : 'export function run() { return require("missing-vibestudio-optional-helper"); }'
        );
        const entry = path.join(root, "entry.js");
        fs.writeFileSync(entry, 'export { run } from "owner";');
        const prepared = prepareDependencyResolution([path.join(alias, "node_modules")], ["owner"]);
        expect(preparedDependencyDirectoryIdentity(prepared, owner)).toBe(
          fs.realpathSync.native(owner)
        );
        expect(
          preparedDependencyDirectoryIdentity(prepared, path.join(alias, "node_modules", "owner"))
        ).toBe(fs.realpathSync.native(owner));
        const build = esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: "cjs",
          platform: "node",
          write: false,
          logLevel: "silent",
          plugins: composePlugins([], [path.join(alias, "node_modules")], [], [], prepared),
        });
        if (guarded) {
          const output = (await build).outputFiles[0]!.text;
          const module = { exports: {} as { run: () => string } };
          new Function("require", "module", output)(() => {
            throw new Error("module not found");
          }, module);
          expect(module.exports.run()).toBe("optional helper absent");
        } else {
          await expect(build).rejects.toThrow("Could not resolve");
        }
      } finally {
        fs.rmSync(alias, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("recognizes a package path composed from logical and physical alias prefixes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-composed-alias-"));
    try {
      const physicalPrefix = path.join(root, "physical-prefix");
      const logicalPrefix = path.join(root, "logical-prefix");
      const physicalTarget = path.join(physicalPrefix, "physical-target");
      const logicalTarget = path.join(logicalPrefix, "logical-target");
      fs.mkdirSync(physicalTarget, { recursive: true });
      fs.symlinkSync(physicalPrefix, logicalPrefix, "junction");
      fs.symlinkSync(physicalTarget, logicalTarget, "junction");
      const logicalModules = path.join(logicalTarget, "node_modules");
      writePackage(logicalModules, "owner", "owned");

      const prepared = prepareDependencyResolution([logicalModules], ["owner"]);
      const physicalOwner = path.join(physicalTarget, "node_modules", "owner");
      const composedOwner = path.join(logicalPrefix, "physical-target", "node_modules", "owner");
      expect(preparedDependencyDirectoryIdentity(prepared, composedOwner)).toBe(
        fs.realpathSync.native(physicalOwner)
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    "preserves guarded missing requires in owned dependencies (guarded=%s)",
    async (guarded) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-guarded-dependency-"));
      try {
        const modules = path.join(root, "node_modules");
        writePackage(modules, "owner", "owned");
        fs.writeFileSync(
          path.join(modules, "owner", "index.js"),
          guarded
            ? 'export function run() { try { return require("missing-vibestudio-optional-helper"); } catch { return "optional helper absent"; } }'
            : 'export function run() { return require("missing-vibestudio-optional-helper"); }'
        );
        const entry = path.join(root, "entry.js");
        fs.writeFileSync(entry, 'export { run } from "owner";');
        const build = esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: "cjs",
          platform: "node",
          write: false,
          logLevel: "silent",
          plugins: composePreparedDependencyPlugins([], [modules], []),
        });
        if (guarded) {
          const output = (await build).outputFiles[0]!.text;
          const module = { exports: {} as { run: () => string } };
          new Function("require", "module", output)(() => {
            throw new Error("module not found");
          }, module);
          expect(module.exports.run()).toBe("optional helper absent");
        } else await expect(build).rejects.toThrow("Could not resolve");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );
  it("preserves native prefix-only Node built-ins", async () => {
    const options: esbuild.BuildOptions = {
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      logLevel: "silent",
      plugins: composePreparedDependencyPlugins([], [], []),
    };
    const result = await esbuild.build({
      ...options,
      stdin: {
        contents: 'export { DatabaseSync } from "node:sqlite"; export { test } from "node:test";',
      },
    });
    const output = result.outputFiles?.[0]?.text;
    expect(output).toContain('"node:sqlite"');
    expect(output).toContain('"node:test"');
  });

  it("prefers an importer's owned dependency over the app-level copy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-nearest-prepared-dependency-"));
    try {
      const modules = path.join(root, "installed", "server", "node_modules");
      const workspace = path.join(root, "producer", "workspaces", "base", "source");
      const owner = path.join(workspace, "packages", "owner");
      const child = path.join(workspace, "packages", "child");
      fs.mkdirSync(owner, { recursive: true });
      fs.mkdirSync(child, { recursive: true });
      writePackage(modules, "child", "app-level");
      fs.mkdirSync(modules, { recursive: true });
      fs.writeFileSync(
        path.join(owner, "package.json"),
        JSON.stringify({
          name: "owner",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
          dependencies: { child: "workspace:*" },
        })
      );
      fs.writeFileSync(path.join(owner, "index.js"), 'export { marker } from "child";');
      fs.writeFileSync(
        path.join(child, "package.json"),
        JSON.stringify({ name: "child", version: "1.0.0", type: "module", exports: "./index.js" })
      );
      fs.writeFileSync(path.join(child, "index.js"), 'export const marker = "importer-local";');
      fs.mkdirSync(path.join(owner, "node_modules"), { recursive: true });
      fs.symlinkSync(child, path.join(owner, "node_modules", "child"), "junction");
      fs.symlinkSync(owner, path.join(modules, "owner"), "junction");
      const entry = path.join(root, "entry.js");
      fs.writeFileSync(entry, 'export { marker } from "owner";');
      const prepared = prepareDependencyResolution([modules], ["owner"]);
      const ownerIdentity = preparedDependencyDirectoryIdentity(prepared, owner)!;
      expect(prepared.dependencyResolveDirectories.get(ownerIdentity)?.get("child")).toBe(owner);

      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        nodePaths: [modules],
        plugins: composePlugins([], [modules], [workspace], [], prepared),
      });
      expect(result.outputFiles[0]?.text).toContain('var marker = "importer-local"');
      expect(result.outputFiles[0]?.text).not.toContain('var marker = "app-level"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts owned descendants whose names begin with two dots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dot-prefix-owned-"));
    try {
      const directory = path.join(root, "..assets");
      const entry = path.join(root, "entry.js");
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "value.js"), 'export const value = "owned";');
      fs.writeFileSync(entry, 'export { value } from "./..assets/value.js";');
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        logLevel: "silent",
        plugins: composePreparedDependencyPlugins([], [], [root]),
      });
      expect(result.outputFiles[0]?.text).toContain('var value = "owned"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("resolves absolute entry points and file imports without treating them as packages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-file-import-"));
    try {
      const entry = path.join(root, "entry.js");
      const dependency = path.join(root, "value.js");
      fs.writeFileSync(dependency, 'export default "local-file";\n');
      fs.writeFileSync(entry, `export { default } from ${JSON.stringify(dependency)};\n`);
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        write: false,
        plugins: composePreparedDependencyPlugins([], [], []),
      });
      expect(result.outputFiles[0]?.text).toContain('"local-file"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "adapts plugin-generated modules to ordinary loaders (aliased=%s)",
    async (aliased) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-plugin-loaders-"));
      const physicalSource = path.join(root, "source");
      const source = aliased ? path.join(root, "source-alias") : physicalSource;
      const entry = path.join(source, "entry.component");
      try {
        fs.mkdirSync(physicalSource, { recursive: true });
        if (aliased)
          fs.symlinkSync(physicalSource, source, process.platform === "win32" ? "junction" : "dir");
        fs.writeFileSync(entry, "plugin-owned entry");
        fs.writeFileSync(path.join(source, "helper.ts"), "export const helper: number = 7;");
        fs.writeFileSync(path.join(source, "theme.css"), ".component { color: red; }");
        fs.writeFileSync(path.join(source, "icon.svg"), "<svg>owned</svg>");
        let pluginEndInputs: string[] = [];
        const frameworkPlugin: esbuild.Plugin = {
          name: "framework-virtual-source",
          setup(build) {
            build.onEnd((result) => {
              pluginEndInputs = Object.keys(result.metafile?.inputs ?? {});
            });
            build.onResolve({ filter: /\.component$/ }, (args) => ({
              path: args.path,
              namespace: "component-source",
            }));
            build.onLoad({ filter: /.*/, namespace: "component-source" }, (args) => ({
              contents:
                'import { helper } from "./helper.ts"; import icon from "./icon.svg"; import "./theme.css"; export { helper, icon };',
              loader: "js",
              resolveDir: path.dirname(args.path),
            }));
          },
        };
        const result = await esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: "esm",
          platform: "browser",
          sourcemap: "linked",
          outdir: path.join(root, "out"),
          metafile: true,
          write: false,
          logLevel: "silent",
          loader: { ".svg": "text" },
          plugins: composePreparedDependencyPlugins([frameworkPlugin], [], [source]),
        });
        expect(result.outputFiles.map((file) => file.text).join("\n")).toContain("7");
        expect(result.outputFiles.map((file) => file.text).join("\n")).toContain(
          "<svg>owned</svg>"
        );
        expect(result.outputFiles.map((file) => file.text).join("\n")).toContain("color: red");
        const metafile = result.metafile;
        expect(metafile).toBeDefined();
        const inputPaths = Object.keys(metafile!.inputs);
        expect(inputPaths).toContain(`component-source:${entry}`);
        // Ordinary files have physical identities; plugin-owned virtual identities stay intact.
        const helperIdentity = path
          .relative(process.cwd(), fs.realpathSync(path.join(source, "helper.ts")))
          .replaceAll("\\", "/");
        expect(inputPaths).toContain(helperIdentity);
        expect(JSON.stringify(metafile)).not.toContain("vibestudio-prepared-");
        expect(pluginEndInputs).toContain(`component-source:${entry}`);
        expect(pluginEndInputs).toContain(helperIdentity);
        expect(pluginEndInputs).not.toContain(
          `vibestudio-prepared-plugin:component-source:${entry}`
        );
        const entryMetadata = Object.values(metafile!.outputs).find(
          (output) => output.entryPoint !== undefined
        );
        expect(entryMetadata?.entryPoint).toBe(`component-source:${entry}`);
        expect(Object.keys(entryMetadata?.inputs ?? {})).toContain(`component-source:${entry}`);
        const mapFile = result.outputFiles.find((file) => file.path.endsWith(".map"));
        expect(mapFile).toBeDefined();
        const inMemorySourceMap = JSON.parse(mapFile!.text) as { sourcesContent?: string[] };
        expect(inMemorySourceMap.sourcesContent).toContain("export const helper: number = 7;");

        const diskOutDir = path.join(root, "written-out");
        const written = await esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: "esm",
          platform: "browser",
          sourcemap: "linked",
          outdir: diskOutDir,
          metafile: true,
          logLevel: "silent",
          loader: { ".svg": "text" },
          plugins: composePreparedDependencyPlugins([frameworkPlugin], [], [source]),
        });
        const writtenMap = Object.keys(written.metafile!.outputs).find((outputPath) =>
          outputPath.endsWith(".map")
        );
        expect(writtenMap).toBeDefined();
        const writtenMapPath = path.isAbsolute(writtenMap!)
          ? writtenMap!
          : path.resolve(process.cwd(), writtenMap!);
        const writtenSourceMap = JSON.parse(fs.readFileSync(writtenMapPath, "utf8")) as {
          sourcesContent?: string[];
        };
        expect(writtenSourceMap.sourcesContent).toContain("export const helper: number = 7;");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("does not wrap a prepared namespace twice when a plugin returns build.resolve()", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-plugin-resolved-file-"));
    const source = path.join(root, "source");
    const entry = path.join(source, "entry.component");
    try {
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(entry, "plugin-owned entry");
      fs.writeFileSync(
        path.join(source, "target.js"),
        'import { value } from "./value.ts"; export { value };'
      );
      fs.writeFileSync(path.join(source, "value.ts"), "export const value: number = 42;");
      const frameworkPlugin: esbuild.Plugin = {
        name: "return-prepared-resolution",
        setup(build) {
          build.onResolve({ filter: /\.component$/ }, async () => {
            const resolved = await build.resolve("./target.js", {
              kind: "import-statement",
              resolveDir: source,
            });
            expect(resolved.errors).toHaveLength(0);
            return resolved;
          });
        },
      };
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        plugins: composePreparedDependencyPlugins([frameworkPlugin], [], [source]),
      });
      expect(result.outputFiles[0]?.text).toContain("42");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not re-enter plugins during the prepared authority's default resolution", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-plugin-default-resolution-"));
    const source = path.join(root, "source");
    const modules = path.join(root, "prepared", "node_modules");
    try {
      fs.mkdirSync(source, { recursive: true });
      writePackage(modules, "react", "prepared react");
      const entry = path.join(source, "entry.js");
      fs.writeFileSync(entry, 'import { marker } from "react"; export { marker };');
      let dedupeCalls = 0;
      const dedupePlugin: esbuild.Plugin = {
        name: "dedupe-shaped-plugin",
        setup(build) {
          build.onResolve({ filter: /^react$/ }, async (args) => {
            if (path.resolve(args.resolveDir).startsWith(path.resolve(modules))) return null;
            dedupeCalls += 1;
            if (dedupeCalls > 8) {
              throw new Error("plugin resolution re-entered before default resolution completed");
            }
            const resolved = await build.resolve(args.path, {
              kind: args.kind,
              resolveDir: modules,
            });
            if (resolved.errors.length > 0) return { errors: resolved.errors };
            return resolved;
          });
        },
      };

      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        nodePaths: [modules],
        plugins: composePreparedDependencyPlugins([dedupePlugin], [modules], [source]),
      });

      expect(dedupeCalls).toBe(1);
      expect(result.outputFiles[0]?.text).toContain("prepared react");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the real Svelte compiler in the prepared namespace composition", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-svelte-composition-"));
    try {
      const entry = path.join(root, "App.svelte");
      fs.writeFileSync(entry, "<h1>Prepared Svelte component</h1>");
      const { default: sveltePlugin } = await import("esbuild-svelte");
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        conditions: ["browser", "development"],
        nodePaths: [path.resolve("node_modules")],
        plugins: composePreparedDependencyPlugins(
          [sveltePlugin({ compilerOptions: { css: "injected" } })],
          [path.resolve("node_modules")],
          [root]
        ),
      });
      expect(result.outputFiles.map((file) => file.text).join("\n")).toContain(
        "Prepared Svelte component"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the prepared environment instead of node_modules above materialized source", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hermetic-build-"));
    try {
      const ambientModules = path.join(root, "node_modules");
      const ownedModules = path.join(root, "owned", "node_modules");
      const sourceDir = path.join(root, "workspace", "source");
      fs.mkdirSync(sourceDir, { recursive: true });
      writePackage(ambientModules, "example-dependency", "ambient");
      writePackage(ownedModules, "example-dependency", "owned");
      const entry = path.join(sourceDir, "entry.js");
      fs.writeFileSync(
        entry,
        'import { marker } from "example-dependency"; export default marker;\n'
      );

      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        write: false,
        plugins: composePreparedDependencyPlugins([], [ownedModules], []),
      });
      const output = result.outputFiles[0]?.text ?? "";
      expect(output).toContain('var marker = "owned"');
      expect(output).not.toContain("ambient");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves owned prepared source against the configured installed package root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-installed-projection-"));
    try {
      const appRoot = path.join(root, "installed", "server");
      const appNodeModules = path.join(appRoot, "node_modules");
      const dependency = path.join(appNodeModules, "@fixture", "runtime-api");
      const sourceRoot = path.join(root, "producer", "workspaces", "base", "source");
      fs.mkdirSync(path.join(dependency, "dist"), { recursive: true });
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(dependency, "package.json"),
        JSON.stringify({
          name: "@fixture/runtime-api",
          version: "1.0.0",
          type: "module",
          exports: { "./contract": "./dist/contract.js" },
        })
      );
      fs.writeFileSync(
        path.join(dependency, "dist/contract.js"),
        'export const marker = "installed-contract";\n'
      );
      fs.writeFileSync(
        path.join(sourceRoot, "package.json"),
        JSON.stringify({ dependencies: { "@fixture/runtime-api": "1.0.0" } })
      );
      const entry = path.join(sourceRoot, "entry.js");
      fs.writeFileSync(entry, "prepared source entry");
      const preparedSourcePlugin: esbuild.Plugin = {
        name: "installed-prepared-source",
        setup(build) {
          build.onResolve({ filter: /entry\.js$/ }, (args) => ({
            path: args.path,
            namespace: "installed-prepared-source",
          }));
          build.onLoad({ filter: /.*/, namespace: "installed-prepared-source" }, () => ({
            contents:
              'import { marker } from "@fixture/runtime-api/contract"; export default marker;\n',
            loader: "js",
            resolveDir: sourceRoot,
          }));
        },
      };

      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        nodePaths: [appNodeModules],
        // The composition owns this installation root. The prepared source
        // remains elsewhere, matching package-preflight production layout.
        plugins: composePreparedDependencyPlugins(
          [preparedSourcePlugin],
          [appNodeModules],
          [sourceRoot]
        ),
      });
      expect(result.outputFiles[0]?.text).toContain('var marker = "installed-contract"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves bare imports from the prepared installation before ancestor node_modules", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".cache", "vibestudio-installed-alias-"));
    try {
      const appRoot = path.join(root, "installed", "server");
      const appNodeModules = path.join(appRoot, "node_modules");
      const dependency = path.join(appNodeModules, "@vibestudio", "shared");
      const sourceRoot = path.join(root, "producer", "workspaces", "base", "source");
      fs.mkdirSync(path.join(dependency, "dist"), { recursive: true });
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(dependency, "package.json"),
        JSON.stringify({
          name: "@vibestudio/shared",
          version: "1.0.0",
          type: "module",
          exports: { "./typedRpcServiceClient": "./dist/typedRpcServiceClient.js" },
        })
      );
      fs.writeFileSync(
        path.join(dependency, "dist/typedRpcServiceClient.js"),
        'export const marker = "installed-contract";\n'
      );
      fs.writeFileSync(
        path.join(sourceRoot, "package.json"),
        JSON.stringify({ dependencies: { "@vibestudio/shared": "workspace:*" } })
      );
      const entry = path.join(sourceRoot, "entry.js");
      fs.writeFileSync(entry, "prepared source entry");
      const preparedSourcePlugin: esbuild.Plugin = {
        name: "installed-prepared-source",
        setup(build) {
          build.onResolve({ filter: /entry\.js$/ }, (args) => ({
            path: args.path,
            namespace: "installed-prepared-source",
          }));
          build.onLoad({ filter: /.*/, namespace: "installed-prepared-source" }, () => ({
            contents:
              'import { marker } from "@vibestudio/shared/typedRpcServiceClient"; export default marker;\n',
            loader: "js",
            resolveDir: sourceRoot,
          }));
        },
      };

      const result = await esbuild.build({
        entryPoints: [entry],
        absWorkingDir: root,
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        nodePaths: [appNodeModules],
        tsconfigRaw: { compilerOptions: {} },
        plugins: composePreparedDependencyPlugins(
          [preparedSourcePlugin],
          [appNodeModules],
          [sourceRoot]
        ),
      });
      expect(result.outputFiles[0]?.text).toContain('var marker = "installed-contract"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "keeps an absent optional peer unavailable even when ambient resolution finds it (ambient=%s)",
    async (ambientPresent) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-optional-peer-"));
      try {
        const preparedModules = path.join(
          root,
          "derived",
          "external-deps",
          "cache",
          "node_modules"
        );
        const owner = path.join(preparedModules, "optional-owner");
        const entry = path.join(owner, "build", "entry.js");
        fs.mkdirSync(path.dirname(entry), { recursive: true });
        fs.writeFileSync(
          path.join(owner, "package.json"),
          JSON.stringify({
            name: "optional-owner",
            version: "1.0.0",
            type: "module",
            peerDependencies: { "optional-peer": "^1.0.0" },
            peerDependenciesMeta: { "optional-peer": { optional: true } },
          })
        );
        fs.writeFileSync(entry, 'export const loadPeer = () => import("optional-peer");\n');
        if (ambientPresent)
          writePackage(path.join(root, "node_modules"), "optional-peer", "ambient");

        const result = await esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: "esm",
          platform: "node",
          write: false,
          logLevel: "silent",
          plugins: composePreparedDependencyPlugins([], [preparedModules], []),
        });
        const output = result.outputFiles.map(({ text }) => text).join("\n");
        expect(output).toContain('import("optional-peer")');
        expect(output).not.toContain('var marker = "ambient"');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("bundles an optional peer when the prepared graph owns it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-owned-optional-peer-"));
    try {
      const preparedModules = path.join(root, "derived", "external-deps", "cache", "node_modules");
      const owner = path.join(preparedModules, "optional-owner");
      const entry = path.join(owner, "build", "entry.js");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(
        path.join(owner, "package.json"),
        JSON.stringify({
          name: "optional-owner",
          version: "1.0.0",
          type: "module",
          peerDependencies: { "optional-peer": "^1.0.0" },
          peerDependenciesMeta: { "optional-peer": { optional: true } },
        })
      );
      fs.writeFileSync(entry, 'export const loadPeer = () => import("optional-peer");\n');
      writePackage(preparedModules, "optional-peer", "prepared");

      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "node",
        write: false,
        logLevel: "silent",
        plugins: composePreparedDependencyPlugins([], [preparedModules], []),
      });
      const output = result.outputFiles.map(({ text }) => text).join("\n");
      expect(output).toContain('marker = "prepared"');
      expect(output).not.toContain('import("optional-peer")');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not inherit an enclosing package's absent optional imports into a required child", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-nearest-optional-owner-"));
    try {
      const modules = path.join(root, "node_modules");
      writePackage(modules, "parent", "parent");
      const parent = path.join(modules, "parent");
      fs.writeFileSync(
        path.join(parent, "package.json"),
        JSON.stringify({
          name: "parent",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
          dependencies: { child: "1.0.0" },
          optionalDependencies: { "missing-peer": "1.0.0" },
        })
      );
      writePackage(path.join(parent, "node_modules"), "child", "child");
      const child = path.join(parent, "node_modules", "child");
      fs.writeFileSync(path.join(parent, "index.js"), 'export { marker } from "child";');
      fs.writeFileSync(
        path.join(child, "index.js"),
        'import "missing-peer"; export const marker = "child";'
      );
      const prepared = prepareDependencyResolution([modules], ["parent"]);
      const parentIdentity = preparedDependencyDirectoryIdentity(prepared, parent);
      const childIdentity = preparedDependencyDirectoryIdentity(prepared, child);
      expect(prepared.absentOptionalImports.get(parentIdentity!)?.has("missing-peer")).toBe(true);
      expect(prepared.absentOptionalImports.get(childIdentity!)?.size).toBe(0);
      await expect(
        esbuild.build({
          entryPoints: [path.join(parent, "index.js")],
          bundle: true,
          format: "esm",
          platform: "node",
          write: false,
          logLevel: "silent",
          plugins: composePlugins([], [modules], [], [], prepared),
        })
      ).rejects.toThrow('Could not resolve "missing-peer"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unowned required peer at the environment boundary even if the host has it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-required-peer-"));
    try {
      const preparedModules = path.join(root, "derived", "external-deps", "cache", "node_modules");
      const owner = path.join(preparedModules, "required-owner");
      const entry = path.join(owner, "build", "entry.js");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(
        path.join(owner, "package.json"),
        JSON.stringify({
          name: "required-owner",
          version: "1.0.0",
          type: "module",
          peerDependencies: { "required-peer": "^1.0.0" },
        })
      );
      fs.writeFileSync(entry, 'import "required-peer";\n');
      writePackage(path.join(root, "node_modules"), "required-peer", "ambient");

      const graph = new PackageGraph();
      const unit: GraphNode = {
        name: "required-owner",
        path: owner,
        relativePath: "required-owner",
        kind: "worker",
        dependencies: {},
        internalDeps: [],
        peerDependencies: { "required-peer": "^1.0.0" },
        optionalPeerDependencies: [],
        dependencyOverrides: {},
        manifest: {},
      };
      graph.addNode(unit);
      const closure = collectExternalDependencyClosure(unit, graph, root, [
        path.join(root, "node_modules"),
      ]);
      expect(unownedPeerRefusal(unit.name, closure)).toContain("required-peer@^1.0.0");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts package sources reached through an owned workspace symlink", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hermetic-build-"));
    try {
      const ownedModules = path.join(root, "owned", "node_modules");
      const packageSource = path.join(root, "packages", "linked-dependency");
      const sourceDir = path.join(root, "workspace", "source");
      fs.mkdirSync(ownedModules, { recursive: true });
      fs.mkdirSync(packageSource, { recursive: true });
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageSource, "package.json"),
        JSON.stringify({
          name: "linked-dependency",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
        })
      );
      fs.writeFileSync(path.join(packageSource, "value.js"), 'export const marker = "linked";\n');
      fs.writeFileSync(
        path.join(packageSource, "index.js"),
        'export { marker } from "./value.js";\n'
      );
      fs.symlinkSync(packageSource, path.join(ownedModules, "linked-dependency"), "junction");
      const entry = path.join(sourceDir, "entry.js");
      fs.writeFileSync(
        entry,
        'import { marker } from "linked-dependency"; export default marker;\n'
      );

      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        write: false,
        plugins: composePreparedDependencyPlugins([], [ownedModules], []),
      });
      expect(result.outputFiles[0]?.text ?? "").toContain('var marker = "linked"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
