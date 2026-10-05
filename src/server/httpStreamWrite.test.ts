import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { writeHttpBytes } from "./httpStreamWrite.js";

function response(write = vi.fn(() => false)) {
  return Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, write });
}
function write(res: ReturnType<typeof response>) {
  return writeHttpBytes(res as unknown as ServerResponse, Buffer.from("payload"));
}
function expectReleased(res: EventEmitter) {
  for (const event of ["drain", "close", "error"]) expect(res.listenerCount(event)).toBe(0);
}

describe("HTTP stream write ownership", () => {
  it("waits for backpressure and releases all terminal listeners on drain", async () => {
    const res = response();
    const pending = write(res);
    expect(res.listenerCount("drain")).toBe(1);
    res.emit("drain");
    await pending;
    expectReleased(res);
  });
  it.each(["close", "error"])(
    "settles a stranded write on %s and releases its listeners",
    async (event) => {
      const res = response();
      const pending = write(res);
      const failure = new Error("socket failure");
      res.emit(event, failure);
      if (event === "error") await expect(pending).rejects.toBe(failure);
      else await expect(pending).rejects.toMatchObject({ code: "ECONNRESET" });
      expectReleased(res);
    }
  );
  it("does not leave a drain listener when the response closes synchronously during write", async () => {
    const res = response();
    res.write.mockImplementation(() => {
      res.emit("close");
      return false;
    });
    await expect(write(res)).rejects.toMatchObject({ code: "ECONNRESET" });
    expectReleased(res);
  });
  it("refuses destroyed responses and preserves thrown write errors", async () => {
    const res = response();
    res.destroyed = true;
    await expect(write(res)).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(res.write).not.toHaveBeenCalled();
    res.destroyed = false;
    const failure = new Error("write failure");
    res.write.mockImplementation(() => {
      throw failure;
    });
    await expect(write(res)).rejects.toBe(failure);
    expectReleased(res);
  });
});
