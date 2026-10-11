import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Pool } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkerdHttpObservation,
  destroyWorkerdConnections,
  getWorkerdConnectionDispatcher,
  postToDurableObject,
  streamFromDurableObject,
  withWorkerdHttpObservation,
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
  it("does not attach an unobserved bodyless request to a reused request context", async () => {
    await withServer(
      (req, res) => {
        req.resume();
        req.on("end", () => {
          if (req.url === "/health") req.socket.destroy();
          else res.end("ok");
        });
      },
      async (origin) => {
        const pool = new Pool(origin, {
          connections: 1,
          pipelining: 1,
          headersTimeout: 0,
          bodyTimeout: 0,
        });
        const dispatcher = withWorkerdHttpObservation(pool);
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const observation = createWorkerdHttpObservation({
            source: ref.source,
            className: ref.className,
            method: "read",
            requestId: "observed-read",
          });
          const response = await observation.fetch(() =>
            fetch(`${origin}/rpc`, {
              method: "POST",
              body: "observed request",
              dispatcher,
            } as RequestInit)
          );
          await observation.readText(response);

          await expect(fetch(`${origin}/health`, { dispatcher } as RequestInit)).rejects.toThrow();

          expect(
            warning.mock.calls.filter(([label]) => label === "[WorkerdHttp] request failed")
          ).toHaveLength(0);
        } finally {
          warning.mockRestore();
          await dispatcher.destroy();
        }
      }
    );
  });

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

  it("keeps an explicit keep-alive pool for reuse and no-replay diagnostics", async () => {
    const sockets = new Set<IncomingMessage["socket"]>();
    const deliveries: string[] = [];
    const remotePortsByMethod = new Map<string, number[]>();
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
          const ports = remotePortsByMethod.get(request.message.method) ?? [];
          const remotePort = req.socket.remotePort;
          if (remotePort === undefined) throw new Error("Request socket has no remote port");
          ports.push(remotePort);
          remotePortsByMethod.set(request.message.method, ports);
          if (request.message.method === "commit-and-disconnect") req.socket.destroy();
          else reply(res, request);
        });
      },
      async (origin) => {
        const pool = new Pool(origin, {
          connections: 1,
          pipelining: 1,
          headersTimeout: 0,
          bodyTimeout: 0,
        });
        const dispatcher = withWorkerdHttpObservation(pool);
        const call = (method: string, requestId: string) => {
          const observation = createWorkerdHttpObservation({
            source: ref.source,
            className: ref.className,
            method,
            requestId,
          });
          return observation
            .fetch(() =>
              fetch(`${origin}/__rpc`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  message: { type: "request", requestId, method },
                }),
                dispatcher,
              } as RequestInit)
            )
            .then((response) => observation.readText(response));
        };
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          for (let index = 0; index < 6; index++) {
            await expect(call("read", `read-${index}`)).resolves.toContain('"result":"done"');
          }
          expect(sockets.size).toBeLessThan(6);
          const firstSocket = remotePortsByMethod.get("read")?.[0];
          expect(firstSocket).toEqual(expect.any(Number));
          expect(remotePortsByMethod.get("read")).toEqual(Array<number>(6).fill(firstSocket!));
          await expect(call("commit-and-disconnect", "ambiguous-post")).rejects.toThrow();
          expect(deliveries.filter((method) => method === "commit-and-disconnect")).toHaveLength(1);
          const failureLog = warning.mock.calls.find(
            ([label]) => label === "[WorkerdHttp] request failed"
          );
          const failureEvidence = JSON.parse(String(failureLog?.[1])) as {
            exchanges: Array<{
              socketPreviousResponseStatus?: number;
              socketPreviousResponseConnection?: string;
              socketPreviousResponseKeepAlive?: string;
              socketPreviousResponseAgeMs?: number;
              socketPreviousResponseBodyAgeMs?: number;
            }>;
          };
          expect(failureEvidence.exchanges).toEqual([
            expect.objectContaining({
              socketPreviousResponseStatus: 200,
              socketPreviousResponseConnection: "keep-alive",
              socketPreviousResponseKeepAlive: "timeout=9",
              socketPreviousResponseAgeMs: expect.any(Number),
              socketPreviousResponseBodyAgeMs: expect.any(Number),
            }),
          ]);
          await expect(call("next-call", "next-call")).resolves.toContain('"result":"done"');
          expect(remotePortsByMethod.get("commit-and-disconnect")).toEqual([firstSocket]);
          expect(remotePortsByMethod.get("next-call")?.[0]).not.toBe(firstSocket);
        } finally {
          warning.mockRestore();
          await dispatcher.destroy();
        }
        expect(deliveries).toEqual([
          ...Array<string>(6).fill("read"),
          "commit-and-disconnect",
          "next-call",
        ]);
      }
    );
  });

  it("gives each unary RPC a close-after-body socket without serializing calls", async () => {
    const sockets = new Set<IncomingMessage["socket"]>();
    const terminal: Promise<void>[] = [];
    const deliveries: string[] = [];
    await withServer(
      (req, res) => {
        sockets.add(req.socket);
        expect(req.headers.connection?.toLowerCase()).toBe("close");
        terminal.push(once(req.socket, "close").then(() => undefined));
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const request = JSON.parse(body) as {
            message: { method: string; requestId: string };
          };
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
        await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            expect(postToDurableObject(ref, "read", [index], deps)).resolves.toBe("done")
          )
        );
        expect(sockets.size).toBe(6);
        await expect(postToDurableObject(ref, "commit-and-disconnect", [], deps)).rejects.toThrow();
        expect(deliveries.filter((method) => method === "commit-and-disconnect")).toHaveLength(1);
        await expect(postToDurableObject(ref, "next-call", [], deps)).resolves.toBe("done");
        expect(sockets.size).toBe(8);
        await Promise.all(terminal);
      }
    );
  });

  it("holds a stream socket through EOF and closes it when the consumer cancels", async () => {
    const sockets = new Set<IncomingMessage["socket"]>();
    const socketOrder: IncomingMessage["socket"][] = [];
    const terminal: Promise<void>[] = [];
    const responses: ServerResponse[] = [];
    await withServer(
      (req, res) => {
        sockets.add(req.socket);
        socketOrder.push(req.socket);
        expect(req.headers.connection?.toLowerCase()).toBe("close");
        terminal.push(once(req.socket, "close").then(() => undefined));
        req.resume();
        req.on("end", () => {
          res.setHeader("Content-Type", "application/x-ndjson");
          res.write("event: data\n\n");
          responses.push(res);
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
        const eof = await streamFromDurableObject(
          ref,
          "updates",
          [],
          deps,
          new AbortController().signal
        );
        expect(sockets.size).toBe(1);
        expect(socketOrder[0]?.destroyed).toBe(false);
        responses[0]!.end();
        await expect(eof.text()).resolves.toBe("event: data\n\n");
        await terminal[0];
        expect(socketOrder[0]?.destroyed).toBe(true);

        const cancelled = await streamFromDurableObject(
          ref,
          "updates",
          [],
          deps,
          new AbortController().signal
        );
        expect(sockets.size).toBe(2);
        expect(socketOrder[1]?.destroyed).toBe(false);
        await cancelled.body!.cancel("consumer stopped");
        await terminal[1];
        expect(socketOrder[1]?.destroyed).toBe(true);
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
