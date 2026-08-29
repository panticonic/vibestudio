import { describe, expect, it, vi } from "vitest";
import { RESUMABLE_GZIP_HEADER } from "@vibestudio/shared/panel/assetHeaders";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: vi.fn() },
  NativeModules: {},
  Platform: { OS: "android" },
}));
vi.mock("react-native-keychain", () => ({}));

import {
  streamArtifactToNative,
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
