import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exactTemplateRoots } from "./exactUserlandRoot";
import { join } from "node:path";

// The Android store is split: the React module exposes the bridge methods and
// owns per-instance write handles; PanelAssetStore owns the on-disk lifecycle.
const androidDir = "../hosts/android/app/src/main/java/app/vibestudio/mobile/";
const androidModule = readFileSync(
  new URL(`${androidDir}VibestudioPanelHostModule.kt`, import.meta.url),
  "utf8"
);
const androidStore = readFileSync(
  new URL(`${androidDir}PanelAssetStore.kt`, import.meta.url),
  "utf8"
);
const android = `${androidModule}\n${androidStore}`;
const ios = readFileSync(
  new URL("../hosts/ios/Vibestudio/VibestudioPanelHost.mm", import.meta.url),
  "utf8"
);
const tcpPatch = readFileSync(
  new URL("../patches/react-native-tcp-socket.patch", import.meta.url),
  "utf8"
);
const facade = readFileSync(
  join(exactTemplateRoots.system, "clients/mobile-browser/src/services/panelAssetFacade.ts"),
  "utf8"
);
const store = readFileSync(
  join(exactTemplateRoots.system, "clients/mobile-browser/src/services/mobileAssetStore.ts"),
  "utf8"
);

describe("native mobile asset store contract", () => {
  it.each([
    ["Android", android],
    ["iOS", ios],
  ])("implements the durable lifecycle symmetrically on %s", (_platform, source) => {
    for (const method of [
      "assetStoreLookup",
      "assetStoreOpenWrite",
      "assetStoreAppend",
      "assetStoreCommit",
      "assetStoreAbort",
      "assetStoreTrim",
      "assetStoreClear",
    ]) {
      expect(source).toContain(method);
    }
    expect(source).toContain("serverEndpointId");
    expect(source).not.toContain("serverIdentity");
    expect(source).toContain("workspaceIdentity");
    expect(source).toContain("vibestudio-panel-assets");
    expect(source).toContain("vibestudio-asset-v1:");
  });

  it("uses the same Iroh Endpoint ID namespace field in JavaScript and both native stores", () => {
    for (const implementation of [store, android, ios]) {
      expect(implementation).toContain("serverEndpointId");
      expect(implementation).not.toContain("serverIdentity");
    }
  });

  it("keeps Android indexes backed up while excluding reconstructable payloads", () => {
    expect(androidStore).toContain("context.filesDir");
    expect(androidStore).toContain("context.noBackupFilesDir");
    expect(android).toContain("assetIndexRoot().deleteRecursively()");
    expect(android).toContain("assetPayloadRoot().deleteRecursively()");
    expect(tcpPatch).toContain("getNoBackupFilesDir()");
  });

  it("rejects oversized and no-store artifacts before returning a stored handle", () => {
    const androidLimit = androidStore.indexOf("size <= MAX_ASSET_STORE_BYTES");
    const androidResult = androidStore.indexOf(
      "storedAssetResult(digest, size, metadataJson)",
      androidLimit
    );
    expect(androidLimit).toBeGreaterThan(0);
    expect(androidResult).toBeGreaterThan(androidLimit);
    expect(androidStore).toContain('"no-store" !in cacheDirectives');

    const iosLimit = ios.indexOf("size > VibestudioAssetStoreMaxBytes");
    const iosResult = ios.indexOf("storedAssetResult:digest", iosLimit);
    expect(iosLimit).toBeGreaterThan(0);
    expect(iosResult).toBeGreaterThan(iosLimit);
    expect(ios).toContain("!immutable || noStore");
  });

  it("requires a real JSON boolean for iOS gzip metadata", () => {
    expect(ios).toContain("CFGetTypeID((__bridge CFTypeRef)gzip) != CFBooleanGetTypeID()");
  });

  it("does not abort active populations during memory-pressure trim", () => {
    const androidTrim = androidModule.slice(
      androidModule.indexOf("fun assetStoreTrim"),
      androidModule.indexOf("fun assetStoreClear")
    );
    const androidStoreTrim = androidStore.slice(
      androidStore.indexOf("fun trim("),
      androidStore.indexOf("fun clear()")
    );
    expect(androidStoreTrim).not.toContain("abortAll");
    const iosTrim = ios.slice(
      ios.indexOf("RCT_EXPORT_METHOD(assetStoreTrim"),
      ios.indexOf("RCT_EXPORT_METHOD(assetStoreClear")
    );
    expect(androidTrim).not.toContain("abortAllAssetWrites");
    expect(iosTrim).not.toContain("abortAllAssetWrites");
    expect(androidStore).toContain("abortAll()\n            assetIndexRoot().deleteRecursively()");
    expect(androidStore).toContain(
      'check(assetWrites.isEmpty()) { "Asset-store clear left active write handles" }'
    );
    expect(ios).toContain(
      "[self abortAllAssetWrites];\n    [NSFileManager.defaultManager removeItemAtURL"
    );
    expect(ios).toContain("Asset-store clear left active write handles");
  });

  it("turns a restored dangling index mapping into a self-healing miss", () => {
    expect(androidStore).toContain(
      "entries.remove(entryKey)\n            writeAssetIndex(namespaceKey, index)\n            return null"
    );
    expect(ios).toContain(
      "[entries removeObjectForKey:entryKey];\n    [self writeAssetIndex:index namespace:namespaceKey];\n    return nil;"
    );
    expect(androidStore).not.toContain(
      'throw IllegalStateException("Asset-store index points to a missing or truncated blob")'
    );
    expect(ios).not.toContain('format:@"Asset-store index points to a missing or truncated blob"');
  });

  it("exposes only opaque handles to JS and resolves them under fixed native roots", () => {
    expect(tcpPatch).toContain('digest.matches("^[a-f0-9]{64}$")');
    expect(tcpPatch).toContain('getNoBackupFilesDir(), "vibestudio-panel-assets/blobs"');
    expect(tcpPatch).toContain('@"^[a-f0-9]{64}$"');
    expect(tcpPatch).toContain('@"vibestudio-panel-assets"');
    expect(tcpPatch).toContain("stringByResolvingSymlinksInPath");
    expect(tcpPatch).not.toContain("writeStoredAsset(final int cId, @NonNull final String path");
  });

  it("streams native hits without retaining the former Hermes memory cache", () => {
    expect(facade).toContain("socket.writeStoredAsset(asset.handle");
    expect(facade).not.toContain("MobileAssetMemoryCache");
    expect(tcpPatch).toContain("new byte[64 * 1024]");
    expect(tcpPatch).toContain("didWriteDataWithTag");
    expect(tcpPatch).toContain("[self writeNextFileChunk]");
  });

  it("claims Android sockets atomically before concurrent teardown", () => {
    expect(tcpPatch).toContain("final Socket socketToClose;");
    expect(tcpPatch).toContain("synchronized (this)");
    expect(tcpPatch).toContain("socketToClose = socket;");
    expect(tcpPatch).toContain("socket = null;");
    expect(tcpPatch).not.toContain("+            if (socket != null && !socket.isClosed())");

    const androidWriter = tcpPatch.slice(
      tcpPatch.indexOf("+    public void writeFile"),
      tcpPatch.indexOf("+    public ReadableMap getPeerCertificate")
    );
    expect(androidWriter).toContain("final Socket socketToWrite;");
    expect(androidWriter).toContain("synchronized (TcpSocketClient.this)");
    expect(androidWriter).toContain("socketToWrite = socket;");
    expect(androidWriter).toContain("final OutputStream output = socketToWrite.getOutputStream();");
    expect(androidWriter).not.toContain("socket.getOutputStream()");
  });

  it("emits credential-safe request telemetry needed to prove warm hits", () => {
    expect(facade).toContain("workspace-panel-asset-store-hit");
    expect(facade).toContain("workspace-panel-asset-pipe-miss");
    expect(facade).toContain("workspace-panel-cacheable-asset-pipe-miss");
    expect(facade).toContain("workspace-panel-asset-no-store");
    for (const field of [
      "routeClass",
      "cacheKeyHash",
      "tier",
      "cacheableResponse",
      "transferredBytes",
      "bridgeCrossings",
      "ttfbMs",
      "totalMs",
    ]) {
      expect(facade).toContain(field);
    }
    expect(facade).toContain('tier = "store-hit"');
    expect(facade).not.toContain("route: gatewayPath");
    expect(facade).not.toContain("cacheKey: cacheKey");
  });
});
