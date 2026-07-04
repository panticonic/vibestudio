import {
  MobileAssetMemoryCache,
  panelAssetCacheKey,
  streamPassthrough,
  type MobileFetchedResponse,
} from "./panelAssetFacade";

jest.mock(
  "react-native-tcp-socket",
  () => ({
    __esModule: true,
    default: {
      Socket: class {},
      createServer: jest.fn(),
    },
  }),
  { virtual: true }
);

describe("panelAssetCacheKey", () => {
  it("varies immutable asset cache entries by forwarded request headers", () => {
    const path = "/apps/shell/assets/app-abc123.js";

    expect(panelAssetCacheKey(path, {})).toBe(path);
    expect(panelAssetCacheKey(path, { authorization: "Bearer a" })).not.toBe(
      panelAssetCacheKey(path, { authorization: "Bearer b" })
    );
    expect(
      panelAssetCacheKey(path, {
        "if-none-match": '"etag"',
        authorization: "Bearer a",
      })
    ).toBe(
      panelAssetCacheKey(path, {
        authorization: "Bearer a",
        "if-none-match": '"etag"',
      })
    );
  });
});

// -------------------------------------------------------------------------
// Fix 2: an asset larger than the whole cache budget is never cached (caching
// it would evict every useful entry and still sit resident over budget).
// -------------------------------------------------------------------------

function bytesStream(byteLength: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(byteLength));
      controller.close();
    },
  });
}

function cacheableResponse(byteLength: number): MobileFetchedResponse {
  return {
    status: 200,
    statusText: "OK",
    gzip: false,
    contentType: "application/octet-stream",
    replayHeaders: {},
    cacheable: true,
    body: bytesStream(byteLength),
  };
}

async function readBodyLength(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
  }
  return total;
}

describe("MobileAssetMemoryCache oversized-asset handling", () => {
  it("does not cache an asset larger than the byte budget (re-fetches next time)", async () => {
    const cache = new MobileAssetMemoryCache(100);
    let fetches = 0;
    const fetcher = () => {
      fetches += 1;
      return Promise.resolve(cacheableResponse(500)); // > 100-byte budget
    };

    const first = await cache.serve("/big-abc.js", fetcher);
    expect(first.kind).toBe("passthrough"); // still served this time, but not buffered
    if (first.kind === "passthrough") expect(await readBodyLength(first.response.body!)).toBe(500);
    expect(fetches).toBe(1);

    // A second request must re-fetch — the oversized asset was never cached.
    const second = await cache.serve("/big-abc.js", fetcher);
    expect(second.kind).toBe("passthrough");
    expect(fetches).toBe(2);
  });

  it("retains existing entries when an oversized asset passes through", async () => {
    const cache = new MobileAssetMemoryCache(1000);
    let smallFetches = 0;
    const smallFetcher = () => {
      smallFetches += 1;
      return Promise.resolve(cacheableResponse(100));
    };
    const bigFetcher = () => Promise.resolve(cacheableResponse(5000));

    await cache.serve("/small-abc.js", smallFetcher); // cached
    expect(smallFetches).toBe(1);

    const big = await cache.serve("/big-abc.js", bigFetcher); // must NOT evict /small
    expect(big.kind).toBe("passthrough");
    if (big.kind === "passthrough") expect(await readBodyLength(big.response.body!)).toBe(5000);

    // /small is still resident: served from cache, no second fetch.
    const hit = await cache.serve("/small-abc.js", smallFetcher);
    expect(hit.kind).toBe("asset");
    expect(smallFetches).toBe(1);
  });
});

// -------------------------------------------------------------------------
// Fix 1: streamPassthrough signals head-written the instant the head write
// resolves, so a mid-body throw leaves the caller's headSent flag true (the
// catch destroys the socket instead of writing a second, corrupting head).
// -------------------------------------------------------------------------

function fakeSocket() {
  const writes: (string | Uint8Array)[] = [];
  return {
    destroyed: false,
    write(data: string | Uint8Array, _enc: unknown, cb?: (err?: Error) => void) {
      writes.push(data);
      cb?.(undefined);
      return true;
    },
    end() {},
    __writes: writes,
  };
}

function throwingBodyAfterFirstChunk(): ReadableStream<Uint8Array> {
  let pulls = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        return;
      }
      throw new Error("mid-body read failure");
    },
  });
}

describe("streamPassthrough head-sent signalling", () => {
  it("fires onHeadSent before a mid-body read throws", async () => {
    const socket = fakeSocket();
    let headSent = false;
    const response: MobileFetchedResponse = {
      status: 200,
      statusText: "OK",
      gzip: false,
      contentType: "text/plain",
      replayHeaders: {},
      cacheable: false,
      body: throwingBodyAfterFirstChunk(),
    };

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamPassthrough(socket as any, response, () => {
        headSent = true;
      })
    ).rejects.toThrow("mid-body read failure");

    // The head was already on the wire when the body failed, so the caller's
    // error handler will destroy() rather than write a second head.
    expect(headSent).toBe(true);
    const firstWrite = String(socket.__writes[0]);
    expect(firstWrite.startsWith("HTTP/1.1 200 OK")).toBe(true);
    // Exactly one status line was written (no corrupting second head).
    const statusLines = socket.__writes.filter((w) => String(w).startsWith("HTTP/1.1"));
    expect(statusLines).toHaveLength(1);
  });
});
