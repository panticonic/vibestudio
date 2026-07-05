import {
  collectExposableMethods,
  createConnectionlessRpcClient,
  envelopeFromMessage,
  rpcExposedMethodNames,
  type AuthenticatedCaller,
  type ConnectionlessRpcClient,
  type DeferrableRpcClient,
  type RpcEnvelope,
  type RpcRequest,
} from "@vibestudio/rpc";

// Re-export the `@rpc` exposure decorator so DO authors import it alongside the base.
export { rpc } from "@vibestudio/rpc";

export interface DurableObjectContext {
  id: { toString(): string; name?: string };
  storage: {
    sql: SqlStorage;
    setAlarm(scheduledTime: number | Date): void;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): void;
    transactionSync<T>(callback: () => T): T;
  };
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  waitUntil?(promise: Promise<unknown>): void;
  /**
   * workerd: discard the in-memory instance (in-flight work aborted) without deleting
   * durable SQLite. Used by EvalDO for idle GC under `preventEviction`. Present on the
   * real workerd `DurableObjectState`; declared here because the minimal type omitted it.
   */
  abort(reason?: string): void;
}

export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlResult;
}

export interface SqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

export interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

export interface LifecyclePrepareInput {
  epoch: string;
  reason: string;
  deadlineMs: number;
}

export interface LifecyclePrepareResult {
  status: "ready" | "failed";
  detail?: string;
}

export interface LifecycleResumeInput {
  epoch: string;
  previousGeneration: number | null;
  currentGeneration: number;
  reason: "planned" | "crash" | "server_restart";
}

// (RPC exposure is now opt-in via `@rpc` + `rpcExposedMethodNames` — no reserved deny-list needed;
// framework/lifecycle methods are simply never `@rpc`-marked, and the base-proto boundary backstops.)

export abstract class DurableObjectBase {
  static schemaVersion = 1;

  protected ctx: DurableObjectContext;
  protected sql: SqlStorage;
  protected env: Record<string, unknown>;

  private schemaReady = false;
  private connectionless: ConnectionlessRpcClient | null = null;
  private currentVerifiedCaller: AuthenticatedCaller | null = null;
  private currentRpcCallerId: string | null = null;
  private currentRpcCallerKind: string | null = null;
  private currentRpcCallerPanelId: string | null = null;
  private currentRpcRequestId: string | null = null;
  private currentRpcIdempotencyKey: string | null = null;
  private currentInvocationToken: string | undefined = undefined;
  private currentCallerContextId: string | undefined = undefined;
  private currentObjectKey: string | null = null;

  constructor(ctx: DurableObjectContext, env: unknown) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.env = env as Record<string, unknown>;
  }

  protected abstract createTables(): void;

  protected migrate(_fromVersion: number, _toVersion: number): void {}

  protected requiredTables(): readonly string[] {
    return [];
  }

  protected validateSchema(): void {
    const missing = this.requiredTables().filter((table) => {
      const rows = this.sql
        .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table)
        .toArray();
      return rows.length === 0;
    });
    if (missing.length > 0) {
      throw new Error(
        `${this.constructor.name} schema validation failed: missing table(s): ${missing.join(", ")}`
      );
    }
  }

  protected ensureReady(): void {
    if (this.schemaReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    let currentVersion = 0;
    const row = this.sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).toArray();
    if (row.length > 0) currentVersion = parseInt(String(row[0]!["value"]), 10) || 0;
    const targetVersion = (this.constructor as typeof DurableObjectBase).schemaVersion;
    if (currentVersion > targetVersion) {
      throw new Error(
        `${this.constructor.name} schema version ${currentVersion} is newer than supported version ${targetVersion}`
      );
    }

    if (currentVersion === 0) {
      this.createTables();
      this.validateSchema();
      this.sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES ('schema_version', ?)`,
        String(targetVersion)
      );
    } else if (currentVersion < targetVersion) {
      this.migrate(currentVersion, targetVersion);
      this.createTables();
      this.validateSchema();
      this.sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES ('schema_version', ?)`,
        String(targetVersion)
      );
    } else {
      this.createTables();
      this.validateSchema();
    }
    this.schemaReady = true;
  }

  protected getStateValue(key: string): string | null {
    const row = this.sql.exec(`SELECT value FROM state WHERE key = ?`, key).toArray();
    return row.length > 0 ? String(row[0]!["value"]) : null;
  }

  protected setStateValue(key: string, value: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`, key, value);
  }

  protected deleteStateValue(key: string): void {
    this.sql.exec(`DELETE FROM state WHERE key = ?`, key);
  }

  protected parseRequestBody(body: string): {
    args: unknown[];
    error?: string;
    caller?: AuthenticatedCaller | null;
    invocationToken?: string;
  } {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return { args: parsed };
    if (
      parsed &&
      typeof parsed === "object" &&
      ("__instanceToken" in parsed || "__instanceId" in parsed) &&
      Array.isArray((parsed as { args?: unknown }).args)
    ) {
      const caller = (parsed as { __caller?: unknown }).__caller;
      if (caller && typeof caller === "object") {
        const record = caller as Record<string, unknown>;
        if (typeof record["callerId"] === "string" && typeof record["callerKind"] === "string") {
          return {
            args: (parsed as { args: unknown[] }).args,
            ...(typeof (parsed as { __invocationToken?: unknown }).__invocationToken === "string"
              ? { invocationToken: (parsed as { __invocationToken: string }).__invocationToken }
              : {}),
            caller: {
              callerId: record["callerId"],
              callerKind: record["callerKind"] as AuthenticatedCaller["callerKind"],
              ...(typeof record["callerPanelId"] === "string"
                ? { callerPanelId: record["callerPanelId"] }
                : {}),
            },
          };
        }
      }
      return {
        args: (parsed as { args: unknown[] }).args,
        ...(typeof (parsed as { __invocationToken?: unknown }).__invocationToken === "string"
          ? { invocationToken: (parsed as { __invocationToken: string }).__invocationToken }
          : {}),
      };
    }
    return { args: [parsed] };
  }

  /**
   * Runtime identity presented on outbound RPC (the RPC_RUNTIME_ID_HEADER, distinct from
   * the bearer token). Default is the service-level `do-service:<source>:<class>` shared by
   * every instance of the class. Subclasses needing PER-OBJECT context (e.g. EvalDO's
   * owner-scoped fs) override this to `do:<source>:<class>:<objectKey>`; the server accepts
   * it because the service bearer covers the `do:<source>:<class>:*` prefix
   * (`rpcServer.isRuntimeIdForServiceToken`).
   */
  protected get rpcSelfId(): string {
    const source = String(this.env["WORKER_SOURCE"] ?? "");
    const className = String(this.env["WORKER_CLASS_NAME"] ?? "");
    return `do-service:${source}:${className}`;
  }

  /**
   * Override the inbound `respond()` reaper for this DO (default 120s — `httpClient.ts`). A DO with
   * legitimately long HELD handlers (the EvalDO's `executeRun`) returns a very large value or `0`
   * (disabled), so the held connection isn't cut short. `undefined` ⇒ the transport default.
   */
  protected get respondTimeoutMs(): number | undefined {
    return undefined;
  }

  /**
   * The unified connectionless RPC client — the same `createRpcClient` core
   * every target runs, behind the envelope-native `httpClientTransport`, plus
   * the `callDeferred` extension. The DO's own public methods are `exposeAll`'d
   * onto it so inbound envelopes dispatched via `handleEnvelope` reach the class
   * method (`respond`/`deliver` are wired in `fetch`).
   */
  protected get rpc(): DeferrableRpcClient {
    return this.connectionlessClient().client;
  }

  private connectionlessClient(): ConnectionlessRpcClient {
    if (!this.connectionless) {
      const token = this.env["RPC_AUTH_TOKEN"];
      const source = this.env["WORKER_SOURCE"];
      const className = this.env["WORKER_CLASS_NAME"];
      const gatewayUrl = this.env["GATEWAY_URL"];
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("RPC not available: RPC_AUTH_TOKEN not configured");
      }
      if (typeof source !== "string" || source.length === 0) {
        throw new Error("RPC not available: WORKER_SOURCE not configured");
      }
      if (typeof className !== "string" || className.length === 0) {
        throw new Error("RPC not available: WORKER_CLASS_NAME not configured");
      }
      if (typeof gatewayUrl !== "string" || gatewayUrl.length === 0) {
        throw new Error("RPC not available: GATEWAY_URL not configured");
      }
      const connectionless = createConnectionlessRpcClient({
        selfId: this.rpcSelfId,
        serverUrl: gatewayUrl,
        authToken: token,
        callerKind: "do",
        ...(this.respondTimeoutMs !== undefined ? { respondTimeoutMs: this.respondTimeoutMs } : {}),
      });
      // Expose ONLY this DO's `@rpc`-marked methods (opt-in / default-deny). Private/protected helpers
      // and all framework plumbing (`dispatchInboundEnvelope`, state-KV, alarms) are unreachable over
      // the open relay; a forgotten `@rpc` fails loud ("not exposed"). Boundary = backstop.
      connectionless.client.exposeAll(
        collectExposableMethods(this, rpcExposedMethodNames(this), DurableObjectBase.prototype)
      );
      this.connectionless = connectionless;
    }
    return this.connectionless;
  }

  protected get caller(): AuthenticatedCaller | null {
    return this.currentVerifiedCaller;
  }

  protected get rpcCallerId(): string | null {
    return this.currentRpcCallerId;
  }

  protected get rpcCallerKind(): string | null {
    return this.currentRpcCallerKind;
  }

  protected get rpcCallerPanelId(): string | null {
    return this.currentRpcCallerPanelId;
  }

  protected get rpcRequestId(): string | null {
    return this.currentRpcRequestId;
  }

  protected get rpcIdempotencyKey(): string | null {
    return this.currentRpcIdempotencyKey;
  }

  /**
   * The host-minted invocation token for the dispatch currently being served, or
   * `undefined` when the inbound call carried none (a non-relayed / non-`vcs`
   * dispatch, or a self-initiated DO call). Opaque correlation nonce, NOT a
   * credential — see `RpcRequest.invocationToken` and
   * docs/narrow-host-vcs-plan.md §4. A DO orchestrating a host write echoes it
   * into `refs.updateMains` so the host can resolve on-behalf-of attribution
   * against its own invocation table.
   *
   * SCOPING CONTRACT (identical to `caller`/`rpcRequestId`): this reflects the
   * dispatch whose handler is CURRENTLY executing its synchronous entry. The DO
   * multiplexes — at any non-storage `await` a concurrent inbound dispatch can be
   * delivered and rebind this field — so a handler MUST read it synchronously at
   * entry and capture it into a local before its first `await`. Read that way it
   * is provably the current dispatch's token: the value is set synchronously in
   * `dispatchInboundEnvelope` and the handler runs one microtask later
   * (`handleRequest` schedules it via `Promise.resolve().then`), and no other
   * dispatch — a fresh `fetch`, i.e. a macrotask — can interpose across that
   * microtask boundary. It is never a concurrent or previous dispatch's token at
   * that point (each dispatch restores the prior value in a `finally`). Reading
   * it lazily AFTER an await is unsupported and may observe another in-flight
   * dispatch's token; capture-at-entry is the contract. Never log it.
   */
  protected get invocationToken(): string | undefined {
    return this.currentInvocationToken;
  }

  /**
   * The originating caller's HOST-RESOLVED context registration id for the
   * dispatch currently being served (or `undefined`). HOST-VERIFIED, never
   * client-asserted — read-at-entry like {@link invocationToken}. Threaded on
   * relayed userland `vcs` dispatches for source-head confinement
   * (docs/narrow-host-vcs-plan.md §3, register row 11).
   */
  protected get callerContextId(): string | undefined {
    return this.currentCallerContextId;
  }

  protected get objectKey(): string {
    if (this.currentObjectKey) return this.currentObjectKey;
    if (this.ctx.id.name) {
      this.currentObjectKey = this.ctx.id.name;
      return this.currentObjectKey;
    }
    try {
      const stored = this.sql.exec(`SELECT value FROM state WHERE key = '__objectKey'`).toArray();
      if (stored.length > 0) {
        this.currentObjectKey = String(stored[0]!["value"]);
        return this.currentObjectKey;
      }
    } catch {
      /* state table may not exist yet */
    }
    throw new Error("objectKey not available");
  }

  protected setAlarm(delayMs: number, opts?: { bestEffort?: boolean }): void {
    this.setAlarmAt(Date.now() + delayMs, opts);
  }

  /**
   * @param opts.bestEffort fire-once, never re-armed on dispatch failure — for alarms
   *   whose handler may abort its own DO (idle GC). Default alarms are at-least-once.
   */
  protected setAlarmAt(timeMs: number, opts?: { bestEffort?: boolean }): void {
    void this.alarmRpc("workspace-state.alarmSet", {
      ...this.lifecycleKey(),
      wakeAt: timeMs,
      ...(opts?.bestEffort ? { bestEffort: true } : {}),
    });
  }

  protected deleteAlarm(): void {
    void this.alarmRpc("workspace-state.alarmClear", this.lifecycleKey());
  }

  private lifecycleKey(): { source: string; className: string; objectKey: string } {
    return {
      source: String(this.env["WORKER_SOURCE"] ?? ""),
      className: String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name),
      objectKey: this.objectKey,
    };
  }

  private async alarmRpc(method: string, payload: unknown): Promise<void> {
    try {
      await this.rpc.call("main", method, [payload]);
    } catch (err) {
      console.warn(`[durable] ${method} failed:`, err instanceof Error ? err.message : err);
    }
  }

  async alarm(): Promise<void> {
    this.ensureReady();
  }

  async prepareForRestart(_input: LifecyclePrepareInput): Promise<LifecyclePrepareResult> {
    return { status: "ready" };
  }

  async resumeAfterRestart(_input: LifecycleResumeInput): Promise<void> {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !this.currentObjectKey) {
      this.currentObjectKey = decodeURIComponent(segments[0]!);
    }

    this.ensureReady();
    if (this.currentObjectKey) {
      this.sql.exec(
        `INSERT OR IGNORE INTO state (key, value) VALUES ('__objectKey', ?)`,
        this.currentObjectKey
      );
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";

    try {
      // Converged inbound dispatch: an `RpcEnvelope` POSTed to `__rpc` (relay
      // traffic, server→DO event push, deferred replies) flows through the
      // shared core's `handleEnvelope` → `exposeAll`'d method / event listeners.
      if (method === "__rpc") {
        return await this.handleInboundEnvelope(request);
      }

      let args: unknown[] = [];
      let verifiedCallerFromBody: AuthenticatedCaller | null = null;
      let invocationTokenFromBody: string | undefined;
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
          verifiedCallerFromBody = result.caller ?? null;
          invocationTokenFromBody = result.invocationToken;
        }
      }

      if (method === "__lifecycle/prepare" || method === "__lifecycle/resume") {
        return this.withCaller(verifiedCallerFromBody, async () => {
          if (this.caller?.callerKind !== "server") {
            return jsonResponse({ error: "Lifecycle calls require server caller" }, 403);
          }
          const result =
            method === "__lifecycle/prepare"
              ? await this.prepareForRestart(args[0] as LifecyclePrepareInput)
              : await this.resumeAfterRestart(args[0] as LifecycleResumeInput);
          return jsonResponse(result ?? null);
        });
      }

      if (method === "__alarm") {
        return this.withCaller(verifiedCallerFromBody, async () => {
          if (this.caller?.callerKind !== "server") {
            return jsonResponse({ error: "Alarm calls require server caller" }, 403);
          }
          await this.alarm();
          return jsonResponse({ result: "ok" });
        });
      }

      // Method-path dispatch (the server's instance-token channel,
      // `DODispatch.dispatch`): build an inbound request envelope from
      // {method, args, __caller} and route it through the SAME converged core
      // dispatch as `__rpc`, so `(this)[method]` is gone and `exposeAll` is the
      // single dispatch. Returns the raw method result (the relay/DODispatch
      // contract), not the response envelope.
      const caller: AuthenticatedCaller =
        verifiedCallerFromBody ?? { callerId: "", callerKind: "unknown" };
      const envelope = envelopeFromMessage({
        selfId: this.rpcSelfId,
        from: caller.callerId || "unknown",
        target: this.rpcSelfId,
        caller,
        message: {
          type: "request",
          requestId: crypto.randomUUID(),
          fromId: caller.callerId || "unknown",
          method,
          args,
          ...(invocationTokenFromBody !== undefined ? { invocationToken: invocationTokenFromBody } : {}),
        },
      });
      const responseEnvelope = await this.dispatchInboundEnvelope(envelope);
      const responseMessage = responseEnvelope?.message;
      if (responseMessage?.type === "response" && "error" in responseMessage) {
        if (responseMessage.error.startsWith('Method "')) {
          return jsonResponse({ error: `Unknown method: ${method}` }, 404);
        }
        return jsonResponse(
          {
            error: responseMessage.error,
            ...(responseMessage.errorCode ? { errorCode: responseMessage.errorCode } : {}),
          },
          500
        );
      }
      return jsonResponse(
        responseMessage?.type === "response" && "result" in responseMessage
          ? (responseMessage.result ?? null)
          : null
      );
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  /**
   * Gate inbound RPC by caller. Default: allow all (the generic relay is open,
   * `rpcServer.checkRelayAuth`). Sensitive recipients that run privileged code
   * (e.g. a server-only internal DO) OVERRIDE this to reject non-trusted callers
   * — a blanket guard, since `exposeAll` reflects every public method (including
   * TS-private helpers, which are runtime-public). Throwing here surfaces a 500
   * error response and the method never runs.
   *
   * `kind` distinguishes a privileged inbound METHOD CALL ("call") from an event
   * DELIVERY ("event"). Event deliveries are opt-in — the DO subscribed to a
   * topic/channel and the publisher (server event-push, a channel DO, …) pushes
   * to it — so a server-only DO should still ACCEPT them while refusing "call".
   */
  protected assertInboundAllowed(
    _caller: AuthenticatedCaller | null,
    _kind: "call" | "event"
  ): void {}

  /** Handle an `RpcEnvelope` POSTed to `__rpc`; returns a response envelope (or `{}` for events). */
  private async handleInboundEnvelope(request: Request): Promise<Response> {
    const envelope = (await request.json()) as RpcEnvelope;
    const message = envelope.message;
    if (message?.type !== "request" && message?.type !== "stream-request") {
      // Event push / frames: deliver with no response (opt-in subscription).
      this.assertInboundAllowed(envelope.delivery.caller ?? null, "event");
      this.connectionlessClient().deliver(envelope);
      return jsonResponse({});
    }
    const responseEnvelope = await this.dispatchInboundEnvelope(envelope);
    return jsonResponse(responseEnvelope ?? {});
  }

  /**
   * Dispatch an inbound request envelope through the converged core
   * (`respond` → `handleEnvelope` → `exposeAll`'d method), with the DO's
   * caller-context getters bound to `envelope.delivery.caller` for the duration.
   */
  private async dispatchInboundEnvelope(envelope: RpcEnvelope): Promise<RpcEnvelope | null> {
    const connectionless = this.connectionlessClient();
    // An unattributed method-path call carries a synthetic empty caller; surface
    // it as a null caller context (matching the pre-convergence behavior) rather
    // than a forgeable `"unknown"` — methods that gate on `this.caller` rely on it.
    const rawCaller = envelope.delivery.caller;
    const caller = rawCaller && rawCaller.callerId !== "" ? rawCaller : null;
    const message = envelope.message as RpcRequest;
    this.assertInboundAllowed(caller, "call");
    const prev = {
      verifiedCaller: this.currentVerifiedCaller,
      callerId: this.currentRpcCallerId,
      callerKind: this.currentRpcCallerKind,
      callerPanelId: this.currentRpcCallerPanelId,
      requestId: this.currentRpcRequestId,
      idempotencyKey: this.currentRpcIdempotencyKey,
      invocationToken: this.currentInvocationToken,
      callerContextId: this.currentCallerContextId,
    };
    this.currentVerifiedCaller = caller;
    this.currentRpcCallerId = caller?.callerId ?? null;
    this.currentRpcCallerKind = caller?.callerKind ?? null;
    this.currentRpcCallerPanelId = caller?.callerPanelId ?? null;
    this.currentRpcRequestId = message?.requestId ?? null;
    this.currentRpcIdempotencyKey = envelope.delivery.idempotencyKey ?? null;
    // Host-minted on-behalf-of nonce, present only on relayed userland `vcs`
    // dispatches (absent → undefined). Bound per-dispatch; see `invocationToken`.
    this.currentInvocationToken = message?.invocationToken ?? undefined;
    // Host-resolved source-head confinement context (register row 11), present
    // only on relayed userland `vcs` dispatches. Bound per-dispatch.
    this.currentCallerContextId = message?.callerContextId ?? undefined;
    try {
      return await connectionless.respond(envelope);
    } finally {
      this.currentVerifiedCaller = prev.verifiedCaller;
      this.currentRpcCallerId = prev.callerId;
      this.currentRpcCallerKind = prev.callerKind;
      this.currentRpcCallerPanelId = prev.callerPanelId;
      this.currentRpcRequestId = prev.requestId;
      this.currentRpcIdempotencyKey = prev.idempotencyKey;
      this.currentInvocationToken = prev.invocationToken;
      this.currentCallerContextId = prev.callerContextId;
    }
  }

  protected handleWebSocketUpgrade(_request: Request): Response {
    return new Response("WebSocket not supported", { status: 426 });
  }

  async webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): Promise<void> {
    this.ensureReady();
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    this.ensureReady();
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    this.ensureReady();
  }

  protected resetRpcClients(): void {
    this.connectionless = null;
  }

  async getState(): Promise<Record<string, unknown>> {
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return { state };
  }

  private async withCaller(
    caller: AuthenticatedCaller | null,
    callback: () => Promise<Response>
  ): Promise<Response> {
    const previous = this.currentVerifiedCaller;
    this.currentVerifiedCaller = caller;
    try {
      return await callback();
    } finally {
      this.currentVerifiedCaller = previous;
    }
  }

}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
