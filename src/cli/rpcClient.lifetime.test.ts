import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { RpcClient } from "./rpcClient.js";

it("closing a client cancels an HTTP RPC that has not produced response headers", async () => {
  let recordRequest!: () => void;
  const requested = new Promise<void>((resolve) => {
    recordRequest = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/refresh-agent")) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          token: "bearer",
          callerId: "agent:test",
          callerKind: "agent",
          entityId: "test",
          contextId: "main",
          channelId: "chat:test",
          agentId: "test",
          serverId: "server:test",
          serverBootId: "boot:test",
          workspaceId: "workspace:test",
        })
      );
    } else {
      recordRequest();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const client = new RpcClient({ url: `http://127.0.0.1:${address.port}`, token: "test-token" });
  const result = client.call("waitForever").then(
    () => ({ resolved: true }),
    (error: unknown) => ({ resolved: false, error })
  );
  try {
    await requested;
    await client.close();
    expect(await result).toMatchObject({ resolved: false, error: expect.any(Error) });
  } finally {
    server.closeAllConnections();
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
