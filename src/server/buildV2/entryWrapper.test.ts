/**
 * Tests for the entry wrapper / module-map bootstrap generators.
 *
 * These cover the small pure-function half of the build pipeline that lives
 * around `__vibestudioRequire__` and `exposeModules`. The full builder is tested
 * indirectly by the running dev server; this file locks in the contract of
 * the helpers shared by both panel and worker builds.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import {
  generateModuleMapBootstrap,
  generateExposeModuleCode,
  generatePanelExposeEntryCode,
  generateWorkerEntry,
  injectHtmlTransforms,
  resolveEntryPoint,
} from "./builder.js";

describe("generateModuleMapBootstrap (panel target)", () => {
  it("declares the module map and both require functions on globalThis", () => {
    const code = generateModuleMapBootstrap("panel");
    expect(code).toContain("globalThis.__vibestudioModuleMap__");
    expect(code).toContain("globalThis.__vibestudioRequire__");
    expect(code).toContain("globalThis.__vibestudioRequireAsync__");
  });

  it("uses idempotent initialization so repeated boots don't clobber state", () => {
    const code = generateModuleMapBootstrap("panel");
    expect(code).toMatch(
      /__vibestudioModuleMap__\s*=\s*globalThis\.__vibestudioModuleMap__\s*\|\|\s*\{\}/
    );
  });

  it("__vibestudioRequire__ throws a clear error for unknown modules", () => {
    const code = generateModuleMapBootstrap("panel");
    expect(code).toContain("not available. Workspace packages");
  });

  it("defaults to panel target when no argument is passed", () => {
    expect(generateModuleMapBootstrap()).toBe(generateModuleMapBootstrap("panel"));
  });
});

describe("generateModuleMapBootstrap (worker target)", () => {
  it("emits the module map and __vibestudioRequire__", () => {
    const code = generateModuleMapBootstrap("worker");
    expect(code).toContain("globalThis.__vibestudioModuleMap__");
    expect(code).toContain("globalThis.__vibestudioRequire__");
  });

  it("omits __vibestudioRequireAsync__ entirely (workerd has no dynamic import)", () => {
    const code = generateModuleMapBootstrap("worker");
    expect(code).not.toContain("__vibestudioRequireAsync__");
    expect(code).not.toContain("__vibestudioModuleLoadingPromises__");
    // No `import(id)` either — that's the body of the async fallback.
    expect(code).not.toMatch(/\bimport\(id\)/);
  });

  it("worker bootstrap is strictly smaller than panel bootstrap", () => {
    expect(generateModuleMapBootstrap("worker").length).toBeLessThan(
      generateModuleMapBootstrap("panel").length
    );
  });
});

describe("generateExposeModuleCode", () => {
  it("includes the bootstrap even with no expose modules", () => {
    const code = generateExposeModuleCode([]);
    expect(code).toContain("globalThis.__vibestudioModuleMap__");
    expect(code).toContain("globalThis.__vibestudioRequire__");
    // No imports or registrations when the list is empty.
    expect(code).not.toContain("__mod0__");
  });

  it("emits literal lazy loaders for each exposed panel module", () => {
    const code = generateExposeModuleCode(["@workspace/runtime", "zod"]);
    expect(code).toContain('import("./_expose_module_0.js")');
    expect(code).toContain('import("./_expose_module_1.js")');
    expect(code).not.toContain("import * as");
    expect(code).toContain('globalThis.__vibestudioModuleMap__["zod"] = mod');
  });

  it("panel target does not preload the lightweight CDP client when runtime is exposed", () => {
    const code = generateExposeModuleCode(["@workspace/runtime"], "panel");
    expect(code).toContain('import("./_expose_module_0.js")');
    expect(code).not.toContain("@workspace/cdp-client");
  });

  it("preserves the order of exposed modules in the generated code", () => {
    const code = generateExposeModuleCode(["a", "b", "c"]);
    const aIdx = code.indexOf('import("./_expose_module_0.js")');
    const bIdx = code.indexOf('import("./_expose_module_1.js")');
    const cIdx = code.indexOf('import("./_expose_module_2.js")');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });

  it("worker target produces the worker-flavored bootstrap", () => {
    const code = generateExposeModuleCode(["@workspace/runtime"], "worker");
    expect(code).not.toContain("__vibestudioRequireAsync__");
    expect(code).toContain('import * as __mod0__ from "@workspace/runtime"');
  });

  it("worker target preloads only the lightweight CDP client when runtime handles are exposed", () => {
    const code = generateExposeModuleCode(["@workspace/runtime"], "worker");
    expect(code).toContain('import * as __mod1__ from "@workspace/cdp-client"');
    expect(code).toContain(
      'globalThis.__vibestudioModuleMap__["@workspace/cdp-client"] = __mod1__'
    );
  });

  it("worker target synthesizes fs shims from runtime exports", () => {
    const code = generateExposeModuleCode(["@workspace/runtime"], "worker");
    expect(code).toContain('map["fs"]');
    expect(code).toContain('__mod0__["fs"]');
  });

  it("panel target produces the panel-flavored bootstrap", () => {
    const code = generateExposeModuleCode(["react"], "panel");
    expect(code).toContain("__vibestudioRequireAsync__");
    expect(code).toContain('import("./_expose_module_0.js")');
  });

  it("preserves exposed CommonJS named exports through a static namespace entry", () => {
    expect(generatePanelExposeEntryCode("react")).toBe(
      'import * as namespace from "react";\nexport default namespace;\n'
    );
  });

  it("loads React lazily with the named exports required by compiled components", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-exposed-react-"));
    const outdir = path.join(tempDir, "out");
    const globals = globalThis as Record<string, unknown>;
    const globalKeys = [
      "__vibestudioModuleMap__",
      "__vibestudioRequire__",
      "__vibestudioModuleLoaders__",
      "__vibestudioModuleLoadingPromises__",
      "__vibestudioNativeImportSpecifiers__",
      "__vibestudioRequireAsync__",
    ] as const;
    const previousGlobals = new Map(globalKeys.map((key) => [key, globals[key]]));

    try {
      for (const key of globalKeys) Reflect.deleteProperty(globals, key);
      fs.writeFileSync(path.join(tempDir, "package.json"), '{"type":"module"}\n');
      fs.writeFileSync(
        path.join(tempDir, "_expose_module_0.js"),
        generatePanelExposeEntryCode("react")
      );
      fs.writeFileSync(
        path.join(tempDir, "_expose.js"),
        generateExposeModuleCode(["react"], "panel")
      );
      fs.writeFileSync(
        path.join(tempDir, "entry.js"),
        'import "./_expose.js";\nexport const loadReact = () => globalThis.__vibestudioRequireAsync__("react");\n'
      );

      await esbuild.build({
        entryPoints: [path.join(tempDir, "entry.js")],
        bundle: true,
        splitting: true,
        format: "esm",
        platform: "browser",
        outdir,
        entryNames: "entry",
        nodePaths: [path.join(process.cwd(), "node_modules")],
      });

      const entry = (await import(pathToFileURL(path.join(outdir, "entry.js")).href)) as {
        loadReact: () => Promise<Record<string, unknown>>;
      };
      const react = await entry.loadReact();
      expect(react["useState"]).toBeTypeOf("function");
      expect(react["createElement"]).toBeTypeOf("function");
    } finally {
      for (const key of globalKeys) {
        const previous = previousGlobals.get(key);
        if (previous === undefined) Reflect.deleteProperty(globals, key);
        else globals[key] = previous;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("routes runtime and fs aliases through one lazy runtime flight", () => {
    const code = generateExposeModuleCode(["@workspace/runtime"], "panel");
    expect(code).toContain("__vibestudioRuntimeLoadPromise__");
    expect(code).toContain(
      'globalThis.__vibestudioModuleLoaders__["fs"] = __vibestudioLoadRuntime__'
    );
    expect(code).toContain(
      'globalThis.__vibestudioModuleLoaders__["node:fs/promises"] = __vibestudioLoadRuntime__'
    );
  });

  it("admits only declared import-map externals to the native dynamic-import fallback", () => {
    const code = generateExposeModuleCode([], "panel", ["external-lib"]);
    expect(code).toContain('__vibestudioNativeImportSpecifiers__.add("external-lib")');
    expect(code).toContain("has no generated loader or import-map external");
  });
});

describe("generateWorkerEntry", () => {
  it("imports the expose file as a side effect before re-exporting", () => {
    const code = generateWorkerEntry("/tmp/_expose.js", "/src/index.ts");
    const exposeIdx = code.indexOf('import "/tmp/_expose.js"');
    const exportStarIdx = code.indexOf('export * from "/src/index.ts"');
    expect(exposeIdx).toBeGreaterThan(-1);
    expect(exportStarIdx).toBeGreaterThan(exposeIdx);
  });

  it("re-exports named exports and forwards default when present", () => {
    const code = generateWorkerEntry("/tmp/_expose.js", "/src/index.ts");
    expect(code).toContain('export * from "/src/index.ts"');
    expect(code).toContain('import * as __vibestudioWorkerEntry from "/src/index.ts"');
    expect(code).toContain('Reflect.get(__vibestudioWorkerEntry, "default")');
    expect(code).toContain("export default __vibestudioDefaultExport");
  });

  it("synthesizes a default fetch handler for DO-only modules", () => {
    const code = generateWorkerEntry("/tmp/_expose.js", "/src/index.ts");
    expect(code).toContain('hasOwnProperty.call(__vibestudioWorkerEntry, "default")');
    expect(code).toContain("Vibestudio worker module has no default fetch handler.");
  });

  it("JSON-quotes paths to handle special characters", () => {
    const code = generateWorkerEntry(
      "/tmp/path with spaces/_expose.js",
      "/src/path with spaces/index.ts"
    );
    expect(code).toContain('"/tmp/path with spaces/_expose.js"');
    expect(code).toContain('"/src/path with spaces/index.ts"');
  });
});

describe("injectHtmlTransforms", () => {
  it("links emitted CSS for template HTML", () => {
    const html = injectHtmlTransforms(
      '<html><head><title>Panel</title></head><body><div id="root"></div><script src="bundle.js"></script></body></html>',
      "/panels/chat/",
      true,
      undefined,
      "Agentic Chat"
    );

    expect(html).toContain("<title>Agentic Chat</title>");
    expect(html).toContain('<link rel="stylesheet" href="./bundle.css" />');
    expect(html).toContain('<base href="./">');
    expect(html).toContain('<link rel="preload" href="./__transport.js" as="script" />');
    expect(html).toContain('<link rel="modulepreload" href="./bundle.js" />');
    expect(html).toContain('<script src="./__loader.js" data-bundle-src="./bundle.js"></script>');
  });

  it("does not duplicate an existing bundle stylesheet", () => {
    const html = injectHtmlTransforms(
      '<html><head><link rel="stylesheet" href="./bundle.css" /></head><body><script src="./bundle.js"></script></body></html>',
      "/panels/chat/",
      true
    );

    expect(html.match(/bundle\.css/g)).toHaveLength(1);
  });

  it("rewrites template bundle references to hashed panel artifacts", () => {
    const html = injectHtmlTransforms(
      '<html><head><link rel="stylesheet" href="./bundle.css" /></head><body><script src="./bundle.js"></script></body></html>',
      "/panels/chat/",
      true,
      undefined,
      "Agentic Chat",
      true,
      { bundleSrc: "./bundle-ABC123.js", cssHref: "./bundle-XYZ789.css" }
    );

    expect(html).toContain('href="./bundle-XYZ789.css"');
    expect(html).toContain('<link rel="modulepreload" href="./bundle-ABC123.js" />');
    expect(html).toContain(
      '<script src="./__loader.js" data-bundle-src="./bundle-ABC123.js"></script>'
    );
    expect(html).not.toContain('href="./bundle.css"');
  });

  it("loads shared base styles before panel-specific CSS", () => {
    const sharedHref =
      "../../__vibestudio/shared-style/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.css";
    const html = injectHtmlTransforms(
      '<html><head><link rel="stylesheet" href="./bundle.css" /></head><body><script src="./bundle.js"></script></body></html>',
      "/panels/chat/",
      true,
      undefined,
      "Agentic Chat",
      true,
      {
        bundleSrc: "./bundle-ABC123.js",
        cssHref: "./bundle-XYZ789.css",
        sharedStyleHrefs: [sharedHref],
      }
    );

    const shared = html.indexOf(`href="${sharedHref}"`);
    const panel = html.indexOf('href="./bundle-XYZ789.css"');
    expect(shared).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(shared);
    expect(new URL(sharedHref, "http://localhost/panels/chat/").pathname).toBe(
      "/__vibestudio/shared-style/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.css"
    );
    expect(new URL(sharedHref, "http://localhost/_workspace/dev/panels/chat/").pathname).toBe(
      "/_workspace/dev/__vibestudio/shared-style/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.css"
    );
  });
});

describe("resolveEntryPoint", () => {
  it("honors package exports before stale root index.js files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-entry-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "@workspace/test-lib",
          type: "module",
          exports: { ".": "./dist/index.js" },
        })
      );
      fs.writeFileSync(path.join(root, "index.js"), "module.exports = require('./lib/missing');");
      fs.writeFileSync(path.join(root, "src", "index.ts"), "export const ok = true;");

      const entry = resolveEntryPoint(
        { name: "@workspace/test-lib", manifest: {}, path: root } as never,
        root
      );

      expect(entry).toBe(path.join(root, "src", "index.ts"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
