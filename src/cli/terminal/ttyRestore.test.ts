import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_RESET_SEQUENCE,
  guardTerminal,
  restoreTerminal,
  routeProcessWarnings,
  tolerateTerminalHangup,
} from "./ttyRestore.js";

function fakeTty(raw = true) {
  const input = {
    isTTY: true,
    isRaw: raw,
    setRawMode: vi.fn((mode: boolean) => {
      input.isRaw = mode;
    }),
    pause: vi.fn(),
  };
  const output = { isTTY: true, write: vi.fn() };
  return { input, output };
}

describe("restoreTerminal", () => {
  it("leaves raw mode, the alternate screen, and hidden-cursor state", () => {
    const { input, output } = fakeTty();
    restoreTerminal(input, output);
    expect(input.setRawMode).toHaveBeenCalledWith(false);
    expect(input.pause).toHaveBeenCalled();
    expect(output.write).toHaveBeenCalledWith(TERMINAL_RESET_SEQUENCE);
    expect(TERMINAL_RESET_SEQUENCE).toContain("\x1b[?1049l");
    expect(TERMINAL_RESET_SEQUENCE).toContain("\x1b[?25h");
    expect(TERMINAL_RESET_SEQUENCE).toContain("\x1b[?1000l");
    expect(TERMINAL_RESET_SEQUENCE).toContain("\x1b[?2004l");
    // The cursor is shown last, after the main screen is back.
    expect(TERMINAL_RESET_SEQUENCE.endsWith("\x1b[?25h")).toBe(true);
  });

  it("does not write control sequences to a non-terminal", () => {
    const input = { isTTY: false, pause: vi.fn() };
    const output = { isTTY: false, write: vi.fn() };
    restoreTerminal(input, output);
    expect(output.write).not.toHaveBeenCalled();
  });
});

describe("guardTerminal", () => {
  it("restores on release and on process exit, exactly once per path", () => {
    const { input, output } = fakeTty();
    const processLike = new EventEmitter() as unknown as Pick<NodeJS.Process, "on" | "off">;
    const release = guardTerminal(input, output, processLike);
    expect((processLike as unknown as EventEmitter).listenerCount("exit")).toBe(1);

    // An app that calls process.exit bypasses finally blocks; the exit hook restores.
    (processLike as unknown as EventEmitter).emit("exit", 0);
    expect(output.write).toHaveBeenCalledTimes(1);

    release();
    release();
    expect((processLike as unknown as EventEmitter).listenerCount("exit")).toBe(0);
    expect(output.write).toHaveBeenCalledTimes(2);
    expect(input.isRaw).toBe(false);
  });
});

describe("tolerateTerminalHangup", () => {
  it("treats EIO from a hung-up terminal as the terminal going away", () => {
    const stdout = Object.assign(new EventEmitter(), { isTTY: true });
    const release = tolerateTerminalHangup([stdout]);
    expect(() =>
      stdout.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" }))
    ).not.toThrow();
    release();
    expect(stdout.listenerCount("error")).toBe(0);
  });

  it("still fails on any other stream error", () => {
    const stdout = Object.assign(new EventEmitter(), { isTTY: true });
    tolerateTerminalHangup([stdout]);
    const failure = Object.assign(new Error("write EBADF"), { code: "EBADF" });
    expect(() => stdout.emit("error", failure)).toThrow(failure);
  });

  it("still fails on EIO from a redirected file", () => {
    const stdout = new EventEmitter();
    tolerateTerminalHangup([stdout]);
    const failure = Object.assign(new Error("write EIO"), { code: "EIO" });
    expect(() => stdout.emit("error", failure)).toThrow(failure);
  });
});

describe("routeProcessWarnings", () => {
  it("writes warnings to the log instead of Node's stderr reporter, and restores it", () => {
    const processLike = new EventEmitter();
    const stderrReporter = vi.fn();
    processLike.on("warning", stderrReporter);
    const write = vi.fn();
    const release = routeProcessWarnings(write, processLike as never);

    const warning = Object.assign(new Error("SQLite is an experimental feature"), {
      name: "ExperimentalWarning",
    });
    processLike.emit("warning", warning);
    expect(stderrReporter).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      `(node:${process.pid}) ExperimentalWarning: SQLite is an experimental feature\n`
    );

    release();
    release();
    processLike.emit("warning", warning);
    expect(stderrReporter).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(processLike.listenerCount("warning")).toBe(1);
  });
});
