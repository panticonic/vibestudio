import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
  createInboundStreamMux,
  decodeFramedResponseToStreaming,
  decodeFramedStream,
} from "./streamCodec.js";

afterEach(() => {
  vi.useRealTimers();
});

const enc = new TextEncoder();

function headPayload(status: number, statusText: string, headerPairs: [string, string][], finalUrl: string): Uint8Array {
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
          message: "upstream boom",
          code: "EBOOM",
          errorKind: "transport",
          errorData: { code: "upstream", retryable: true },
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

  it("fails LOUD when HEAD never arrives within the deadline instead of hanging (bug #7)", async () => {
    vi.useFakeTimers();
    const mux = createInboundStreamMux();
    const body = mux.acquire(9);
    // Server accepted the stream-open but never emits HEAD (wedged upstream).
    const decoded = decodeFramedResponseToStreaming(body, "https://slow/");
    const expectation = expect(decoded).rejects.toThrow(/HEAD not received/);
    await vi.advanceTimersByTimeAsync(20_001);
    await expectation;
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
