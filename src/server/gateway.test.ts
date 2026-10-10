import { createConnection } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gateway } from "./gateway.js";

describe("Gateway lifecycle", () => {
  let gateway: Gateway | null = null;

  afterEach(async () => {
    await gateway?.stop();
    gateway = null;
  });

  it("retains a completed loader connection until its owner retires it", async () => {
    gateway = new Gateway({
      tokenManager: {} as never,
      getWorkerHost: () =>
        ({
          getLoaderSecret: () => "fixture-loader",
          getDoCode: async () => ({ version: "fixture-version" }),
        }) as never,
    });
    const port = await gateway.start(0);
    const socket = createConnection(port, "127.0.0.1");
    await once(socket, "connect");
    const request = async () => {
      const received = once(socket, "data");
      socket.write(
        "GET /_docode/source/Class HTTP/1.1\r\nHost: localhost\r\nX-Vibestudio-Loader-Secret: fixture-loader\r\n\r\n"
      );
      const [data] = await received;
      expect(data.toString()).toContain("200 OK");
      expect(data.toString()).toContain('"version":"fixture-version"');
    };
    await request();
    // Cross Node's default five-second keep-alive expiry and its one-second
    // buffer. A slow workerd consumer must retain this completed connection
    // until it closes it or the owning gateway stops.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(socket.destroyed).toBe(false);
    await request();
    const closed = once(socket, "close");
    await gateway.stop();
    await closed;
  }, 15_000);

  it("owns and closes an idle connection during stop", async () => {
    gateway = new Gateway({
      tokenManager: {} as never,
    });
    const port = await gateway.start(0);
    const socket = createConnection(port, "127.0.0.1");
    await once(socket, "connect");

    await Promise.race([
      gateway.stop(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("gateway stop did not close the connection")), 1_000)
      ),
    ]);
    if (!socket.destroyed) await once(socket, "close").catch(() => undefined);

    expect(gateway.getPort()).toBeNull();
    await gateway.stop();
  });

  it("does not expose raw userland Durable Object transport", async () => {
    gateway = new Gateway({
      tokenManager: {} as never,
    });
    const port = await gateway.start(0);

    const response = await fetch(
      `http://127.0.0.1:${port}/_u/workers%252Fexample%7CStore%7Ckey/ping`
    );

    expect(response.status).toBe(404);
  });

  it("routes the authenticated workspace relay endpoint only to the RPC owner", async () => {
    const handleWorkspaceRpcHttp = vi.fn((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    gateway = new Gateway({
      tokenManager: {} as never,
      rpcHandler: { handleWorkspaceRpcHttp } as never,
    });
    const port = await gateway.start(0);

    const response = await fetch(`http://127.0.0.1:${port}/_r/s/internal/workspace-rpc`, {
      method: "POST",
    });

    expect(response.status).toBe(204);
    expect(handleWorkspaceRpcHttp).toHaveBeenCalledOnce();
  });
});
