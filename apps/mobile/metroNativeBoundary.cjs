const fs = require("fs");
const path = require("path");

function normalize(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function blockedImportFor(blockedImports, moduleName) {
  for (const blocked of Object.keys(blockedImports)) {
    if (moduleName === blocked || moduleName.startsWith(`${blocked}/`)) {
      return blocked;
    }
  }
  return null;
}

function createNativeBoundary(workspaceAppRoot) {
  const appPackage = JSON.parse(
    fs.readFileSync(path.join(workspaceAppRoot, "package.json"), "utf8"),
  );
  const declaration = appPackage.vibestudio?.app?.nativeModulePolicy;
  if (typeof declaration !== "string" || !declaration) {
    throw new Error("Mobile workspace app must declare vibestudio.app.nativeModulePolicy");
  }
  const appRoot = path.resolve(workspaceAppRoot);
  const policyPath = path.resolve(appRoot, declaration);
  if (!policyPath.startsWith(`${appRoot}${path.sep}`)) {
    throw new Error("Mobile native-module policy escapes the workspace app");
  }
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const blockedImports = policy.blockedImports;
  if (!blockedImports || typeof blockedImports !== "object") {
    throw new Error("Mobile native-module-policy.json must declare blockedImports");
  }
  const allowedByModule = new Map(
    Object.entries(blockedImports).map(([moduleName, relativePaths]) => [
      moduleName,
      new Set(relativePaths.map((relativePath) => normalize(path.join(workspaceAppRoot, relativePath)))),
    ]),
  );
  const nativeBootstrap = normalize(path.join(__dirname, "index.js"));
  // Trusted PLATFORM code that runs before any downloaded workspace app bundle
  // is active. It can read pairing links from Clipboard and persist connect-link
  // replay state directly because no capability manifest exists until after
  // pairing + app activation.
  allowedByModule.get("@react-native-clipboard/clipboard")?.add(nativeBootstrap);
  allowedByModule.get("@react-native-async-storage/async-storage")?.add(nativeBootstrap);

  // Trusted PLATFORM code that persists the device's WebRTC shell-reconnect
  // credential directly (not userland workspace surface, so not capability-gated):
  // the native host bootstrap (apps/mobile/index.js) and the shared WebRTC
  // transport package (@vibestudio/mobile-webrtc). Both live OUTSIDE
  // workspaceAppRoot and bundle through this Metro, so they are exempted by
  // absolute path rather than the workspaceAppRoot-relative allowlist above.
  const mobileWebRtcConnect = normalize(
    path.join(__dirname, "..", "..", "packages", "mobile-webrtc", "src", "connect.ts"),
  );
  const mobileWebRtcConnectLink = normalize(
    path.join(__dirname, "..", "..", "packages", "mobile-webrtc", "src", "connectLink.ts"),
  );
  const keychainAllowed = allowedByModule.get("react-native-keychain");
  keychainAllowed?.add(mobileWebRtcConnect);
  const asyncStorageAllowed = allowedByModule.get(
    "@react-native-async-storage/async-storage",
  );
  asyncStorageAllowed?.add(mobileWebRtcConnect);
  asyncStorageAllowed?.add(mobileWebRtcConnectLink);
  // The native host bootstrap (apps/mobile/index.js) is the out-of-tree trusted
  // consumer of the @vibestudio/mobile-webrtc capability; allowlist it by absolute
  // path alongside the workspace-app-relative shell consumers above.
  allowedByModule
    .get("@vibestudio/mobile-webrtc")
    ?.add(nativeBootstrap);

  return {
    guardNativeModuleImport(moduleName, originModulePath) {
      const blocked = blockedImportFor(blockedImports, moduleName);
      if (!blocked) return;
      const origin = originModulePath ? normalize(originModulePath) : "";
      if (allowedByModule.get(blocked)?.has(origin)) return;
      throw new Error(
        `Direct import of native module "${moduleName}" from workspace app code is blocked. ` +
          `Importer: ${origin || "unknown"}. ` +
          "Use the Vibestudio platform-owned wrapper for this native surface.",
      );
    },
  };
}

module.exports = {
  createNativeBoundary,
};
