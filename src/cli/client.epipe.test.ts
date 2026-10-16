import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installBrokenPipeHandler } from "./client.js";

describe("CLI broken-pipe handling", () => {
  it("treats EPIPE as a successful downstream close", () => {
    const stream = new EventEmitter();
    const terminate = vi.fn();
    const uninstall = installBrokenPipeHandler(stream, terminate);

    stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));

    expect(terminate).toHaveBeenCalledOnce();
    uninstall();
  });

  it("does not swallow unrelated stream errors", () => {
    const stream = new EventEmitter();
    const uninstall = installBrokenPipeHandler(stream, vi.fn());

    expect(() =>
      stream.emit("error", Object.assign(new Error("disk failure"), { code: "EIO" }))
    ).toThrow("disk failure");
    uninstall();
  });

  it("lets a command outlive a hung-up terminal", () => {
    const stream = Object.assign(new EventEmitter(), { isTTY: true });
    const terminate = vi.fn();
    const uninstall = installBrokenPipeHandler(stream, terminate);

    expect(() =>
      stream.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" }))
    ).not.toThrow();
    expect(terminate).not.toHaveBeenCalled();
    uninstall();
  });
});

describe("routeDiagnosticsToStderr", () => {
  it("keeps library diagnostics off stdout, which belongs to command results", async () => {
    const { routeDiagnosticsToStderr } = await import("./client.js");
    const { info, debug } = console;
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      routeDiagnosticsToStderr();
      console.info("trace");
      console.debug("detail");
      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledTimes(2);
    } finally {
      console.info = info;
      console.debug = debug;
      out.mockRestore();
      err.mockRestore();
    }
  });
});
