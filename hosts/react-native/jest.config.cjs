/**
 * The React Native clients' tests live in the System template; their test runner lives here.
 *
 * The host keeps the native shell and the only React Native jest preset in the
 * repository, while `clients/mobile-browser`, `clients/chat-mobile` and `packages/client-kit-native`
 * (and their test files) are userland. So this config resolves the selected
 * Base and System checkouts exactly as `test:userland` and
 * `type-check:userland` do, and points the RN runner at them. Without it the
 * host runs jest over a directory with no tests and the template has no runner
 * for them at all.
 *
 * Host-runtime tests (`hosts/react-native/src/**`, `packages/rn-client-api`)
 * are plain TypeScript with injected ports and run in the host vitest suite.
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
        typeof target === "string"
          ? target
          : (target?.default ?? target?.import ?? target?.require);
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

/**
 * Registry dependencies declared by Base packages, materialized the same way
 * `test:userland` and `type-check:userland` materialize them.
 *
 * The clients themselves stay out of that projection — their React pin and
 * their native modules must come from the APK's own install — but the
 * *libraries* they import are ordinary userland units, and their npm
 * dependencies have to be resolvable or the RN runner cannot load them at all.
 */
function userlandDependencyModules(selectedTemplates) {
  const { register } = require(require.resolve("tsx/cjs/api", { paths: [repoRoot] }));
  const unregister = register();
  try {
    const { prepareUserlandDependencyProjection } = require(
      path.join(repoRoot, "scripts/lib/userland-dependency-projection.ts")
    );
    const { composeDevelopmentTemplateCheckouts } = require(
      path.join(repoRoot, "src/dev/developmentTemplateComposition.ts")
    );
    const composition = composeDevelopmentTemplateCheckouts(
      selectedTemplates.sources
        .filter(({ id }) => id === "base" || id === "system")
        .map(({ id, url }) => ({ checkout: selectedTemplates.checkouts[id], url }))
    );
    return prepareUserlandDependencyProjection({
      appRoot: repoRoot,
      workspaceRoot: composition.root,
      includeDevelopmentDependencies: true,
    }).then((projection) => ({
      ...projection,
      release() {
        projection.release();
        composition.release();
      },
    }));
  } finally {
    unregister();
  }
}
const { requireDevelopmentTemplateCheckouts } = require(
  path.join(repoRoot, "src/dev/developmentTemplateConfig.cjs")
);

const selectedTemplates = requireDevelopmentTemplateCheckouts(repoRoot);
const templateRoots = selectedTemplates.checkouts;
const { REACT_NATIVE_JEST_SUITE_ROOTS } = require("./jestSuiteRoots.cjs");
const suiteRoots = REACT_NATIVE_JEST_SUITE_ROOTS.map((relative) =>
  path.join(templateRoots.system, relative)
);
const mobileBrowserRoot = path.join(templateRoots.system, "clients", "mobile-browser");
const hostModules = path.join(repoRoot, "node_modules");
const packageSource = (name) => path.join(repoRoot, "packages", name, "src");

module.exports = (async () => {
  const projection = await userlandDependencyModules(selectedTemplates);
  // The projection is a lease on the content-addressed cache, recorded durably.
  // Holding it for the run is the point; keeping it after the run would pin the
  // entry against pruning forever.
  process.on("exit", () => projection.release());
  return {
    preset: "react-native",
    // rootDir stays in the host so the preset, its transforms, and every bare
    // module name still resolve against the host install. Only test discovery
    // points at userland.
    rootDir: __dirname,
    roots: suiteRoots,
    // The kit's tests render through the same native mocks as the browser's.
    setupFilesAfterEnv: [path.join(mobileBrowserRoot, "jest.setup.ts")],
    // Babel resolves config from the file being compiled, which now lives in
    // Base — and Base declares no babel config, so React Native's own Flow-typed
    // sources would go through untransformed. Name the host's config explicitly.
    transform: {
      "^.+\\.[jt]sx?$": [
        require.resolve("babel-jest"),
        {
          configFile: path.join(__dirname, "babel.config.js"),
          // Jest executes CommonJS in its VM. Compile lazy schema imports into
          // that same module system so they use Jest's resolver and transforms.
          plugins: [require.resolve("@babel/plugin-transform-dynamic-import")],
        },
      ],
    },
    // React Native and its ecosystem ship untranspiled sources that must be
    // compiled rather than ignored, as does every workspace package under test.
    transformIgnorePatterns: [
      // transformIgnorePatterns is an OR: one pattern, one allowlist. The
      // unified/micromark half exists because that ecosystem ships ESM with no
      // CJS fallback, so jest must compile it like any other source under test.
      "node_modules/(?!(?:\\.pnpm/)?(?:@react-native|react-native|@react-navigation|@notifee|@vibestudio|mdast-util-[^/]+|micromark[^/]*|unist-util-[^/]+|character-entities[^/]*|decode-named-character-reference|devlop|ccount|escape-string-regexp|longest-streak|markdown-table|zwitch))",
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
      "^@vibestudio/mobile-iroh$": path.join(packageSource("mobile-iroh"), "index.ts"),
      "^@vibestudio/rn-client-api$": path.join(packageSource("rn-client-api"), "index.ts"),
      "^@vibestudio/rn-client-api/(.*)$": path.join(packageSource("rn-client-api"), "$1"),
      "^@vibestudio/rpc$": path.join(packageSource("rpc"), "index.ts"),
      "^@vibestudio/rpc/(.*)$": path.join(packageSource("rpc"), "$1"),
      "^@vibestudio/shared$": path.join(packageSource("shared"), "index.ts"),
      "^@vibestudio/shared/(.*)$": path.join(packageSource("shared"), "$1"),
      "^@vibestudio/shell-core$": path.join(packageSource("shell-core"), "index.ts"),
      "^@vibestudio/shell-core/(.*)$": path.join(packageSource("shell-core"), "$1"),
      "^@vibestudio/service-schemas/(.*)$": path.join(packageSource("service-schemas"), "$1"),
      "^@vibestudio/browser-data$": path.join(packageSource("browser-data"), "index.ts"),
      "^@vibestudio/browser-data/(.*)$": path.join(packageSource("browser-data"), "$1"),
      ...workspacePackageAliases(templateRoots.base),
      ...workspacePackageAliases(templateRoots.system),
      "^(\\.{1,2}/.*)\\.js$": "$1",
    },
    modulePaths: [hostModules, projection.nodeModulesDir],
  };
})();
