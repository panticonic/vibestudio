import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { envelopeFromMessage, type RpcEnvelope, type RpcResponse } from "@vibestudio/rpc";
import { FRAME_DATA, FRAME_END, FRAME_HEAD } from "@vibestudio/rpc/protocol/streamCodec";
import { RPC_CONTRACT_VERSION } from "@vibestudio/rpc/protocol/contractVersion";
import { createServerClient } from "./serverClient.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function startRpcHarness() {
  const admissionCredentials = new Map<string, string>();
  const admissionPlatforms: Array<string | undefined> = [];
  let admissionSequence = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/rpc/ws-admission") {
      res.writeHead(404);
      res.end();
      return;
    }
    const authorization = req.headers.authorization;
    const credential =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
    admissionPlatforms.push(
      typeof req.headers["x-vibestudio-rpc-client-platform"] === "string"
        ? req.headers["x-vibestudio-rpc-client-platform"]
        : undefined
    );
    const grant = `admission-${++admissionSequence}`;
    admissionCredentials.set(grant, credential);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, grant, expiresAt: Date.now() + 15_000 }));
  });
  const wss = new WebSocketServer({ noServer: true });
  const grantRequests: unknown[][] = [];
  const scopedRequests: Array<{ callerId: string; callerKind: string; method: string }> = [];
  const scopedEnvelopes: Array<{
    callerId: string;
    callerKind: string;
    envelope: RpcEnvelope;
  }> = [];
  let shellSocket: import("ws").WebSocket | undefined;
  let appSocket: import("ws").WebSocket | undefined;
  let panelSocket: import("ws").WebSocket | undefined;
  let appGrantSequence = 0;
  let appConnectionCount = 0;
  const redeemedAppGrants = new Set<string>();
  let reverseSequence = 0;
  const reverseCalls = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/rpc") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let callerId = "";
      let callerKind = "";
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as {
          type?: string;
          token?: string;
          envelope?: {
            from?: string;
            message?: {
              type?: string;
              requestId?: string;
              method?: string;
              args?: unknown[];
            };
          };
        };
        if (msg.type === "ws:auth") {
          const credential = admissionCredentials.get(msg.token ?? "") ?? "";
          const shell = credential === "shell-token";
          const appGrant = credential.startsWith("app-grant-");
          const app = appGrant && !redeemedAppGrants.has(credential);
          if (app) redeemedAppGrants.add(credential);
          const panel = credential === "panel-grant";
          // A pairing code redeems into a shell principal and rides the freshly
          // issued device credential back on the auth-result (rpcServer.handleAuth).
          const pairing = credential === "pairing-code";
          callerId = shell
            ? "electron-main"
            : app
              ? "@workspace-apps/shell"
              : panel
                ? "panel:nav-current"
                : pairing
                  ? "shell:device-1"
                  : "";
          callerKind = shell || pairing ? "shell" : app ? "app" : panel ? "panel" : "";
          if (shell) shellSocket = ws;
          if (app) {
            appSocket = ws;
            appConnectionCount += 1;
          }
          if (panel) panelSocket = ws;
          const success = shell || app || panel || pairing;
          ws.send(
            JSON.stringify({
              type: "ws:auth-result",
              success,
              ...(success ? { contractVersion: RPC_CONTRACT_VERSION } : {}),
              callerId,
              callerKind,
              connectionId: "conn",
              serverBootId: "boot",
              sessionDirty: false,
              ...(pairing
                ? {
                    deviceCredential: {
                      deviceId: "device-1",
                      refreshToken: "refresh-secret",
                    },
                    pairingContext: { workspaceId: "workspace-1" },
                  }
                : {}),
            })
          );
          if (app || panel) {
            ws.send(
              JSON.stringify({
                type: "ws:rpc",
                envelope: {
                  from: "main",
                  target: callerId,
                  delivery: { caller: { callerId: "main", callerKind: "server" } },
                  provenance: [{ callerId: "main", callerKind: "server" }],
                  message: {
                    type: "event",
                    fromId: "main",
                    event: "workspace:changed",
                    payload: { callerId },
                  },
                },
              })
            );
          }
          return;
        }
        const envelope = msg.envelope as RpcEnvelope | undefined;
        const message = envelope?.message;
        if ((msg.type !== "ws:rpc" && msg.type !== "ws:route") || !message || !envelope) return;
        if (callerKind === "app") scopedEnvelopes.push({ callerId, callerKind, envelope });
        if (message.type === "response") {
          const pending = reverseCalls.get(message.requestId);
          if (!pending) return;
          reverseCalls.delete(message.requestId);
          if ("error" in message) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
          return;
        }
        if (message.type !== "request") return;
        const { requestId, method, args = [] } = message;
        const sendResponse = (response: RpcResponse) => {
          ws.send(
            JSON.stringify({
              type: "ws:rpc",
              envelope: envelopeFromMessage({
                selfId: "main",
                from: "main",
                target: envelope.from,
                callerKind: "server",
                message: response,
              }),
            })
          );
        };
        if (callerKind === "app" && envelope.target.startsWith("do:") && method === "direct.echo") {
          ws.send(
            JSON.stringify({
              type: "ws:routed",
              envelope: envelopeFromMessage({
                selfId: envelope.target,
                from: envelope.target,
                target: envelope.from,
                callerKind: "do",
                message: {
                  type: "response",
                  requestId,
                  result: { args, target: envelope.target },
                },
              }),
            })
          );
          return;
        }
        if (callerKind === "shell" && method === "auth.grantConnection") {
          grantRequests.push(args);
          const principalId = String(args[0] ?? "");
          sendResponse({
            type: "response",
            requestId,
            result: {
              token: principalId.startsWith("panel:")
                ? "panel-grant"
                : `app-grant-${++appGrantSequence}`,
            },
          });
          return;
        }
        if ((callerKind === "app" || callerKind === "panel") && method === "workspace.getInfo") {
          scopedRequests.push({ callerId, callerKind, method });
          sendResponse({
            type: "response",
            requestId,
            result: { callerId, callerKind },
          });
          return;
        }
        sendResponse({
          type: "response",
          requestId,
          error: `unexpected ${callerKind}:${method}`,
          errorKind: "application",
        });
      });
    });
  });

  const port: number = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  cleanup.push(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const callShell = async (method: string, args: unknown[]): Promise<unknown> => {
    const ws = shellSocket;
    if (!ws) throw new Error("Shell is not connected");
    const requestId = `reverse-${++reverseSequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      reverseCalls.set(requestId, { resolve, reject });
    });
    ws.send(
      JSON.stringify({
        type: "ws:rpc",
        envelope: {
          from: "server",
          target: "electron-main",
          delivery: { caller: { callerId: "server", callerKind: "server" } },
          provenance: [{ callerId: "server", callerKind: "server" }],
          message: { type: "request", requestId, fromId: "server", method, args },
        },
      })
    );
    return await result;
  };
  const sendPanelEnvelope = (envelope: RpcEnvelope): void => {
    if (!panelSocket) throw new Error("Panel is not connected");
    panelSocket.send(JSON.stringify({ type: "ws:rpc", envelope }));
  };
  const sendAppEnvelope = (envelope: RpcEnvelope): void => {
    if (!appSocket) throw new Error("App is not connected");
    appSocket.send(JSON.stringify({ type: "ws:routed", envelope }));
  };
  const dropAppConnection = (): void => {
    if (!appSocket) throw new Error("App is not connected");
    appSocket.terminate();
  };
  return {
    port,
    grantRequests,
    scopedRequests,
    scopedEnvelopes,
    admissionPlatforms,
    callShell,
    sendPanelEnvelope,
    sendAppEnvelope,
    dropAppConnection,
    appConnectionCount: () => appConnectionCount,
  };
}

describe("ServerClient scoped runtime callers", () => {
  it("binds desktop host metadata into local WebSocket admission", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token", {
      clientPlatform: "desktop",
    });
    cleanup.push(() => client.close());

    expect(harness.admissionPlatforms).toEqual(["desktop"]);
  });

  it("accepts reverse host-method calls from the authenticated WebSocket server bridge", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());
    client.exposeHostMethod("desktopProbe.inspect", ({ args }) => ({
      value: args[0],
    }));

    await expect(harness.callShell("desktopProbe.inspect", ["ready"])).resolves.toEqual({
      value: "ready",
    });
  });

  it("creates an app-scoped WS client through a shell-issued connection grant", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());
    const events: unknown[] = [];
    client.addMessageListener(
      { callerId: "@workspace-apps/shell", callerKind: "app" },
      (envelope) => {
        const message = envelope.message;
        if (message.type === "event") events.push(message.payload);
      }
    );

    await expect(
      client.callAs(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "workspace",
        "getInfo",
        []
      )
    ).resolves.toEqual({ callerId: "@workspace-apps/shell", callerKind: "app" });

    expect(harness.grantRequests).toEqual([["@workspace-apps/shell"]]);
    expect(harness.scopedRequests).toEqual([
      {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        method: "workspace.getInfo",
      },
    ]);
    await expect.poll(() => events).toEqual([{ callerId: "@workspace-apps/shell" }]);
  });

  it("relays the complete direct-target envelope protocol over one app-scoped session", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());
    const caller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };
    const received: RpcEnvelope[] = [];
    client.addMessageListener(caller, (envelope) => received.push(envelope));
    const target =
      "do:workers/workspace-presentation:WorkspacePresentationDO:workspace-presentation";
    const request: RpcEnvelope = {
      from: caller.callerId,
      target,
      delivery: { caller },
      provenance: [caller],
      message: {
        type: "request",
        requestId: "direct-request-1",
        fromId: caller.callerId,
        method: "direct.echo",
        args: ["panel-1"],
      },
    };

    await client.sendAs(caller, request);
    await expect
      .poll(() =>
        received.find(
          (envelope) =>
            envelope.message.type === "response" &&
            envelope.message.requestId === "direct-request-1"
        )
      )
      .toMatchObject({
        from: target,
        target: caller.callerId,
        message: {
          type: "response",
          requestId: "direct-request-1",
          result: { args: ["panel-1"], target },
        },
      });

    const directEvent = envelopeFromMessage({
      selfId: target,
      from: target,
      target: caller.callerId,
      callerKind: "do",
      message: {
        type: "event",
        fromId: target,
        event: "presentation:changed",
        payload: { slotId: "panel-1" },
      },
    });
    harness.sendAppEnvelope(directEvent);
    await expect.poll(() => received).toContainEqual(directEvent);

    const streamRequest: RpcEnvelope = {
      ...request,
      message: {
        type: "stream-request",
        requestId: "direct-stream-1",
        fromId: caller.callerId,
        method: "direct.watch",
        args: [],
      },
    };
    const streamCancel: RpcEnvelope = {
      ...request,
      message: {
        type: "stream-cancel",
        requestId: "direct-stream-1",
        fromId: caller.callerId,
      },
    };
    const requestCancel: RpcEnvelope = {
      ...request,
      message: {
        type: "request-cancel",
        requestId: "direct-request-2",
        fromId: caller.callerId,
      },
    };
    await client.sendAs(caller, streamRequest);
    const streamFrames = [
      {
        frameType: FRAME_HEAD,
        payload: JSON.stringify({ status: 200, statusText: "OK", headerPairs: [], finalUrl: "" }),
      },
      { frameType: FRAME_DATA, payload: "aGVsbG8=" },
      { frameType: FRAME_END, payload: JSON.stringify({ bytesIn: 5 }) },
    ].map(({ frameType, payload }) =>
      envelopeFromMessage({
        selfId: target,
        from: target,
        target: caller.callerId,
        callerKind: "do",
        message: {
          type: "stream-frame",
          requestId: "direct-stream-1",
          fromId: target,
          frameType,
          payload,
        },
      })
    );
    for (const frame of streamFrames) harness.sendAppEnvelope(frame);
    await expect.poll(() => received).toEqual(expect.arrayContaining(streamFrames));

    const incomingRequest = envelopeFromMessage({
      selfId: target,
      from: target,
      target: caller.callerId,
      callerKind: "do",
      message: {
        type: "request",
        requestId: "incoming-request-1",
        fromId: target,
        method: "host.refresh",
        args: [],
      },
    });
    harness.sendAppEnvelope(incomingRequest);
    await expect.poll(() => received).toContainEqual(incomingRequest);
    const outgoingResponse: RpcEnvelope = {
      from: caller.callerId,
      target,
      delivery: { caller },
      provenance: [caller],
      message: {
        type: "response",
        requestId: "incoming-request-1",
        result: { refreshed: true },
      },
    };
    await client.sendAs(caller, outgoingResponse);
    await client.sendAs(caller, streamCancel);
    await client.sendAs(caller, requestCancel);

    await expect
      .poll(() => harness.scopedEnvelopes.map(({ envelope }) => envelope))
      .toEqual(
        expect.arrayContaining([
          request,
          streamRequest,
          outgoingResponse,
          streamCancel,
          requestCancel,
        ])
      );
    expect(harness.grantRequests).toEqual([[caller.callerId]]);
  });

  it("reconnects the app-scoped session with a fresh one-shot grant", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());
    const caller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };
    const received: RpcEnvelope[] = [];
    client.addMessageListener(caller, (envelope) => received.push(envelope));
    const target = "do:workers/example:ExampleDO:singleton";
    const makeRequest = (requestId: string): RpcEnvelope => ({
      from: caller.callerId,
      target,
      delivery: { caller },
      provenance: [caller],
      message: {
        type: "request",
        requestId,
        fromId: caller.callerId,
        method: "direct.echo",
        args: [requestId],
      },
    });

    await client.sendAs(caller, makeRequest("before-drop"));
    await expect
      .poll(() =>
        received.some(
          ({ message }) => message.type === "response" && message.requestId === "before-drop"
        )
      )
      .toBe(true);

    harness.dropAppConnection();
    await expect.poll(() => harness.appConnectionCount(), { timeout: 5_000 }).toBe(2);
    await expect
      .poll(() => harness.grantRequests, { timeout: 5_000 })
      .toEqual([[caller.callerId], [caller.callerId]]);

    await client.sendAs(caller, makeRequest("after-reconnect"));
    await expect
      .poll(() =>
        received.some(
          ({ message }) => message.type === "response" && message.requestId === "after-reconnect"
        )
      )
      .toBe(true);
  });

  it("surfaces the auth-result deviceCredential via onPaired (pairing-code bootstrap)", async () => {
    const harness = await startRpcHarness();
    const paired: Array<{
      credential: { deviceId: string; refreshToken: string };
      context?: { workspaceId: string };
    }> = [];
    const client = await createServerClient(harness.port, "pairing-code", {
      onPaired: (credential, context) => paired.push({ credential, context }),
    });
    cleanup.push(() => client.close());

    await expect
      .poll(() => paired)
      .toEqual([
        {
          credential: { deviceId: "device-1", refreshToken: "refresh-secret" },
          context: { workspaceId: "workspace-1" },
        },
      ]);
  });

  it("does not invoke onPaired when the auth-result carries no credential", async () => {
    const harness = await startRpcHarness();
    const paired: unknown[] = [];
    const client = await createServerClient(harness.port, "shell-token", {
      onPaired: (credential) => paired.push(credential),
    });
    cleanup.push(() => client.close());

    expect(client.isConnected()).toBe(true);
    expect(paired).toEqual([]);
  });

  it("fails closed for panel scoped callers", async () => {
    // A panel authenticates its own direct connection, which holds the panel
    // lease; a second host-opened connection for the same panel is rejected by
    // the server's lease gate. So scoped panel RPC is refused up front (no grant
    // request) — panel operations are translated by the trusted host instead.
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());

    await expect(
      client.callAs(
        { callerId: "panel:nav-current", callerKind: "panel" },
        "workspace",
        "getInfo",
        []
      )
    ).rejects.toThrow(/not available for panel/);
    expect(harness.grantRequests).toEqual([]);
  });

  it("keeps loopback panel sessions as transport-only envelope relays", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());
    const session = await client.openPanelSession("panel:nav-current", "panel-connection");
    cleanup.push(() => session.close());
    const received: RpcEnvelope[] = [];
    session.onMessage((envelope) => received.push(envelope));

    const request = envelopeFromMessage({
      selfId: "main",
      from: "main",
      target: "panel:nav-current",
      callerKind: "server",
      message: {
        type: "request",
        requestId: "snapshot-request",
        fromId: "main",
        method: "_agent.snapshot",
        args: [],
      },
    });
    harness.sendPanelEnvelope(request);

    await expect.poll(() => received).toContainEqual(request);
    expect(session.streamReadable).toBeTypeOf("function");
  });

  it("fails closed for unsupported scoped caller kinds", async () => {
    const harness = await startRpcHarness();
    const client = await createServerClient(harness.port, "shell-token");
    cleanup.push(() => client.close());

    await expect(
      client.callAs({ callerId: "worker-1", callerKind: "worker" }, "workspace", "getInfo", [])
    ).rejects.toThrow(/not available for worker/);
    expect(harness.grantRequests).toEqual([]);
  });
});
