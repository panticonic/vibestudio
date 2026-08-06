import { createConnection } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { Gateway } from "./gateway.js";

describe("Gateway lifecycle", () => {
  let gateway: Gateway | null = null;

  afterEach(async () => {
    await gateway?.stop();
    gateway = null;
  });

  it("owns and closes an idle connection during stop", async () => {
    gateway = new Gateway({
      externalHost: "127.0.0.1",
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
      externalHost: "127.0.0.1",
      tokenManager: {} as never,
    });
    const port = await gateway.start(0);

    const response = await fetch(
      `http://127.0.0.1:${port}/_u/workers%252Fexample%7CStore%7Ckey/ping`
    );

    expect(response.status).toBe(404);
  });
});
