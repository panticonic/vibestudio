import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { RemoteCdpHostProviderSocket } from "./remoteCdpHostProviderSocket.js";
import type { ServerClient } from "./serverClient.js";

function once<T>(
  target: { once(event: string, listener: (value: T) => void): unknown },
  event: string
) {
  return new Promise<T>((resolve) => target.once(event, resolve));
}

describe("RemoteCdpHostProviderSocket", () => {
  it("opens a panelCdp provider stream and forwards frames in both directions", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const streamResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
      })
    );
    const serverClient = {
      stream: vi.fn(async () => streamResponse),
      call: vi.fn(async () => undefined),
    } as Partial<ServerClient> as ServerClient;

    const socket = new RemoteCdpHostProviderSocket({
      serverClient,
      hostConnectionId: "desktop-host",
      sessionId: "provider-session",
    });

    await once<unknown>(socket, "open");
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(serverClient.stream).toHaveBeenCalledWith("panelCdp", "hostProvider.open", [
      "provider-session",
      "desktop-host",
    ]);

    const messagePromise = once<string>(socket, "message");
    controller.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify(JSON.stringify({ type: "vibez1:cdp-auth-ok" }))}\n`
      )
    );
    await expect(messagePromise).resolves.toBe(JSON.stringify({ type: "vibez1:cdp-auth-ok" }));

    const outbound = JSON.stringify({ type: "cdp:register", targetId: "panel-1", tabId: 1 });
    socket.send(outbound);
    await vi.waitFor(() => {
      expect(serverClient.call).toHaveBeenCalledWith("panelCdp", "hostProvider.send", [
        "provider-session",
        outbound,
      ]);
    });

    socket.close();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(serverClient.call).toHaveBeenCalledWith("panelCdp", "hostProvider.close", [
      "provider-session",
    ]);
  });
});
