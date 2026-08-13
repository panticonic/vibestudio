/**
 * The React Native app's tests live in Base; its test runner lives here.
 *
 * The host keeps the native shell and the only React Native jest preset in the
 * repository, while `apps/mobile/src` and its 39 test files are userland. So
 * this config resolves the selected Base checkout exactly as `test:userland`
 * and `type-check:userland` do, and points the RN runner at it. Without it the
 * host runs jest over a directory with no tests and Base has no runner at all,
 * which is how these tests stopped running after the external-Base cutover.
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * Base's own `@workspace/*` packages, resolved from the subpath `exports` each
 * one declares. Reading the manifests keeps this correct as Base adds packages
 * and entry points; a transcribed list is what silently rots.
 */
function workspacePackageAliases(baseRoot) {
  const packagesDir = path.join(baseRoot, "packages");
  const aliases = {};
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(
        fs.readFileSync(path.join(packagesDir, entry.name, "package.json"), "utf8")
      );
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@workspace/")) continue;
    const declared =
      manifest.exports && typeof manifest.exports === "object" ? manifest.exports : {};
    for (const [subpath, target] of Object.entries(declared)) {
      const file =
        typeof target === "string" ? target : (target?.default ?? target?.import ?? target?.require);
      if (typeof file !== "string") continue;
      const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      aliases[`^${specifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`] = path.join(
        packagesDir,
        entry.name,
        file
      );
    }
  }
  return aliases;
}

const repoRoot = path.resolve(__dirname, "..", "..");
const {
  requireDevelopmentBaseCheckout,
} = require(path.join(repoRoot, "src/dev/developmentBaseConfig.cjs"));

const baseRoot = requireDevelopmentBaseCheckout(repoRoot);
const mobileRoot = path.join(baseRoot, "apps", "mobile");
const hostModules = path.join(repoRoot, "node_modules");
const packageSource = (name) => path.join(repoRoot, "packages", name, "src");

module.exports = {
  preset: "react-native",
  // rootDir stays in the host so the preset, its transforms, and every bare
  // module name still resolve against the host install. Only test discovery
  // points at userland.
  rootDir: __dirname,
  roots: [mobileRoot],
  setupFilesAfterEnv: [path.join(mobileRoot, "jest.setup.ts")],
  // Babel resolves config from the file being compiled, which now lives in
  // Base — and Base declares no babel config, so React Native's own Flow-typed
  // sources would go through untransformed. Name the host's config explicitly.
  transform: {
    "^.+\\.[jt]sx?$": [
      require.resolve("babel-jest"),
      { configFile: path.join(__dirname, "babel.config.js") },
    ],
  },
  // React Native and its ecosystem ship untranspiled sources that must be
  // compiled rather than ignored, as does every workspace package under test.
  transformIgnorePatterns: [
    "node_modules/(?!(?:\\.pnpm/)?(?:@react-native|react-native|@react-navigation|@notifee|@vibestudio))",
  ],
  // Resolve React, React Native, and the platform packages from the host
  // install. Base declares them, but only one copy may be loaded or React
  // Native's renderer and the platform's singletons split in two.
  moduleNameMapper: {
    "^jotai$": path.join(hostModules, "jotai"),
    "^jotai/(.*)$": path.join(hostModules, "jotai", "$1"),
    "^react$": path.join(hostModules, "react"),
    "^react/(.*)$": path.join(hostModules, "react", "$1"),
    "^react-native$": path.join(hostModules, "react-native"),
    "^react-test-renderer$": path.join(hostModules, "react-test-renderer"),
    "^@vibestudio/mobile-webrtc$": path.join(packageSource("mobile-webrtc"), "index.ts"),
    "^@vibestudio/rpc$": path.join(packageSource("rpc"), "index.ts"),
    "^@vibestudio/rpc/(.*)$": path.join(packageSource("rpc"), "$1"),
    "^@vibestudio/shared$": path.join(packageSource("shared"), "index.ts"),
    "^@vibestudio/shared/(.*)$": path.join(packageSource("shared"), "$1"),
    "^@vibestudio/shell-core$": path.join(packageSource("shell-core"), "index.ts"),
    "^@vibestudio/shell-core/(.*)$": path.join(packageSource("shell-core"), "$1"),
    "^@vibestudio/service-schemas/(.*)$": path.join(packageSource("service-schemas"), "$1"),
    "^@vibestudio/browser-data$": path.join(packageSource("browser-data"), "index.ts"),
    "^@vibestudio/browser-data/(.*)$": path.join(packageSource("browser-data"), "$1"),
    ...workspacePackageAliases(baseRoot),
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  modulePaths: [hostModules],
};
