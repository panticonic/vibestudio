import { describe, expect, it, vi } from "vitest";
import { RESUMABLE_GZIP_HEADER } from "@vibestudio/shared/panel/assetHeaders";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: vi.fn() },
  NativeModules: {},
  Platform: { OS: "android" },
}));
vi.mock("react-native-keychain", () => ({}));
vi.mock("./connect.js", () => ({
  loadShellCredential: async () => ({
    schemaVersion: 5,
    phase: "routed",
    credential: { deviceId: "device", refreshToken: "test-token" },
  }),
}));

import {
  streamArtifactToNative,
  selectPlatformArtifacts,
  activateApprovedWorkspaceApp,
  RN_HOST_ABI,
  type BundleDeliveryRpc,
  type NativeBundleHost,
} from "./bundleDelivery.js";

function response(chunks: Uint8Array[], start: number, total: number) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return {
    status: 206,
    headers: [
      ["x-vibestudio-content-gzip", "1"],
      ["content-range", `bytes ${start}-${start + length - 1}/${total}`],
    ] as Array<[string, string]>,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

function nativeHost(): NativeBundleHost {
  return {
    openSafariBrowserDataExport: vi.fn(async () => ({ opened: false })),
    pickBrowserImportArchive: vi.fn(async () => null),
    readBrowserImportEntry: vi.fn(async () => ({ dataBase64: "", eof: true })),
    releaseBrowserImportArchive: vi.fn(async () => undefined),
    appendBundleChunk: vi.fn(async () => undefined),
    finalizeBundleWrite: vi.fn(),
    activatePreparedAppBundle: vi.fn(),
    reloadActiveAppBundle: vi.fn(),
  };
}

describe("mobile bundle delivery over Iroh", () => {
  it("streams one open-ended response into native storage with per-chunk backpressure", async () => {
    const rpc = {
      streamReadable: vi.fn(async () =>
        response([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])], 0, 5)
      ),
    } as unknown as BundleDeliveryRpc;
    const host = nativeHost();
    const transfer = { offset: 0 };

    await expect(
      streamArtifactToNative(
        rpc,
        host,
        { path: "/bundle", method: "GET" },
        "build",
        "index.bundle",
        transfer
      )
    ).resolves.toBe(true);

    expect(transfer.offset).toBe(5);
    expect(rpc.streamReadable).toHaveBeenCalledTimes(1);
    expect(rpc.streamReadable).toHaveBeenCalledWith("main", "gateway.fetch", [
      {
        path: "/bundle",
        method: "GET",
        gzip: true,
        headers: { [RESUMABLE_GZIP_HEADER]: "1", Range: "bytes=0-" },
      },
    ]);
    expect(host.appendBundleChunk).toHaveBeenNthCalledWith(
      1,
      "AQI=",
      "build",
      "index.bundle",
      true
    );
    expect(host.appendBundleChunk).toHaveBeenNthCalledWith(
      2,
      "AwQF",
      "build",
      "index.bundle",
      false
    );
  });

  it("resumes from the last native-acknowledged byte without restarting the artifact", async () => {
    let first = true;
    const rpc = {
      streamReadable: vi.fn(async () => {
        if (!first) return response([new Uint8Array([3, 4])], 2, 4);
        first = false;
        return {
          status: 206,
          headers: [
            ["x-vibestudio-content-gzip", "1"],
            ["content-range", "bytes 0-3/4"],
          ],
          body: new ReadableStream<Uint8Array>({
            pull: (() => {
              let delivered = false;
              return (controller: ReadableStreamDefaultController<Uint8Array>) => {
                if (!delivered) {
                  delivered = true;
                  controller.enqueue(new Uint8Array([1, 2]));
                  return;
                }
                controller.error(
                  Object.assign(new Error("connection lost"), { code: "CONNECTION_LOST" })
                );
              };
            })(),
          }),
        };
      }),
    } as unknown as BundleDeliveryRpc;
    const host = nativeHost();
    const transfer = { offset: 0 };

    await expect(
      streamArtifactToNative(rpc, host, { path: "/bundle" }, "build", "index.bundle", transfer)
    ).rejects.toThrow("connection lost");
    expect(transfer.offset).toBe(2);

    await expect(
      streamArtifactToNative(rpc, host, { path: "/bundle" }, "build", "index.bundle", transfer)
    ).resolves.toBe(true);
    expect(transfer.offset).toBe(4);
    expect(rpc.streamReadable).toHaveBeenLastCalledWith("main", "gateway.fetch", [
      expect.objectContaining({ headers: expect.objectContaining({ Range: "bytes=2-" }) }),
    ]);
    expect(host.appendBundleChunk).toHaveBeenLastCalledWith("AwQ=", "build", "index.bundle", false);
  });
});

describe("complete native app artifact delivery", () => {
  function artifact(path: string, role = "asset", platform = "android") {
    return {
      path,
      role,
      platform,
      integrity: `sha256-${"a".repeat(64)}`,
      url: `https://host.test/_a/build/${path}`,
    };
  }
  it("preserves the runnable platform tree and rejects path collisions before transfer", () => {
    const primary = artifact("android/index.bundle", "primary");
    const image = artifact("android/drawable-mdpi/logo.png");
    expect(
      selectPlatformArtifacts(
        { artifacts: [primary, image, artifact("ios/index.bundle", "primary", "ios")] },
        "android"
      )
    ).toEqual({ primary, artifacts: [primary, image] });
    for (const path of [
      "../logo.png",
      "/logo.png",
      "android/../logo.png",
      "android//logo.png",
      "android\\logo.png",
      primary.path,
    ]) {
      expect(() =>
        selectPlatformArtifacts({ artifacts: [primary, artifact(path)] }, "android")
      ).toThrow(/invalid or duplicate/);
    }
  });
  it("verifies every platform asset before activating the primary bundle", async () => {
    const artifacts = [
      artifact("android/index.bundle", "primary"),
      artifact("android/drawable-mdpi/logo.png"),
      artifact("ios/index.bundle", "primary", "ios"),
    ];
    const events: string[] = [];
    const rpc = {
      // The manifest arrives over RPC; only the artifact bytes still stream
      // through the gateway.
      call: vi.fn(async () => ({
        bootstrap: { buildKey: "build", rnHostAbi: RN_HOST_ABI, artifacts },
      })),
      streamReadable: vi.fn(async (_target, _method, args) => {
        events.push(args[0].path);
        return response([new Uint8Array([1])], 0, 1);
      }),
    } as unknown as BundleDeliveryRpc;
    const host = nativeHost();
    let path = "";
    host.appendBundleChunk = vi.fn(async (_bytes, _build, artifactPath) => {
      path = artifactPath;
    });
    host.finalizeBundleWrite = vi.fn(async () => {
      events.push(`verified:${path}`);
      return { localPath: `/cache/build/${path}` };
    });
    host.activatePreparedAppBundle = vi.fn(async () => {
      events.push("activate");
      return { activated: true };
    });
    const transport = { rpc, close: vi.fn(async () => undefined) };
    await activateApprovedWorkspaceApp(transport, { nativeHost: host });
    expect(events).toEqual([
      "/_a/build/android/index.bundle",
      "verified:android/index.bundle",
      "/_a/build/android/drawable-mdpi/logo.png",
      "verified:android/drawable-mdpi/logo.png",
      "activate",
    ]);
    expect(host.activatePreparedAppBundle).toHaveBeenCalledWith(
      "/cache/build/android/index.bundle",
      "build",
      artifacts[0]!.integrity
    );
  });
});
