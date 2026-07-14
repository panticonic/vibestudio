import { describe, expect, it, vi } from "vitest";
import type { RpcCaller } from "@vibestudio/rpc";
import { createDevHostClient } from "./devHostClient.js";

describe("createDevHostClient", () => {
  it("parses chunk-split NDJSON and cancels when iteration stops", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"seq":1,"at":2,'));
        controller.enqueue(encoder.encode('"level":"info","message":"ready"}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const rpc = {
      call: vi.fn(),
      stream: vi.fn(async () => new Response(body)),
    } as unknown as RpcCaller;
    const client = createDevHostClient(rpc);

    for await (const entry of client.logs({ launchId: "launch", after: 0 })) {
      expect(entry).toEqual({ seq: 1, at: 2, level: "info", message: "ready" });
      break;
    }
    expect(cancelled).toBe(true);
    expect(rpc.stream).toHaveBeenCalledWith("main", "devHost.logs", [
      { launchId: "launch", after: 0 },
    ]);
  });

  it("rejects malformed lifecycle entries at the stream boundary", async () => {
    const rpc = {
      call: vi.fn(),
      stream: vi.fn(async () => new Response('{"seq":1,"state":"invented","at":2}\n')),
    } as unknown as RpcCaller;
    const iterator = createDevHostClient(rpc).watch({ launchId: "launch" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow();
  });
});
