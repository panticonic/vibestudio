import { describe, expect, it, vi } from "vitest";
import { isTerminalCancellation, retireServer } from "./terminalCommand.js";
import type { LocalServer } from "./localServer.js";

describe("terminal command retirement", () => {
  it("recognizes the original cancellation through a causal startup wrapper", () => {
    const owner = new AbortController();
    const reason = new Error("user interrupted");
    owner.abort(reason);
    expect(
      isTerminalCancellation(new Error("startup stopped", { cause: reason }), owner.signal)
    ).toBe(true);
  });

  it("does not hide earlier operation or cleanup failures behind a later cancellation", () => {
    const owner = new AbortController();
    const reason = new Error("user interrupted");
    const failure = new Error("socket failed to retire");
    owner.abort(reason);
    expect(isTerminalCancellation(failure, owner.signal)).toBe(false);
    expect(isTerminalCancellation(new AggregateError([reason, failure]), owner.signal)).toBe(false);
  });
  it("rejects a failed server join instead of leaving a successful return code", async () => {
    const original = new Error("owned process did not retire");
    const server: LocalServer = {
      ready: {},
      pid: 123,
      retained: false,
      logFile: "/private/server.log",
      exited: Promise.resolve("closed"),
      stop: vi.fn(async () => {
        throw original;
      }),
    };
    const messages: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(retireServer(server, (line) => messages.push(line))).rejects.toMatchObject({
        cause: original,
      });
      expect(messages).not.toContain("Local server stopped.");
    } finally {
      stderr.mockRestore();
    }
  });
});
