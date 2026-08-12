import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { BuildProviderInput } from "@vibestudio/shared/buildProvider";

interface NativeModulePolicy {
  blockedImports: Record<string, string[]>;
}

const require = createRequire(import.meta.url);

export function writeProjectedMetroConfig(input: BuildProviderInput, tempDir: string): string {
  const nodeModulesPath = input.dependencyProjection.nodeModulesPath;
  if (!nodeModulesPath) {
    throw new Error("React Native builds require a Build V2 dependency projection");
  }
  const app = appManifest(input);
  const policy = readNativeModulePolicy(input.sourcePath, app["nativeModulePolicy"]);
  const metroConfigPackage = require.resolve("@react-native/metro-config");
  const configPath = path.join(tempDir, "metro.config.cjs");
  const data = JSON.stringify({
    sourcePath: input.sourcePath,
    nodeModulesPath,
    modules: input.dependencyProjection.modules,
    policy,
    metroConfigPackage,
  });
  fs.writeFileSync(configPath, metroConfigSource(data));
  return configPath;
}

function appManifest(input: BuildProviderInput): Record<string, unknown> {
  return input.manifest["app"] && typeof input.manifest["app"] === "object"
    ? (input.manifest["app"] as Record<string, unknown>)
    : input.manifest;
}

function readNativeModulePolicy(sourcePath: string, declaration: unknown): NativeModulePolicy {
  if (typeof declaration !== "string" || declaration.length === 0) {
    return { blockedImports: {} };
  }
  const appRoot = path.resolve(sourcePath);
  const policyPath = path.resolve(appRoot, declaration);
  if (!policyPath.startsWith(`${appRoot}${path.sep}`)) {
    throw new Error("React Native nativeModulePolicy escapes the app source");
  }
  const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8")) as Partial<NativeModulePolicy>;
  if (!parsed.blockedImports || typeof parsed.blockedImports !== "object") {
    throw new Error("React Native nativeModulePolicy must declare blockedImports");
  }
  for (const [moduleName, importers] of Object.entries(parsed.blockedImports)) {
    if (
      !moduleName ||
      !Array.isArray(importers) ||
      importers.some((item) => typeof item !== "string")
    ) {
      throw new Error("React Native nativeModulePolicy contains an invalid blocked import");
    }
  }
  return { blockedImports: parsed.blockedImports };
}

function metroConfigSource(data: string): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const data = ${data};
const { getDefaultConfig, mergeConfig } = require(data.metroConfigPackage);
const normalize = (value) => path.resolve(value).replace(/\\\\/g, "/");
const moduleNames = Object.keys(data.modules).sort((left, right) => right.length - left.length);
const allowedByModule = new Map(
  Object.entries(data.policy.blockedImports).map(([moduleName, importers]) => [
    moduleName,
    new Set(importers.map((importer) => normalize(path.join(data.sourcePath, importer)))),
  ]),
);
const mobileWebRtc = data.modules["@vibestudio/mobile-webrtc"];
if (mobileWebRtc) {
  allowedByModule.get("react-native-keychain")?.add(normalize(path.join(mobileWebRtc, "src/connect.ts")));
  allowedByModule.get("@react-native-async-storage/async-storage")?.add(
    normalize(path.join(mobileWebRtc, "src/connect.ts")),
  );
  allowedByModule.get("@react-native-async-storage/async-storage")?.add(
    normalize(path.join(mobileWebRtc, "src/connectLink.ts")),
  );
}
const blockedImportFor = (moduleName) =>
  Object.keys(data.policy.blockedImports).find(
    (blocked) => moduleName === blocked || moduleName.startsWith(blocked + "/"),
  );
const guardNativeImport = (moduleName, originModulePath) => {
  const blocked = blockedImportFor(moduleName);
  if (!blocked) return;
  const origin = originModulePath ? normalize(originModulePath) : "";
  if (allowedByModule.get(blocked)?.has(origin)) return;
  throw new Error(
    'Direct import of native module "' + moduleName + '" from workspace app code is blocked. ' +
      'Importer: ' + (origin || "unknown") + '. Use the Vibestudio platform-owned wrapper for this native surface.',
  );
};
const projectedPackage = (moduleName) =>
  moduleNames.find((name) => moduleName === name || moduleName.startsWith(name + "/"));
const polyfills = {
  path: require.resolve("path-browserify", { paths: [data.nodeModulesPath] }),
  crypto: path.join(data.sourcePath, "src/polyfills/crypto.js"),
  fs: path.join(data.sourcePath, "src/polyfills/fs.js"),
  "node:crypto": path.join(data.sourcePath, "src/polyfills/crypto.js"),
  "node:path": require.resolve("path-browserify", { paths: [data.nodeModulesPath] }),
  "node:fs": path.join(data.sourcePath, "src/polyfills/fs.js"),
};
const config = {
  watchFolders: [...new Set([
    data.sourcePath,
    data.nodeModulesPath,
    ...Object.values(data.modules),
  ])].filter((candidate) => fs.existsSync(candidate)),
  resolver: {
    nodeModulesPaths: [data.nodeModulesPath],
    extraNodeModules: data.modules,
    resolveRequest(context, moduleName, platform) {
      guardNativeImport(moduleName, context.originModulePath);
      if (polyfills[moduleName]) return { type: "sourceFile", filePath: polyfills[moduleName] };
      if (
        moduleName === "react" ||
        moduleName === "react/jsx-runtime" ||
        moduleName === "react/jsx-dev-runtime" ||
        moduleName === "react-native-webrtc" ||
        moduleName.startsWith("react-native-webrtc/")
      ) {
        return context.resolveRequest(
          context,
          path.join(data.nodeModulesPath, ...moduleName.split("/")),
          platform,
        );
      }
      if (moduleName === "react-native-screens") {
        return {
          type: "sourceFile",
          filePath: path.join(
            data.nodeModulesPath,
            "react-native-screens/lib/commonjs/index.js",
          ),
        };
      }
      const packageName = projectedPackage(moduleName);
      if (packageName) {
        const packageRoot = data.modules[packageName];
        const rawSubpath = moduleName.slice(packageName.length);
        const subpath = rawSubpath.startsWith("/") ? rawSubpath.slice(1) : rawSubpath;
        const sourceRoot = path.join(packageRoot, "src");
        if (fs.existsSync(sourceRoot)) {
          const sourceTarget = subpath
            ? path.join(sourceRoot, subpath)
            : path.join(sourceRoot, "index.ts");
          return context.resolveRequest(context, sourceTarget, platform);
        }
        return context.resolveRequest(
          context,
          subpath ? path.join(packageRoot, subpath) : packageRoot,
          platform,
        );
      }
      if (
        moduleName.endsWith(".js") &&
        (moduleName.startsWith("./") || moduleName.startsWith("../") || moduleName.startsWith("/"))
      ) {
        try {
          return context.resolveRequest(context, moduleName.slice(0, -3), platform);
        } catch {}
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};
module.exports = mergeConfig(getDefaultConfig(data.sourcePath), config);
`;
}
