import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { AuthenticatedCaller, AuthorizationContext, RpcEnvelope } from "@vibestudio/rpc";
import type { DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import {
  attachRpcDiagnosticId,
  decodeRpcJson,
  encodeRpcJson,
  RemoteRpcError,
  rpcMethodAuthority,
} from "@vibestudio/rpc";
import { parseDurableWorkReady } from "@vibestudio/shared/durableWork";

type BindParams = Parameters<Database["run"]>[1];

interface SqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

export class MockWebSocket {
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  private attachment: unknown = undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

interface AcceptedWebSocket {
  ws: unknown;
  tags: string[];
}

interface TestDOResult<T> {
  instance: T;
  sql: { exec(query: string, ...bindings: unknown[]): SqlResult };
  db: Database;
  alarms: number[];
  acceptedWebSockets: AcceptedWebSocket[];
  call: <R = unknown>(method: string, ...args: unknown[]) => Promise<R>;
  callAs: <R = unknown>(
    caller: Pick<AuthenticatedCaller, "callerId" | "callerKind"> &
      Partial<Pick<AuthenticatedCaller, "callerPanelId" | "userId">>,
    method: string,
    ...args: unknown[]
  ) => Promise<R>;
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) sqlJsPromise = initSqlJs();
  return sqlJsPromise;
}

function createSqlProxy(db: Database) {
  return {
    exec(query: string, ...bindings: unknown[]): SqlResult {
      const parameters = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value
      ) as BindParams;
      const trimmed = query.trim().toUpperCase();
      const isQuery =
        trimmed.startsWith("SELECT") ||
        trimmed.startsWith("WITH") ||
        trimmed.startsWith("PRAGMA") ||
        // `EXPLAIN QUERY PLAN` returns rows like any other read; the query
        // planner gate reads them, so the in-memory proxy must too.
        trimmed.startsWith("EXPLAIN") ||
        /\bRETURNING\b/.test(trimmed);

      if (isQuery) {
        const stmt = db.prepare(query);
        if (bindings.length > 0) stmt.bind(parameters);
        const rows: Record<string, unknown>[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
        stmt.free();
        return {
          toArray() {
            return rows;
          },
          one() {
            if (rows.length === 0) throw new Error("Expected one row, got none");
            return rows[0]!;
          },
        };
      }

      if (bindings.length === 0) {
        db.run(query);
      } else {
        db.run(query, parameters);
      }
      return {
        toArray() {
          return [];
        },
        one() {
          throw new Error("No rows from mutation");
        },
      };
    },
    transactionSync<T>(callback: () => T): T {
      db.run("BEGIN");
      try {
        const value = callback();
        db.run("COMMIT");
        return value;
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    },
  };
}

export async function createInMemorySql(): Promise<{
  exec(query: string, ...bindings: unknown[]): SqlResult;
  transactionSync<T>(callback: () => T): T;
}> {
  const SQL = await getSqlJs();
  return createSqlProxy(new SQL.Database());
}

const AGENTIC_ENV_DEFAULTS: Record<string, string> = {
  GATEWAY_URL: "http://test-server.invalid",
  RPC_AUTH_TOKEN: "test-token",
  WORKER_SOURCE: "test",
  WORKSPACE_ID: "test",
  WORKER_CLASS_NAME: "TestDO",
};

/** Deterministic host transport for unit tests whose subject schedules durable work. */
export const successfulTestRpcFetch: typeof fetch = async (_input, init) => {
  const request = JSON.parse(String(init?.body ?? "{}")) as RpcEnvelope;
  const requestMessage = request.message as { requestId?: string };
  return new Response(
    JSON.stringify({
      from: request.target,
      target: request.from,
      delivery: request.delivery,
      provenance: request.provenance ?? [],
      message: {
        type: "response",
        requestId: requestMessage.requestId ?? "",
        result: null,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

export function createTestDirectAuthority(input: {
  callerKind: AuthenticatedCaller["callerKind"];
  method: string;
  /** Exact semantic effect declared by the receiver method, when applicable. */
  capability?: string;
  effect?: DirectAuthorityAttestation["effect"];
  source?: string;
  className?: string;
  objectKey?: string;
  tier?: "open" | "gated" | "critical";
  now?: number;
}): DirectAuthorityAttestation {
  const now = input.now ?? Date.now();
  const invocationDigest =
    input.tier === "critical" ? `test-invocation:${crypto.randomUUID()}` : undefined;
  const audience = `do:${input.source ?? "test"}:${input.className ?? "TestDO"}:${input.objectKey ?? "test-key"}`;
  const isHost = input.callerKind === "server";
  const principal = isHost
    ? ("host:test" as const)
    : (`code:tests/durable@${"a".repeat(64)}` as `code:${string}`);
  const capability = input.capability ?? `rpc:${input.method}`;
  const resourceKey =
    input.effect?.kind === "userland-capability" ? `${capability}:${audience}` : audience;
  const context: AuthorizationContext = {
    authorizingOrigin: isHost
      ? { kind: "host", principal: principal as `host:${string}` }
      : { kind: "code", principal: principal as `code:${string}` },
    host: isHost ? (principal as `host:${string}`) : null,
    actingUser: isHost ? null : "user:test",
    entity: null,
    incarnation: null,
    executingCode: isHost
      ? null
      : {
          principal: principal as `code:${string}`,
          requested: [{ capability, resource: { kind: "exact", key: resourceKey } }],
          sourceLineage: { class: "internal", externalKeys: [] },
        },
    initiatorChain: [principal],
    ownerChain: isHost ? [] : ["user:test"],
    agentBinding: null,
    executionSession: null,
    testPolicy: null,
    workspace: { workspaceId: "test", member: true, role: "member", revision: "test" },
    session: { id: "test", audience, version: "1", expiresAt: now + 60_000 },
  };
  return {
    audience,
    method: input.method,
    effect:
      input.effect ??
      (input.capability
        ? { kind: "host-capability", capability, resource: { kind: "receiver-object" } }
        : { kind: "open" }),
    capability,
    capabilityDefinitionDigest: "-",
    resourceType: capability,
    provider: "-",
    providerExecutionDigest: "-",
    ...(invocationDigest ? { invocationDigest } : {}),
    resourceKey,
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: crypto.randomUUID(),
    context,
    grants: [
      {
        id: `test:${input.method}:${principal}`,
        subject: principal,
        effect: "allow",
        capability,
        resource: { kind: "exact", key: resourceKey },
        issuedBy: "test-fixture",
        createdAt: now,
        constraints: {
          ...(invocationDigest ? { invocationDigest } : {}),
        },
        provenance: invocationDigest ? "critical-confirmation" : "explicit-test-fixture",
      },
    ],
  };
}

export async function createTestDO<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DOClass: new (ctx: any, env: any) => T,
  env?: Record<string, unknown>,
  opts?: { db?: Database; initialize?: boolean }
): Promise<TestDOResult<T>> {
  const SQL = await getSqlJs();
  const db = opts?.db ?? new SQL.Database();
  const sqlProxy = createSqlProxy(db);
  const alarms: number[] = [];
  const acceptedWebSockets: AcceptedWebSocket[] = [];
  const objectKey = (env?.["__objectKey"] as string) ?? "test-key";

  const ctx = {
    id: { toString: () => objectKey, name: objectKey },
    storage: {
      sql: sqlProxy,
      setAlarm(scheduledTime: number | Date) {
        const ts = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
        alarms.push(ts);
      },
      async getAlarm(): Promise<number | null> {
        return alarms.length > 0 ? alarms[alarms.length - 1]! : null;
      },
      deleteAlarm() {
        alarms.length = 0;
      },
      async transaction<T>(callback: () => Promise<T>): Promise<T> {
        const savepoint = "_async_" + crypto.randomUUID().replaceAll("-", "");
        sqlProxy.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = await callback();
          sqlProxy.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          sqlProxy.exec(`ROLLBACK TO ${savepoint}`);
          sqlProxy.exec(`RELEASE ${savepoint}`);
          throw error;
        }
      },
      transactionSync<TValue>(callback: () => TValue): TValue {
        const savepoint = `_tx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        sqlProxy.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = callback();
          sqlProxy.exec(`RELEASE ${savepoint}`);
          return result;
        } catch (err) {
          try {
            sqlProxy.exec(`ROLLBACK TO ${savepoint}`);
          } catch {
            /* ignore */
          }
          try {
            sqlProxy.exec(`RELEASE ${savepoint}`);
          } catch {
            /* ignore */
          }
          throw err;
        }
      },
    },
    acceptWebSocket(ws: unknown, tags?: string[]) {
      acceptedWebSockets.push({ ws, tags: tags ?? [] });
    },
    getWebSockets(tag?: string) {
      if (tag) return acceptedWebSockets.filter((s) => s.tags.includes(tag)).map((s) => s.ws);
      return acceptedWebSockets.map((s) => s.ws);
    },
    blockConcurrencyWhile<TValue>(fn: () => Promise<TValue>) {
      return fn();
    },
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => undefined);
    },
  };

  const mergedEnv = { ...AGENTIC_ENV_DEFAULTS, ...env };
  const instance = new DOClass(ctx, mergedEnv);
  if (opts?.initialize !== false) {
    await (instance as unknown as { initializeSchema?: () => Promise<void> }).initializeSchema?.();
  }

  const dispatch = async <R = unknown>(
    caller: Pick<AuthenticatedCaller, "callerId" | "callerKind"> &
      Partial<Pick<AuthenticatedCaller, "callerPanelId" | "userId">>,
    method: string,
    args: unknown[]
  ): Promise<R> => {
    const fetchable = instance as unknown as { fetch(request: Request): Promise<Response> };
    if (typeof fetchable.fetch !== "function") {
      throw new Error("DO instance does not have a fetch() method");
    }
    const lifecycle = method.startsWith("__lifecycle/");
    const targetId = `do:${mergedEnv["WORKER_SOURCE"]}:${mergedEnv["WORKER_CLASS_NAME"]}:${objectKey}`;
    const methodPath = lifecycle ? method.split("/").map(encodeURIComponent).join("/") : "__rpc";
    const url = `http://test/${encodeURIComponent(objectKey)}/${methodPath}`;
    const localDeclaration = rpcMethodAuthority(instance as object, method);
    const schemaMethod = (
      (instance as object).constructor as unknown as {
        rpcMethods?: Record<
          string,
          {
            capability?: string;
            directEffect?: DirectAuthorityAttestation["effect"];
            tier?: { tier: "open" | "gated" | "critical" };
          }
        >;
      }
    ).rpcMethods?.[method];
    const capability =
      schemaMethod?.capability ??
      (localDeclaration?.effect.kind !== "open" ? localDeclaration?.effect.capability : undefined);
    const effect =
      schemaMethod?.directEffect ??
      (schemaMethod?.capability
        ? {
            kind: "host-capability" as const,
            capability: schemaMethod.capability,
            resource: { kind: "receiver-object" as const },
          }
        : localDeclaration?.effect);
    const attestedCapability =
      effect?.kind === "userland-capability" ? `userland:${effect.capability}` : capability;
    const attestedCaller = {
      ...caller,
      authorization: createTestDirectAuthority({
        callerKind: caller.callerKind,
        method,
        capability: attestedCapability,
        ...(effect ? { effect } : {}),
        tier: schemaMethod?.tier?.tier ?? localDeclaration?.tier,
        source: String(mergedEnv["WORKER_SOURCE"]),
        className: String(mergedEnv["WORKER_CLASS_NAME"]),
        objectKey,
      }),
    };
    const envelope: RpcEnvelope = {
      from: caller.callerId,
      target: targetId,
      delivery: { caller: attestedCaller },
      provenance: [attestedCaller],
      message: {
        type: "request",
        requestId: crypto.randomUUID(),
        fromId: caller.callerId,
        method,
        args,
      },
    };
    const request = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeRpcJson(
        lifecycle
          ? {
              args,
              __instanceToken: "token",
              __instanceId: targetId,
              __caller: attestedCaller,
            }
          : envelope
      ),
    });
    const response = await fetchable.fetch(request);
    const text = await response.text();
    if (!response.ok) {
      const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      throw new Error(
        typeof parsed["error"] === "string"
          ? parsed["error"]
          : `DO call ${method} failed: ${response.status}`
      );
    }
    if (!lifecycle) {
      const reply = decodeRpcJson(text) as RpcEnvelope;
      if (reply.message?.type !== "response")
        throw new Error("DO request did not return a terminal response");
      if ("error" in reply.message) {
        const failure = new RemoteRpcError(
          reply.message.error,
          reply.message.errorKind,
          reply.message.errorCode,
          reply.message.errorData
        );
        if (reply.message.diagnosticId) attachRpcDiagnosticId(failure, reply.message.diagnosticId);
        throw failure;
      }
      if (reply.message.metadata?.durableWorkReady !== undefined)
        parseDurableWorkReady(reply.message.metadata.durableWorkReady);
      return reply.message.result as R;
    }
    const reply = text
      ? (decodeRpcJson(text) as { value?: unknown; metadata?: { durableWorkReady?: unknown } })
      : null;
    if (!reply || !Object.prototype.hasOwnProperty.call(reply, "value"))
      throw new Error("DO lifecycle response must contain its canonical value field");
    if (reply.metadata?.durableWorkReady !== undefined)
      parseDurableWorkReady(reply.metadata.durableWorkReady);
    return reply.value as R;
  };

  const call = <R = unknown>(method: string, ...args: unknown[]): Promise<R> =>
    dispatch<R>({ callerId: "main", callerKind: "server" }, method, args);

  const callAs = <R = unknown>(
    caller: Pick<AuthenticatedCaller, "callerId" | "callerKind"> &
      Partial<Pick<AuthenticatedCaller, "callerPanelId" | "userId">>,
    method: string,
    ...args: unknown[]
  ): Promise<R> => dispatch<R>(caller, method, args);

  return {
    instance,
    sql: sqlProxy,
    db,
    alarms,
    acceptedWebSockets,
    call,
    callAs,
  };
}
