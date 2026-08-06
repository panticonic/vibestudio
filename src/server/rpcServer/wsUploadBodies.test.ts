import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "@vibestudio/rpc";
import { WsUploadBodies } from "./wsUploadBodies.js";

describe("WsUploadBodies", () => {
  it("reassembles ordered chunks and closes at the acknowledged terminal frame", async () => {
    const uploads = new WsUploadBodies();
    uploads.open("request-1");
    const body = uploads.take("request-1");
    expect(body).toBeDefined();

    await uploads.push({
      requestId: "request-1",
      seq: 0,
      payload: bytesToBase64(new Uint8Array([1, 2, 3])),
    });
    await uploads.push({ requestId: "request-1", seq: 1, done: true });

    const reader = body!.getReader();
    await expect(reader.read()).resolves.toEqual({
      value: new Uint8Array([1, 2, 3]),
      done: false,
    });
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true });
    expect(uploads.take("request-1")).toBeUndefined();
  });

  it("rejects out-of-order and reused upload ids", async () => {
    const uploads = new WsUploadBodies();
    uploads.open("request-1");
    expect(() => uploads.open("request-1")).toThrow(/reused/);
    await expect(uploads.push({ requestId: "request-1", seq: 1, done: true })).rejects.toThrow(
      /expected chunk 0/
    );
    uploads.closeAll(new Error("test complete"));
  });
});
