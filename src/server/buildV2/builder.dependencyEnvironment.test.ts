import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import { composePreparedDependencyPlugins } from "./preparedDependencyPlugins.js";

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
        const build = esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: "cjs",
          platform: "node",
          write: false,
          logLevel: "silent",
          plugins: composePreparedDependencyPlugins([], [path.join(alias, "node_modules")], []),
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
  it("preserves prefix-only Node built-ins without admitting unknown Node modules", async () => {
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
    await expect(
      esbuild.build({
        ...options,
        stdin: { contents: 'import "node:unknown-vibestudio-module";' },
      })
    ).rejects.toThrow("not present in the prepared build environment");
  });
  it.each([true, false])(
    "owns only declared transitive workspace source links (declared=%s)",
    async (declared) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-workspace-dependency-"));
      try {
        const modules = path.join(root, "prepared", "node_modules");
        const source = path.join(root, "packages", "owner");
        const child = path.join(root, "packages", "child");
        fs.mkdirSync(modules, { recursive: true });
        fs.mkdirSync(path.join(source, "node_modules"), { recursive: true });
        fs.mkdirSync(child, { recursive: true });
        fs.writeFileSync(
          path.join(source, "package.json"),
          JSON.stringify({
            name: "owner",
            type: "module",
            exports: "./index.js",
            dependencies: declared ? { child: "workspace:*" } : {},
          })
        );
        fs.writeFileSync(path.join(source, "index.js"), 'export { marker } from "child";');
        fs.writeFileSync(
          path.join(child, "package.json"),
          JSON.stringify({ name: "child", type: "module", exports: "./index.js" })
        );
        fs.writeFileSync(
          path.join(child, "index.js"),
          'export const marker = "declared workspace source";'
        );
        fs.symlinkSync(source, path.join(modules, "owner"), "junction");
        fs.symlinkSync(child, path.join(source, "node_modules", "child"), "junction");
        const entry = path.join(root, "entry.js");
        fs.writeFileSync(entry, 'export { marker } from "owner";');
        const build = esbuild.build({
          entryPoints: [entry],
          bundle: true,
          write: false,
          logLevel: "silent",
          plugins: composePreparedDependencyPlugins([], [modules], []),
        });
        if (declared)
          expect((await build).outputFiles[0]?.text).toContain("declared workspace source");
        else await expect(build).rejects.toThrow('Could not resolve "child"');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("does not inherit workspace dependency declarations from an ancestor package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-nearest-workspace-owner-"));
    try {
      const modules = path.join(root, "prepared", "node_modules");
      const owner = path.join(root, "packages", "owner");
      const child = path.join(owner, "packages", "child");
      const leaf = path.join(root, "packages", "leaf");
      fs.mkdirSync(modules, { recursive: true });
      fs.mkdirSync(path.join(owner, "node_modules"), { recursive: true });
      fs.mkdirSync(path.join(child, "node_modules"), { recursive: true });
      fs.mkdirSync(leaf, { recursive: true });
      fs.writeFileSync(
        path.join(owner, "package.json"),
        JSON.stringify({
          name: "owner",
          type: "module",
          dependencies: { child: "workspace:*", leaf: "workspace:*" },
        })
      );
      fs.writeFileSync(path.join(owner, "index.js"), 'export { marker } from "child";');
      fs.writeFileSync(
        path.join(child, "package.json"),
        JSON.stringify({ name: "child", type: "module", exports: "./index.js" })
      );
      fs.writeFileSync(path.join(child, "index.js"), 'export { marker } from "leaf";');
      fs.writeFileSync(
        path.join(leaf, "package.json"),
        JSON.stringify({ name: "leaf", type: "module", exports: "./index.js" })
      );
      fs.writeFileSync(path.join(leaf, "index.js"), 'export const marker = "leaf";');
      fs.symlinkSync(owner, path.join(modules, "owner"), "junction");
      fs.symlinkSync(child, path.join(owner, "node_modules", "child"), "junction");
      fs.symlinkSync(leaf, path.join(child, "node_modules", "leaf"), "junction");
      const entry = path.join(root, "entry.js");
      fs.writeFileSync(entry, 'export { marker } from "owner";');

      await expect(
        esbuild.build({
          entryPoints: [entry],
          bundle: true,
          write: false,
          logLevel: "silent",
          plugins: composePreparedDependencyPlugins([], [modules], []),
        })
      ).rejects.toThrow('Could not resolve "leaf"');
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

  it.each([true, false])(
    "keeps framework-owned module imports inside the prepared graph (guarded=%s)",
    async (guarded) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-composed-plugin-"));
      const source = path.join(root, "source");
      const preparedModules = path.join(root, "prepared", "node_modules");
      const ambientModules = path.join(root, "node_modules");
      const fixturePath = path.join(source, "panel.component");
      const opaquePluginData = { owner: "framework-plugin" };
      try {
        fs.mkdirSync(source, { recursive: true });
        writePackage(preparedModules, "prepared-helper", "prepared");
        writePackage(ambientModules, "ambient-helper", "ambient");
        fs.writeFileSync(fixturePath, "component source is handled by the plugin");
        const frameworkPlugin: esbuild.Plugin = {
          name: "framework-fixture",
          setup(build) {
            build.onResolve({ filter: /\.component$/ }, (args) => ({
              path: args.path,
              namespace: "component-source",
              pluginData: opaquePluginData,
            }));
            build.onLoad({ filter: /.*/, namespace: "component-source" }, async (args) => {
              expect(args.pluginData).toBe(opaquePluginData);
              const prepared = await build.resolve("prepared-helper", {
                kind: "import-statement",
                resolveDir: preparedModules,
                pluginData: opaquePluginData,
              });
              expect(prepared.errors).toHaveLength(0);
              expect(prepared.path).toContain(
                path.join("prepared", "node_modules", "prepared-helper")
              );
              const ambient = await build.resolve("ambient-helper", {
                kind: "import-statement",
                resolveDir: source,
              });
              expect(ambient.errors.length).toBeGreaterThan(0);
              return {
                contents: guarded
                  ? 'import { marker } from "prepared-helper"; export function read(){ try { return require("ambient-helper"); } catch { return marker; } }'
                  : 'import { marker } from "prepared-helper"; export function read(){ return require("ambient-helper"); }',
                loader: "js",
                resolveDir: source,
              };
            });
          },
        };
        const result = await esbuild.build({
          entryPoints: [fixturePath],
          bundle: true,
          format: "cjs",
          platform: "node",
          nodePaths: [preparedModules],
          write: false,
          logLevel: "silent",
          plugins: composePreparedDependencyPlugins([frameworkPlugin], [preparedModules], [source]),
        });
        if (!guarded) throw new Error("unguarded ambient import unexpectedly built");
        expect(result.outputFiles[0]?.text).toContain('"prepared"');
        expect(result.outputFiles[0]?.text).not.toContain('"ambient"');
      } catch (error) {
        if (guarded) throw error;
        expect(String(error)).toContain('Could not resolve "ambient-helper"');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("adapts plugin-generated modules to ordinary JS, TS, CSS, and asset loaders", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-plugin-loaders-"));
    const source = path.join(root, "source");
    const entry = path.join(source, "entry.component");
    try {
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(entry, "plugin-owned entry");
      fs.writeFileSync(path.join(source, "helper.ts"), "export const helper: number = 7;");
      fs.writeFileSync(path.join(source, "theme.css"), ".component { color: red; }");
      fs.writeFileSync(path.join(source, "icon.svg"), "<svg>owned</svg>");
      const frameworkPlugin: esbuild.Plugin = {
        name: "framework-virtual-source",
        setup(build) {
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
        outdir: path.join(root, "out"),
        write: false,
        logLevel: "silent",
        loader: { ".svg": "text" },
        plugins: composePreparedDependencyPlugins([frameworkPlugin], [], [source]),
      });
      expect(result.outputFiles.map((file) => file.text).join("\n")).toContain("7");
      expect(result.outputFiles.map((file) => file.text).join("\n")).toContain("<svg>owned</svg>");
      expect(result.outputFiles.map((file) => file.text).join("\n")).toContain("color: red");
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

  it("refuses an ambient dependency absent from the prepared environment", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hermetic-build-"));
    try {
      const ambientModules = path.join(root, "node_modules");
      const ownedModules = path.join(root, "owned", "node_modules");
      const sourceDir = path.join(root, "workspace", "source");
      fs.mkdirSync(ownedModules, { recursive: true });
      fs.mkdirSync(sourceDir, { recursive: true });
      writePackage(ambientModules, "ambient-only", "ambient");
      const entry = path.join(sourceDir, "entry.js");
      fs.writeFileSync(entry, 'import "ambient-only";\n');

      await expect(
        esbuild.build({
          entryPoints: [entry],
          bundle: true,
          write: false,
          logLevel: "silent",
          plugins: composePreparedDependencyPlugins([], [ownedModules], []),
        })
      ).rejects.toThrow("Dependency ambient-only is not present in the prepared build environment");
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

  it("continues to reject required peers resolved only from ambient modules", async () => {
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

      await expect(
        esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: "esm",
          platform: "node",
          write: false,
          logLevel: "silent",
          plugins: composePreparedDependencyPlugins([], [preparedModules], []),
        })
      ).rejects.toThrow('Could not resolve "required-peer"');
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
