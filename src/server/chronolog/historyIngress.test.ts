import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { handleChronologHistoryIngress } from "./historyIngress.js";

it("only stages packets on the native route after checking the exact transition", async () => {
  const dispatch = vi.fn<Parameters<typeof handleChronologHistoryIngress>[3]>(
    async (method, input) => {
      if (method === "stageIncomingHistory") return { kind: "staged", head: input.proposedHead };
      if (method === "serveIncomingHistory") return input.bytes;
      return undefined;
    }
  );
  const server = createServer((req, res) => {
    void handleChronologHistoryIngress(req, res, "trusted-runtime", dispatch);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server");
    const transition = {
      publicationId: "a".repeat(64),
      sourceNodeId: "b".repeat(64),
      previousHead: "c".repeat(40),
      proposedHead: "d".repeat(40),
    };
    const url = `http://127.0.0.1:${address.port}/_chronolog-history?${new URLSearchParams(transition)}`;
    const request = (
      method: string,
      token: string,
      length: number,
      body?: Uint8Array<ArrayBuffer>
    ) =>
      fetch(url, {
        method,
        headers: {
          "x-chronolog-node-token": token,
          "x-chronolog-history-operation": method === "PUT" ? "grant" : "push",
          "x-chronolog-packet-bytes": String(length),
        },
        ...(body ? { body } : {}),
      });

    expect((await request("PUT", "different-runtime", 0)).status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await (await request("PUT", "trusted-runtime", 0)).json()).toEqual({
      kind: "staged",
      head: transition.proposedHead,
    });
    expect((await request("HEAD", "trusted-runtime", 3)).status).toBe(204);
    expect(dispatch).toHaveBeenLastCalledWith("checkIncomingHistory", transition);

    const bytes = Uint8Array.of(1, 2, 3);
    expect((await request("POST", "trusted-runtime", 4, bytes)).status).toBe(409);
    expect(dispatch).toHaveBeenLastCalledWith("checkIncomingHistory", transition);
    const accepted = await request("POST", "trusted-runtime", bytes.length, bytes);
    expect(new Uint8Array(await accepted.arrayBuffer())).toEqual(bytes);
    expect(dispatch).toHaveBeenLastCalledWith("serveIncomingHistory", {
      ...transition,
      bytes: Buffer.from(bytes),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
