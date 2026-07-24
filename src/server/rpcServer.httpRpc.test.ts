import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { WebSocket } from "ws";
import { RpcServer } from "./rpcServer.js";
import type { UserSubjectSource } from "@vibestudio/identity/userSubjectSource";
import { Gateway } from "./gateway.js";
import type {
  ServiceDispatcher,
  ServiceContext,
} from "../../packages/shared/src/serviceDispatcher.js";
import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { EntityCache } from "../../packages/shared/src/runtime/entityCache.js";
import type { EntityRecord } from "../../packages/shared/src/runtime/entitySpec.js";
import type { UserSubject } from "../../packages/identity/src/types.js";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import { createTestServiceDispatcher } from "../../packages/shared/src/serviceDispatcherTestUtils.js";
import type { ServiceDefinition } from "../../packages/shared/src/serviceDefinition.js";

function makeDoRecord(
  id: string,
  repoPath: string,
  effectiveVersion: string,
  requestedMethods: string[] = ["credentials.listStoredCredentials"],
  agentBinding?: EntityRecord["agentBinding"]
): EntityRecord {
  return {
    id,
    kind: "do",
    source: { repoPath, effectiveVersion },
    contextId: "",
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
    activeBuildKey: `build:${effectiveVersion}`,
    activeExecutionDigest: "a".repeat(64),
    activeAuthority: {
      requests: requestedMethods.map((method) => ({
        capability: method === "credentials.proxyFetch" ? "credential.use" : `service:${method}`,
        resource:
          method === "credentials.proxyFetch"
            ? { kind: "prefix" as const, prefix: "" }
            : {
                kind: "exact" as const,
                key:
                  method === "credentials.listStoredCredentials"
                    ? "workspace:test"
                    : `service:${method}`,
              },
        tier: "gated" as const,
        evidence: "exact" as const,
      })),
    },
    ...(agentBinding ? { agentBinding } : {}),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTestSetup(opts?: {
  entityCache?: EntityCache;
  userSubjectSource?: UserSubjectSource;
  membershipGate?: (subject: UserSubject | undefined) => boolean;
  verifyExactCausalInvocation?: ConstructorParameters<
    typeof RpcServer
  >[0]["verifyExactCausalInvocation"];
}) {
  const tokenManager = new TokenManager();
  const adminToken = "test-admin-token";
  tokenManager.setAdminToken(adminToken);
  const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
  const shellToken = tokenManager.ensureToken("shell:test", "shell");
  const literalShellToken = tokenManager.ensureToken("shell", "shell");
  const remoteShellToken = tokenManager.ensureToken("shell:remote-test", "shell");
  const entityCache = opts?.entityCache ?? new EntityCache();

  const dispatchResults = new Map<string, unknown>();
  const dispatched: Array<{
    ctx: ServiceContext;
    service: string;
    method: string;
    args: unknown[];
  }> = [];

  const dispatcher = createTestServiceDispatcher({
    openMethods: ["automation.spawn", "build.recompute", "build.status"],
  });
  const handler: ServiceDefinition["handler"] = async (ctx, method, args) => {
    const service = serviceForMethod(method);
    dispatched.push({ ctx, service, method, args });
    const key = `${service}.${method}`;
    if (dispatchResults.has(key)) return dispatchResults.get(key);
    return { ok: true };
  };
  registerRpcTestService(
    dispatcher,
    "credentials",
    ["user", "code"],
    {
      listStoredCredentials: "read",
      resolveCredential: "write",
      proxyFetch: "write",
    },
    handler
  );
  registerRpcTestService(dispatcher, "automation", ["code"], { spawn: "write" }, handler);
  registerRpcTestService(
    dispatcher,
    "build",
    ["user", "code", "host"],
    {
      recompute: "write",
      status: "read",
    },
    handler
  );
  dispatcher.markInitialized();
  vi.spyOn(dispatcher, "dispatch");

  const server = new RpcServer({
    tokenManager,
    dispatcher,
    entityCache,
    userSubjectSource: opts?.userSubjectSource,
    membershipGate: opts?.membershipGate,
    verifyExactCausalInvocation: opts?.verifyExactCausalInvocation,
  });

  return {
    server,
    tokenManager,
    adminToken,
    workerToken,
    shellToken,
    literalShellToken,
    remoteShellToken,
    entityCache,
    dispatcher,
    dispatched,
    dispatchResults,
  };
}

function registerRpcTestService(
  dispatcher: ServiceDispatcher,
  name: string,
  principals: Array<"user" | "code" | "host">,
  methods: Record<string, "read" | "write">,
  handler: ServiceDefinition["handler"] = async () => ({ ok: true })
): void {
  const methodEntries = Object.fromEntries(
    Object.entries(methods).map(([method, sensitivity]) => [
      method,
      { args: z.tuple([]).rest(z.unknown()), access: { sensitivity } },
    ])
  ) as ServiceDefinition["methods"];
  dispatcher.registerService({ name, authority: { principals }, methods: methodEntries, handler });
}

function serviceForMethod(method: string): string {
  if (["listStoredCredentials", "resolveCredential", "proxyFetch"].includes(method)) {
    return "credentials";
  }
  if (method === "spawn") return "automation";
  return "build";
}

/**
 * Build the canonical envelope accepted by `/rpc` from concise test inputs.
 * The wire request and successful wire response remain envelope-native.
 */
function toEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const caller = { callerId: "test-caller", callerKind: "shell" };
  const type = body["type"] as string | undefined;
  const target = (body["targetId"] as string | undefined) ?? "main";
  if (type === "emit") {
    return {
      from: caller.callerId,
      target,
      delivery: { caller },
      provenance: [caller],
      message: {
        type: "event",
        fromId: caller.callerId,
        event: body["event"],
        payload: body["payload"],
      },
    };
  }
  const requestId =
    (body["requestId"] as string | undefined) ?? `req-${Math.random().toString(36).slice(2)}`;
  return {
    from: caller.callerId,
    target,
    delivery: {
      caller,
      ...(body["idempotencyKey"] ? { idempotencyKey: body["idempotencyKey"] } : {}),
      ...(body["readOnly"] ? { readOnly: true } : {}),
    },
    provenance: [caller],
    message: {
      type: "request",
      requestId,
      fromId: caller.callerId,
      method: body["method"],
      args: body["args"] ?? [],
      ...(body["causalParent"] ? { causalParent: body["causalParent"] } : {}),
    },
  };
}

/** Build a canonical stream-request envelope from concise test inputs. */
function toStreamEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const caller = { callerId: "test-caller", callerKind: "shell" };
  return {
    from: caller.callerId,
    target: (body["targetId"] as string | undefined) ?? "main",
    delivery: { caller, ...(body["readOnly"] ? { readOnly: true } : {}) },
    provenance: [caller],
    message: {
      type: "stream-request",
      requestId: `s-${Math.random().toString(36).slice(2)}`,
      fromId: caller.callerId,
      method: body["method"],
      args: body["args"] ?? [],
      ...(body["readOnly"] ? { readOnly: true } : {}),
      ...(body["causalParent"] ? { causalParent: body["causalParent"] } : {}),
    },
  };
}

async function postRpc(
  port: number,
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(toEnvelope(body)),
  });
  const json = (await res.json()) as Record<string, unknown>;
  // Auth/transport failures return a bare `{error}` (not an envelope).
  if (!res.ok || "deferred" in json || !("message" in json || "envelope" in json)) {
    return { status: res.status, body: json };
  }
  const message = (
    ("envelope" in json ? json["envelope"] : json) as { message?: Record<string, unknown> }
  ).message;
  return { status: res.status, body: (message ?? {}) as Record<string, unknown> };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RpcServer HTTP POST /rpc", () => {
  let setup: ReturnType<typeof createTestSetup>;
  let gateway: Gateway;
  let port: number;

  beforeEach(async () => {
    setup = createTestSetup();
    setup.server.initHandlers();
    gateway = new Gateway({
      tokenManager: setup.tokenManager,
      externalHost: "localhost",
      getRpcHandler: () => setup.server,
    });
    port = await gateway.start(0);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await gateway.stop();
    await setup.server.stop();
  });

  // ── Authentication ──────────────────────────────────────────────────────────

  describe("authentication", () => {
    it("rejects requests without authorization header", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "credentials.listStoredCredentials", args: [] }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body["error"]).toContain("Missing authorization");
    });

    it("rejects invalid token", async () => {
      const { status, body } = await postRpc(port, "invalid-token-xxx", {
        method: "credentials.listStoredCredentials",
        args: [],
      });
      expect(status).toBe(401);
      expect(body["error"]).toContain("Invalid token");
    });

    it("rejects admin token", async () => {
      const { status, body } = await postRpc(port, setup.adminToken, {
        method: "build.recompute",
        args: [],
      });
      expect(status).toBe(401);
      expect(body["error"]).toContain("caller-scoped token or connection grant");
    });

    it("accepts worker token", async () => {
      const { status, body } = await postRpc(port, setup.workerToken, {
        method: "credentials.listStoredCredentials",
        args: [],
      });
      expect(status).toBe(200);
      expect(body["result"]).toBeDefined();
    });

    it("uses shell tokens for HTTP RPC service policy", async () => {
      const { status, body } = await postRpc(port, setup.remoteShellToken, {
        method: "build.status",
        args: [],
      });

      expect(status).toBe(200);
      expect(body["error"]).toBeUndefined();
      expect(setup.dispatched[setup.dispatched.length - 1]?.ctx.caller.runtime).toEqual({
        id: "shell:remote-test",
        kind: "shell",
      });
    });

    it("re-evaluates membership on every HTTP request", async () => {
      await gateway.stop();
      await setup.server.stop();
      let isMember = true;
      setup = createTestSetup({
        userSubjectSource: {
          resolve: (callerId) =>
            callerId === "shell:remote-test" ? { userId: "usr_remote", handle: "remote" } : null,
        },
        membershipGate: (subject) => isMember && subject?.userId === "usr_remote",
      });
      setup.server.initHandlers();
      gateway = new Gateway({
        tokenManager: setup.tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => setup.server,
      });
      port = await gateway.start(0);

      await expect(
        postRpc(port, setup.remoteShellToken, { method: "build.status", args: [] })
      ).resolves.toMatchObject({ status: 200 });
      isMember = false;
      const rejected = await postRpc(port, setup.remoteShellToken, {
        method: "build.status",
        args: [],
      });
      expect(rejected).toEqual({
        status: 403,
        body: { error: "Not a member of this workspace", code: "EACCES" },
      });
      expect(setup.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it("admits a concrete system-owned DO through the HTTP membership gate", async () => {
      await gateway.stop();
      await setup.server.stop();
      const callerId = "do:workers/model-settings:ModelSettingsDO:workspace-model-settings";
      const entityCache = new EntityCache();
      entityCache._onActivate(
        makeDoRecord(callerId, "workers/model-settings", "model-settings-version", ["build.status"])
      );
      setup = createTestSetup({
        entityCache,
        userSubjectSource: {
          resolve: (id) => (id === callerId ? { userId: "system", handle: "system" } : null),
        },
        membershipGate: (subject) => subject?.userId === "system",
      });
      setup.server.initHandlers();
      gateway = new Gateway({
        tokenManager: setup.tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => setup.server,
      });
      port = await gateway.start(0);
      const serviceToken = setup.tokenManager.ensureToken(
        "do-service:workers/model-settings:ModelSettingsDO",
        "worker"
      );

      const result = await postRpc(
        port,
        serviceToken,
        { method: "build.status", args: [] },
        { "X-vibestudio-Runtime-Id": callerId }
      );

      expect(result).toMatchObject({ status: 200 });
      expect(setup.dispatched.at(-1)?.ctx.caller.subject).toEqual({
        userId: "system",
        handle: "system",
      });
    });

    it("rejects the in-process shell principal over HTTP RPC", async () => {
      const { status, body } = await postRpc(port, setup.literalShellToken, {
        method: "build.status",
        args: [],
      });

      expect(status).toBe(403);
      expect(body["error"]).toBe('callerId:"shell" cannot authenticate over HTTP RPC');
      expect(setup.dispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe("verified runtime identity", () => {
    it("rejects an HTTP causal parent before dispatch when its exact invocation is absent", async () => {
      await gateway.stop();
      await setup.server.stop();

      const verifyExactCausalInvocation = vi.fn(async () => false);
      setup = createTestSetup({ verifyExactCausalInvocation });
      setup.server.initHandlers();
      gateway = new Gateway({
        tokenManager: setup.tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => setup.server,
      });
      port = await gateway.start(0);
      const binding = {
        entityId: "entity:agent",
        contextId: "context:agent",
        channelId: "channel:agent",
        agentId: "agent:stable",
        userId: "user:one",
      };
      const token = setup.tokenManager.ensureToken("agent:one", "agent", {
        agentBinding: binding,
      });
      const causalParent = {
        kind: "trajectory-invocation" as const,
        ...channelTrajectoryFor(binding.channelId),
        invocationId: "invocation:missing",
      };

      const result = await postRpc(port, token, {
        targetId: "main",
        method: "build.status",
        args: [],
        causalParent,
      });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        error: expect.stringContaining("does not exist"),
        errorCode: "EACCES",
      });
      expect(setup.dispatcher.dispatch).not.toHaveBeenCalled();
      expect(verifyExactCausalInvocation).toHaveBeenCalledWith(causalParent);
    });

    it("verifies exact trajectory causality without replacing the caller's code origin", async () => {
      await gateway.stop();
      await setup.server.stop();

      setup = createTestSetup({ verifyExactCausalInvocation: vi.fn(async () => true) });
      setup.server.initHandlers();
      gateway = new Gateway({
        tokenManager: setup.tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => setup.server,
      });
      port = await gateway.start(0);
      const binding = {
        entityId: "entity:agent",
        contextId: "context:agent",
        channelId: "channel:agent",
        agentId: "agent:stable",
        userId: "user:one",
      };
      const token = setup.tokenManager.ensureToken("agent:one", "agent", {
        agentBinding: binding,
      });
      const causalParent = {
        kind: "trajectory-invocation" as const,
        ...channelTrajectoryFor(binding.channelId),
        invocationId: "invocation:present",
      };

      const result = await postRpc(port, token, {
        targetId: "main",
        method: "build.status",
        args: [],
        causalParent,
      });

      expect(result.body["error"]).toBeUndefined();
      expect(setup.dispatched.at(-1)?.ctx).toMatchObject({
        caller: { runtime: { id: "agent:one", kind: "agent" } },
        authorization: { authorizingOrigin: { kind: "host" } },
        causalParent,
      });
      expect(setup.dispatched.at(-1)?.ctx.caller.executionSession).toBeUndefined();
    });

    it("uses a verified concrete DO caller for service dispatch", async () => {
      await gateway.stop();
      await setup.server.stop();

      const entityCache = new EntityCache();
      entityCache._onActivate(
        makeDoRecord(
          "do:workers/agent-worker:AiChatWorker:agent-1",
          "workers/agent-worker",
          "hash-1",
          ["build.status"]
        )
      );
      setup = createTestSetup({ entityCache });
      setup.server.initHandlers();
      gateway = new Gateway({
        tokenManager: setup.tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => setup.server,
      });
      port = await gateway.start(0);

      const serviceToken = setup.tokenManager.ensureToken(
        "do-service:workers/agent-worker:AiChatWorker",
        "worker"
      );

      const res = await postRpc(
        port,
        serviceToken,
        {
          targetId: "main",
          method: "build.status",
          args: [],
        },
        {
          "X-vibestudio-Runtime-Id": "do:workers/agent-worker:AiChatWorker:agent-1",
        }
      );

      expect(res.status).toBe(200);
      expect(res.body["error"]).toBeUndefined();
      expect(setup.dispatched[setup.dispatched.length - 1]?.ctx).toMatchObject({
        caller: {
          runtime: {
            id: "do:workers/agent-worker:AiChatWorker:agent-1",
            kind: "do",
          },
        },
      });
    });

    it("keeps ambient entity binding as a relationship instead of replacing sealed DO code authority", async () => {
      await gateway.stop();
      await setup.server.stop();

      const entityCache = new EntityCache();
      entityCache._onActivate(
        makeDoRecord(
          "do:workers/agent-worker:AiChatWorker:agent-1",
          "workers/agent-worker",
          "hash-1",
          undefined,
          {
            entityId: "session:agent-1",
            contextId: "ctx-agent-1",
            channelId: "channel-agent-1",
          }
        )
      );
      setup = createTestSetup({ entityCache });
      setup.server.initHandlers();
      gateway = new Gateway({
        tokenManager: setup.tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => setup.server,
      });
      port = await gateway.start(0);

      const serviceToken = setup.tokenManager.ensureToken(
        "do-service:workers/agent-worker:AiChatWorker",
        "worker"
      );

      const res = await postRpc(
        port,
        serviceToken,
        {
          targetId: "main",
          method: "credentials.listStoredCredentials",
          args: [],
        },
        {
          "X-vibestudio-Runtime-Id": "do:workers/agent-worker:AiChatWorker:agent-1",
        }
      );

      expect(res.status).toBe(200);
      expect(setup.dispatched[0]!.ctx.caller).toEqual({
        runtime: {
          id: "do:workers/agent-worker:AiChatWorker:agent-1",
          kind: "do",
        },
        code: {
          callerId: "do:workers/agent-worker:AiChatWorker:agent-1",
          callerKind: "do",
          repoPath: "workers/agent-worker",
          effectiveVersion: "hash-1",
          executionDigest: "a".repeat(64),
          requested: [
            {
              capability: "service:credentials.listStoredCredentials",
              resource: { kind: "exact", key: "workspace:test" },
              tier: "gated",
              evidence: "exact",
            },
          ],
        },
        codeApproved: true,
        agentBinding: {
          entityId: "session:agent-1",
          contextId: "ctx-agent-1",
          channelId: "channel-agent-1",
        },
      });
      expect(setup.dispatched[0]!.ctx.authorization?.authorizingOrigin.kind).toBe("code");
    });

    it("rejects runtime identities outside the authenticated service scope", async () => {
      const serviceToken = setup.tokenManager.ensureToken(
        "do-service:workers/agent-worker:AiChatWorker",
        "worker"
      );

      const res = await postRpc(
        port,
        serviceToken,
        {
          targetId: "main",
          method: "build.status",
          args: [],
        },
        {
          "X-vibestudio-Runtime-Id": "do:workers/other-worker:OtherDO:agent-1",
        }
      );

      expect(res.status).toBe(403);
      expect(String(res.body["error"])).toContain("RPC runtime identity denied");
      expect(setup.dispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe("websocket origin allow-list", () => {
    it("rejects websocket upgrades from disallowed origins", async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
            headers: { Origin: "https://evil.example" },
          });
          ws.once("open", () => {
            ws.close();
            reject(new Error("unexpected websocket upgrade"));
          });
          ws.once("error", (err) => {
            try {
              expect(err.message).toContain("Unexpected server response: 403");
              resolve();
            } catch (expectErr) {
              reject(expectErr);
            }
          });
        })
      ).resolves.toBeUndefined();
    });

    it("allows loopback websocket origins", async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
            headers: { Origin: "http://localhost:5173" },
          });
          ws.once("open", () => {
            ws.close();
            resolve();
          });
          ws.once("error", reject);
        })
      ).resolves.toBeUndefined();
    });

    // (Removed) "allows the configured public URL origin" — public-URL ingress
    // is decommissioned (§8); remote traffic is WebRTC, the gateway is loopback-only.
  });

  // ── Service dispatch ────────────────────────────────────────────────────────

  describe("service dispatch", () => {
    it("dispatches to correct service and method", async () => {
      setup.dispatchResults.set("credentials.listStoredCredentials", [
        { id: "cred-1", label: "Example" },
      ]);

      const { body } = await postRpc(port, setup.workerToken, {
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(body["result"]).toEqual([{ id: "cred-1", label: "Example" }]);
      expect(setup.dispatched[0]!.service).toBe("credentials");
      expect(setup.dispatched[0]!.method).toBe("listStoredCredentials");
    });

    it("passes args to dispatcher", async () => {
      await postRpc(port, setup.workerToken, {
        method: "credentials.resolveCredential",
        args: [{ url: "https://api.example.com/", credentialId: "cred-1" }],
      });

      expect(setup.dispatched[0]!.args).toEqual([
        { url: "https://api.example.com/", credentialId: "cred-1" },
      ]);
    });

    it("builds correct ServiceContext from worker token", async () => {
      await postRpc(port, setup.workerToken, {
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(setup.dispatched[0]!.ctx).toMatchObject({
        caller: {
          runtime: {
            id: "do:test:Worker:obj1",
            kind: "worker",
          },
        },
      });
    });

    it("builds correct ServiceContext from shell token", async () => {
      const shellToken = setup.tokenManager.ensureToken("electron-shell", "shell");
      await postRpc(port, shellToken, {
        method: "build.recompute",
        args: [],
      });

      expect(setup.dispatched[0]!.ctx).toMatchObject({
        caller: {
          runtime: {
            id: "electron-shell",
            kind: "shell",
          },
        },
      });
    });

    it("returns dispatch errors in body (not HTTP error)", async () => {
      (setup.dispatcher.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("token expired")
      );

      const { status, body } = await postRpc(port, setup.workerToken, {
        method: "credentials.resolveCredential",
        args: [{ url: "https://api.example.com/", credentialId: "cred-1" }],
      });

      // HTTP 200, error in body (RPC convention)
      expect(status).toBe(200);
      expect(body["error"]).toBe("token expired");
    });
  });

  // ── Policy enforcement ──────────────────────────────────────────────────────

  describe("policy enforcement", () => {
    it("rejects shell calling automation service", async () => {
      const { body } = await postRpc(port, setup.shellToken, {
        method: "automation.spawn",
        args: [{}],
      });

      expect(body["error"]).toContain("no authority branch admits the user origin");
      expect(setup.dispatched).toHaveLength(0);
    });

    it("allows worker calling credentials service", async () => {
      await postRpc(port, setup.workerToken, {
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(setup.dispatched).toHaveLength(1);
    });

    it("rejects invalid method format", async () => {
      const { body } = await postRpc(port, setup.workerToken, {
        method: "no-dot-separator",
        args: [],
      });

      expect(body["error"]).toContain("Invalid method format");
    });

    it("rejects unknown service", async () => {
      const { body } = await postRpc(port, setup.workerToken, {
        method: "nonexistent.foo",
        args: [],
      });

      expect(body["error"]).toContain("Unknown service");
    });
  });

  // ── HTTP routing ────────────────────────────────────────────────────────────

  describe("HTTP routing", () => {
    it("returns 404 for non-/rpc paths", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/other`, {
        method: "POST",
        headers: { Authorization: `Bearer ${setup.workerToken}` },
        body: "{}",
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for GET /rpc", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "GET",
        headers: { Authorization: `Bearer ${setup.workerToken}` },
      });
      expect(res.status).toBe(404);
    });

    it("treats targetId=main as direct dispatch", async () => {
      await postRpc(port, setup.workerToken, {
        targetId: "main",
        method: "credentials.listStoredCredentials",
        args: [],
      });

      expect(setup.dispatched).toHaveLength(1);
    });

    it("allows authenticated HTTP callers to relay to an unrelated panel target", async () => {
      const { body } = await postRpc(port, setup.workerToken, {
        type: "call",
        targetId: "panel-unrelated",
        method: "foo.bar",
        args: [],
      });

      expect(body["error"]).toContain("Target not reachable");
      expect(body["error"]).not.toContain("cannot relay to unrelated panel");
    });

    it("allows authenticated HTTP callers to relay to a panel target", async () => {
      const { body } = await postRpc(port, setup.workerToken, {
        type: "call",
        targetId: "panel-parent",
        method: "foo.bar",
        args: [],
      });

      expect(body["error"]).toContain("Target not reachable");
      expect(body["error"]).not.toContain("cannot relay to unrelated panel");
    });

    it("allows authenticated HTTP callers to relay to a shell target", async () => {
      const { body } = await postRpc(port, setup.workerToken, {
        type: "call",
        targetId: "shell:test",
        method: "foo.bar",
        args: [],
      });

      expect(body["error"]).toContain("Target not reachable");
      expect(body["error"]).not.toContain("cannot relay to unrelated panel");
    });

    it("rejects an HTTP caller that forges host identity to relay extension control RPC", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${setup.workerToken}`,
        },
        body: JSON.stringify({
          from: "main",
          target: "@workspace-extensions/git-bridge",
          delivery: { caller: { callerId: "main", callerKind: "server" } },
          provenance: [{ callerId: "main", callerKind: "server" }],
          message: {
            type: "request",
            requestId: "http-host-control",
            fromId: "main",
            method: "extension.invoke",
            args: ["publishRepo", [{ repoPath: "projects/demo" }]],
          },
        }),
      });

      expect(res.status).toBe(200);
      const envelope = (await res.json()) as {
        message?: { error?: string; errorCode?: string };
      };
      expect(envelope.message).toMatchObject({
        errorCode: "EACCES",
        error: expect.stringContaining("cannot directly relay host-control method"),
      });
      expect(setup.dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("propagates readOnly metadata when relaying HTTP calls to workers", async () => {
      setup.server.setWorkerdUrl("http://127.0.0.1:8787");
      setup.server.setWorkerdGatewayToken("gateway-token");
      setup.server.setWorkerInstanceResolver((targetId) =>
        targetId === "worker:docs" ? "docs" : null
      );
      const realFetch = globalThis.fetch.bind(globalThis);
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" || input instanceof URL ? String(input) : String(input.url);
        if (url.startsWith("http://127.0.0.1:8787/")) {
          return new Response(
            JSON.stringify({
              from: "worker:docs",
              target: "test-caller",
              delivery: { caller: { callerId: "worker:docs", callerKind: "worker" } },
              provenance: [],
              message: { type: "response", requestId: "x", result: { ok: true } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return realFetch(input, init);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { status, body } = await postRpc(port, setup.workerToken, {
        type: "call",
        targetId: "worker:docs",
        method: "docs.list",
        args: [],
        idempotencyKey: "idem-1",
        readOnly: true,
      });

      expect(status).toBe(200);
      expect(body["result"]).toEqual({ ok: true });
      const relayCall = fetchMock.mock.calls.find(([input]) => {
        const url =
          typeof input === "string" || input instanceof URL ? String(input) : String(input.url);
        return url.startsWith("http://127.0.0.1:8787/");
      });
      expect(relayCall).toBeTruthy();
      const envelope = JSON.parse(String(relayCall![1]!.body));
      expect(envelope.delivery).toMatchObject({
        idempotencyKey: "idem-1",
        readOnly: true,
      });
    });
  });

  describe("/rpc/stream service-policy enforcement", () => {
    it("rejects the in-process shell principal over HTTP stream RPC", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${setup.literalShellToken}`,
        },
        body: JSON.stringify({
          targetId: "main",
          method: "credentials.proxyFetch",
          args: [{ url: "https://example.com/", method: "GET" }],
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('callerId:"shell" cannot authenticate over HTTP RPC');
      expect(setup.dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("rejects an HTTP stream caller that forges host identity for extension control RPC", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${setup.workerToken}`,
        },
        body: JSON.stringify({
          from: "main",
          target: "@workspace-extensions/git-bridge",
          delivery: { caller: { callerId: "main", callerKind: "server" } },
          provenance: [{ callerId: "main", callerKind: "server" }],
          message: {
            type: "stream-request",
            requestId: "http-stream-host-control",
            fromId: "main",
            method: "extension.invokeStream",
            args: ["publishRepo", [{ repoPath: "projects/demo" }]],
          },
        }),
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        errorCode: "EACCES",
        error: expect.stringContaining("cannot directly relay host-control method"),
      });
      expect(setup.dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("rejects an absent exact causal invocation before HTTP streaming dispatch", async () => {
      await gateway.stop();
      await setup.server.stop();
      const verifyExactCausalInvocation = vi.fn(async () => false);
      setup = createTestSetup({ verifyExactCausalInvocation });
      setup.server.initHandlers();
      gateway = new Gateway({
        tokenManager: setup.tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => setup.server,
      });
      port = await gateway.start(0);
      const binding = {
        entityId: "entity:agent",
        contextId: "context:agent",
        channelId: "channel:agent",
        agentId: "agent:stable",
        userId: "user:one",
      };
      const token = setup.tokenManager.ensureToken("agent:stream", "agent", {
        agentBinding: binding,
      });
      const causalParent = {
        kind: "trajectory-invocation" as const,
        ...channelTrajectoryFor(binding.channelId),
        invocationId: "invocation:missing-stream",
      };

      const res = await fetch(`http://127.0.0.1:${port}/rpc/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(
          toStreamEnvelope({
            targetId: "main",
            method: "credentials.proxyFetch",
            args: [{ url: "https://example.com/", method: "GET" }],
            causalParent,
          })
        ),
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        errorCode: "EACCES",
        error: expect.stringContaining("does not exist"),
      });
      expect(setup.dispatcher.dispatch).not.toHaveBeenCalled();
      expect(verifyExactCausalInvocation).toHaveBeenCalledWith(causalParent);
    });

    it("denies a caller-kind not in the credentials service policy", async () => {
      // Set up a real dispatcher whose credentials method requires a user
      // principal. A worker's code principal must be rejected before frames.
      const tokenManager = new TokenManager();
      const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
      const stubEgress = { forwardProxyFetchStream: vi.fn() };
      const dispatcher = createTestServiceDispatcher();
      registerRpcTestService(dispatcher, "credentials", ["user"], { proxyFetch: "write" });
      dispatcher.markInitialized();
      const server = new RpcServer({ tokenManager, dispatcher, egressProxy: stubEgress });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify(
            toStreamEnvelope({
              targetId: "main",
              method: "credentials.proxyFetch",
              args: [{ url: "https://example.com/", method: "GET" }],
            })
          ),
        });
        expect(res.status).toBe(403);
        expect(stubEgress.forwardProxyFetchStream).not.toHaveBeenCalled();
      } finally {
        await gw.stop();
        await server.stop();
      }
    });

    it("blocks credentials.proxyFetch in read-only HTTP stream RPC", async () => {
      const tokenManager = new TokenManager();
      const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
      const stubEgress = { forwardProxyFetchStream: vi.fn() };
      const dispatcher = createTestServiceDispatcher();
      registerRpcTestService(dispatcher, "credentials", ["code"], { proxyFetch: "write" });
      dispatcher.markInitialized();
      const server = new RpcServer({ tokenManager, dispatcher, egressProxy: stubEgress });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify(
            toStreamEnvelope({
              targetId: "main",
              method: "credentials.proxyFetch",
              args: [{ url: "https://example.com/", method: "GET" }],
              readOnly: true,
            })
          ),
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toContain("Blocked in read-only mode");
        expect(stubEgress.forwardProxyFetchStream).not.toHaveBeenCalled();
      } finally {
        await gw.stop();
        await server.stop();
      }
    });
  });

  describe("/rpc/stream streaming proxy fetch", () => {
    it("returns 503 when no egressProxy is wired in", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${setup.workerToken}`,
        },
        body: JSON.stringify(
          toStreamEnvelope({
            targetId: "main",
            method: "credentials.proxyFetch",
            args: [{ url: "https://example.com/", method: "GET" }],
          })
        ),
      });
      expect(res.status).toBe(503);
    });

    it("uses a verified concrete DO caller for streaming proxy fetch", async () => {
      const tokenManager = new TokenManager();
      const serviceToken = tokenManager.ensureToken(
        "do-service:workers/agent-worker:AiChatWorker",
        "worker"
      );
      const entityCache = new EntityCache();
      entityCache._onActivate(
        makeDoRecord(
          "do:workers/agent-worker:AiChatWorker:agent-1",
          "workers/agent-worker",
          "hash-1",
          ["credentials.proxyFetch"]
        )
      );
      const stubEgress = {
        forwardProxyFetchStream: vi.fn(
          async (
            _params: { caller: unknown; url: string; method: string },
            sink: (frame: {
              kind: string;
              status?: number;
              bytesIn?: number;
            }) => Promise<void> | void
          ) => {
            await sink({ kind: "head", status: 200 });
            await sink({ kind: "end", bytesIn: 0 });
            return { status: 200, bytesIn: 0 };
          }
        ),
      };
      const dispatcher = createTestServiceDispatcher();
      registerRpcTestService(dispatcher, "credentials", ["code"], { proxyFetch: "write" });
      dispatcher.markInitialized();
      const assertAuthority = vi.spyOn(dispatcher, "assertAuthority");
      const server = new RpcServer({
        tokenManager,
        dispatcher,
        egressProxy: stubEgress,
        entityCache,
      });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceToken}`,
            "X-vibestudio-Runtime-Id": "do:workers/agent-worker:AiChatWorker:agent-1",
          },
          body: JSON.stringify(
            toStreamEnvelope({
              targetId: "main",
              method: "credentials.proxyFetch",
              args: [{ url: "https://example.com/", method: "GET" }],
            })
          ),
        });
        expect(res.status).toBe(200);
        await res.arrayBuffer();
        expect(stubEgress.forwardProxyFetchStream).toHaveBeenCalledWith(
          expect.objectContaining({
            caller: {
              runtime: {
                id: "do:workers/agent-worker:AiChatWorker:agent-1",
                kind: "do",
              },
              code: {
                callerId: "do:workers/agent-worker:AiChatWorker:agent-1",
                callerKind: "do",
                repoPath: "workers/agent-worker",
                effectiveVersion: "hash-1",
                executionDigest: "a".repeat(64),
                requested: [
                  {
                    capability: "credential.use",
                    resource: { kind: "prefix", prefix: "" },
                    tier: "gated",
                    evidence: "exact",
                  },
                ],
              },
              codeApproved: true,
            },
          }),
          expect.any(Function),
          expect.any(AbortSignal)
        );
        expect(assertAuthority).toHaveBeenCalledWith(
          expect.objectContaining({ caller: expect.any(Object) }),
          "credentials",
          "proxyFetch",
          [{ url: "https://example.com/", method: "GET" }]
        );
      } finally {
        await gw.stop();
        await server.stop();
      }
    });

    it("rejects non-Response service methods on the generic streaming endpoint", async () => {
      const tokenManager = new TokenManager();
      const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
      const stubEgress = {
        forwardProxyFetchStream: vi.fn(),
      };
      const dispatcher = createTestServiceDispatcher();
      registerRpcTestService(
        dispatcher,
        "credentials",
        ["code"],
        { listStoredCredentials: "read" },
        async () => ({ ok: true })
      );
      dispatcher.markInitialized();
      vi.spyOn(dispatcher, "dispatch");
      const server = new RpcServer({
        tokenManager,
        dispatcher,
        egressProxy: stubEgress,
      });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify(
            toStreamEnvelope({
              targetId: "main",
              method: "credentials.listStoredCredentials",
              args: [],
            })
          ),
        });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("did not return a Response");
        expect(stubEgress.forwardProxyFetchStream).not.toHaveBeenCalled();
      } finally {
        await gw.stop();
        await server.stop();
      }
    });

    it("streams generic service Response methods over HTTP", async () => {
      const tokenManager = new TokenManager();
      const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
      const dispatcher = createTestServiceDispatcher();
      registerRpcTestService(
        dispatcher,
        "extensions",
        ["code"],
        { invokeStream: "write" },
        async () =>
          new Response("hello stream", {
            status: 201,
            statusText: "Created",
            headers: { "content-type": "text/plain" },
          })
      );
      dispatcher.markInitialized();
      vi.spyOn(dispatcher, "dispatch");
      const server = new RpcServer({
        tokenManager,
        dispatcher,
      });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify(
            toStreamEnvelope({
              targetId: "main",
              method: "extensions.invokeStream",
              args: ["@workspace-extensions/shell", "attach", ["session-1"]],
            })
          ),
        });
        expect(res.status).toBe(200);
        const { decodeFramedResponseToStreaming } =
          await import("@vibestudio/credential-client/streamFraming");
        const decoded = await decodeFramedResponseToStreaming(res.body!, "");
        expect(decoded.status).toBe(201);
        expect(decoded.headers.get("content-type")).toContain("text/plain");
        expect(await decoded.text()).toBe("hello stream");
        expect(dispatcher.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            caller: expect.objectContaining({
              runtime: expect.objectContaining({ kind: "worker" }),
            }),
          }),
          "extensions",
          "invokeStream",
          ["@workspace-extensions/shell", "attach", ["session-1"]]
        );
      } finally {
        await gw.stop();
        await server.stop();
      }
    });

    it("emits framed HEAD, DATA, END frames and decodes round-trip", async () => {
      const tokenManager = new TokenManager();
      const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
      const stubEgress = {
        forwardProxyFetchStream: vi.fn(
          async (
            _params: { caller: unknown; url: string; method: string },
            sink: (frame: {
              kind: string;
              status?: number;
              statusText?: string;
              headerPairs?: Array<[string, string]>;
              finalUrl?: string;
              bytes?: Uint8Array;
              bytesIn?: number;
            }) => Promise<void> | void
          ) => {
            await sink({
              kind: "head",
              status: 200,
              statusText: "OK",
              headerPairs: [
                ["content-type", "text/plain"],
                ["set-cookie", "a=1"],
                ["set-cookie", "b=2"],
              ],
              finalUrl: "https://example.com/landing",
            });
            await sink({ kind: "chunk", bytes: new Uint8Array([0x68, 0x65]) });
            await sink({ kind: "chunk", bytes: new Uint8Array([0x6c, 0x6c, 0x6f]) });
            await sink({ kind: "end", bytesIn: 5 });
            return { status: 200, bytesIn: 5 };
          }
        ),
      };
      const dispatcher = createTestServiceDispatcher();
      registerRpcTestService(dispatcher, "credentials", ["code"], { proxyFetch: "write" });
      dispatcher.markInitialized();
      const server = new RpcServer({
        tokenManager,
        dispatcher,
        egressProxy: stubEgress,
      });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify(
            toStreamEnvelope({
              targetId: "main",
              method: "credentials.proxyFetch",
              args: [{ url: "https://example.com/", method: "GET" }],
            })
          ),
        });
        expect(res.status).toBe(200);
        const buf = new Uint8Array(await res.arrayBuffer());

        const { FrameDecoder, FRAME_HEAD, FRAME_DATA, FRAME_END, parseHeadFrame, parseEndFrame } =
          await import("@vibestudio/credential-client/streamFraming");

        const frames: Array<{ type: number; payload: Uint8Array }> = [];
        const decoder = new FrameDecoder((type, payload) => {
          frames.push({ type, payload });
        });
        await decoder.push(buf);

        expect(frames.map((f) => f.type)).toEqual([FRAME_HEAD, FRAME_DATA, FRAME_DATA, FRAME_END]);
        const head = parseHeadFrame(frames[0]!.payload);
        expect(head.status).toBe(200);
        expect(head.finalUrl).toBe("https://example.com/landing");
        expect(head.headerPairs.filter(([k]) => k === "set-cookie").map(([, v]) => v)).toEqual([
          "a=1",
          "b=2",
        ]);
        const bodyBytes = new Uint8Array(
          frames[1]!.payload.byteLength + frames[2]!.payload.byteLength
        );
        bodyBytes.set(frames[1]!.payload, 0);
        bodyBytes.set(frames[2]!.payload, frames[1]!.payload.byteLength);
        expect(new TextDecoder().decode(bodyBytes)).toBe("hello");
        expect(parseEndFrame(frames[3]!.payload).bytesIn).toBe(5);
      } finally {
        await gw.stop();
        await server.stop();
      }
    });

    it("preserves egress proxy error codes in HTTP stream error frames", async () => {
      const tokenManager = new TokenManager();
      const workerToken = tokenManager.ensureToken("do:test:Worker:obj1", "worker");
      const error = Object.assign(new Error("client_not_authorized"), {
        code: "client_not_authorized",
      });
      const stubEgress = {
        forwardProxyFetchStream: vi.fn(async () => {
          throw error;
        }),
      };
      const dispatcher = createTestServiceDispatcher();
      registerRpcTestService(dispatcher, "credentials", ["code"], { proxyFetch: "write" });
      dispatcher.markInitialized();
      const server = new RpcServer({
        tokenManager,
        dispatcher,
        egressProxy: stubEgress,
      });
      server.initHandlers();
      const gw = new Gateway({
        tokenManager,
        externalHost: "localhost",
        getRpcHandler: () => server,
      });
      const p = await gw.start(0);
      try {
        const res = await fetch(`http://127.0.0.1:${p}/rpc/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify(
            toStreamEnvelope({
              targetId: "main",
              method: "credentials.proxyFetch",
              args: [{ url: "https://example.com/", method: "GET" }],
            })
          ),
        });
        expect(res.status).toBe(200);
        const { FrameDecoder, FRAME_ERROR, parseErrorFrame } =
          await import("@vibestudio/credential-client/streamFraming");
        const frames: Array<{ type: number; payload: Uint8Array }> = [];
        const decoder = new FrameDecoder((type, payload) => {
          frames.push({ type, payload });
        });
        await decoder.push(new Uint8Array(await res.arrayBuffer()));

        expect(frames.map((frame) => frame.type)).toEqual([FRAME_ERROR]);
        expect(parseErrorFrame(frames[0]!.payload)).toMatchObject({
          status: 502,
          message: "client_not_authorized",
          code: "client_not_authorized",
        });
      } finally {
        await gw.stop();
        await server.stop();
      }
    });
  });
});
