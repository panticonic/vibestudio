import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

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
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) sqlJsPromise = initSqlJs();
  return sqlJsPromise;
}

function createSqlProxy(db: Database) {
  return {
    exec(query: string, ...bindings: unknown[]): SqlResult {
      const trimmed = query.trim().toUpperCase();
      const isQuery =
        trimmed.startsWith("SELECT") ||
        trimmed.startsWith("WITH") ||
        trimmed.startsWith("PRAGMA") ||
        /\bRETURNING\b/.test(trimmed);

      if (isQuery) {
        const stmt = db.prepare(query);
        if (bindings.length > 0) stmt.bind(bindings as BindParams);
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
        db.run(query, bindings as BindParams);
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
  };
}

export async function createInMemorySql(): Promise<{
  exec(query: string, ...bindings: unknown[]): SqlResult;
}> {
  const SQL = await getSqlJs();
  return createSqlProxy(new SQL.Database());
}

const AGENTIC_ENV_DEFAULTS: Record<string, string> = {
  GATEWAY_URL: "http://test-server.invalid",
  RPC_AUTH_TOKEN: "test-token",
  WORKER_SOURCE: "test",
  WORKER_CLASS_NAME: "TestDO",
};

export async function createTestDO<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DOClass: new (ctx: any, env: any) => T,
  env?: Record<string, unknown>,
  opts?: { db?: Database }
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
  };

  const mergedEnv = { ...AGENTIC_ENV_DEFAULTS, ...env };
  const instance = new DOClass(ctx, mergedEnv);

  const call = async <R = unknown>(method: string, ...args: unknown[]): Promise<R> => {
    const fetchable = instance as unknown as { fetch(request: Request): Promise<Response> };
    if (typeof fetchable.fetch !== "function") {
      throw new Error("DO instance does not have a fetch() method");
    }
    const url = `http://test/${encodeURIComponent(objectKey)}/${encodeURIComponent(method)}`;
    const request = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
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
    return (text ? JSON.parse(text) : undefined) as R;
  };

  return { instance, sql: sqlProxy, db, alarms, acceptedWebSockets, call };
}
