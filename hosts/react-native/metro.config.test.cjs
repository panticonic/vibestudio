const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("Metro resolves Vibestudio package roots and subpaths through package exports", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const producer = path.join(repoRoot, "scripts", "build-infrastructure-packages.mjs");
  const originalExecFileSync = childProcess.execFileSync;
  const buildCalls = [];
  childProcess.execFileSync = (...args) => {
    if (args[1]?.[0] === producer) {
      buildCalls.push(args);
    }
    return originalExecFileSync(...args);
  };

  let config;
  try {
    config = require("./metro.config.js");
  } finally {
    childProcess.execFileSync = originalExecFileSync;
  }

  assert.deepEqual(buildCalls, [
    [
      process.execPath,
      [path.join(repoRoot, "scripts", "build-infrastructure-packages.mjs")],
      { cwd: repoRoot, stdio: "inherit" },
    ],
  ]);

  const metroResolver = require("metro-resolver");
  const packageRootOf = (modulePath) => {
    let directory;
    try {
      directory = fs.statSync(modulePath).isDirectory() ? modulePath : path.dirname(modulePath);
    } catch {
      directory = path.dirname(modulePath);
    }
    while (directory !== path.dirname(directory)) {
      const manifestPath = path.join(directory, "package.json");
      if (fs.existsSync(manifestPath)) {
        return {
          rootPath: directory,
          packageJson: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
          packageRelativePath: path.relative(directory, modulePath),
        };
      }
      directory = path.dirname(directory);
    }
    return null;
  };
  const contextFor = (originModulePath) => ({
    allowHaste: false,
    assetExts: new Set(config.resolver.assetExts),
    candidateExts: config.resolver.sourceExts,
    doesFileExist: fs.existsSync,
    disableHierarchicalLookup: false,
    extraNodeModules: config.resolver.extraNodeModules ?? null,
    filePathPrefix: "",
    fileSystemLookup(filePath) {
      try {
        const stats = fs.statSync(filePath);
        return {
          exists: true,
          type: stats.isDirectory() ? "d" : "f",
          realPath: fs.realpathSync(filePath),
        };
      } catch {
        return { exists: false };
      }
    },
    getPackage(packageJsonPath) {
      return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    },
    getPackageForModule: packageRootOf,
    mainFields: config.resolver.resolverMainFields ?? config.resolver.mainFields,
    nodeModulesPaths: config.resolver.nodeModulesPaths,
    originModulePath,
    preferNativePlatform: true,
    resolveAsset: () => null,
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    resolveRequest: config.resolver.resolveRequest,
    sourceExts: config.resolver.sourceExts,
    unstable_conditionNames: config.resolver.unstable_conditionNames,
    unstable_conditionsByPlatform: config.resolver.unstable_conditionsByPlatform,
    unstable_enablePackageExports: config.resolver.unstable_enablePackageExports,
    unstable_logWarning: () => {},
  });
  const resolve = (origin, specifier) =>
    metroResolver.resolve(contextFor(origin), specifier, "ios");
  const mobileEntry = path.join(config.projectRoot, "index.js");
  const rpcEntry = path.join(repoRoot, "packages", "rpc", "src", "index.ts");

  assert.equal(config.resolver.unstable_enablePackageExports, true);
  assert.equal(
    resolve(rpcEntry, "@vibestudio/binary-brand").filePath,
    path.join(repoRoot, "packages", "binary-brand", "src", "browser.js")
  );
  assert.equal(
    resolve(mobileEntry, "@vibestudio/shared/rpcMethods").filePath,
    path.join(repoRoot, "packages", "shared", "src", "rpcMethods.ts")
  );
  assert.throws(() => resolve(mobileEntry, "@vibestudio/shared"));

  const rpcManifest = require(path.join(repoRoot, "packages", "rpc", "package.json"));
  const rpcRootTarget = path.resolve(repoRoot, "packages", "rpc", rpcManifest.exports["."].default);
  const rpcSubpathTarget = path.resolve(
    repoRoot,
    "packages",
    "rpc",
    rpcManifest.exports["./protocol/wsProtocol"].default
  );
  assert.equal(fs.existsSync(rpcRootTarget), true);
  assert.equal(fs.existsSync(rpcSubpathTarget), true);
  assert.equal(resolve(mobileEntry, "@vibestudio/rpc").filePath, rpcRootTarget);
  assert.equal(
    resolve(mobileEntry, "@vibestudio/rpc/protocol/wsProtocol").filePath,
    rpcSubpathTarget
  );
});
