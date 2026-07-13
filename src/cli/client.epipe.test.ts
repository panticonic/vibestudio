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
});
