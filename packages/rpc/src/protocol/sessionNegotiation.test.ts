import { describe, expect, it } from "vitest";
import type { RpcEnvelope } from "../types.js";
import {
  SESSION_HELLO,
  SESSION_NOT_OPEN_CLOSE_CODE,
  SESSION_OPEN,
  SESSION_OPEN_RESULT,
  SESSION_PROTOCOL_VERSION,
  SESSION_RPC,
  decodeControlFrame,
  encodeControlFrame,
  isSessionHello,
  isSessionOpen,
  isSessionRpc,
  isSessionStreamOpen,
  openResultFor,
  type SessionControlFrame,
} from "./sessionNegotiation.js";

const ENVELOPE: RpcEnvelope = {
  from: "panel:abc",
  target: "main",
  delivery: { caller: { callerId: "panel:abc", callerKind: "panel" } },
  provenance: [{ callerId: "panel:abc", callerKind: "panel" }],
  message: { type: "request", requestId: "r1", fromId: "panel:abc", method: "fs.read", args: ["/x"] },
};

describe("session control frame codec", () => {
  it("round-trips an open frame", () => {
    const frame: SessionControlFrame = {
      t: SESSION_OPEN,
      sid: "s1",
      token: "grant-token",
      connectionId: "desktop-panel-1-uuid",
      clientPlatform: "desktop",
    };
    const decoded = decodeControlFrame(encodeControlFrame(frame));
    expect(decoded).toEqual(frame);
    expect(isSessionOpen(decoded)).toBe(true);
  });

  it("round-trips an rpc frame carrying an immutable-identity envelope", () => {
    const frame: SessionControlFrame = { t: SESSION_RPC, sid: "s2", envelope: ENVELOPE };
    const decoded = decodeControlFrame(encodeControlFrame(frame));
    expect(isSessionRpc(decoded)).toBe(true);
    if (isSessionRpc(decoded)) {
      // delivery.caller / provenance survive verbatim — the channel never rewrites identity.
      expect(decoded.envelope.delivery.caller.callerId).toBe("panel:abc");
      expect(decoded.envelope.provenance[0]!.callerKind).toBe("panel");
    }
  });

  it("round-trips a stream-open frame keyed to a bulk streamId", () => {
    const frame: SessionControlFrame = { t: "stream-open", sid: "s3", streamId: 42, envelope: ENVELOPE };
    const decoded = decodeControlFrame(encodeControlFrame(frame));
    expect(isSessionStreamOpen(decoded)).toBe(true);
    if (isSessionStreamOpen(decoded)) expect(decoded.streamId).toBe(42);
  });

  it("round-trips a stream-open with a request-body stream (bodyStreamId, §1.6)", () => {
    const frame: SessionControlFrame = {
      t: "stream-open",
      sid: "s3",
      streamId: 42,
      bodyStreamId: 43,
      envelope: ENVELOPE,
    };
    const decoded = decodeControlFrame(encodeControlFrame(frame));
    expect(isSessionStreamOpen(decoded)).toBe(true);
    if (isSessionStreamOpen(decoded)) expect(decoded.bodyStreamId).toBe(43);
  });

  it("round-trips the pipe-level hello preamble without a sid", () => {
    const frame: SessionControlFrame = {
      t: SESSION_HELLO,
      proto: SESSION_PROTOCOL_VERSION,
      maxMsg: 256 * 1024,
      platform: "server",
      keepalive: { intervalMs: 15_000, timeoutMs: 45_000 },
    };
    const decoded = decodeControlFrame(encodeControlFrame(frame));
    expect(decoded).toEqual(frame);
    expect(isSessionHello(decoded)).toBe(true);
    if (isSessionHello(decoded)) {
      expect(decoded.proto).toBe(2);
      expect(decoded.keepalive?.timeoutMs).toBe(45_000);
    }
  });

  it("decodes a minimal hello (proto + maxMsg only)", () => {
    const decoded = decodeControlFrame(JSON.stringify({ t: "hello", proto: 2, maxMsg: 16_384 }));
    expect(isSessionHello(decoded)).toBe(true);
  });

  it("round-trips pipe-level ping/pong without a sid", () => {
    expect(decodeControlFrame(encodeControlFrame({ t: "ping", ts: 5 }))).toEqual({ t: "ping", ts: 5 });
    expect(decodeControlFrame(encodeControlFrame({ t: "pong", ts: 9 }))).toEqual({ t: "pong", ts: 9 });
  });

  describe("decode fails loud (never silently drops)", () => {
    it("rejects a non-object frame", () => {
      expect(() => decodeControlFrame("42")).toThrow(/missing tag/);
    });
    it("rejects an unknown tag", () => {
      expect(() => decodeControlFrame(JSON.stringify({ t: "evil", sid: "x" }))).toThrow(/Unknown session control frame tag/);
    });
    it("rejects a session frame missing its sid", () => {
      expect(() => decodeControlFrame(JSON.stringify({ t: "rpc", envelope: ENVELOPE }))).toThrow(/missing sid/);
    });
    it("rejects malformed JSON", () => {
      expect(() => decodeControlFrame("{not json")).toThrow();
    });
    it("rejects a hello missing its negotiation numbers", () => {
      expect(() => decodeControlFrame(JSON.stringify({ t: "hello" }))).toThrow(/proto\/maxMsg/);
      expect(() => decodeControlFrame(JSON.stringify({ t: "hello", proto: "2", maxMsg: 1 }))).toThrow(
        /proto\/maxMsg/,
      );
      expect(() => decodeControlFrame(JSON.stringify({ t: "hello", proto: 2 }))).toThrow(/proto\/maxMsg/);
    });
  });
});

describe("v2 protocol constants", () => {
  it("speaks protocol version 2 (hello preamble + bulk mux)", () => {
    expect(SESSION_PROTOCOL_VERSION).toBe(2);
  });
  it("names the self-healing unknown-sid close code (non-terminal 'closed')", () => {
    expect(SESSION_NOT_OPEN_CLOSE_CODE).toBe(4008);
  });
});

describe("openResultFor", () => {
  it("builds a success result carrying bootId + sessionDirty (drives cold-recover)", () => {
    const r = openResultFor("s1", { ok: true, callerId: "panel:abc", callerKind: "panel", connectionId: "c1", sessionDirty: true }, "boot-xyz");
    expect(r).toEqual({
      t: SESSION_OPEN_RESULT,
      sid: "s1",
      success: true,
      callerId: "panel:abc",
      callerKind: "panel",
      connectionId: "c1",
      serverBootId: "boot-xyz",
      sessionDirty: true,
    });
  });

  it("builds a terminal failure result (lease denied is not retried)", () => {
    const r = openResultFor("s1", { ok: false, error: "Panel runtime is leased by Desktop", terminal: true }, "boot-xyz");
    expect(r.success).toBe(false);
    expect(r.terminal).toBe(true);
    expect(r.error).toMatch(/leased by/);
  });
});
