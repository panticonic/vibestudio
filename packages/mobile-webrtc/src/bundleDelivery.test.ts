import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  NativeModules: {},
  Platform: { OS: "android" },
}));

vi.mock("./connect.js", () => ({
  loadShellCredential: vi.fn(async () => ({
    schemaVersion: 4,
    phase: "routed",
    credential: {
      deviceId: "device-1",
      refreshToken: "refresh-1",
    },
  })),
}));

import { activateApprovedWorkspaceApp, type NativeBundleHost } from "./bundleDelivery.js";

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("workspace bundle delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("commits one validated bounded response to the native host", async () => {
    const artifact = Uint8Array.from({ length: 20_000 }, (_, index) => index % 251);
    const bootstrap = new TextEncoder().encode(
      JSON.stringify({
        bootstrap: {
          rnHostAbi: "rn-host-3",
          buildKey: "build-1",
          capabilities: [],
          artifacts: [
            {
              role: "primary",
              platform: "android",
              path: "index.android.bundle",
              url: "https://example.test/index.android.bundle",
              integrity: `sha256-${"0".repeat(64)}`,
            },
          ],
        },
      })
    );
    const appendBundleChunk = vi.fn<NativeBundleHost["appendBundleChunk"]>(async () => {});
    const lifecycle: string[] = [];
    const nativeHost: NativeBundleHost = {
      appendBundleChunk,
      finalizeBundleWrite: vi.fn(async () => ({ localPath: "/tmp/index.android.bundle" })),
      activatePreparedAppBundle: vi.fn(async () => {
        lifecycle.push("activate");
        return { activated: true };
      }),
      reloadActiveAppBundle: vi.fn(async () => {
        lifecycle.push("reload");
        return { reloading: true };
      }),
    };
    const streamReadable = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, headers: [], body: byteStream(bootstrap) })
      .mockResolvedValueOnce({
        status: 206,
        headers: [
          ["x-vibestudio-content-gzip", "1"],
          ["content-range", `bytes 0-${artifact.length - 1}/${artifact.length}`],
        ],
        body: byteStream(artifact),
      });

    await activateApprovedWorkspaceApp(
      {
        streamReadable,
        close: async () => {
          lifecycle.push("close");
        },
      },
      { nativeHost }
    );

    const writes = appendBundleChunk.mock.calls.map(([base64]) =>
      Uint8Array.from(Buffer.from(base64, "base64"))
    );
    expect(writes.map((bytes) => bytes.length)).toEqual([20_000]);
    expect(appendBundleChunk.mock.calls.map((call) => call[3])).toEqual([true]);
    const reconstructed = new Uint8Array(writes.reduce((sum, bytes) => sum + bytes.length, 0));
    let offset = 0;
    for (const bytes of writes) {
      reconstructed.set(bytes, offset);
      offset += bytes.length;
    }
    expect(reconstructed).toEqual(artifact);
    expect(lifecycle).toEqual(["activate", "close", "reload"]);
  });

  it("stays below the one-MiB native delivery boundary while bounding round trips", async () => {
    const total = 1024 * 1024 + 17;
    const artifact = Uint8Array.from({ length: total }, (_, index) => index % 251);
    const bootstrap = new TextEncoder().encode(
      JSON.stringify({
        bootstrap: {
          rnHostAbi: "rn-host-3",
          buildKey: "build-windowed",
          capabilities: [],
          artifacts: [
            {
              role: "primary",
              platform: "android",
              path: "index.android.bundle",
              url: "https://example.test/index.android.bundle",
              integrity: `sha256-${"0".repeat(64)}`,
            },
          ],
        },
      })
    );
    const ranges: string[] = [];
    const streamReadable = vi.fn(async (_target, _method, args) => {
      if (streamReadable.mock.calls.length === 1) {
        return { status: 200, headers: [], body: byteStream(bootstrap) };
      }
      const descriptor = args[0] as { headers: { Range: string } };
      ranges.push(descriptor.headers.Range);
      const match = /^bytes=(\d+)-(\d+)$/u.exec(descriptor.headers.Range)!;
      const start = Number(match[1]);
      const requestedEnd = Number(match[2]);
      const end = Math.min(requestedEnd, artifact.length - 1);
      return {
        status: 206,
        headers: [
          ["x-vibestudio-content-gzip", "1"],
          ["content-range", `bytes ${start}-${end}/${artifact.length}`],
        ] as [string, string][],
        body: byteStream(artifact.subarray(start, end + 1)),
      };
    });
    const appendBundleChunk = vi.fn<NativeBundleHost["appendBundleChunk"]>(async () => {});

    await activateApprovedWorkspaceApp(
      { streamReadable, close: async () => {} },
      {
        nativeHost: {
          appendBundleChunk,
          finalizeBundleWrite: vi.fn(async () => ({ localPath: "/tmp/bundle" })),
          activatePreparedAppBundle: vi.fn(async () => ({ activated: true })),
          reloadActiveAppBundle: vi.fn(async () => ({ reloading: true })),
        },
      }
    );

    expect(ranges).toEqual([
      "bytes=0-524287",
      "bytes=524288-1048575",
      "bytes=1048576-1572863",
    ]);
    expect(appendBundleChunk).toHaveBeenCalledTimes(3);
  });

  it("rejects a range before committing it when the WebRTC stream loses bytes", async () => {
    const artifact = new Uint8Array(100);
    const bootstrap = new TextEncoder().encode(
      JSON.stringify({
        bootstrap: {
          rnHostAbi: "rn-host-3",
          buildKey: "build-1",
          capabilities: [],
          artifacts: [
            {
              role: "primary",
              platform: "android",
              path: "index.android.bundle",
              url: "https://example.test/index.android.bundle",
              integrity: `sha256-${"0".repeat(64)}`,
            },
          ],
        },
      })
    );
    const appendBundleChunk = vi.fn<NativeBundleHost["appendBundleChunk"]>(async () => {});
    const streamReadable = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, headers: [], body: byteStream(bootstrap) })
      .mockResolvedValueOnce({
        status: 206,
        headers: [
          ["x-vibestudio-content-gzip", "1"],
          ["content-range", "bytes 0-99/100"],
        ],
        body: byteStream(artifact.subarray(0, 80)),
      })
      .mockResolvedValueOnce({
        status: 206,
        headers: [
          ["x-vibestudio-content-gzip", "1"],
          ["content-range", "bytes 0-99/100"],
        ],
        body: byteStream(artifact),
      });

    await activateApprovedWorkspaceApp(
      { streamReadable, waitUntilConnected: async () => {}, close: async () => {} },
      {
        nativeHost: {
          appendBundleChunk,
          finalizeBundleWrite: vi.fn(async () => ({ localPath: "/tmp/bundle" })),
          activatePreparedAppBundle: vi.fn(async () => ({ activated: true })),
          reloadActiveAppBundle: vi.fn(async () => ({ reloading: true })),
        },
      }
    );

    expect(streamReadable).toHaveBeenCalledTimes(3);
    expect(appendBundleChunk).toHaveBeenCalledOnce();
    expect(Buffer.from(appendBundleChunk.mock.calls[0]![0], "base64")).toEqual(
      Buffer.from(artifact)
    );
  });
});
