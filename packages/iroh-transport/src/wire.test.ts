import { describe, expect, it } from "vitest";
import {
  decodeIrohStreamPreamble,
  encodeIrohStreamPreamble,
  IROH_WIRE_VERSION,
  MAX_CONTROL_FRAME_BYTES,
  MAX_SESSION_ID_BYTES,
} from "./wire.js";

const encoder = new TextEncoder();

describe("Iroh wire preamble", () => {
  it.each([
    { k: "control", v: IROH_WIRE_VERSION } as const,
    { k: "envelope", sid: "shell", v: IROH_WIRE_VERSION } as const,
    { k: "message", sid: "panel", v: IROH_WIRE_VERSION } as const,
    {
      body: true,
      k: "stream",
      requestId: "request-1",
      sid: "shell",
      v: IROH_WIRE_VERSION,
    } as const,
  ])("round-trips canonical $k streams", (preamble) => {
    const encoded = encodeIrohStreamPreamble(preamble);
    expect(encoded.byteLength).toBeLessThan(MAX_CONTROL_FRAME_BYTES);
    expect(decodeIrohStreamPreamble(encoded)).toEqual(preamble);
    expect(encodeIrohStreamPreamble(decodeIrohStreamPreamble(encoded))).toEqual(encoded);
  });

  it.each([
    { k: "control", v: 3 },
    { extra: true, k: "control", v: IROH_WIRE_VERSION },
    { k: "envelope", sid: "", v: IROH_WIRE_VERSION },
    { body: "yes", k: "stream", requestId: "r", sid: "s", v: IROH_WIRE_VERSION },
    { k: "unknown", v: IROH_WIRE_VERSION },
  ])("rejects malformed preamble %#", (value) => {
    expect(() => decodeIrohStreamPreamble(encoder.encode(JSON.stringify(value)))).toThrow();
  });

  it("rejects oversized session identifiers", () => {
    expect(() =>
      encodeIrohStreamPreamble({
        k: "envelope",
        sid: "s".repeat(MAX_SESSION_ID_BYTES + 1),
        v: IROH_WIRE_VERSION,
      })
    ).toThrow(/session ID/);
  });

  it("rejects invalid UTF-8", () => {
    expect(() => decodeIrohStreamPreamble(Uint8Array.of(0xff))).toThrow(/Invalid/);
  });
});
