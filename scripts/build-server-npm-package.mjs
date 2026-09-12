#!/usr/bin/env node
import { DEVELOPMENT_DIST_ENTRIES } from "./build-artifact-contracts.mjs";
// Stage the one publishable npm package from a completed `pnpm build`:
//
//   dist-packages/server  → @panticonic/vibestudio-server  (slim headless server, no electron)
//
// The desktop app is distributed only as a native package — deb/rpm/pacman with
// the AppArmor profile a workspace sandbox needs, a Homebrew cask on macOS, and
// the NSIS installer on Windows. npm remains the route for a headless host that
// no native package covers, which is the one thing it does better than an
// archive: it resolves this host's own native dependencies (node-pty, esbuild,
// ripgrep's fetched binary) instead of shipping every platform's copy.
//
// The monorepo root stays private; this script synthesizes each package.json and
// assembles its file tree. Host @vibestudio/* packages are vendored under
// vendor/ and copied into node_modules by postinstall. @workspace/* packages are
// not host dependencies; userland is acquired from the exact external Base
// release and built by the runtime workspace build system. Userland dependencies
// include packages that require Node >=22.13, so the generated packages declare
// the same floor.
//
// Run AFTER `pnpm build`:  node scripts/build-server-npm-package.mjs
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execPnpmSync } from "./cli/lib/package-manager.mjs";
import { assertNoBundledUserlandSource } from "./packaged-userland-boundary.mjs";
import { STANDALONE_SERVER_RUNTIME_ARTIFACTS } from "./server-runtime-artifacts.mjs";
import { stageNodeRuntime, NODE_RUNTIME_TARGETS } from "./node-runtime-artifacts.mjs";

import { assertNativeIsolationArtifacts } from "./native-isolation-artifacts.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outRoot = path.join(repoRoot, "dist-packages");
const rootPkg = readJson(path.join(repoRoot, "package.json"));
const VERSION = rootPkg.version;
const PUBLIC_SERVER_PACKAGE_NAME = "@panticonic/vibestudio-server";
export const SERVER_RUNTIME_ARTIFACTS = STANDALONE_SERVER_RUNTIME_ARTIFACTS;

// Only run the build when invoked directly (`node scripts/build-server-npm-package.mjs`),
// not when imported (e.g. by the drift-guard test) — importing must be free of
// side effects beyond the cheap top-level reads above.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

async function main() {
  console.log(`Staging ${PUBLIC_SERVER_PACKAGE_NAME} @ v${VERSION}`);
  assertBuilt();
  const nativeArtifacts = assertNativeIsolationArtifacts(repoRoot);
  // This npm package is portable across the supported targets, so retain every
  // pinned Node distribution alongside the complete Unix MXC artifact matrix.
  const nodeRuntimes = await Promise.all(
    NODE_RUNTIME_TARGETS.map((target) => stageNodeRuntime(repoRoot, target))
  );
  buildSelfContainedExtensionHost();
  rmrf(outRoot);
  stageServer(nativeArtifacts, nodeRuntimes);
  assertNoBundledUserlandSource(path.join(outRoot, "server"), "staged server npm package");
  console.log("\n✔ Staged dist-packages/server. Validate with:");
  console.log("    (cd dist-packages/server && npm publish --dry-run)");
}

function assertBuilt() {
  const required = [...SERVER_RUNTIME_ARTIFACTS, "dist/main.cjs", "dist/cli/client.mjs"];
  const missing = required.filter((p) => !fs.existsSync(path.join(repoRoot, p)));
  if (missing.length) {
    throw new Error(`Run \`pnpm build\` first — missing: ${missing.join(", ")}`);
  }
}

function buildSelfContainedExtensionHost() {
  console.log("• Building self-contained @vibestudio/extension-host (publish)…");
  execPnpmSync(["--filter", "@vibestudio/extension-host", "run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, VIBESTUDIO_EXTHOST_PUBLISH: "1" },
  });
}

// ---------------------------------------------------------------------------
// @panticonic/vibestudio-server
// ---------------------------------------------------------------------------
function stageServer(nativeArtifacts, nodeRuntimes) {
  const root = path.join(outRoot, "server");
  console.log(`• Staging ${PUBLIC_SERVER_PACKAGE_NAME}…`);
  mkdirp(root);

  // Server runtime files (see paths.ts / internalDoLoader.ts / headlessHostManager.ts).
  for (const artifact of SERVER_RUNTIME_ARTIFACTS) {
    copyFile(artifact, path.join(root, artifact));
  }
  stageNativeIsolationArtifacts(root, nativeArtifacts);
  for (const runtime of nodeRuntimes) stageNodeRuntimeArtifacts(root, runtime);
  copyTree(path.join(repoRoot, "dist/cli"), path.join(root, "dist/cli"), defaultSkip);
  copyTree(
    path.join(repoRoot, "dist/headless-host"),
    path.join(root, "dist/headless-host"),
    defaultSkip
  );

  stageBaseTemplateRelease(root);

  // Bin shims.
  copyWorkerdWindowsMetadata(root);
  copyFile("scripts/vibestudio-cli-shim.mjs", path.join(root, "scripts/vibestudio-cli-shim.mjs"));
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
      vibestudio: "scripts/vibestudio-cli-shim.mjs",
    },
    engines: { node: ">=22.13.0" },
    files: ["dist", "vendor", "scripts", "build-resources"],
    scripts: { postinstall: "node scripts/vendor-install.mjs" },
    // Full host build-dependency surface (app minus electron).
    dependencies: computeHostDependencies(),
    publishConfig: { access: "public" },
  });
}

function copyWorkerdWindowsMetadata(root) {
  copyFile("scripts/workerd-windows-metadata.mjs", path.join(root, "scripts/workerd-windows-metadata.mjs"));
  copyFile("scripts/workerd.exe.manifest", path.join(root, "scripts/workerd.exe.manifest"));
}

export function assertPassthroughScriptsStaged(root) {
  const required = [
    "scripts/cli/remote-serve.mjs",
    "scripts/cli/remote-doctor.mjs",
    "scripts/cli/lib/server-entry.mjs",
    "scripts/cli/lib/pair-server.mjs",
    "scripts/cli/lib/connect-grammar.generated.mjs",
    "scripts/cli/lib/config-paths.mjs",
    "scripts/cli/lib/smoke-remote-server.mjs",
    "scripts/cli/lib/mobile-native-android.mjs",
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

export function stageBaseTemplateRelease(pkgRoot) {
  copyFile(
    "build-resources/base-template-release.json",
    path.join(pkgRoot, "build-resources/base-template-release.json")
  );
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

// The dependency surface a host package needs to build the default template at
// runtime is the root's declared runtime dependency surface. The vendored
// @vibestudio packages are NOT listed here — they ship under vendor/ and are
// copied into node_modules by the postinstall. Electron is deliberately absent:
// it is a development tool in the monorepo and belongs only to the desktop app,
// which ships as a native package rather than from this registry.
export function computeHostDependencies() {
  const deps = {};
  for (const [name, range] of Object.entries(rootPkg.dependencies ?? {})) {
    if (typeof range === "string" && range.startsWith("workspace:")) continue;
    deps[name] = range;
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

export function stageNativeIsolationArtifacts(root, artifacts) {
  for (const { source, artifact } of artifacts) {
    const destination = path.join(root, artifact);
    mkdirp(path.dirname(destination));
    fs.copyFileSync(source, destination);
    if (!artifact.endsWith(".json") && !artifact.endsWith(".exe")) fs.chmodSync(destination, 0o755);
  }
}

export function stageNodeRuntimeArtifacts(root, runtime) {
  const target = path.basename(runtime.root);
  if (!/^(linux-(x64|arm64)|darwin-arm64|win32-x64)$/u.test(target))
    throw new Error(`Unsupported staged Node runtime target: ${target}`);
  const destination = path.join(root, "dist/node", target);
  mkdirp(path.dirname(destination));
  fs.cpSync(runtime.root, destination, { recursive: true, verbatimSymlinks: true });
}
