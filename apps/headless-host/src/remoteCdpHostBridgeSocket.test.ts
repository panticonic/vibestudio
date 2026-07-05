import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RpcClient } from "@vibestudio/rpc";
import { RemoteCdpHostBridgeSocket } from "./remoteCdpHostBridgeSocket.js";

function once<T>(
  target: { once(event: string, listener: (value: T) => void): unknown },
  event: string
) {
  return new Promise<T>((resolve) => target.once(event, resolve));
}

describe("RemoteCdpHostBridgeSocket", () => {
  it("opens a panelCdp provider stream and forwards frames in both directions", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const streamResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
      })
    );
    const rpc = {
      stream: vi.fn(async () => streamResponse),
      call: vi.fn(async () => undefined),
    } as unknown as Pick<RpcClient, "call" | "stream"> & {
      stream: ReturnType<typeof vi.fn>;
      call: ReturnType<typeof vi.fn>;
    };

    const socket = new RemoteCdpHostBridgeSocket({
      rpc,
      hostConnectionId: "headless-host",
      sessionId: "provider-session",
    });

    await once<unknown>(socket, "open");
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(rpc.stream).toHaveBeenCalledWith("main", "panelCdp.hostProvider.open", [
      "provider-session",
      "headless-host",
    ]);

    const messagePromise = once<string>(socket, "message");
    controller.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify(JSON.stringify({ type: "vibestudio:cdp-auth-ok" }))}\n`
      )
    );
    await expect(messagePromise).resolves.toBe(JSON.stringify({ type: "vibestudio:cdp-auth-ok" }));

    const outbound = JSON.stringify({ type: "cdp:register", targetId: "panel-1", tabId: 1 });
    socket.send(outbound);
    await vi.waitFor(() => {
      expect(rpc.call).toHaveBeenCalledWith("main", "panelCdp.hostProvider.send", [
        "provider-session",
        outbound,
      ]);
    });

    socket.close();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(rpc.call).toHaveBeenCalledWith("main", "panelCdp.hostProvider.close", [
      "provider-session",
    ]);
  });

  it("fails when the remote CDP stream sends an oversized chunk", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const streamResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
      })
    );
    const rpc = {
      stream: vi.fn(async () => streamResponse),
      call: vi.fn(async () => undefined),
    } as unknown as Pick<RpcClient, "call" | "stream"> & {
      stream: ReturnType<typeof vi.fn>;
      call: ReturnType<typeof vi.fn>;
    };
    const socket = new RemoteCdpHostBridgeSocket({
      rpc,
      hostConnectionId: "headless-host",
      sessionId: "provider-session",
      ndjsonLimits: { maxChunkBytes: 4 },
    });

    await once<unknown>(socket, "open");
    const errorPromise = once<Error>(socket, "error");
    controller.enqueue(new Uint8Array(5));

    await expect(errorPromise).resolves.toMatchObject({
      message: expect.stringMatching(/frame exceeded/),
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("fails when a remote CDP NDJSON line exceeds the limit across chunks", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const streamResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
      })
    );
    const rpc = {
      stream: vi.fn(async () => streamResponse),
      call: vi.fn(async () => undefined),
    } as unknown as Pick<RpcClient, "call" | "stream"> & {
      stream: ReturnType<typeof vi.fn>;
      call: ReturnType<typeof vi.fn>;
    };
    const socket = new RemoteCdpHostBridgeSocket({
      rpc,
      hostConnectionId: "headless-host",
      sessionId: "provider-session",
      ndjsonLimits: { maxLineBytes: 8 },
    });

    await once<unknown>(socket, "open");
    const errorPromise = once<Error>(socket, "error");
    controller.enqueue(new Uint8Array(4));
    controller.enqueue(new Uint8Array(5));

    await expect(errorPromise).resolves.toMatchObject({
      message: expect.stringMatching(/NDJSON line exceeded/),
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
