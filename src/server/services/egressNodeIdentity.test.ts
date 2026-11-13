import { describe, expect, it, vi } from "vitest";
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { EgressProxy } from "./egressProxy.js";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { signCelldEgress } from "./celldEgressIdentity.js";

const SECRET = "node-egress-secret-0123456789";

function workerCaller(id: string) {
  return createVerifiedCaller(id, "worker", {
    callerId: id,
    callerKind: "worker",
    repoPath: "/repo",
    effectiveVersion: "v",
    executionDigest: "a".repeat(64),
    requested: [],
  });
}

async function listen(handler: (req: IncomingMessage) => void) {
  const seen: IncomingMessage["headers"][] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    handler(req);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("gateway-ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function send(proxyPort: number, target: string, identity: Parameters<typeof signCelldEgress>[0]["identity"]) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: target,
        headers: signCelldEgress({ secret: SECRET, kind: "fetch", method: "GET", target, identity }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the node's identity at the egress proxy", () => {
  it("admits a host program to the gateway origin only, and strips the node's headers", async () => {
    const gateway = await listen(() => undefined);
    const other = await listen(() => undefined);
    const proxy = new EgressProxy({
      credentialStore: { loadUrlBound: vi.fn(() => null) },
      auditLog: { append: vi.fn() },
    });
    proxy.setHostProgramOrigins(() => [gateway.origin]);
    const port = await proxy.startShared(SECRET);
    try {
      for (const identity of [
        { loaded: false, class: null },
        { loaded: false, class: "UniversalDO" },
      ] as const) {
        const ok = await send(port, `${gateway.origin}/_docode/x`, identity);
        expect(ok).toEqual({ status: 200, body: "gateway-ok" });
        const refused = await send(port, `${other.origin}/anything`, identity);
        expect(refused.status).toBe(403);
      }
      expect(other.seen).toHaveLength(0);
      for (const name of ["x-celld-egress-identity", "x-celld-egress-nonce", "x-celld-egress-mac"]) {
        expect(gateway.seen[0]).not.toHaveProperty(name);
      }
    } finally {
      await proxy.stop();
      await gateway.close();
      await other.close();
    }
  });

  it("resolves a product class to its service principal and a loaded worker to its loader's identity", async () => {
    const proxy = new EgressProxy({
      credentialStore: { loadUrlBound: vi.fn(() => null) },
      auditLog: { append: vi.fn() },
    });
    const asked: string[] = [];
    proxy.setCallerResolver((callerId) => {
      asked.push(callerId);
      return null;
    });
    const port = await proxy.startShared(SECRET);
    try {
      await send(port, "http://example.invalid/", { loaded: false, class: "WorkspaceDO" });
      await send(port, "http://example.invalid/", { loaded: true, egressIdentity: ["worker:w", "x"] });
      // Unattributed identities never reach a resolver.
      await send(port, "http://example.invalid/", { loaded: true, egressIdentity: [] });
      expect(asked).toEqual(["do-service:vibestudio/internal:WorkspaceDO", "worker:w"]);
      void workerCaller;
    } finally {
      await proxy.stop();
    }
  });
});
