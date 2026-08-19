import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import * as esbuild from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createNodeProcessAdapter, type ProcessAdapter } from "@vibestudio/process-adapter";
import {
  envelopeFromMessage,
  type RpcEnvelope,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "@vibestudio/rpc";
import type {
  WsClientMessage,
  WsServerMessage,
  WsRpcResponseMessage,
} from "@vibestudio/shared/ws/protocol";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-runtime-"));
}

function waitForMessage<T>(
  subscribe: (resolve: (value: T) => void, reject: (err: Error) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    subscribe(resolve, reject);
  });
}

function makeEnvelope(
  from: string,
  target: string,
  callerKind: RpcEnvelope["delivery"]["caller"]["callerKind"],
  message: RpcMessage
): RpcEnvelope {
  return envelopeFromMessage({
    selfId: from,
    from,
    target,
    callerKind,
    message,
  });
}

describe("extension child runtime process", () => {
  let childRuntimeBundle = "";
  let root: string | null = null;
  let proc: ProcessAdapter | null = null;
  let server: WebSocketServer | null = null;
  let httpServer: Server | null = null;

  beforeAll(async () => {
    const result = await esbuild.build({
      entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), "childRuntime.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      write: false,
      external: ["@vibestudio/process-adapter"],
      logLevel: "silent",
    });
    childRuntimeBundle = result.outputFiles[0]!.text;
  });

  afterEach(async () => {
    proc?.kill();
    proc = null;
    for (const client of server?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = null;
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()) ?? resolve());
    httpServer = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("starts through the process adapter, reports ready, and handles invoke", async () => {
    root = tempDir();
    const childRuntimePath = path.join(root, "childRuntime.mjs");
    fs.writeFileSync(childRuntimePath, childRuntimeBundle);
    const extensionDir = path.join(root, "extension");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, "package.json"), '{"type":"module"}');
    const bundlePath = path.join(extensionDir, "bundle.js");
    fs.writeFileSync(
      bundlePath,
      [
        "export async function activate(ctx) {",
        "  ctx.log.info('activated');",
        "  return {",
        "    ping(value) { return `pong:${value}`; },",
        "    callerContext() {",
        "      const invocation = ctx.invocation.current();",
        "      return invocation?.chainCaller?.contextId ?? invocation?.caller.contextId ?? null;",
        "    },",
        "    targetEcho(targetId, method, value) {",
        "      return ctx.rpc.call(targetId, method, value);",
        "    },",
        "    structuredFailure() {",
        "      const error = new Error('approval required');",
        "      error.code = 'EACQUIRE';",
        "      error.errorKind = 'access';",
        "      error.errorData = { acquisition: { id: 'acq-child', ownerRuntimeId: 'panel-1' } };",
        "      throw error;",
        "    },",
        "    providerContracts: {",
        "      gitInterop: {",
        "        providerPing(value) { return `provider-pong:${value}`; },",
        "      },",
        "    },",
        "  };",
        "}",
        "",
      ].join("\n")
    );

    const admissionGrant = "extension-admission-grant";
    httpServer = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/rpc/ws-admission") {
        expect(req.headers.authorization).toBe("Bearer test-token");
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            grant: admissionGrant,
            expiresAt: Date.now() + 15_000,
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      expect(req.headers["sec-websocket-protocol"]).toContain("vibestudio.auth.rpc.");
      server!.handleUpgrade(req, socket, head, (ws) => server!.emit("connection", ws, req));
    });
    httpServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      httpServer!.once("listening", resolve);
      httpServer!.once("error", reject);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("WebSocket server did not bind");
    const gatewayUrl = `http://127.0.0.1:${address.port}`;

    let extensionLogArgs: unknown[] | undefined;
    const readyPromise = waitForMessage<{ ws: import("ws").WebSocket; message: RpcRequest }>(
      (resolve, reject) => {
        server!.once("connection", (ws) => {
          ws.on("message", (raw) => {
            try {
              const message = JSON.parse(String(raw)) as WsClientMessage;
              if (message.type === "ws:auth") {
                expect(message.token).toBe(admissionGrant);
                ws.send(
                  JSON.stringify({
                    type: "ws:auth-result",
                    success: true,
                    contractVersion: 2,
                  } satisfies WsServerMessage)
                );
                return;
              }
              if (message.type === "ws:route") {
                const envelope = message.envelope as RpcEnvelope | undefined;
                const rpc = envelope?.message as RpcMessage | undefined;
                if (!envelope || rpc?.type !== "request") return;
                const response: RpcResponse = {
                  type: "response",
                  requestId: rpc.requestId,
                  result: {
                    targetId: envelope.target,
                    method: rpc.method,
                    args: rpc.args,
                    parentRequestId: rpc.parentRequestId,
                  },
                };
                ws.send(
                  JSON.stringify({
                    type: "ws:routed",
                    envelope: makeEnvelope(envelope.target, envelope.from, "do", response),
                  } satisfies WsServerMessage)
                );
                return;
              }
              if (message.type !== "ws:rpc") return;
              const envelope = message.envelope as RpcEnvelope | undefined;
              const rpc = envelope?.message as RpcMessage | undefined;
              if (!envelope || rpc?.type !== "request") return;
              const response: RpcResponse = {
                type: "response",
                requestId: rpc.requestId,
                result: null,
              };
              ws.send(
                JSON.stringify({
                  type: "ws:rpc",
                  envelope: makeEnvelope("main", envelope.from, "server", response),
                } satisfies WsServerMessage)
              );
              if (rpc.method === "runtime.supervision.appendLog") {
                extensionLogArgs = rpc.args;
              }
              if (rpc.method === "runtime.supervision.reportReady") {
                resolve({ ws, message: rpc });
              }
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        });
      }
    );

    proc = createNodeProcessAdapter(childRuntimePath, {
      ...process.env,
      VIBESTUDIO_EXTENSION_NAME: "@workspace-extensions/process-test",
      VIBESTUDIO_EXTENSION_VERSION: "0.0.0",
      VIBESTUDIO_EXTENSION_BUNDLE_PATH: bundlePath,
      VIBESTUDIO_EXTENSION_STORAGE_DIR: path.join(root, "storage"),
      VIBESTUDIO_EXTENSION_GATEWAY_URL: gatewayUrl,
      VIBESTUDIO_EXTENSION_RPC_TOKEN: "test-token",
    });
    const ready = await readyPromise;
    expect(ready.message.args[0]).toEqual({
      methods: ["ping", "callerContext", "targetEcho", "structuredFailure"],
      providerMethods: { gitInterop: ["providerPing"] },
      hasFetch: false,
    });
    expect(extensionLogArgs).toEqual([{ level: "info", message: "activated" }]);

    const requestId = randomUUID();
    const response = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === requestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "ping",
              ["ok"],
              {
                requestId,
                extensionName: "@workspace-extensions/process-test",
                method: "ping",
                caller: { callerId: "test", callerKind: "shell" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(response).toEqual({
      type: "response",
      requestId,
      result: "pong:ok",
    });

    const providerRequestId = randomUUID();
    const providerResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === providerRequestId) resolve(rpc);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: providerRequestId,
            fromId: "main",
            method: "extension.invokeProvider",
            args: [
              "gitInterop",
              "providerPing",
              ["ok"],
              {
                requestId: providerRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "providers.gitInterop.providerPing",
                caller: { callerId: "server", callerKind: "server" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(providerResponse).toEqual({
      type: "response",
      requestId: providerRequestId,
      result: "provider-pong:ok",
    });

    const flatProviderRequestId = randomUUID();
    const flatProviderResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === flatProviderRequestId) resolve(rpc);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: flatProviderRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "providerPing",
              ["bypass"],
              {
                requestId: flatProviderRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "providerPing",
                caller: { callerId: "server", callerKind: "server" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(flatProviderResponse).toMatchObject({
      type: "response",
      requestId: flatProviderRequestId,
      errorCode: "ENOMETHOD",
    });

    const directRequestId = randomUUID();
    const directResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === directRequestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: {
            from: "main",
            target: "@workspace-extensions/process-test",
            delivery: { caller: { callerId: "panel-1", callerKind: "panel" } },
            provenance: [{ callerId: "panel-1", callerKind: "panel" }],
            message: {
              type: "request",
              requestId: directRequestId,
              fromId: "main",
              method: "extension.invoke",
              args: [
                "ping",
                ["bypass"],
                {
                  requestId: directRequestId,
                  extensionName: "@workspace-extensions/process-test",
                  method: "ping",
                  caller: { callerId: "panel-1", callerKind: "panel" },
                },
              ],
            } satisfies RpcRequest,
          } satisfies RpcEnvelope,
        } satisfies WsServerMessage)
      );
    });

    expect(directResponse).toMatchObject({
      type: "response",
      requestId: directRequestId,
      errorCode: "EACCES",
      error: expect.stringContaining("trusted host principal"),
    });

    const serverTargetRequestId = randomUUID();
    const serverTargetRequest: RpcRequest = {
      type: "request",
      requestId: serverTargetRequestId,
      fromId: "server",
      method: "extension.invoke",
      args: [
        "ping",
        ["server-ok"],
        {
          requestId: serverTargetRequestId,
          extensionName: "@workspace-extensions/process-test",
          method: "ping",
          caller: { callerId: "server", callerKind: "server" },
        },
      ],
    };
    const serverTargetEnvelope: RpcEnvelope = {
      from: "server",
      target: "@workspace-extensions/process-test",
      delivery: { caller: { callerId: "server", callerKind: "server" } },
      provenance: [{ callerId: "server", callerKind: "server" }],
      message: serverTargetRequest,
    };
    const serverTargetResponse = await waitForMessage<WsRpcResponseMessage>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsRpcResponseMessage;
          const rpc = message.envelope?.message;
          if (rpc?.type === "response" && rpc.requestId === serverTargetRequestId) {
            resolve(message);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: serverTargetEnvelope,
        } satisfies WsServerMessage)
      );
    });

    expect(serverTargetResponse).toMatchObject({
      type: "ws:rpc",
      envelope: {
        target: "server",
        message: {
          type: "response",
          requestId: serverTargetRequestId,
          result: "pong:server-ok",
        },
      },
    });

    const contextRequestId = randomUUID();
    const contextResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === contextRequestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: contextRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "callerContext",
              [],
              {
                requestId: contextRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "callerContext",
                caller: { callerId: "panel-1", callerKind: "panel", contextId: "ctx-panel" },
                chainCaller: {
                  callerId: "panel-1",
                  callerKind: "panel",
                  repoPath: "panels/test",
                  effectiveVersion: "ev-test",
                  contextId: "ctx-panel",
                },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(contextResponse).toEqual({
      type: "response",
      requestId: contextRequestId,
      result: "ctx-panel",
    });

    const structuredFailureRequestId = randomUUID();
    const structuredFailureResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === structuredFailureRequestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: structuredFailureRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "structuredFailure",
              [],
              {
                requestId: structuredFailureRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "structuredFailure",
                caller: { callerId: "panel-1", callerKind: "panel" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(structuredFailureResponse).toMatchObject({
      type: "response",
      requestId: structuredFailureRequestId,
      errorCode: "EACQUIRE",
      errorKind: "access",
      errorData: { acquisition: { id: "acq-child", ownerRuntimeId: "panel-1" } },
    });

    const targetRequestId = randomUUID();
    const targetResponse = await waitForMessage<RpcResponse>((resolve, reject) => {
      ready.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as WsClientMessage;
          if (message.type !== "ws:rpc") return;
          const rpc = message.envelope?.message as RpcMessage | undefined;
          if (rpc?.type === "response" && rpc.requestId === targetRequestId) {
            resolve(rpc);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ready.ws.send(
        JSON.stringify({
          type: "ws:rpc",
          envelope: makeEnvelope("main", "@workspace-extensions/process-test", "server", {
            type: "request",
            requestId: targetRequestId,
            fromId: "main",
            method: "extension.invoke",
            args: [
              "targetEcho",
              ["do:workers/example:ExampleDO:object-1", "lookup", "value"],
              {
                requestId: targetRequestId,
                extensionName: "@workspace-extensions/process-test",
                method: "targetEcho",
                caller: { callerId: "test", callerKind: "shell" },
              },
            ],
          } satisfies RpcRequest),
        } satisfies WsServerMessage)
      );
    });

    expect(targetResponse).toEqual({
      type: "response",
      requestId: targetRequestId,
      result: {
        targetId: "do:workers/example:ExampleDO:object-1",
        method: "lookup",
        args: ["value"],
        parentRequestId: targetRequestId,
      },
    });
  });
});
