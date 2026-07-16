import type { WsLike } from "@vibestudio/rpc/protocol/wsAdapter";
import { describe, expect, it } from "vitest";
import { createServerWsTransport } from "./serverWsTransport.js";

class FakeSocket implements WsLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  authenticate(): void {
    this.onmessage?.({
      data: JSON.stringify({
        success: true,
        type: "ws:auth-result",
        contractVersion: 2,
      }),
    });
  }
}

describe("createServerWsTransport", () => {
  it("preserves selected workspace paths", async () => {
    const sockets: FakeSocket[] = [];
    const transport = createServerWsTransport({
      selfId: "shell:mobile",
      serverUrl: "https://server.example/_workspace/dev",
      adapter: {
        now: () => Date.now(),
        getAuthToken: async () => "grant",
        createSocket: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      },
    });
    const connected = transport.connectAndWait();
    await Promise.resolve();
    sockets[0]?.open();
    sockets[0]?.authenticate();
    await connected;

    expect(sockets[0]?.url).toBe("wss://server.example/_workspace/dev/rpc");
  });
});
