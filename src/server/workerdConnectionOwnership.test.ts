import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { destroyWorkerdConnections, getWorkerdConnectionDispatcher } from "./workerdRpcRelay.js";

it("retires only the owning workerd endpoint and gives its next generation a fresh pool", async () => {
  function endpoint() {
    let admit!: (response: ServerResponse) => void;
    const admitted = new Promise<ServerResponse>((resolve) => {
      admit = resolve;
    });
    const server = createServer((_request, response) => admit(response));
    return { server, admitted };
  }
  const first = endpoint(),
    second = endpoint();
  first.server.listen(0, "127.0.0.1");
  second.server.listen(0, "127.0.0.1");
  await Promise.all([once(first.server, "listening"), once(second.server, "listening")]);
  const origin = (server: typeof first.server) => {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing owned endpoint");
    return `http://127.0.0.1:${address.port}`;
  };
  const firstOrigin = origin(first.server),
    secondOrigin = origin(second.server);
  const firstPool = getWorkerdConnectionDispatcher(firstOrigin);
  const secondPool = getWorkerdConnectionDispatcher(secondOrigin);
  const request = (url: string) =>
    fetch(url, {
      method: "POST",
      dispatcher: getWorkerdConnectionDispatcher(url),
    } as RequestInit).then(
      async (response) => ({ text: await response.text() }),
      (error: unknown) => ({ error })
    );
  const firstRequest = request(firstOrigin),
    secondRequest = request(secondOrigin);
  try {
    const [firstResponse, secondResponse] = await Promise.all([first.admitted, second.admitted]);
    await destroyWorkerdConnections(firstOrigin, "first generation explicitly retired");
    const failure = await firstRequest;
    expect(failure).toMatchObject({
      error: { cause: { message: "first generation explicitly retired" } },
    });
    expect(getWorkerdConnectionDispatcher(firstOrigin)).not.toBe(firstPool);
    expect(getWorkerdConnectionDispatcher(`${secondOrigin}/another-method`)).toBe(secondPool);
    expect(secondResponse.destroyed).toBe(false);
    secondResponse.end("second generation remains live");
    expect(await secondRequest).toEqual({ text: "second generation remains live" });
    firstResponse.destroy();
  } finally {
    await Promise.all([
      destroyWorkerdConnections(firstOrigin, "fixture cleanup"),
      destroyWorkerdConnections(secondOrigin, "fixture cleanup"),
    ]);
    await Promise.all([firstRequest, secondRequest]);
    await Promise.all(
      [first.server, second.server].map(async (server) => {
        const closed = once(server, "close");
        server.closeAllConnections();
        server.close();
        await closed;
      })
    );
  }
});
