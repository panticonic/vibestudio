import { describe, expect, it } from "vitest";
import {
  BULK_MUX_ACCUMULATION_CAP_BYTES,
  BULK_MUX_HEADER_BYTES,
  BULK_MUX_PARTIAL_STREAM_CAP,
  BulkProtocolViolation,
  MUX_FLAG_MORE,
  createBulkDemux,
  decodeBulkMessage,
  encodeBulkMessage,
  type BulkDemuxLimits,
  type StreamFrameType,
} from "./bulkMux.js";
import { FRAME_DATA, FRAME_END, FRAME_ERROR, FRAME_HEAD } from "./streamCodec.js";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe("bulk mux codec", () => {
  it("round-trips all four frame types", () => {
    const payloads: Array<[StreamFrameType, Uint8Array]> = [
      [FRAME_HEAD, new TextEncoder().encode('{"status":200}')],
      [FRAME_DATA, bytes(1, 2, 3, 4, 5)],
      [FRAME_END, new Uint8Array(0)],
      [FRAME_ERROR, new TextEncoder().encode('{"status":502,"message":"boom"}')],
    ];
    for (const [type, payload] of payloads) {
      const message = encodeBulkMessage(0xdead, type, payload);
      const decoded = decodeBulkMessage(message);
      expect(decoded.type).toBe(type);
      expect(decoded.more).toBe(false);
      expect([...decoded.payload]).toEqual([...payload]);
    }
  });

  it("round-trips the full u32 streamId range big-endian", () => {
    for (const id of [0, 1, 0x1234, 0x7fffffff, 0xfffffffe]) {
      const decoded = decodeBulkMessage(encodeBulkMessage(id, FRAME_DATA, bytes(9)));
      expect(decoded.streamId).toBe(id);
    }
  });

  it("carries the MORE flag on HEAD and ERROR", () => {
    for (const type of [FRAME_HEAD, FRAME_ERROR] as const) {
      const message = encodeBulkMessage(7, type, bytes(1), true);
      expect(message[4]! & MUX_FLAG_MORE).toBe(MUX_FLAG_MORE);
      expect(decodeBulkMessage(message).more).toBe(true);
    }
  });

  it("returns the payload as a zero-copy view past the header", () => {
    const message = encodeBulkMessage(1, FRAME_DATA, bytes(10, 20, 30));
    const { payload } = decodeBulkMessage(message);
    expect(payload.buffer).toBe(message.buffer);
    expect(payload.byteOffset).toBe(BULK_MUX_HEADER_BYTES);
  });

  describe("violations fail loud", () => {
    it("rejects a message shorter than the header", () => {
      expect(() => decodeBulkMessage(new Uint8Array(BULK_MUX_HEADER_BYTES - 1))).toThrow(
        BulkProtocolViolation
      );
      expect(() => decodeBulkMessage(new Uint8Array(0))).toThrow(/shorter than/);
    });

    it("rejects type bits outside 1..4", () => {
      for (const badType of [0x00, 0x05, 0x07]) {
        const message = encodeBulkMessage(1, FRAME_DATA, bytes(1));
        message[4] = badType;
        expect(() => decodeBulkMessage(message)).toThrow(/invalid bulk frame type/);
      }
    });

    it("rejects unknown flag bits", () => {
      for (const badBits of [0x10, 0x40, 0x80]) {
        const message = encodeBulkMessage(1, FRAME_DATA, bytes(1));
        message[4] = FRAME_DATA | badBits;
        expect(() => decodeBulkMessage(message)).toThrow(/unknown bulk flag bits/);
      }
    });

    it("rejects MORE on DATA and END (decode)", () => {
      for (const type of [FRAME_DATA, FRAME_END] as const) {
        const message = encodeBulkMessage(1, type, bytes(1));
        message[4] = type | MUX_FLAG_MORE;
        expect(() => decodeBulkMessage(message)).toThrow(/MORE flag set on/);
      }
    });

    it("refuses to encode MORE on DATA and END", () => {
      expect(() => encodeBulkMessage(1, FRAME_DATA, bytes(1), true)).toThrow(BulkProtocolViolation);
      expect(() => encodeBulkMessage(1, FRAME_END, bytes(1), true)).toThrow(BulkProtocolViolation);
    });

    it("carries a stable machine-readable code", () => {
      try {
        decodeBulkMessage(new Uint8Array(1));
        expect.unreachable("must throw");
      } catch (error) {
        expect((error as BulkProtocolViolation).code).toBe("BULK_PROTOCOL_VIOLATION");
      }
    });
  });
});

describe("bulk demux", () => {
  const collect = (limits?: BulkDemuxLimits) => {
    const frames: Array<{ streamId: number; type: StreamFrameType; payload: Uint8Array }> = [];
    const demux = createBulkDemux(
      (streamId, type, payload) => frames.push({ streamId, type, payload: payload.slice() }),
      limits
    );
    return { frames, demux };
  };

  it("emits DATA and END immediately per message", () => {
    const { frames, demux } = collect();
    demux.push(encodeBulkMessage(3, FRAME_DATA, bytes(1, 2)));
    demux.push(encodeBulkMessage(3, FRAME_DATA, bytes(3)));
    demux.push(encodeBulkMessage(3, FRAME_END, new Uint8Array(0)));
    expect(frames.map((f) => f.type)).toEqual([FRAME_DATA, FRAME_DATA, FRAME_END]);
    expect([...frames[0]!.payload]).toEqual([1, 2]);
    expect([...frames[1]!.payload]).toEqual([3]);
  });

  it("reassembles a HEAD continued via MORE into ONE emitted frame", () => {
    const { frames, demux } = collect();
    const json = new TextEncoder().encode('{"status":200,"headerPairs":[["x","y"]]}');
    demux.push(encodeBulkMessage(9, FRAME_HEAD, json.subarray(0, 10), true));
    demux.push(encodeBulkMessage(9, FRAME_HEAD, json.subarray(10, 25), true));
    expect(frames).toHaveLength(0); // nothing until the final (MORE unset) message
    demux.push(encodeBulkMessage(9, FRAME_HEAD, json.subarray(25)));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.streamId).toBe(9);
    expect(frames[0]!.type).toBe(FRAME_HEAD);
    expect(new TextDecoder().decode(frames[0]!.payload)).toBe(new TextDecoder().decode(json));
  });

  it("reassembles a continued ERROR the same way", () => {
    const { frames, demux } = collect();
    demux.push(encodeBulkMessage(4, FRAME_ERROR, bytes(1, 2), true));
    demux.push(encodeBulkMessage(4, FRAME_ERROR, bytes(3, 4)));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe(FRAME_ERROR);
    expect([...frames[0]!.payload]).toEqual([1, 2, 3, 4]);
  });

  it("interleaved streams' DATA messages emit independently", () => {
    const { frames, demux } = collect();
    demux.push(encodeBulkMessage(1, FRAME_DATA, bytes(0xaa)));
    demux.push(encodeBulkMessage(2, FRAME_DATA, bytes(0xbb)));
    demux.push(encodeBulkMessage(1, FRAME_DATA, bytes(0xac)));
    demux.push(encodeBulkMessage(2, FRAME_END, new Uint8Array(0)));
    expect(frames.map((f) => f.streamId)).toEqual([1, 2, 1, 2]);
  });

  it("keeps per-stream HEAD continuations distinct while other streams flow", () => {
    const { frames, demux } = collect();
    demux.push(encodeBulkMessage(1, FRAME_HEAD, bytes(1), true));
    demux.push(encodeBulkMessage(2, FRAME_DATA, bytes(9))); // other stream, unaffected
    demux.push(encodeBulkMessage(1, FRAME_HEAD, bytes(2)));
    expect(frames.map((f) => [f.streamId, f.type])).toEqual([
      [2, FRAME_DATA],
      [1, FRAME_HEAD],
    ]);
    expect([...frames[1]!.payload]).toEqual([1, 2]);
  });

  it("throws when a different frame type interleaves inside a continuation", () => {
    const { demux } = collect();
    demux.push(encodeBulkMessage(5, FRAME_HEAD, bytes(1), true));
    expect(() => demux.push(encodeBulkMessage(5, FRAME_DATA, bytes(2)))).toThrow(
      /interleaved inside a continued/
    );
  });

  it("caps accumulation at the configured per-stream catastrophe fuse", () => {
    const { demux } = collect({ maxAccumulationBytes: 3 });
    demux.push(encodeBulkMessage(6, FRAME_HEAD, bytes(1, 2), true));
    expect(() => demux.push(encodeBulkMessage(6, FRAME_HEAD, bytes(3, 4), true))).toThrow(
      /exceeds 3 bytes/
    );
    expect(BULK_MUX_ACCUMULATION_CAP_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it("caps the number of simultaneous partial streams", () => {
    const { demux } = collect({ maxPartialStreams: 2 });
    demux.push(encodeBulkMessage(1, FRAME_HEAD, bytes(1), true));
    demux.push(encodeBulkMessage(2, FRAME_HEAD, bytes(1), true));
    expect(() =>
      demux.push(encodeBulkMessage(3, FRAME_HEAD, bytes(1), true))
    ).toThrow(/partial stream count exceeds 2/);
    expect(BULK_MUX_PARTIAL_STREAM_CAP).toBeGreaterThanOrEqual(65_536);
  });

  it("propagates decode violations to the caller (transport turns it into pipe-down)", () => {
    const { frames, demux } = collect();
    expect(() => demux.push(new Uint8Array(2))).toThrow(BulkProtocolViolation);
    expect(frames).toHaveLength(0);
  });

  it("reset() drops partial accumulations (reconnect)", () => {
    const { frames, demux } = collect();
    demux.push(encodeBulkMessage(8, FRAME_HEAD, bytes(1, 2), true));
    demux.reset();
    // The new pipe's final HEAD must NOT concatenate onto the dead pipe's partial.
    demux.push(encodeBulkMessage(8, FRAME_HEAD, bytes(3)));
    expect(frames).toHaveLength(1);
    expect([...frames[0]!.payload]).toEqual([3]);
  });
});
