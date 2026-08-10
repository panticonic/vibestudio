import {
  panelAssetCacheKey,
  streamAndPopulateImmutableAsset,
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
jest.mock("react-native", () => ({ NativeModules: {} }), { virtual: true });

describe("panelAssetCacheKey", () => {
  it("varies immutable asset cache entries by forwarded request headers", () => {
    const path = "/apps/shell/assets/app-abc123.js";

    expect(panelAssetCacheKey(path, {})).toBe(path);
    expect(panelAssetCacheKey(path, { authorization: "Bearer a" })).toBe(
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

  it("collapses build-pinned entry documents across runtime contexts", () => {
    const buildKey = "a".repeat(64);
    const expected = `/panels/chat/?buildKey=${buildKey}`;
    expect(
      panelAssetCacheKey(`/panels/chat/?contextId=one&buildKey=${buildKey}`, {
        accept: "text/html",
        authorization: "Bearer first-boot",
      })
    ).toBe(expected);
    expect(
      panelAssetCacheKey(`/panels/chat/?contextId=two&ref=state%3Anew&buildKey=${buildKey}`, {
        "cache-control": "max-age=0",
        authorization: "Bearer rotated-after-restart",
      })
    ).toBe(expected);
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
    expect(socket.__writes).toHaveLength(2);
    expect(Buffer.from(socket.__writes[1] as Uint8Array)).toEqual(
      Buffer.concat([Buffer.from("3\r\n", "ascii"), Buffer.from([1, 2, 3]), Buffer.from("\r\n")])
    );
  });
});

describe("streamAndPopulateImmutableAsset", () => {
  it("streams cold bytes before durable population completes", async () => {
    const calls: string[] = [];
    let resolveCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => (resolveCommit = resolve));
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    const store = {
      openWrite: jest.fn(async () => {
        calls.push("open");
        return "write-1";
      }),
      append: jest.fn(async (_writeId: string, bytes: Uint8Array) => {
        calls.push(`append:${Array.from(bytes).join(",")}`);
      }),
      commit: jest.fn(async () => {
        await commitGate;
        calls.push("commit");
        return {
          handle: `vibestudio-asset-v1:${"a".repeat(64)}`,
          size: 5,
          metadata: {
            status: 200 as const,
            statusText: "OK",
            gzip: true,
            contentType: "text/javascript",
            replayHeaders: { "cache-control": "public, max-age=31536000, immutable" },
          },
        };
      }),
      abort: jest.fn(async () => {
        calls.push("abort");
      }),
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    let transferred = 0;
    const socket = fakeSocket();

    const population = streamAndPopulateImmutableAsset(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket as any,
      store,
      "/immutable.js",
      {
        status: 200,
        statusText: "OK",
        gzip: true,
        contentType: "text/javascript",
        replayHeaders: { "cache-control": "public, max-age=31536000, immutable" },
        cacheable: true,
        body,
      },
      () => calls.push("head"),
      (bytes) => {
        transferred += bytes;
      }
    );

    // Both chunks and their staging appends happen while commit is still
    // blocked: cold TTFB no longer waits for the complete artifact.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["open", "head", "append:1,2", "append:3,4,5"]);
    expect(String(socket.__writes[0])).toMatch(/^HTTP\/1\.1 200 OK/u);
    expect(socket.__writes).toHaveLength(3);
    resolveCommit();
    const stored = await population;

    expect(stored.size).toBe(5);
    expect(transferred).toBe(5);
    expect(calls).toEqual(["open", "head", "append:1,2", "append:3,4,5", "commit"]);
    expect(socket.__writes.at(-1)).toBe("0\r\n\r\n");
    expect(store.abort).not.toHaveBeenCalled();
  });

  it("aborts an incomplete native write", async () => {
    const store = {
      openWrite: jest.fn(async () => "write-2"),
      append: jest.fn(async () => {
        throw new Error("native append failed");
      }),
      commit: jest.fn(),
      abort: jest.fn(async () => undefined),
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    await expect(
      streamAndPopulateImmutableAsset(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fakeSocket() as any,
        store,
        "/immutable.js",
        {
          status: 200,
          statusText: "OK",
          gzip: true,
          contentType: "text/javascript",
          replayHeaders: { "cache-control": "public, max-age=31536000, immutable" },
          cacheable: true,
          body,
        },
        () => undefined,
        () => undefined
      )
    ).rejects.toThrow("native append failed");
    expect(store.abort).toHaveBeenCalledWith("write-2");
    expect(store.commit).not.toHaveBeenCalled();
  });
  it("aborts a truncated transfer without multiplying network work", async () => {
    const store = {
      openWrite: jest.fn(async () => "write-truncated"),
      append: jest.fn(async () => undefined),
      commit: jest.fn(),
      abort: jest.fn(async () => undefined),
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("body length mismatch"));
      },
    });

    await expect(
      streamAndPopulateImmutableAsset(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fakeSocket() as any,
        store,
        "/immutable.js",
        {
          status: 200,
          statusText: "OK",
          gzip: true,
          contentType: "text/javascript",
          replayHeaders: { "cache-control": "public, max-age=31536000, immutable" },
          cacheable: true,
          body,
        },
        () => undefined,
        () => undefined
      )
    ).rejects.toThrow("body length mismatch");
    expect(store.abort).toHaveBeenCalledWith("write-truncated");
    expect(store.commit).not.toHaveBeenCalled();
  });
});
