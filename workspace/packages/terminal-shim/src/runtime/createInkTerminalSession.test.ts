import { describe, it, expect } from "vitest";
import { createInkTerminalSession } from "./createInkTerminalSession.js";
import terminalSize from "../node/terminal-size.js";

const decode = (chunks: Uint8Array[]): string =>
  chunks.map((c) => new TextDecoder().decode(c)).join("");

describe("createInkTerminalSession", () => {
  it("forwards stdout/stderr writes to the host sink tagged by stream", () => {
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    const session = createInkTerminalSession({
      sessionId: "s",
      sink: { write: (stream, data) => (stream === "stdout" ? out : err).push(data) },
      initialSize: { columns: 40, rows: 10 },
    });
    session.stdout.write("hello");
    session.stderr.write("oops");
    expect(decode(out)).toBe("hello");
    expect(decode(err)).toBe("oops");
  });

  it("exposes the initial size on the streams and via the terminal-size shim", () => {
    const session = createInkTerminalSession({
      sessionId: "s",
      sink: { write: () => {} },
      initialSize: { columns: 100, rows: 30 },
    });
    expect(session.stdout.columns).toBe(100);
    expect(session.stdout.rows).toBe(30);
    expect(terminalSize()).toEqual({ columns: 100, rows: 30 });
  });

  it("emitResize updates streams, the size shim, and emits 'resize'", () => {
    const session = createInkTerminalSession({
      sessionId: "s",
      sink: { write: () => {} },
      initialSize: { columns: 80, rows: 24 },
    });
    let resized = false;
    session.stdout.on("resize", () => (resized = true));
    session.emitResize({ columns: 120, rows: 40 });
    expect(session.stdout.columns).toBe(120);
    expect(session.stdout.rows).toBe(40);
    expect(resized).toBe(true);
    expect(terminalSize()).toEqual({ columns: 120, rows: 40 });
  });

  it("emitInput delivers bytes as a 'data' event for Ink useInput", () => {
    const session = createInkTerminalSession({ sessionId: "s", sink: { write: () => {} } });
    const received: Uint8Array[] = [];
    session.stdin.on("data", (d: Uint8Array) => received.push(d));
    const bytes = new TextEncoder().encode("\x1b[A"); // up arrow
    session.emitInput(bytes);
    expect(decode(received)).toBe("\x1b[A");
  });

  it("setRawMode on stdin calls back to the host", () => {
    const calls: boolean[] = [];
    const session = createInkTerminalSession({
      sessionId: "s",
      sink: { write: () => {}, setRawMode: (enabled) => calls.push(enabled) },
    });
    session.stdin.setRawMode(true);
    session.stdin.setRawMode(false);
    expect(calls).toEqual([true, false]);
    expect(session.stdin.isRaw).toBe(false);
  });

  it("dispose stops further input and is idempotent", () => {
    const session = createInkTerminalSession({ sessionId: "s", sink: { write: () => {} } });
    const received: Uint8Array[] = [];
    session.stdin.on("data", (d: Uint8Array) => received.push(d));
    session.dispose();
    session.dispose(); // idempotent
    session.emitInput(new TextEncoder().encode("x"));
    expect(received).toHaveLength(0);
  });
});
