import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  decodeFrameData,
  encodeInput,
  decodeInputData,
  HOST_METHODS,
  SESSION_METHODS,
} from "./index.js";

describe("terminal-host-protocol codecs", () => {
  it("round-trips frame bytes through base64", () => {
    const bytes = new Uint8Array([0x1b, 0x5b, 0x32, 0x4b, 0x00, 0xff, 0x41]);
    const frame = encodeFrame("s1", "stdout", bytes, 7);
    expect(frame).toMatchObject({ sessionId: "s1", stream: "stdout", seq: 7 });
    expect(decodeFrameData(frame)).toEqual(bytes);
  });

  it("round-trips input bytes", () => {
    const bytes = new TextEncoder().encode("\x1b[Ahello");
    const ev = encodeInput("s1", bytes);
    expect(decodeInputData(ev)).toEqual(bytes);
  });

  it("handles empty and large payloads", () => {
    expect(decodeFrameData(encodeFrame("s", "stderr", new Uint8Array(0), 0))).toHaveLength(0);
    const big = new Uint8Array(8192).map((_, i) => i % 256);
    expect(decodeFrameData(encodeFrame("s", "stdout", big, 1))).toEqual(big);
  });

  it("exposes disjoint host/session method names", () => {
    const host = Object.values(HOST_METHODS);
    const session = Object.values(SESSION_METHODS);
    expect(new Set([...host, ...session]).size).toBe(host.length + session.length);
  });
});
