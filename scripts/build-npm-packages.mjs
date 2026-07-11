#!/usr/bin/env node
// Stage the two publishable npm packages from a completed `pnpm build`:
//
//   dist-packages/server  → @panticonic/vibestudio-server  (slim headless server, no electron)
//   dist-packages/app     → @panticonic/vibestudio         (full Electron desktop app)
//
// The monorepo root stays private; this script synthesizes each package.json and
// assembles its file tree. Host @vibestudio/* packages are vendored under
// vendor/ and copied into node_modules by postinstall. @workspace/* packages are
// not host dependencies; they ship only as first-run workspace template source
// and are built by the runtime workspace build system. Userland dependencies
// include packages that require Node >=22.13, so the generated packages declare
// the same floor.
//
// Run AFTER `pnpm build`:  node scripts/build-npm-packages.mjs
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outRoot = path.join(repoRoot, "dist-packages");
const rootPkg = readJson(path.join(repoRoot, "package.json"));
const VERSION = rootPkg.version;
const PUBLIC_APP_PACKAGE_NAME = "@panticonic/vibestudio";
const PUBLIC_SERVER_PACKAGE_NAME = "@panticonic/vibestudio-server";

// Host-provided build deps that live in root devDependencies (browser polyfills
// and alternative panel compilers) — needed to build the default template's
// panels/workers at runtime.
const HOST_BUILD_DEV_DEPS = ["buffer", "sql.js", "svelte", "esbuild-svelte"];

// Runtime/build deps not present in root.dependencies: the headless-host Chromium
// downloader, and react-devtools-core (pulled by `ink`, which the terminal
// workers bundle — hoisted via react-native in the dev monorepo). The npm CLI,
// esbuild, workerd, ws, zod, arborist, pi-ai are already root dependencies and
// come in via the root.dependencies mirror.
const SERVER_EXTRA_DEPS = ["@puppeteer/browsers", "react-devtools-core"];

// Workspace source dirs staged into the packaged template (the initial
// workspace a fresh install ships with). This is a subset of the canonical
// WORKSPACE_SOURCE_DIRS from @vibestudio/shared/workspace/sourceDirs — `projects/`
// is runtime-only content created per user and starts empty, so it is not
// shipped. A drift guard (tests/workspaceTemplateDirs.drift.test.ts) asserts
// this list stays in sync with the shared taxonomy. This module can't import
// the TS constant directly, so the list is mirrored here and cross-checked.
export const WORKSPACE_TEMPLATE_DIRS = [
  "meta",
  "panels",
  "packages",
  "agents",
  "workers",
  "skills",
  "about",
  "templates",
  "apps",
  "extensions",
];

export const WORKSPACE_TEMPLATE_ROOT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.integration.json",
  "tsconfig.integration.mobile.json",
];

// Support dirs referenced by workspace/package.json metadata. Host packages are
// intentionally not copied here: packaged runtime builds resolve @vibestudio/*
// from the installed app node_modules (vendor/postinstall), not from a duplicate
// sibling source tree.
export const WORKSPACE_TEMPLATE_SUPPORT_DIRS = ["patches"];

// Only run the build when invoked directly (`node scripts/build-npm-packages.mjs`),
// not when imported (e.g. by the drift-guard test) — importing must be free of
// side effects beyond the cheap top-level reads above.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

async function main() {
  console.log(`Staging npm packages @ v${VERSION}`);
  assertBuilt();
  buildSelfContainedExtensionHost();
  rmrf(outRoot);
  stageServer();
  stageApp();
  console.log("\n✔ Staged dist-packages/{server,app}. Validate with:");
  console.log("    (cd dist-packages/server && npm publish --dry-run)");
  console.log("    (cd dist-packages/app && npm publish --dry-run)");
}

function assertBuilt() {
  const required = ["dist/server.mjs", "dist/main.cjs", "dist/cli/client.mjs"];
  const missing = required.filter((p) => !fs.existsSync(path.join(repoRoot, p)));
  if (missing.length) {
    throw new Error(`Run \`pnpm build\` first — missing: ${missing.join(", ")}`);
  }
}

function buildSelfContainedExtensionHost() {
  console.log("• Building self-contained @vibestudio/extension-host (publish)…");
  execFileSync("pnpm", ["--filter", "@vibestudio/extension-host", "run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, VIBESTUDIO_EXTHOST_PUBLISH: "1" },
  });
}

// ---------------------------------------------------------------------------
// @panticonic/vibestudio-server
// ---------------------------------------------------------------------------
function stageServer() {
  const root = path.join(outRoot, "server");
  console.log(`• Staging ${PUBLIC_SERVER_PACKAGE_NAME}…`);
  mkdirp(root);

  // Server runtime files (see paths.ts / internalDoLoader.ts / headlessHostManager.ts).
  copyFile("dist/server.mjs", path.join(root, "dist/server.mjs"));
  copyFile("dist/internal-do.bundle.mjs", path.join(root, "dist/internal-do.bundle.mjs"));
  copyTree(path.join(repoRoot, "dist/cli"), path.join(root, "dist/cli"), defaultSkip);
  copyTree(
    path.join(repoRoot, "dist/headless-host"),
    path.join(root, "dist/headless-host"),
    defaultSkip
  );

  // First-run workspace template (runtimePaths.ts: appRoot/workspace-template).
  stageWorkspaceTemplate(path.join(root, "workspace-template"));
  stageWorkspaceTemplateSupport(root);

  // Bin shims.
  copyFile("scripts/vibestudio-launcher.mjs", path.join(root, "scripts/vibestudio-launcher.mjs"));
  copyFile(
    "scripts/vibestudio-server-shim.mjs",
    path.join(root, "scripts/vibestudio-server-shim.mjs")
  );
  // Passthrough CLI commands resolve these scripts relative to the installed
  // package root. Keep the complete tree (including cli/lib/) in both npm
  // packages so documented commands work outside a source checkout.
  copyTree(path.join(repoRoot, "scripts/cli"), path.join(root, "scripts/cli"), defaultSkip);
  assertPassthroughScriptsStaged(root);

  // Vendor the host's @vibestudio/* packages under vendor/ (NOT node_modules). A
  // partial node_modules shipped in the tarball perturbs npm's reify ordering —
  // it runs dependency postinstall scripts (e.g. electron's) against an
  // incomplete tree. The package's own postinstall copies vendor/@vibestudio →
  // node_modules/@vibestudio AFTER install, where the runtime build resolves them
  // (getExistingAppNodeModulesRoots → builder.ts initBuilder). extension-host
  // ships self-contained; @workspace/* are NOT host deps (workspace's own build).
  vendorVibestudioPackages(root);
  vendorExtensionHost(root);
  copyFile("scripts/vendor-install.mjs", path.join(root, "scripts/vendor-install.mjs"));

  writeJson(path.join(root, "package.json"), {
    name: PUBLIC_SERVER_PACKAGE_NAME,
    version: VERSION,
    description:
      "Vibestudio headless server (build, git, channels, AI, agents) over WebSocket RPC.",
    type: "module",
    license: rootPkg.license ?? "MIT",
    bin: {
      "vibestudio-server": "scripts/vibestudio-server-shim.mjs",
      vibestudio: "scripts/vibestudio-launcher.mjs",
    },
    engines: { node: ">=22.13.0" },
    files: ["dist", "vendor", "workspace-template", "patches", "scripts"],
    scripts: { postinstall: "node scripts/vendor-install.mjs" },
    // Full host build-dependency surface (app minus electron).
    dependencies: computeHostDependencies({ electron: false }),
    publishConfig: { access: "public" },
  });
}

// ---------------------------------------------------------------------------
// @panticonic/vibestudio
// ---------------------------------------------------------------------------
function stageApp() {
  const root = path.join(outRoot, "app");
  console.log(`• Staging ${PUBLIC_APP_PACKAGE_NAME}…`);
  mkdirp(root);

  // Full host build (main + all preloads + server-electron + cli + headless-host).
  copyTree(path.join(repoRoot, "dist"), path.join(root, "dist"), defaultSkip);

  // The app runs unpackaged: it reads appRoot/workspace as the first-run template.
  stageWorkspaceTemplate(path.join(root, "workspace"));
  stageWorkspaceTemplateSupport(root);

  copyFile("scripts/vibestudio-launcher.mjs", path.join(root, "scripts/vibestudio-launcher.mjs"));
  copyFile(
    "scripts/vibestudio-server-shim.mjs",
    path.join(root, "scripts/vibestudio-server-shim.mjs")
  );
  copyFile("scripts/branded-electron.mjs", path.join(root, "scripts/branded-electron.mjs"));
  copyTree(path.join(repoRoot, "scripts/cli"), path.join(root, "scripts/cli"), defaultSkip);
  assertPassthroughScriptsStaged(root);
  if (fs.existsSync(path.join(repoRoot, "build-resources"))) {
    copyTree(
      path.join(repoRoot, "build-resources"),
      path.join(root, "build-resources"),
      defaultSkip
    );
  }

  // Vendor the host's @vibestudio/* packages under vendor/ (copied into node_modules
  // by the postinstall — see the server staging note). The managed workspace's
  // @workspace/* packages are NOT host deps; they ship only as first-run template
  // content under workspace/ (above).
  vendorVibestudioPackages(root);
  vendorExtensionHost(root);
  copyFile("scripts/vendor-install.mjs", path.join(root, "scripts/vendor-install.mjs"));

  writeJson(path.join(root, "package.json"), {
    name: PUBLIC_APP_PACKAGE_NAME,
    version: VERSION,
    productName: rootPkg.productName ?? "Vibestudio",
    description: rootPkg.description,
    type: "module",
    license: rootPkg.license ?? "MIT",
    main: "dist/main.cjs",
    bin: {
      vibestudio: "scripts/vibestudio-launcher.mjs",
      "vibestudio-server": "scripts/vibestudio-server-shim.mjs",
    },
    engines: { node: ">=22.13.0" },
    files: ["dist", "vendor", "workspace", "patches", "scripts", "build-resources"],
    scripts: { postinstall: "node scripts/vendor-install.mjs" },
    dependencies: computeHostDependencies({ electron: true }),
    publishConfig: { access: "public" },
  });
}

export function assertPassthroughScriptsStaged(root) {
  const required = [
    "scripts/cli/remote-serve.mjs",
    "scripts/cli/remote-doctor.mjs",
    "scripts/cli/lib/server-entry.mjs",
    "scripts/cli/lib/pair-server.mjs",
  ];
  const missing = required.filter((relative) => !fs.existsSync(path.join(root, relative)));
  if (missing.length > 0) {
    throw new Error(`Staged package is missing CLI support files: ${missing.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Vendoring
// ---------------------------------------------------------------------------
function vendorExtensionHost(pkgRoot) {
  const distPublish = path.join(repoRoot, "packages/extension-host/dist-publish");
  if (!fs.existsSync(distPublish)) {
    throw new Error("extension-host dist-publish/ missing — self-contained build did not run");
  }
  const dest = path.join(pkgRoot, "vendor/@vibestudio/extension-host");
  rmrf(dest);
  copyTree(distPublish, path.join(dest, "dist"), () => false);
  writeJson(path.join(dest, "package.json"), {
    name: "@vibestudio/extension-host",
    version: VERSION,
    type: "module",
    main: "./dist/index.js",
    exports: {
      ".": { default: "./dist/index.js" },
      "./child-runtime": { default: "./dist/childRuntime.js" },
    },
  });
}

// Vendor the host's own @vibestudio/* packages (from packages/) under vendor/, so
// the package's postinstall can copy them into node_modules where the runtime
// build system resolves the @vibestudio API surface that panels/workers import.
// Excludes extension-host (vendored self-contained). @workspace/* are
// intentionally NOT vendored — they belong to the managed workspace's own build.
function vendorVibestudioPackages(pkgRoot) {
  const packagesDir = path.join(repoRoot, "packages");
  for (const entry of fs.readdirSync(packagesDir)) {
    const manifest = path.join(packagesDir, entry, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const name = readJson(manifest).name;
    if (!name || !name.startsWith("@vibestudio/")) continue;
    if (name === "@vibestudio/extension-host") continue; // self-contained, vendored separately
    const base = name.slice("@vibestudio/".length);
    const dest = path.join(pkgRoot, "vendor", "@vibestudio", base);
    copyTree(path.join(packagesDir, entry), dest, defaultSkip);
    normalizeVendoredManifest(path.join(dest, "package.json"));
  }
}

// Normalize a vendored @vibestudio manifest. Critically, KEEP its workspace:*
// specifiers for inter-@vibestudio/@workspace deps: the runtime build system skips
// workspace:* deps from its registry `npm install` and resolves them from the
// app's node_modules (externalDeps.ts:47). Rewriting them to a concrete version
// would make panel/worker builds try to fetch e.g. @vibestudio/dev-log@0.1.0 from
// the public registry (404). Drop dev-only fields that would otherwise trigger
// lifecycle scripts or extra registry installs. (The package is listed at its
// concrete version at the host package's top level for bundledDependencies.)
function normalizeVendoredManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return VERSION;
  const pkg = readJson(manifestPath);
  delete pkg.devDependencies;
  delete pkg.scripts;
  writeJson(manifestPath, pkg);
  return pkg.version ?? VERSION;
}

// ---------------------------------------------------------------------------
// Workspace template
// ---------------------------------------------------------------------------
function stageWorkspaceTemplate(dest) {
  const src = path.join(repoRoot, "workspace");
  const include = new Set(WORKSPACE_TEMPLATE_DIRS);
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!include.has(entry.name)) continue;
      copyTree(path.join(src, entry.name), path.join(dest, entry.name), templateSkip);
    } else if (entry.isFile() && WORKSPACE_TEMPLATE_ROOT_FILES.includes(entry.name)) {
      copyTree(path.join(src, entry.name), path.join(dest, entry.name), templateSkip);
    }
  }
}

function stageWorkspaceTemplateSupport(pkgRoot) {
  for (const dir of WORKSPACE_TEMPLATE_SUPPORT_DIRS) {
    const src = path.join(repoRoot, dir);
    if (!fs.existsSync(src)) continue;
    copyTree(src, path.join(pkgRoot, dir), defaultSkip);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function defaultSkip(name, dirent) {
  if (dirent.isDirectory()) {
    return (
      name === "node_modules" ||
      name === ".git" ||
      name === "tests" ||
      name === "__tests__" ||
      name === "dist-publish"
    );
  }
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    name.endsWith(".tsbuildinfo") ||
    name.endsWith(".map")
  );
}

function templateSkip(name, dirent) {
  if (dirent.isDirectory()) {
    // Skip build/vcs cruft and the workspace's dot-prefixed runtime dirs. Do NOT
    // skip a plain "state" dir: panels legitimately have state/ source (e.g.
    // workspace/panels/spectrolite/state). The workspace's runtime state lives at
    // the top level and is already excluded by stageWorkspaceTemplate's include-list.
    return (
      name === "node_modules" ||
      name === ".git" ||
      name === ".databases" ||
      name === ".contexts" ||
      name === ".cache"
    );
  }
  return name === ".env" || name === ".secrets.yml";
}

function copyTree(src, dest, skip) {
  const st = fs.statSync(src);
  if (!st.isDirectory()) {
    mkdirp(path.dirname(dest));
    fs.copyFileSync(src, dest);
    return;
  }
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name, entry)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d, skip);
    else if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(s);
      if (fs.statSync(real).isDirectory()) copyTree(real, d, skip);
      else fs.copyFileSync(real, d);
    } else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function copyFile(rel, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(path.join(repoRoot, rel), dest);
}

function resolveVersion(name) {
  // Read the installed package.json directly — require.resolve fails for packages
  // whose `exports` map doesn't expose ./package.json.
  const direct = path.join(repoRoot, "node_modules", ...name.split("/"), "package.json");
  if (fs.existsSync(direct)) return `^${readJson(direct).version}`;
  return rootPkg.dependencies?.[name] ?? rootPkg.devDependencies?.[name] ?? null;
}

// The dependency surface a host package needs to build the default template at
// runtime: all public root.dependencies + the build-relevant root devDeps +
// headless extras. The vendored @vibestudio packages are NOT listed here — they
// ship under vendor/ and are copied into node_modules by the postinstall. The
// server omits electron; the app includes it. (Building panels needs the full
// host dep surface, so the headless server is really "app minus electron".)
function computeHostDependencies({ electron }) {
  const deps = {};
  for (const [name, range] of Object.entries(rootPkg.dependencies ?? {})) {
    if (typeof range === "string" && range.startsWith("workspace:")) continue;
    deps[name] = range;
  }
  for (const name of HOST_BUILD_DEV_DEPS) {
    const v = rootPkg.devDependencies?.[name];
    if (v) deps[name] = v;
  }
  for (const name of SERVER_EXTRA_DEPS) {
    if (deps[name]) continue;
    const v = resolveVersion(name);
    if (v) deps[name] = v;
    else console.warn(`  ⚠ could not resolve a version for ${name}`);
  }
  if (electron) {
    deps["electron"] = rootPkg.devDependencies?.electron ?? resolveVersion("electron");
  }
  return deps;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}
function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}
function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
