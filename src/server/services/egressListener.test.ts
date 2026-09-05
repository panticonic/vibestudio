import { describe, expect, it, vi } from "vitest";
import { connect as netConnect, type Socket } from "node:net";
import { EgressListener } from "./egressListener.js";

function listener(overrides: Partial<ConstructorParameters<typeof EgressListener>[0]> = {}) {
  return new EgressListener({
    request: (_req, res) => res.end(),
    connect: vi.fn(),
    upgrade: vi.fn(),
    ...overrides,
  });
}

function connectedSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("EgressListener", () => {
  it("shares one ready port with concurrent consumers", async () => {
    const owner = listener();
    const first = owner.ready;
    const second = owner.ready;
    const [firstPort, secondPort] = await Promise.all([first, second]);
    expect(secondPort).toBe(firstPort);
    await owner.close();
  });

  it("rejects readiness when closed during startup", async () => {
    const owner = listener();
    const ready = owner.ready;
    const closing = owner.close();
    await expect(ready).rejects.toThrow("retired during startup");
    await expect(closing).resolves.toBeUndefined();
  });

  it("destroys idle accepted sockets on close", async () => {
    const owner = listener();
    const port = await owner.ready;
    const socket = await connectedSocket(port);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await owner.close();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it("destroys a CONNECT-upgraded socket on close", async () => {
    const connect = vi.fn();
    const owner = listener({ connect });
    const port = await owner.ready;
    const socket = await connectedSocket(port);
    socket.write("CONNECT local.test:443 HTTP/1.1\r\nHost: local.test:443\r\n\r\n");
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await owner.close();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it("makes close idempotent", async () => {
    const owner = listener();
    await owner.ready;
    const first = owner.close();
    const second = owner.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
  });
});
