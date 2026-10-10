import { describe, expect, it } from "vitest";
import { bytesToBase64, serializeRpcFailure, RemoteRpcAggregateError } from "@vibestudio/rpc";
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

it("preserves upload failure members, cause identity, and metadata", async () => {
  const uploads = new WsUploadBodies();
  uploads.open("failed-upload");
  const reader = uploads.take("failed-upload")!.getReader();
  const original = Object.assign(new Error("source failed"), { code: "SOURCE_FAILED" });
  await uploads.push({
    requestId: "failed-upload",
    seq: 0,
    error: serializeRpcFailure(
      new AggregateError([original, new Error("release failed")], "upload failed", {
        cause: original,
      })
    ),
  });
  const failure = await reader.read().catch((error) => error);
  expect(failure).toBeInstanceOf(RemoteRpcAggregateError);
  expect(failure.errors.map((error: Error) => error.message)).toEqual([
    "source failed",
    "release failed",
  ]);
  expect(failure.cause).toBe(failure.errors[0]);
  expect(failure.errors[0].code).toBe("SOURCE_FAILED");
  reader.releaseLock();
});
