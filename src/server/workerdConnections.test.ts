import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkerdHttpObservation,
  destroyWorkerdConnections,
  getWorkerdConnectionDispatcher,
  postToDurableObject,
} from "./workerdRpcRelay.js";

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
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive", "timeout=9");
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
  it("attributes concurrent socket failures to the request that owned each socket", async () => {
    await withServer(
      (req, res) => {
        req.resume();
        req.on("end", () => {
          if (req.url === "/reset") req.socket.destroy();
          else res.end("ok");
        });
      },
      async (origin) => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const request = (path: string, requestId: string) => {
          const observation = createWorkerdHttpObservation({
            source: "workers/test",
            className: "TestDO",
            method: path.slice(1),
            requestId,
          });
          const url = `${origin}${path}`;
          return observation
            .fetch(() =>
              fetch(url, {
                method: "POST",
                body: "test",
                dispatcher: getWorkerdConnectionDispatcher(url),
              } as RequestInit)
            )
            .then((response) => observation.readText(response));
        };
        try {
          const outcomes = await Promise.allSettled([
            request("/reset", "failed-request"),
            request("/success", "successful-request"),
          ]);
          expect(outcomes[0]?.status).toBe("rejected");
          expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: "ok" });
          const failureLogs = warning.mock.calls.filter(
            ([label]) => label === "[WorkerdHttp] request failed"
          );
          expect(failureLogs).toHaveLength(1);
          const failureEvidence = JSON.parse(String(failureLogs[0]?.[1])) as {
            method: string;
            requestId: string;
            exchanges: Array<{
              localPort?: number;
              requestSentAtMs?: number;
              requestBodySentAtMs?: number;
              requestErrorAtMs?: number;
              requestError?: { code?: string };
            }>;
          };
          expect(failureEvidence).toMatchObject({
            method: "reset",
            requestId: "failed-request",
            exchanges: [expect.objectContaining({ localPort: expect.any(Number) })],
          });
          expect(failureEvidence.exchanges[0]?.requestError?.code).toEqual(expect.any(String));
          const exchange = failureEvidence.exchanges[0]!;
          expect(exchange.requestSentAtMs).toEqual(expect.any(Number));
          expect(exchange.requestBodySentAtMs).toEqual(expect.any(Number));
          expect(exchange.requestErrorAtMs).toEqual(expect.any(Number));
          expect(exchange.requestSentAtMs).toBeLessThanOrEqual(exchange.requestBodySentAtMs!);
          expect(exchange.requestBodySentAtMs).toBeLessThanOrEqual(exchange.requestErrorAtMs!);
          expect(failureEvidence).not.toHaveProperty("requestId", "successful-request");
        } finally {
          warning.mockRestore();
        }
      }
    );
  });

  it("records response headers when a socket resets while the body is being read", async () => {
    await withServer(
      (req, res) => {
        req.resume();
        req.on("end", () => {
          res.setHeader("Content-Type", "text/plain");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("Keep-Alive", "timeout=17");
          res.writeHead(200);
          res.flushHeaders();
          res.write("partial");
          req.socket.destroy();
        });
      },
      async (origin) => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const observation = createWorkerdHttpObservation({
          source: "workers/test",
          className: "TestDO",
          method: "body-reset",
          requestId: "body-reset-request",
        });
        try {
          const response = await observation.fetch(() =>
            fetch(origin, {
              method: "POST",
              body: "test",
              dispatcher: getWorkerdConnectionDispatcher(origin),
            } as RequestInit)
          );
          expect(response.status).toBe(200);
          await expect(observation.readText(response)).rejects.toThrow();
          const failureLog = warning.mock.calls.find(
            ([label]) => label === "[WorkerdHttp] request failed"
          );
          const failureEvidence = JSON.parse(String(failureLog?.[1])) as Record<string, unknown>;
          expect(failureEvidence).toMatchObject({
            requestId: "body-reset-request",
            exchanges: [
              expect.objectContaining({
                responseStatus: 200,
                responseConnection: "keep-alive",
                responseKeepAlive: "timeout=17",
                responseHeadersAtMs: expect.any(Number),
              }),
            ],
          });
          expect(failureEvidence).not.toHaveProperty("exchanges.0.responseBodyComplete");
        } finally {
          warning.mockRestore();
        }
      }
    );
  });

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
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          await expect(postToDurableObject(ref, "commit-and-disconnect", [], deps)).rejects.toThrow(
            /fetch/
          );
          const failureLog = warning.mock.calls.find(
            ([label]) => label === "[WorkerdHttp] request failed"
          );
          const failureEvidence = JSON.parse(String(failureLog?.[1])) as Record<string, unknown>;
          expect(failureEvidence).toMatchObject({
            source: ref.source,
            className: ref.className,
            method: "commit-and-disconnect",
            requestId: expect.any(String),
            exchanges: [
              expect.objectContaining({
                localPort: expect.any(Number),
                remotePort: expect.any(Number),
                socketPreviousResponseStatus: 200,
                socketPreviousResponseConnection: "keep-alive",
                socketPreviousResponseKeepAlive: "timeout=9",
                socketPreviousResponseAgeMs: expect.any(Number),
                socketPreviousResponseBodyAgeMs: expect.any(Number),
              }),
            ],
          });
          expect(failureEvidence).not.toHaveProperty("url");
          expect(failureEvidence).not.toHaveProperty("headers");
          expect(failureEvidence).not.toHaveProperty("body");
        } finally {
          warning.mockRestore();
        }
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
