import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { destroyWorkerdConnections, postToDurableObject } from "./workerdRpcRelay.js";

const ref = { source: "workers/test", className: "TestDO", objectKey: "connections" };

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (origin: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await run(origin);
  } finally {
    await destroyWorkerdConnections(origin, "test owner retired");
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function reply(res: ServerResponse, request: { message: { requestId: string } }): void {
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      from: "do",
      target: "main",
      delivery: { caller: { callerId: "do", callerKind: "do" } },
      provenance: [],
      message: { type: "response", requestId: request.message.requestId, result: "done" },
    })
  );
}

describe("owned workerd HTTP connections", () => {
  it("reuses sockets for repeated calls and never replays an ambiguously delivered POST", async () => {
    const sockets = new Set<IncomingMessage["socket"]>();
    const deliveries: string[] = [];
    await withServer(
      (req, res) => {
        sockets.add(req.socket);
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const request = JSON.parse(body) as { message: { requestId: string; method: string } };
          deliveries.push(request.message.method);
          if (request.message.method === "commit-and-disconnect") req.socket.destroy();
          else reply(res, request);
        });
      },
      async (origin) => {
        const deps = {
          workerdUrl: origin,
          workerdGatewayToken: "test",
          resolveExecutableAdmission: () => ({
            executableVersion: "version",
            incarnationVersion: "version",
            props: { stateArgs: null, image: null },
          }),
        };
        for (let index = 0; index < 6; index++) {
          await expect(postToDurableObject(ref, "read", [], deps)).resolves.toBe("done");
        }
        expect(sockets.size).toBeLessThan(6);
        await expect(postToDurableObject(ref, "commit-and-disconnect", [], deps)).rejects.toThrow(
          /fetch/
        );
        await expect(postToDurableObject(ref, "next-call", [], deps)).resolves.toBe("done");
        expect(deliveries).toEqual([
          ...Array<string>(6).fill("read"),
          "commit-and-disconnect",
          "next-call",
        ]);
      }
    );
  });

  it("delivers cancellation on another socket while the original call joins cleanup", async () => {
    let held: { response: ServerResponse; request: { message: { requestId: string } } } | undefined;
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const sockets = new Set<IncomingMessage["socket"]>();
    await withServer(
      (req, res) => {
        sockets.add(req.socket);
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const request = JSON.parse(body) as { message: { requestId: string; type: string } };
          if (request.message.type === "request-cancel") {
            res.end();
            if (!held) throw new Error("Cancellation arrived before admission");
            held.response.end(
              JSON.stringify({
                from: "do",
                target: "main",
                delivery: { caller: { callerId: "do", callerKind: "do" } },
                provenance: [],
                message: {
                  type: "response",
                  requestId: held.request.message.requestId,
                  error: { message: "explicit stop", errorKind: "application" },
                },
              })
            );
          } else {
            held = { response: res, request };
            res.setHeader("Content-Type", "application/json");
            res.flushHeaders();
            admitted();
          }
        });
      },
      async (origin) => {
        const controller = new AbortController();
        const call = postToDurableObject(
          ref,
          "held",
          [],
          {
            workerdUrl: origin,
            workerdGatewayToken: "test",
            resolveExecutableAdmission: () => ({
              executableVersion: "version",
              incarnationVersion: "version",
              props: { stateArgs: null, image: null },
            }),
          },
          controller.signal
        );
        await admission;
        controller.abort(new Error("explicit stop"));
        await expect(call).rejects.toThrow("explicit stop");
        expect(sockets.size).toBe(2);
      }
    );
  });
});
