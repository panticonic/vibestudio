import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { execFileSync, execSync } from "child_process";
import { builtinModules, createRequire } from "node:module";
import { collectWorkersFromDependencies, workersToArray } from "./scripts/collectWorkers.mjs";
import { SERVER_ESM_BANNER } from "./scripts/build-artifact-contracts.mjs";
import { generateConnectGrammar } from "./scripts/generate-connect-grammar.mjs";
import { buildWorkerdPrograms } from "./scripts/build-workerd-programs.mjs";
import {
  computeHostBuildFingerprint,
  writeHostBuildFingerprint,
} from "./scripts/host-build-fingerprint.mjs";

const isDev = process.env.NODE_ENV === "development";

function verifyDerivedAuthority() {
  // Authority requests are reviewed source contracts. Builds must never turn
  // inferred use into a request by rewriting package manifests, even in local
  // development. The explicit generation command may propose/apply changes;
  // every normal build only proves that the reviewed sources are current.
  const checkArgs = ["--check"];
  console.log("Checking explicit authority manifests and derived audit artifacts...");
  execFileSync(process.execPath, ["scripts/generate-unit-authority-manifests.mjs", ...checkArgs], {
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    ["scripts/generate-runtime-foundation-ledgers.mjs", ...checkArgs],
    {
      stdio: "inherit",
    }
  );
}

const logOverride = {
  "suspicious-logical-operator": "silent",
};

// Plugin to mark node: prefixed imports as external (for browser platform builds)
const nodeBuiltinsExternalPlugin = {
  name: "node-builtins-external",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      return { path: args.path, external: true };
    });
  },
};

// CJS build for utilityProcess.fork() from Electron.
const serverElectronConfig = {
  entryPoints: ["src/server/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/server-electron.cjs",
  external: [
    "electron",
    "esbuild",
    "@npmcli/arborist",
    "node-datachannel",
    "@vibestudio/extension-host",
    "vitest",
    "vitest/node",
    "vite",
    // Agent SDKs: must stay external — they use import.meta.url at module scope
    // to locate config files, which breaks when bundled into CJS.
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

// Stub out 'electron' for the standalone ESM server build.
//
// Problem: Shared code in src/main/ contains `try { require("electron") } catch`
// guards that esbuild hoists to top-level ESM `import` statements. These fail
// at module load time when electron isn't installed.
//
// Solution: Two-tier stub.  `app` throws on method calls so the try/catch
// guards in envPaths.ts and paths.ts fall through to headless fallbacks.
// Everything else (protocol, session, etc.) is a silent no-op Proxy for code
// that runs at module scope.
const electronStubPlugin = {
  name: "electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({
      path: "electron",
      namespace: "electron-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "electron-stub" }, () => ({
      contents: `
        const notElectron = new Error("Not running in Electron");

        // app: throws on method calls so try/catch guards trigger fallbacks
        const app = new Proxy({}, {
          get(_, prop) {
            if (prop === Symbol.toPrimitive) return () => "";
            if (prop === "then") return undefined;
            return function() { throw notElectron; };
          },
        });

        // Silent no-op proxy for everything else
        function noopFn() {}
        const silentHandler = {
          get(_, prop) {
            if (prop === Symbol.toPrimitive) return () => "";
            if (prop === "then") return undefined;
            return new Proxy(noopFn, silentHandler);
          },
          apply() { return undefined; },
        };
        const silentProxy = new Proxy(noopFn, silentHandler);

        export { app };
        export const session = silentProxy;
        export const protocol = silentProxy;
        export const ipcMain = silentProxy;
        export const nativeTheme = silentProxy;
        export const dialog = silentProxy;
        export const Menu = silentProxy;
        export const WebContentsView = silentProxy;
        export const webContents = silentProxy;
        export const BaseWindow = silentProxy;
        export default silentProxy;
      `,
      loader: "js",
    }));
  },
};

const serverConfig = {
  entryPoints: ["src/server/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/server.mjs",
  external: [
    "esbuild",
    "@npmcli/arborist",
    "@vibestudio/extension-host",
    "vitest",
    "vitest/node",
    "vite",
    // Agent SDKs: must stay external — they use import.meta.url at module scope
    // to locate config files relative to their install path.
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ],
  plugins: [electronStubPlugin],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
  banner: {
    js: SERVER_ESM_BANNER,
  },
};

const clientConfig = {
  entryPoints: ["src/cli/client.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/cli/client.mjs",
  external: ["ws", "node-datachannel"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const mainConfig = {
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/main.cjs",
  external: ["electron", "esbuild", "@npmcli/arborist", "node-datachannel"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
  // Inject __dirname and __filename for CJS compatibility
  // esbuild should do this automatically for CJS output, but we ensure it explicitly
  banner: {
    js: `
const __injected_filename__ = typeof __filename !== 'undefined' ? __filename : '';
const __injected_dirname__ = typeof __dirname !== 'undefined' ? __dirname : (typeof __filename !== 'undefined' ? require('path').dirname(__filename) : '');
`.trim(),
  },
};

function createPreloadConfig(name) {
  return {
    entryPoints: [`src/preload/${name}.ts`],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: `dist/${name}.cjs`,
    external: ["electron"],
    sourcemap: isDev,
    minify: !isDev,
    logOverride,
  };
}

const preloadConfigs = [
  "bootstrapPreload",
  "panelPreload",
  "appPreload",
  "browserPreload",
  "autofillPreload",
  "autofillOverlayPreload",
  "shellOverlayPreload",
  "contentOverlayPreload",
].map(createPreloadConfig);

// Browser transport IIFE — used by PanelHttpServer to inject into panel HTML.
// Reuses createWsTransport from the preload, compiled for the browser.
const browserTransportConfig = {
  entryPoints: ["src/server/browserTransportEntry.ts"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
  outfile: "dist/browserTransport.js",
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

const internalDoBundleConfig = {
  entryPoints: ["src/server/internalDOs/index.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: "dist/internal-do.bundle.mjs",
  conditions: ["worker", "browser"],
  external: ["node:*", "electron"],
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
};

// Plugin to rewrite bare Node builtin imports to node: prefix and mark electron
// as external for the shipped bootstrap/recovery UI bundle.
const bootstrapExternalsPlugin = {
  name: "bootstrap-externals",
  setup(build) {
    const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

    // Mark electron as external
    build.onResolve({ filter: /^electron$/ }, (args) => ({
      path: args.path,
      external: true,
    }));

    // Rewrite bare builtin imports to node: prefix
    build.onResolve({ filter: /.*/ }, (args) => {
      if (builtins.has(args.path)) {
        return { path: `node:${args.path}`, external: true };
      }
      // Already node:-prefixed — pass through as external
      if (args.path.startsWith("node:")) {
        return { path: args.path, external: true };
      }
      return undefined;
    });
  },
};

const bootstrapConfig = {
  entryPoints: ["src/bootstrap/index.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outdir: "dist/bootstrap",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  sourcemap: isDev,
  minify: !isDev,
  logOverride,
  loader: {
    ".html": "text",
    ".css": "css",
    // Monaco editor assets
    ".ttf": "dataurl",
    ".woff": "dataurl",
    ".woff2": "dataurl",
    ".eot": "dataurl",
    ".svg": "dataurl",
  },
  // Define process.env.NODE_ENV at build time (React checks this before Node globals are available)
  define: {
    "process.env.NODE_ENV": isDev ? '"development"' : '"production"',
  },
  // Force react/react-dom to a single absolute path. Required because pnpm
  // (node-linker=hoisted) leaves the root node_modules/react as a real directory
  // while workspace packages keep symlinks into .pnpm/react@.../... — esbuild then
  // bundles two physically distinct copies, breaking the React dispatcher
  // (e.g. `useSyncExternalStore` returns null inside @workspace/react/responsive).
  alias: {
    react: path.resolve("node_modules/react"),
    "react-dom": path.resolve("node_modules/react-dom"),
  },
  plugins: [bootstrapExternalsPlugin],
};

function copyAssets() {
  fs.copyFileSync("src/bootstrap/index.html", "dist/index.html");
  copyDirectoryRecursive("build-resources/brand", "dist/assets/brand");
  fs.mkdirSync("dist/baked-app", { recursive: true });
  // Bundled agent skill consumed by `vibestudio agent skill install|print`
  // (resolved as a sibling of dist/cli/client.mjs).
  copyDirectoryRecursive("skills/vibestudio-agent", "dist/cli/skills/vibestudio-agent");
}

function copyDirectoryRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function buildVibestudioPackages() {
  console.log("Building @vibestudio/* infrastructure packages...");
  try {
    execSync('pnpm --filter "!@vibestudio/headless-host" --filter "@vibestudio/*" build', {
      stdio: "inherit",
    });
    console.log("@vibestudio/* packages built successfully!");
  } catch (error) {
    console.error("Failed to build @vibestudio/* packages:", error);
    throw error;
  }
}

async function buildWorkspacePackages() {
  console.log("Building userland workspace packages...");
  try {
    execSync("pnpm --dir workspace build", {
      stdio: "inherit",
    });
    console.log("Userland workspace packages built successfully!");
  } catch (error) {
    console.error("Failed to build userland workspace packages:", error);
    throw error;
  }
}

async function buildHeadlessHost() {
  console.log("Building @vibestudio/headless-host...");
  try {
    execSync('pnpm --filter "@vibestudio/headless-host" build', { stdio: "inherit" });
    fs.rmSync("dist/headless-host", { recursive: true, force: true });
    copyDirectoryRecursive("apps/headless-host/dist", "dist/headless-host");
    console.log("@vibestudio/headless-host built successfully!");
  } catch (error) {
    console.error("Failed to build @vibestudio/headless-host:", error);
    throw error;
  }
}

async function checkBuildArtifacts() {
  console.log("Checking build artifact contracts...");
  try {
    execSync("node scripts/check-build-artifacts.mjs", { stdio: "inherit" });
  } catch (error) {
    console.error("Build artifact contract check failed:", error);
    throw error;
  }
}

/**
 * Build web workers declared by dependencies via vibestudio.workers in package.json.
 * Scans node_modules for worker declarations and bundles them.
 */
async function buildDependencyWorkers() {
  const req = createRequire(import.meta.url);
  const nodeModulesDir = path.join(process.cwd(), "node_modules");

  // Collect workers from dependencies (workspace packages are symlinked here)
  const workers = collectWorkersFromDependencies(nodeModulesDir, {
    log: (msg) => console.warn(`[build] ${msg}`),
  });

  const workerEntries = workersToArray(workers);
  if (workerEntries.length === 0) {
    return;
  }

  let builtCount = 0;
  for (const entry of workerEntries) {
    let entryPath;
    try {
      entryPath = req.resolve(entry.specifier);
    } catch {
      console.warn(
        `[build] Could not resolve worker: ${entry.specifier} (declared by ${entry.declaredBy})`
      );
      continue;
    }

    // Create output directory based on worker path (e.g., "monaco/editor.worker.js" -> "dist/monaco/")
    const outfile = path.join("dist", entry.name);
    fs.mkdirSync(path.dirname(outfile), { recursive: true });

    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "esm",
      outfile,
      sourcemap: isDev,
      minify: !isDev,
      logLevel: "silent",
    });
    builtCount += 1;
  }

  if (builtCount > 0) {
    const packages = [...new Set(workerEntries.map((e) => e.declaredBy))];
    console.log(`[build] Bundled ${builtCount} worker assets from: ${packages.join(", ")}`);
  }
}

/**
 * Build dependency graph
 * Defines explicit dependencies between build steps to ensure correct ordering
 */
async function build() {
  try {
    verifyDerivedAuthority();
    fs.mkdirSync("dist", { recursive: true });

    // Raw-node support scripts import this generated, dependency-free artifact.
    // Rebuild it from the canonical TypeScript grammar before packaging.
    await generateConnectGrammar();

    // ========================================================================
    // STEP 0.75: Build @vibestudio/* infrastructure packages
    // ========================================================================
    // Must be built before @workspace/* packages since they depend on @vibestudio/*
    // Dependencies: none
    await buildVibestudioPackages();

    // ========================================================================
    // STEP 1: Build @workspace/* packages
    // ========================================================================
    // These must be built as they are consumed by later steps
    // Dependencies: buildVibestudioPackages
    await buildWorkspacePackages();

    // ========================================================================
    // STEP 1.5: Build standalone headless panel host
    // ========================================================================
    // The server auto-spawns this bundle as a child process when no desktop
    // CDP host is connected; copy it under dist/ so packaged CLIs can find it.
    // Dependencies: buildVibestudioPackages, buildWorkspacePackages
    await buildHeadlessHost();

    // ========================================================================
    // STEP 2: Build main application
    // ========================================================================
    // These can run in parallel as they don't depend on each other.
    // Dependencies: buildWorkspacePackages
    // Required by: None (final outputs)
    // Clean stale renderer/bootstrap artifacts before the parallel ESM builds.
    for (const artifact of [
      "dist/renderer.js",
      "dist/renderer.css",
      "dist/preload.cjs",
      "dist/preload.cjs.map",
    ]) {
      fs.rmSync(artifact, { force: true });
    }
    fs.rmSync("dist/renderer", { recursive: true, force: true });
    fs.rmSync("dist/bootstrap", { recursive: true, force: true });

    const workerdProgramsPromise = buildWorkerdPrograms({ minify: !isDev, logOverride });
    await Promise.all([
      esbuild.build(mainConfig),
      ...preloadConfigs.map((config) => esbuild.build(config)),
      esbuild.build(browserTransportConfig),
      esbuild.build(internalDoBundleConfig),
      esbuild.build(bootstrapConfig),
      esbuild.build(clientConfig),
      buildDependencyWorkers(),
      workerdProgramsPromise,
    ]);
    const workerdPrograms = await workerdProgramsPromise;
    // Inline the build-compiled internal DO and workerd host programs into both
    // server artifacts. Source-mode execution reads the same emitted files.
    const internalDoBundleContent = fs.readFileSync("dist/internal-do.bundle.mjs", "utf8");
    const internalDoBundleDefine = {
      "globalThis.__VIBESTUDIO_INTERNAL_DO_BUNDLE__": JSON.stringify(internalDoBundleContent),
      "globalThis.__VIBESTUDIO_WORKERD_PROGRAMS__": JSON.stringify(workerdPrograms),
    };
    const serverElectronWithBundle = {
      ...serverElectronConfig,
      define: { ...(serverElectronConfig.define ?? {}), ...internalDoBundleDefine },
    };
    const serverWithBundle = {
      ...serverConfig,
      define: { ...(serverConfig.define ?? {}), ...internalDoBundleDefine },
    };
    // Both server bundles consume the internal-DO output captured above.
    await Promise.all([esbuild.build(serverElectronWithBundle), esbuild.build(serverWithBundle)]);

    // ========================================================================
    // STEP 3: Copy static assets
    // ========================================================================
    // Dependencies: None (just copying files)
    // Required by: None
    copyAssets();

    await checkBuildArtifacts();

    // Smoke suites reuse a build only when every conservative host-build input
    // (including the build mode) still has the same content.
    writeHostBuildFingerprint(computeHostBuildFingerprint());

    console.log("Build successful!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

async function buildInternalDoOnly() {
  try {
    fs.mkdirSync("dist", { recursive: true });
    await esbuild.build(internalDoBundleConfig);
    console.log("Internal Durable Object bundle built successfully!");
  } catch (error) {
    console.error("Internal Durable Object bundle build failed:", error);
    process.exitCode = 1;
  }
}

async function buildSourceServerPrerequisites() {
  try {
    verifyDerivedAuthority();
    // Source-mode servers import infrastructure packages through their public
    // dist exports, and auto-spawn the compiled headless host. Rebuilding only
    // the internal DO bundle can therefore combine live server source with
    // stale RPC/runtime binaries. Keep this boundary equivalent to the
    // infrastructure portion of `pnpm dev` without rebuilding desktop UI.
    await buildVibestudioPackages();
    await buildHeadlessHost();
    fs.mkdirSync("dist", { recursive: true });
    // Injected into every non-Electron/headless panel by PanelHttpServer. It
    // embeds the RPC WebSocket client, so leaving it stale can make panels use
    // an older wire protocol even when packages/rpc/dist is current.
    await esbuild.build(browserTransportConfig);
    await esbuild.build(internalDoBundleConfig);
    await buildWorkerdPrograms({ minify: !isDev, logOverride });
    console.log("Source server prerequisites built successfully!");
  } catch (error) {
    console.error("Source server prerequisite build failed:", error);
    process.exitCode = 1;
  }
}

if (process.argv.includes("--internal-do-only")) {
  await buildInternalDoOnly();
} else if (process.argv.includes("--source-server-prereqs")) {
  await buildSourceServerPrerequisites();
} else {
  await build();
}
