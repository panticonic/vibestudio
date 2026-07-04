import { describe, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "./types.js";
import type { DecodedFramedStream } from "./protocol/streamCodec.js";
import { bytesToBase64 } from "./base64.js";
import {
  createBridgeBodyReassembler,
  createBridgeStreamRelay,
  openBridgeUploadStream,
  type BridgeStreamMessage,
  type BridgeStreamShellSurface,
} from "./bridgeStream.js";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function streamRequestEnvelope(): RpcEnvelope {
  const caller = { callerId: "panel-1", callerKind: "panel" as const };
  return {
    from: "panel-1",
    target: "main",
    delivery: { caller },
    provenance: [caller],
    message: {
      type: "stream-request",
      requestId: "req-1",
      fromId: "panel-1",
      method: "gateway.fetch",
      args: [{ path: "/x" }],
    },
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function bodyStreamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function decodedResponse(
  body: Uint8Array,
  init: { status?: number; headers?: [string, string][] } = {}
): DecodedFramedStream {
  return {
    status: init.status ?? 200,
    statusText: "OK",
    headers: init.headers ?? [["content-type", "application/octet-stream"]],
    finalUrl: "http://gateway/x",
    body: bodyStreamOf(body),
  };
}

describe("createBridgeBodyReassembler", () => {
  it("reassembles pushed chunks in order and closes on end", async () => {
    const reassembler = createBridgeBodyReassembler();
    await reassembler.push(bytes(1, 2));
    await reassembler.push(bytes(3));
    reassembler.end();
    expect(await drain(reassembler.stream)).toEqual(bytes(1, 2, 3));
  });

  it("defers the push ack above the watermark until the consumer drains", async () => {
    // cap 8 → watermark 4: a 6-byte backlog must not resolve until read.
    const reassembler = createBridgeBodyReassembler({ maxBufferedBytes: 8 });
    await reassembler.push(bytes(1, 2, 3)); // 3 ≤ watermark: immediate
    let resolved = false;
    const pending = reassembler.push(bytes(4, 5, 6)).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    const reader = reassembler.stream.getReader();
    expect((await reader.read()).value).toEqual(bytes(1, 2, 3));
    await pending;
    expect(resolved).toBe(true);
    expect((await reader.read()).value).toEqual(bytes(4, 5, 6));
    reassembler.end();
    expect((await reader.read()).done).toBe(true);
  });

  it("fails LOUDLY when un-awaited pushes exceed the hard cap", async () => {
    const reassembler = createBridgeBodyReassembler({ maxBufferedBytes: 4 });
    const first = reassembler.push(bytes(1, 2, 3)); // 3 ≤ 4: accepted (over watermark → deferred)
    await expect(reassembler.push(bytes(4, 5))).rejects.toThrow(/buffer overflow/);
    await expect(first).rejects.toThrow(/buffer overflow/);
    await expect(drain(reassembler.stream)).rejects.toThrow(/buffer overflow/);
    // Terminal: later pushes stay rejected.
    await expect(reassembler.push(bytes(9))).rejects.toThrow(/buffer overflow/);
  });

  it("fail() errors the stream and rejects deferred pushes", async () => {
    const reassembler = createBridgeBodyReassembler({ maxBufferedBytes: 4 });
    const deferred = reassembler.push(bytes(1, 2, 3));
    reassembler.fail(new Error("panel went away"));
    await expect(deferred).rejects.toThrow("panel went away");
    await expect(drain(reassembler.stream)).rejects.toThrow("panel went away");
  });

  it("propagates consumer cancel to the pushing side", async () => {
    const reassembler = createBridgeBodyReassembler();
    await reassembler.push(bytes(1));
    await reassembler.stream.cancel(new Error("pipe gone"));
    await expect(reassembler.push(bytes(2))).rejects.toThrow("pipe gone");
  });
});

describe("createBridgeStreamRelay", () => {
  function makeRelay(opts: {
    openStream?: ReturnType<typeof vi.fn>;
    chunkFormat?: "binary" | "base64";
    autoAck?: boolean;
    maxBufferedBytes?: number;
  }) {
    const sent: BridgeStreamMessage[] = [];
    const openStream =
      opts.openStream ??
      vi.fn(async (_env, _signal, body: ReadableStream<Uint8Array>) => {
        const received = await drain(body);
        return decodedResponse(received);
      });
    const relay = createBridgeStreamRelay({
      chunkFormat: opts.chunkFormat ?? "binary",
      maxBufferedBytes: opts.maxBufferedBytes,
      openStream: openStream as never,
      sendToPanel: (msg) => {
        sent.push(msg);
        if (opts.autoAck !== false && msg.kind === "chunk") relay.ack(msg.opId, msg.seq);
      },
    });
    return { relay, sent, openStream };
  }

  it("round-trips an upload: reassembled body in, ack-gated response out", async () => {
    const { relay, sent, openStream } = makeRelay({});
    relay.open({ opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" });
    await relay.pushBodyChunk({ bodyId: "b-1", seq: 1, chunk: bytes(1, 2) });
    await relay.pushBodyChunk({ bodyId: "b-1", seq: 2, chunk: bytes(3) });
    await relay.pushBodyChunk({ bodyId: "b-1", seq: 3, done: true });

    await vi.waitFor(() => expect(sent.at(-1)?.kind).toBe("end"));
    expect(openStream).toHaveBeenCalledTimes(1);
    expect((openStream.mock.calls[0]?.[0] as RpcEnvelope).message.type).toBe("stream-request");
    expect(sent[0]).toMatchObject({ kind: "head", opId: "op-1", status: 200 });
    expect(sent[1]).toMatchObject({ kind: "chunk", opId: "op-1", seq: 1 });
    const firstChunk = sent[1];
    expect(firstChunk?.kind === "chunk" ? firstChunk.chunk : null).toEqual(bytes(1, 2, 3));
    expect(relay.size()).toBe(0);
  });

  it("encodes response chunks as base64 for string-only bridges", async () => {
    const { relay, sent } = makeRelay({ chunkFormat: "base64" });
    relay.open({ opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" });
    // base64 request chunk decodes on the way in, too.
    await relay.pushBodyChunk({ bodyId: "b-1", seq: 1, chunk: bytesToBase64(bytes(7, 8, 9)) });
    await relay.pushBodyChunk({ bodyId: "b-1", seq: 2, done: true });

    await vi.waitFor(() => expect(sent.at(-1)?.kind).toBe("end"));
    const chunk = sent.find((msg) => msg.kind === "chunk");
    expect(chunk && chunk.kind === "chunk" && chunk.chunk).toBe(bytesToBase64(bytes(7, 8, 9)));
  });

  it("holds the next response chunk until the previous one is acked", async () => {
    const { relay, sent } = makeRelay({
      autoAck: false,
      openStream: vi.fn(async (_env, _signal, body: ReadableStream<Uint8Array>) => {
        void drain(body);
        return {
          ...decodedResponse(bytes()),
          body: bodyStreamOf(bytes(1), bytes(2)),
        };
      }),
    });
    relay.open({ opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" });
    await relay.pushBodyChunk({ bodyId: "b-1", seq: 1, done: true });

    await vi.waitFor(() => expect(sent.filter((msg) => msg.kind === "chunk")).toHaveLength(1));
    // No ack → the second chunk must NOT go out.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.filter((msg) => msg.kind === "chunk")).toHaveLength(1);

    relay.ack("op-1", 1);
    await vi.waitFor(() => expect(sent.filter((msg) => msg.kind === "chunk")).toHaveLength(2));
    relay.ack("op-1", 2);
    await vi.waitFor(() => expect(sent.at(-1)?.kind).toBe("end"));
  });

  it("rejects a stream-open without a bodyId (upload-only hop)", () => {
    const { relay } = makeRelay({});
    expect(() =>
      relay.open({ opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "" })
    ).toThrow(/bodyId/);
  });

  it("rejects a non-stream-request envelope", () => {
    const { relay } = makeRelay({});
    const envelope = streamRequestEnvelope();
    (envelope.message as { type: string }).type = "request";
    expect(() => relay.open({ opId: "op-1", envelope, bodyId: "b-1" })).toThrow(
      /stream-request envelope/
    );
  });

  it("rejects body chunks for an unknown bodyId", async () => {
    const { relay } = makeRelay({});
    await expect(relay.pushBodyChunk({ bodyId: "nope", seq: 1, chunk: bytes(1) })).rejects.toThrow(
      /unknown bodyId/
    );
  });

  it("rejects out-of-order request body chunks instead of reassembling arrival order", async () => {
    const { relay, openStream } = makeRelay({
      openStream: vi.fn(async (_env, _signal, body: ReadableStream<Uint8Array>) => {
        await expect(drain(body)).rejects.toThrow(/out of order/);
        return decodedResponse(bytes());
      }),
    });
    relay.open({ opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" });

    await expect(relay.pushBodyChunk({ bodyId: "b-1", seq: 2, chunk: bytes(2) })).rejects.toThrow(
      /expected seq 1, got 2/
    );
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(1));
    expect(relay.size()).toBe(0);
    await expect(relay.pushBodyChunk({ bodyId: "b-1", seq: 1, chunk: bytes(1) })).rejects.toThrow(
      /unknown bodyId/
    );
  });

  it("sends a loud error message when the session cannot stream (no silent fallback)", async () => {
    const { relay, sent } = makeRelay({
      openStream: vi.fn(async () => {
        throw new Error("Streaming request bodies (uploads) require the WebRTC transport");
      }),
    });
    relay.open({ opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" });
    await vi.waitFor(() => expect(sent.at(-1)?.kind).toBe("error"));
    expect(sent.at(-1)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("require the WebRTC transport"),
    });
    expect(relay.size()).toBe(0);
  });

  it("abort() aborts the session signal, fails the body, and drops the op", async () => {
    const seen: { signal: AbortSignal | null; bodyError: unknown } = {
      signal: null,
      bodyError: null,
    };
    const { relay } = makeRelay({
      openStream: vi.fn(async (_env, signal: AbortSignal, body: ReadableStream<Uint8Array>) => {
        seen.signal = signal;
        void drain(body).catch((err) => {
          seen.bodyError = err;
        });
        // Hang until aborted, like a real in-flight stream.
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("stream aborted")));
        });
      }),
    });
    relay.open({ opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" });
    await relay.pushBodyChunk({ bodyId: "b-1", seq: 1, chunk: bytes(1) });
    relay.abort("op-1");

    expect(seen.signal?.aborted).toBe(true);
    expect(relay.size()).toBe(0);
    await vi.waitFor(() => expect(seen.bodyError).toBeInstanceOf(Error));
    await expect(relay.pushBodyChunk({ bodyId: "b-1", seq: 2, chunk: bytes(2) })).rejects.toThrow(
      /unknown bodyId/
    );
  });

  it("destroy() aborts every open op", async () => {
    const { relay } = makeRelay({
      openStream: vi.fn(
        (_env, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("destroyed")));
          })
      ),
    });
    relay.open({ opId: "op-1", envelope: streamRequestEnvelope(), bodyId: "b-1" });
    relay.open({ opId: "op-2", envelope: streamRequestEnvelope(), bodyId: "b-2" });
    expect(relay.size()).toBe(2);
    relay.destroy("webview destroyed");
    expect(relay.size()).toBe(0);
  });
});

describe("openBridgeUploadStream ↔ relay (in-memory bridge)", () => {
  function connect(
    openStream: (
      envelope: RpcEnvelope,
      signal: AbortSignal,
      body: ReadableStream<Uint8Array>
    ) => Promise<DecodedFramedStream>
  ) {
    let panelHandler: ((msg: BridgeStreamMessage) => void) | null = null;
    const relay = createBridgeStreamRelay({
      chunkFormat: "base64",
      openStream,
      // Round-trip through JSON like the RN injection channel does.
      sendToPanel: (msg) => panelHandler?.(JSON.parse(JSON.stringify(msg))),
    });
    const surface: BridgeStreamShellSurface = {
      streamChunkFormat: "base64",
      streamOpen: (msg) => relay.open(JSON.parse(JSON.stringify(msg))),
      streamBodyChunk: (msg) => relay.pushBodyChunk(JSON.parse(JSON.stringify(msg))),
      streamAbort: (opId) => relay.abort(opId),
      streamAck: (opId, seq) => relay.ack(opId, seq),
      onStreamMessage: (handler) => {
        panelHandler = handler;
        return () => {
          panelHandler = null;
        };
      },
    };
    return { relay, surface };
  }

  it("uploads the request body and returns the streamed Response", async () => {
    const seen: { body?: Uint8Array } = {};
    const { surface, relay } = connect(async (_envelope, _signal, body) => {
      seen.body = await drain(body);
      return decodedResponse(new TextEncoder().encode('{"ok":true}'), {
        headers: [["content-type", "application/json"]],
      });
    });

    const payload = new Uint8Array(700_000); // > 2 bridge chunks
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const response = await openBridgeUploadStream(
      surface,
      streamRequestEnvelope(),
      null,
      bodyStreamOf(payload)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(seen.body).toBeDefined());
    expect(seen.body).toEqual(payload);
    expect(relay.size()).toBe(0);
  });

  it("constructs null-body responses for statuses that forbid a body", async () => {
    const { surface, relay } = connect(async () => decodedResponse(bytes(), { status: 204 }));

    const response = await openBridgeUploadStream(
      surface,
      streamRequestEnvelope(),
      null,
      bodyStreamOf(bytes(1))
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
    await vi.waitFor(() => expect(relay.size()).toBe(0));
  });

  it.each([101, 103, 199, 600])(
    "maps invalid bridge response status %s to 502 before constructing Response",
    async (status) => {
      const { surface, relay } = connect(async () =>
        decodedResponse(new TextEncoder().encode("bad status"), { status })
      );

      const response = await openBridgeUploadStream(
        surface,
        streamRequestEnvelope(),
        null,
        bodyStreamOf(bytes(1))
      );

      expect(response.status).toBe(502);
      expect(await response.text()).toBe("bad status");
      await vi.waitFor(() => expect(relay.size()).toBe(0));
    }
  );

  it("rejects when the host session cannot stream a request body", async () => {
    const { surface } = connect(async () => {
      throw new Error(
        "Streaming request bodies (uploads) require the WebRTC transport; " +
          "this panel's host session cannot stream a request body"
      );
    });
    await expect(
      openBridgeUploadStream(surface, streamRequestEnvelope(), null, bodyStreamOf(bytes(1)))
    ).rejects.toThrow(/require the WebRTC transport/);
  });

  it("caller abort propagates across the bridge and stops both pumps", async () => {
    let hostSignal: AbortSignal | null = null;
    const { surface, relay } = connect(
      (_envelope, signal) =>
        new Promise((_resolve, reject) => {
          hostSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted upstream")));
        })
    );
    const controller = new AbortController();
    // An endless body: the pump must stop on abort, not drain forever.
    const endlessBody = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(bytes(0));
      },
    });
    const pending = openBridgeUploadStream(
      surface,
      streamRequestEnvelope(),
      controller.signal,
      endlessBody
    );
    await vi.waitFor(() => expect(hostSignal).not.toBeNull());
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(hostSignal!.aborted).toBe(true);
    await vi.waitFor(() => expect(relay.size()).toBe(0));
  });

  it("throws immediately on a pre-aborted signal", async () => {
    const { surface } = connect(async () => decodedResponse(bytes()));
    const controller = new AbortController();
    controller.abort();
    await expect(
      openBridgeUploadStream(surface, streamRequestEnvelope(), controller.signal, bodyStreamOf())
    ).rejects.toThrow(/aborted/);
  });
});
