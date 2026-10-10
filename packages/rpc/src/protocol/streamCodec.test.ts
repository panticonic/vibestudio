import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
  createInboundStreamMux,
  decodeFramedResponseToStreaming,
  FrameDecoder,
  decodeFramedStream,
  encodeDataFrame,
} from "./streamCodec.js";

afterEach(() => {
  vi.useRealTimers();
});

const enc = new TextEncoder();

function headPayload(
  status: number,
  statusText: string,
  headerPairs: [string, string][],
  finalUrl: string
): Uint8Array {
  return enc.encode(JSON.stringify({ status, statusText, headerPairs, finalUrl }));
}

describe("inbound stream mux → framed Response decode", () => {
  it("mux feeds decodeFramedResponseToStreaming to rebuild a Response per stream", async () => {
    const mux = createInboundStreamMux();
    const bodyA = mux.acquire(11);
    const bodyB = mux.acquire(22);
    const respA = decodeFramedResponseToStreaming(bodyA, "https://a/");
    const respB = decodeFramedResponseToStreaming(bodyB, "https://b/");

    // Drive both streams interleaved, as the bulk channel demux would.
    mux.push(11, FRAME_HEAD, headPayload(201, "Created", [["x-a", "1"]], "https://a/final"));
    mux.push(22, FRAME_HEAD, headPayload(200, "OK", [], "https://b/"));
    mux.push(11, FRAME_DATA, enc.encode("hello-"));
    mux.push(22, FRAME_DATA, enc.encode("world"));
    mux.push(11, FRAME_DATA, enc.encode("A"));
    mux.push(11, FRAME_END, enc.encode(JSON.stringify({ bytesIn: 7 })));
    mux.push(22, FRAME_END, enc.encode(JSON.stringify({ bytesIn: 5 })));

    const a = await respA;
    const b = await respB;
    expect(a.status).toBe(201);
    expect(a.headers.get("x-a")).toBe("1");
    expect(a.url).toBe("https://a/final");
    expect(await a.text()).toBe("hello-A");
    expect(b.status).toBe(200);
    expect(await b.text()).toBe("world");
    expect(mux.size).toBe(0);
  });

  it("propagates an ERROR frame into the stream's Response", async () => {
    const mux = createInboundStreamMux();
    const body = mux.acquire(5);
    const resp = decodeFramedResponseToStreaming(body, "https://e/");
    mux.push(5, FRAME_HEAD, headPayload(200, "OK", [], "https://e/"));
    // Read side starts; now error it.
    mux.push(
      5,
      FRAME_ERROR,
      enc.encode(
        JSON.stringify({
          status: 502,
          error: {
            message: "upstream boom",
            code: "EBOOM",
            errorKind: "transport",
            errorData: { code: "upstream", retryable: true },
          },
        })
      )
    );
    const r = await resp;
    await expect(r.text()).rejects.toMatchObject({
      name: "RemoteRpcError",
      message: "upstream boom",
      code: "EBOOM",
      errorKind: "transport",
      errorData: { code: "upstream", retryable: true },
    });
  });

  it("closeAll errors every open stream (pipe loss is loud, not a hang)", async () => {
    const mux = createInboundStreamMux();
    const body = mux.acquire(1);
    const resp = decodeFramedResponseToStreaming(body, "https://x/");
    mux.push(1, FRAME_HEAD, headPayload(200, "OK", [], "https://x/"));
    mux.closeAll(new Error("pipe lost"));
    const r = await resp;
    await expect(r.text()).rejects.toThrow(/pipe lost/);
    expect(mux.size).toBe(0);
  });

  it("rejects a truncated body when END declares more bytes than arrived", async () => {
    const mux = createInboundStreamMux();
    const body = mux.acquire(6);
    const response = decodeFramedResponseToStreaming(body, "https://truncated/");
    mux.push(6, FRAME_HEAD, headPayload(200, "OK", [], "https://truncated/"));
    mux.push(6, FRAME_DATA, enc.encode("partial"));
    mux.push(6, FRAME_END, enc.encode(JSON.stringify({ bytesIn: 96_886 })));

    const decoded = await response;
    await expect(decoded.text()).rejects.toThrow(
      /body length mismatch: expected 96886 bytes, received 7/
    );
  });

  it("waits for a slow HEAD without an implicit deadline and fails when the wire errors", async () => {
    vi.useFakeTimers();
    const mux = createInboundStreamMux();
    const body = mux.acquire(9);
    let settled = false;
    const decoded = decodeFramedResponseToStreaming(body, "https://slow/");
    void decoded.then(
      () => (settled = true),
      () => (settled = true)
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
    const expectation = expect(decoded).rejects.toThrow(/connection lost/);
    mux.fail(9, new Error("connection lost"));
    await expectation;
  });

  it("cancels a pending HEAD read and rejects when the caller aborts", async () => {
    const abort = new AbortController();
    let wireCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        wireCancelled = true;
      },
    });
    const decoded = decodeFramedStream(body, "https://aborted/", abort.signal);
    const expectation = expect(decoded).rejects.toThrow("caller stopped waiting");

    abort.abort(new Error("caller stopped waiting"));

    await expectation;
    expect(wireCancelled).toBe(true);
  });

  it("respects a custom headTimeoutMs and still honors a caller AbortSignal", async () => {
    vi.useFakeTimers();
    const mux = createInboundStreamMux();
    const body = mux.acquire(10);
    const decoded = decodeFramedStream(body, "https://slow/", null, { headTimeoutMs: 500 });
    const expectation = expect(decoded).rejects.toThrow(/HEAD not received within 500ms/);
    await vi.advanceTimersByTimeAsync(600);
    await expectation;
  });

  it("does NOT trip the HEAD deadline when HEAD arrives in time", async () => {
    vi.useFakeTimers();
    const mux = createInboundStreamMux();
    const body = mux.acquire(11);
    const decoded = decodeFramedResponseToStreaming(body, "https://ok/");
    mux.push(11, FRAME_HEAD, headPayload(200, "OK", [], "https://ok/"));
    mux.push(11, FRAME_END, enc.encode(JSON.stringify({ bytesIn: 0 })));
    const r = await decoded;
    expect(r.status).toBe(200);
    await vi.advanceTimersByTimeAsync(30_000); // deadline already cleared — no throw
  });
});

describe("FrameDecoder", () => {
  it("decodes frames split across arbitrary chunk boundaries", async () => {
    const frames: Array<[number, string]> = [];
    const decoder = new FrameDecoder((type, payload) => {
      frames.push([type, new TextDecoder().decode(payload)]);
    });
    const wire = new Uint8Array([
      ...encodeDataFrame(enc.encode("alpha")),
      ...encodeDataFrame(enc.encode("")),
      ...encodeDataFrame(enc.encode("beta-gamma")),
    ]);
    for (let i = 0; i < wire.byteLength; i += 3) {
      await decoder.push(wire.subarray(i, i + 3));
    }
    expect(frames).toEqual([
      [FRAME_DATA, "alpha"],
      [FRAME_DATA, ""],
      [FRAME_DATA, "beta-gamma"],
    ]);
    expect(decoder.finished()).toBe(true);
  });

  it("reads lengths of 2^31 and above as unsigned and waits for the full payload", async () => {
    const decoder = new FrameDecoder(() => {
      throw new Error("no frame should be emitted");
    });
    await decoder.push(new Uint8Array([FRAME_DATA, 0x80, 0x00, 0x00, 0x00, 1, 2, 3]));
    expect(decoder.finished()).toBe(false);
  });

  it("rejects an unknown frame type instead of silently consuming the frame", async () => {
    const onFrame = vi.fn();
    const decoder = new FrameDecoder(onFrame);

    await expect(decoder.push(new Uint8Array([0xff, 0, 0, 0, 0]))).rejects.toThrow(
      "Unknown streaming RPC frame type: 255"
    );
    expect(onFrame).not.toHaveBeenCalled();
  });
});
