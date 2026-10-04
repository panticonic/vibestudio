import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import type { Credential } from "@vibestudio/credential-client/types";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { EGRESS_CREDENTIAL_HEADER } from "@vibestudio/shared/runtime/egressCredential";
import { EgressProxy } from "./egressProxy.js";

async function fixture() {
  const observed: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    observed.push(req.headers);
    res.end("ok");
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    observed.push(req.headers);
    sockets.handleUpgrade(req, socket, head, (ws) => ws.close(1000, "done"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const credential = (id: string, token: string): Credential => ({
    id,
    providerId: "url-bound",
    connectionId: id,
    connectionLabel: id,
    accountIdentity: { providerUserId: id },
    accessToken: token,
    scopes: [],
    bindings: [
      {
        id: "model",
        use: "fetch",
        audience: [{ url: `${origin}/model`, match: "path-prefix" }],
        injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
      },
    ],
    grants: [
      {
        bindingId: "model",
        use: "fetch",
        resource: `${origin}/model`,
        action: "use",
        scope: "version",
        repoPath: "workers/agent",
        effectiveVersion: "reviewed-version",
        grantedAt: 1,
        grantedBy: "self",
      },
    ],
  });
  const credentials = new Map([
    ["selected", credential("selected", "selected-token")],
    ["other", credential("other", "other-token")],
  ]);
  const caller = createVerifiedCaller("worker:agent", "worker", {
    callerId: "worker:agent",
    callerKind: "worker",
    repoPath: "workers/agent",
    effectiveVersion: "reviewed-version",
    executionDigest: "a".repeat(64),
    requested: [],
  });
  const proxy = new EgressProxy({
    credentialStore: {
      loadUrlBound: (id) => credentials.get(id) ?? null,
      listUrlBound: () => [...credentials.values()],
    },
    auditLog: { async append() {} },
    // Real network policy denies loopback. This fixture authorizes its exact
    // listener while retaining the actual credential authorization/injection.
    authorizeInternalRequest: ({ targetUrl }) => (targetUrl.origin === origin ? {} : null),
  });
  proxy.setCallerResolver((id) => (id === caller.runtime.id ? caller : null));
  const port = await proxy.startShared("fixture-secret");

  const send = (websocket: boolean, selection?: string | string[], secret = "fixture-secret") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: `${websocket ? "ws" : "http"}://127.0.0.1:${address.port}/model/responses`,
        headers: {
          "X-Vibestudio-Egress-Caller": caller.runtime.id,
          "X-Vibestudio-Egress-Secret": secret,
          ...(selection === undefined ? {} : { [EGRESS_CREDENTIAL_HEADER]: selection }),
          ...(websocket
            ? {
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Key": Buffer.alloc(16).toString("base64"),
                "Sec-WebSocket-Version": "13",
              }
            : {}),
        },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, body: "" });
      });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          })
        );
      });
      req.on("error", reject);
      req.end();
    });
  return {
    observed,
    credentials,
    send,
    async close() {
      await proxy.stop();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        sockets.close((error) => (error ? reject(error) : resolve()))
      );
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

describe.each([false, true])("host egress exact credential (WebSocket=%s)", (websocket) => {
  it("uses the selected credential among multiple matches and strips the selector", async () => {
    const f = await fixture();
    try {
      expect((await f.send(websocket, "selected")).status).toBe(websocket ? 101 : 200);
      expect(f.observed).toHaveLength(1);
      expect(f.observed[0]?.authorization).toBe("Bearer selected-token");
      expect(f.observed[0]).not.toHaveProperty(EGRESS_CREDENTIAL_HEADER);
      expect(f.observed[0]).not.toHaveProperty("x-vibestudio-egress-secret");
      expect(f.observed[0]).not.toHaveProperty("x-vibestudio-egress-caller");
    } finally {
      await f.close();
    }
  });

  it.each(["missing", "revoked", "expired", "audience", "ungranted"] as const)(
    "refuses %s selection without using another matching credential",
    async (failure) => {
      const f = await fixture();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const selected = f.credentials.get("selected");
        if (!selected) throw new Error("Missing fixture credential");
        if (failure === "missing") f.credentials.delete("selected");
        if (failure === "revoked") selected.revokedAt = 1;
        if (failure === "expired") selected.expiresAt = 1;
        if (failure === "audience") {
          selected.bindings = selected.bindings?.map((binding) => ({
            ...binding,
            audience: [{ url: "https://other.example.test/", match: "origin" }],
          }));
        }
        if (failure === "ungranted") selected.grants = [];
        expect((await f.send(websocket, "selected")).status).toBe(403);
        expect(f.observed).toEqual([]);
      } finally {
        warn.mockRestore();
        await f.close();
      }
    }
  );

  it.each(["", ["selected", "other"], ["selected", "selected"]])(
    "refuses an empty or ambiguous selector: %j",
    async (selection) => {
      const f = await fixture();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect((await f.send(websocket, selection)).status).toBe(400);
        expect(f.observed).toEqual([]);
      } finally {
        warn.mockRestore();
        await f.close();
      }
    }
  );

  it("does not treat a credential selector as caller authentication", async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await f.send(websocket, "selected", "wrong-secret")).status).toBe(403);
      expect(f.observed).toEqual([]);
    } finally {
      warn.mockRestore();
      await f.close();
    }
  });
});

it("strips egress routing headers from an authenticated platform callback", async () => {
  let observed: IncomingHttpHeaders | undefined;
  const target = createServer((req, res) => {
    observed = req.headers;
    res.end("ok");
  });
  const proxy = new EgressProxy({
    credentialStore: { loadUrlBound: () => null },
    auditLog: { async append() {} },
    authorizePlatformRpcCallback: ({ targetUrl, authorization, runtimeId }) =>
      targetUrl.origin === origin &&
      authorization === "Bearer callback-token" &&
      runtimeId === "worker:agent",
  });
  let origin: string;
  try {
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    origin = `http://127.0.0.1:${address.port}`;
    const port = await proxy.start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: `${origin}/rpc`,
          method: "POST",
          headers: {
            Authorization: "Bearer callback-token",
            "X-Vibestudio-Runtime-Id": "worker:agent",
            "X-Vibestudio-Egress-Caller": "worker:agent",
            "X-Vibestudio-Egress-Secret": "private-routing-secret",
            [EGRESS_CREDENTIAL_HEADER]: "selected",
          },
        },
        (res) => {
          res.resume();
          res.on("error", reject);
          res.on("end", () => resolve(res.statusCode ?? 0));
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(observed?.authorization).toBe("Bearer callback-token");
    expect(observed?.["x-vibestudio-runtime-id"]).toBe("worker:agent");
    expect(observed).not.toHaveProperty(EGRESS_CREDENTIAL_HEADER);
    expect(observed).not.toHaveProperty("x-vibestudio-egress-secret");
    expect(observed).not.toHaveProperty("x-vibestudio-egress-caller");
  } finally {
    await proxy.stop();
    await new Promise<void>((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
