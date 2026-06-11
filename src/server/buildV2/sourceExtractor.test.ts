import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  isExpectedPipeClosure,
  pipeChildOutputToInput,
  processFailureMessage,
  waitForClose,
} from "./sourceExtractor.js";
import type { ChildProcess } from "node:child_process";

describe("sourceExtractor process helpers", () => {
  it("preserves signal-only process termination instead of treating it as success", async () => {
    const child = new EventEmitter() as ChildProcess;
    const resultPromise = waitForClose(child);

    child.emit("close", null, "SIGTERM");

    await expect(resultPromise).resolves.toEqual({ code: null, signal: "SIGTERM" });
  });

  it("formats signal termination as a failed extraction process", () => {
    expect(
      processFailureMessage(
        "tar extract",
        "/repo",
        "abc123",
        { code: null, signal: "SIGKILL" },
        "partial archive"
      )
    ).toMatch(/tar extract was killed by signal SIGKILL.*partial archive/);
  });

  it("does not report a failure for clean zero exits", () => {
    expect(
      processFailureMessage("git archive", "/repo", "abc123", { code: 0, signal: null }, "")
    ).toBeNull();
  });

  it("captures broken pipe errors from child stream piping", async () => {
    const error = new Error("write EPIPE") as NodeJS.ErrnoException;
    error.code = "EPIPE";
    const source = Readable.from([Buffer.from("archive data")]);
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback(error);
      },
    });

    const result = await pipeChildOutputToInput(source, destination);

    expect(result).toMatchObject({ code: "EPIPE" });
    expect(isExpectedPipeClosure(result)).toBe(true);
  });
});
