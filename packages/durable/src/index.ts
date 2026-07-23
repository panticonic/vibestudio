import {
  DIRECT_AUTHORITY_ACCEPTED_AT_HEADER,
  collectExposableMethods,
  createConnectionlessRpcClient,
  envelopeFromMessage,
  rpcExposedMethodNames,
  rpcErrorDataOf,
  rpcErrorKindOf,
  rpcMethodAuthority,
  type AuthenticatedCaller,
  type ConnectionlessRpcClient,
  type DeferrableRpcClient,
  type RpcEnvelope,
  type RpcEvent,
  type RpcRequest,
} from "@vibestudio/rpc";
import {
  DurableDirectRpcNonceLedger,
  directRpcDenial,
  eventIntakeAuthority,
  hostControlDenial,
  type EventIntakeRule,
} from "@vibestudio/shared/directRpcEnforcement";
import {
  migrateDurableObjectSchema,
  type DurableObjectSchemaBaseline,
  type DurableObjectSchemaMigration,
} from "./schema.js";

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

export type {
  DurableObjectSchemaBaseline,
  DurableObjectSchemaMigration,
  SchemaSqlStorage,
} from "./schema.js";

export interface LifecyclePrepareInput {
  epoch: string;
  /** Release only activation resources, or perform terminal entity release. */
  mode: "suspend" | "retire";
  reason: string;
  /** Remaining preparation budget; zero means the caller imposes no deadline. */
  deadlineMs: number;
}

export interface LifecyclePrepareResult {
  status: "ready" | "failed";
  detail?: unknown;
}

export interface LifecycleResumeInput {
  epoch: string;
  previousGeneration: number | null;
  currentGeneration: number;
  reason: "planned" | "crash" | "server_restart";
}

export interface AlarmSchedule {
  wakeAt: number;
}

// (RPC exposure is now opt-in via `@rpc` + `rpcExposedMethodNames` — no reserved deny-list needed;
// framework/lifecycle methods are simply never `@rpc`-marked, and the base-proto boundary backstops.)

export abstract class DurableObjectBase {
  static schemaVersion = 1;
  static eventIntake: readonly EventIntakeRule[] = [];

  protected ctx: DurableObjectContext;
  protected sql: SqlStorage;
  private readonly directRpcNonces: DurableDirectRpcNonceLedger;
  protected env: Record<string, unknown>;

  private schemaReady = false;
  private connectionless: ConnectionlessRpcClient | null = null;
  private currentVerifiedCaller: AuthenticatedCaller | null = null;
  private currentRpcCallerId: string | null = null;
  private currentRpcCallerKind: string | null = null;
  private currentRpcCallerPanelId: string | null = null;
  private currentRpcRequestId: string | null = null;
  private currentRpcIdempotencyKey: string | null = null;
  private currentObjectKey: string | null = null;

  constructor(ctx: DurableObjectContext, env: unknown) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.directRpcNonces = new DurableDirectRpcNonceLedger({
      exec: (query, ...bindings) => this.sql.exec(query, ...bindings),
      transactionSync: (callback) => this.ctx.storage.transactionSync(callback),
    });
    this.env = env as Record<string, unknown>;
  }

  protected abstract createTables(): void;

  /** Explicit persisted-state upgrades. Fresh databases never replay these. */
  protected schemaMigrations(): readonly DurableObjectSchemaMigration[] {
    return [];
  }

  /** Oldest production schema shape this class can open without data loss. */
  protected schemaProductionBaseline(): DurableObjectSchemaBaseline | undefined {
    return undefined;
  }

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
    migrateDurableObjectSchema({
      className: this.constructor.name,
      targetVersion: (this.constructor as typeof DurableObjectBase).schemaVersion,
      storage: this.ctx.storage,
      migrations: this.schemaMigrations(),
      productionBaseline: this.schemaProductionBaseline(),
      createSchema: () => this.createTables(),
      validateSchema: () => this.validateSchema(),
    });
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
            caller: {
              callerId: record["callerId"],
              callerKind: record["callerKind"] as AuthenticatedCaller["callerKind"],
              ...(typeof record["callerPanelId"] === "string"
                ? { callerPanelId: record["callerPanelId"] }
                : {}),
              ...(typeof record["userId"] === "string" ? { userId: record["userId"] } : {}),
              ...(record["authorization"] && typeof record["authorization"] === "object"
                ? {
                    authorization: record["authorization"] as AuthenticatedCaller["authorization"],
                  }
                : {}),
            },
          };
        }
      }
      return {
        args: (parsed as { args: unknown[] }).args,
      };
    }
    return { args: [parsed] };
  }

  /**
   * Concrete runtime identity presented on outbound RPC (the RPC_RUNTIME_ID_HEADER,
   * distinct from the class-scoped bearer token). The bearer proves that this code is
   * running inside the declared DO service; the concrete id selects the immutable entity
   * row that supplies this object's owner, context, execution digest, and sealed authority.
   */
  protected get rpcSelfId(): string {
    const source = String(this.env["WORKER_SOURCE"] ?? "");
    const className = String(this.env["WORKER_CLASS_NAME"] ?? "");
    return `do:${source}:${className}:${this.objectKey}`;
  }

  /**
   * Optional inbound `respond()` watchdog for this DO. `undefined` uses the
   * transport default (unbounded); a positive value opts into a deadline, and
   * `0` explicitly disables one.
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

  protected setAlarm(delayMs: number): void {
    this.setAlarmAt(Date.now() + delayMs);
  }

  /**
   * Persist an alarm from an ordinary DO request. An `alarm()` handler returns
   * its next schedule directly instead of calling this method.
   *
   */
  protected setAlarmAt(timeMs: number): void {
    this.trackAlarmRpc(
      this.rpc.call<void>("main", "workspace-state.alarmSet", [
        {
          ...this.lifecycleKey(),
          wakeAt: timeMs,
        },
      ])
    );
  }

  /** Clear an alarm from an ordinary DO request. A completed `alarm()` returns `null`. */
  protected deleteAlarm(): void {
    this.trackAlarmRpc(
      this.rpc.call<void>("main", "workspace-state.alarmClear", [this.lifecycleKey()])
    );
  }

  private readonly pendingAlarmRpcs = new Set<Promise<void>>();

  private trackAlarmRpc(pending: Promise<void>): void {
    this.pendingAlarmRpcs.add(pending);
  }

  private async drainAlarmRpcs(): Promise<void> {
    while (this.pendingAlarmRpcs.size > 0) {
      const pending = [...this.pendingAlarmRpcs];
      try {
        await Promise.all(pending);
      } finally {
        for (const settled of pending) this.pendingAlarmRpcs.delete(settled);
      }
    }
  }

  private lifecycleKey(): { source: string; className: string; objectKey: string } {
    return {
      source: String(this.env["WORKER_SOURCE"] ?? ""),
      className: String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name),
      objectKey: this.objectKey,
    };
  }

  async alarm(): Promise<AlarmSchedule | null> {
    this.ensureReady();
    return null;
  }

  async releaseForLifecycle(_input: LifecyclePrepareInput): Promise<LifecyclePrepareResult> {
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
    const acceptedAtRaw = request.headers.get(DIRECT_AUTHORITY_ACCEPTED_AT_HEADER);
    const acceptedAtHeader = acceptedAtRaw === null ? Number.NaN : Number(acceptedAtRaw);
    const authorityAcceptedAt = Number.isFinite(acceptedAtHeader) ? acceptedAtHeader : Date.now();

    try {
      // Converged inbound dispatch: an `RpcEnvelope` POSTed to `__rpc` (relay
      // traffic, server→DO event push, deferred replies) flows through the
      // shared core's `handleEnvelope` → `exposeAll`'d method / event listeners.
      if (method === "__rpc") {
        return await this.handleInboundEnvelope(request, authorityAcceptedAt);
      }

      let args: unknown[] = [];
      let verifiedCallerFromBody: AuthenticatedCaller | null = null;
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
        }
      }

      if (method === "__lifecycle/prepare" || method === "__lifecycle/resume") {
        return this.withCaller(verifiedCallerFromBody, async () => {
          const denial = this.hostControlDenial(method, authorityAcceptedAt);
          if (denial) {
            return jsonResponse({ error: denial.reason, errorCode: denial.code }, 403);
          }
          const result =
            method === "__lifecycle/prepare"
              ? await (async () => {
                  await this.drainAlarmRpcs();
                  return this.releaseForLifecycle(args[0] as LifecyclePrepareInput);
                })()
              : await this.resumeAfterRestart(args[0] as LifecycleResumeInput);
          return jsonResponse(result ?? null);
        });
      }

      if (method === "__alarm") {
        return this.withCaller(verifiedCallerFromBody, async () => {
          const denial = this.hostControlDenial(method, authorityAcceptedAt);
          if (denial) {
            return jsonResponse({ error: denial.reason, errorCode: denial.code }, 403);
          }
          return jsonResponse({ nextAlarm: await this.alarm() });
        });
      }

      // Method-path dispatch (the server's instance-token channel,
      // `DODispatch.dispatch`): build an inbound request envelope from
      // {method, args, __caller} and route it through the SAME converged core
      // dispatch as `__rpc`, so `(this)[method]` is gone and `exposeAll` is the
      // single dispatch. Returns the raw method result (the relay/DODispatch
      // contract), not the response envelope.
      const caller: AuthenticatedCaller = verifiedCallerFromBody ?? {
        callerId: "",
        callerKind: "unknown",
      };
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
        },
      });
      const responseEnvelope = await this.dispatchInboundEnvelope(envelope, authorityAcceptedAt);
      const responseMessage = responseEnvelope?.message;
      if (responseMessage?.type === "response" && "error" in responseMessage) {
        if (responseMessage.error.startsWith('Method "')) {
          return jsonResponse({ error: `Unknown method: ${method}` }, 404);
        }
        return jsonResponse(
          {
            error: responseMessage.error,
            errorKind: responseMessage.errorKind,
            ...(responseMessage.errorCode ? { errorCode: responseMessage.errorCode } : {}),
            ...(responseMessage.errorData !== undefined
              ? { errorData: responseMessage.errorData }
              : {}),
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
      const errorData = rpcErrorDataOf(err);
      const errorCode = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      return jsonResponse(
        {
          error: err instanceof Error ? err.message : String(err),
          errorKind: rpcErrorKindOf(err),
          ...(typeof errorCode === "string" ? { errorCode } : {}),
          ...(errorData === undefined ? {} : { errorData }),
        },
        500
      );
    } finally {
      // An alarm mutation is part of the request's durable outcome. If its
      // single scheduling write fails, the request fails too; returning a
      // successful domain response would otherwise acknowledge work whose
      // only future wake was never recorded.
      await this.drainAlarmRpcs();
    }
  }

  private hostControlDenial(
    method: string,
    authorityAcceptedAt: number
  ): { code: "EACCES"; reason: string } | null {
    const attestation = this.caller?.authorization ?? null;
    const denial = hostControlDenial({
      method,
      attestation,
      audience: this.rpcSelfId,
      now: authorityAcceptedAt,
    });
    if (denial) return denial;
    if (
      !attestation ||
      !this.directRpcNonces.consume(attestation.nonce, attestation.expiresAt, authorityAcceptedAt)
    ) {
      return { code: "EACCES", reason: `${method}: host authority attestation was replayed` };
    }
    return null;
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
   *
   * This receiver hook remains an independent fail-closed boundary. `@rpc`
   * authority metadata does not supersede it: privileged internal DOs must keep
   * overriding this method until the shared inbound authority evaluator is the
   * sole enforced receiver boundary.
   */
  protected assertInboundAllowed(
    _caller: AuthenticatedCaller | null,
    _kind: "call" | "event"
  ): void {}

  /** Handle an `RpcEnvelope` POSTed to `__rpc`; returns a response envelope (or `{}` for events). */
  private async handleInboundEnvelope(
    request: Request,
    authorityAcceptedAt: number
  ): Promise<Response> {
    const envelope = (await request.json()) as RpcEnvelope;
    const message = envelope.message;
    if (message?.type === "event") {
      const caller = envelope.delivery.caller ?? null;
      const event = message as RpcEvent;
      const method = `__event:${event.event}`;
      const audience = this.rpcSelfId;
      const denial = directRpcDenial({
        kind: "event",
        method,
        eventTopic: event.event,
        caller,
        attestation: caller?.authorization ?? null,
        declaration: eventIntakeAuthority(this, event.event),
        audience,
        resourceKey: audience,
        capability: `event:${event.event}`,
        now: authorityAcceptedAt,
      });
      if (denial) return jsonResponse({ error: denial.reason, errorCode: denial.code }, 403);
      const attestation = caller?.authorization;
      if (
        !attestation ||
        !this.directRpcNonces.consume(attestation.nonce, attestation.expiresAt, authorityAcceptedAt)
      ) {
        return jsonResponse(
          { error: `${method}: host authority attestation was replayed`, errorCode: "EACCES" },
          403
        );
      }
      // Retained until the checked-in parity worksheet proves shared enforcement.
      this.assertInboundAllowed(caller, "event");
      this.connectionlessClient().deliver(envelope);
      return jsonResponse({});
    }
    if (message?.type !== "request" && message?.type !== "stream-request") {
      // Correlated responses and stream frames are not new effectful event intake.
      this.connectionlessClient().deliver(envelope);
      return jsonResponse({});
    }
    if (message.type === "stream-request") {
      const responseEnvelope = await this.dispatchInboundEnvelope(
        {
          ...envelope,
          message: { ...message, type: "request" } satisfies RpcRequest,
        },
        authorityAcceptedAt
      );
      const responseMessage = responseEnvelope?.message;
      if (responseMessage?.type === "response" && "result" in responseMessage) {
        if (responseMessage.result instanceof Response) return responseMessage.result;
        return jsonResponse(
          { error: `Streaming method ${message.method} did not return a Response` },
          500
        );
      }
      return jsonResponse(
        {
          error:
            responseMessage?.type === "response" && "error" in responseMessage
              ? responseMessage.error
              : `Streaming method ${message.method} did not produce a response`,
        },
        500
      );
    }
    const responseEnvelope = await this.dispatchInboundEnvelope(envelope, authorityAcceptedAt);
    return jsonResponse(responseEnvelope ?? {});
  }

  /**
   * Dispatch an inbound request envelope through the converged core
   * (`respond` → `handleEnvelope` → `exposeAll`'d method), with the DO's
   * caller-context getters bound to `envelope.delivery.caller` for the duration.
   */
  private async dispatchInboundEnvelope(
    envelope: RpcEnvelope,
    authorityAcceptedAt: number
  ): Promise<RpcEnvelope | null> {
    const connectionless = this.connectionlessClient();
    // An unattributed method-path call carries a synthetic empty caller; surface
    // it as a null caller context (matching the pre-convergence behavior) rather
    // than a forgeable `"unknown"` — methods that gate on `this.caller` rely on it.
    const rawCaller = envelope.delivery.caller;
    const caller = rawCaller && rawCaller.callerId !== "" ? rawCaller : null;
    const message = envelope.message as RpcRequest;
    const method = message?.method;
    const audience = this.rpcSelfId;
    const denial = method
      ? directRpcDenial({
          kind: "call",
          method,
          caller,
          attestation: caller?.authorization ?? null,
          declaration: rpcMethodAuthority(this, method) ?? null,
          audience,
          resourceKey: audience,
          capability: caller?.authorization?.capability ?? "",
          now: authorityAcceptedAt,
        })
      : { code: "EACCES" as const, reason: "direct RPC method is required" };
    if (denial) {
      return {
        from: envelope.target,
        target: envelope.from,
        delivery: { caller: caller ?? { callerId: "", callerKind: "unknown" } },
        provenance: envelope.provenance ?? [],
        message: {
          type: "response",
          requestId: message?.requestId ?? "",
          error: denial.reason,
          errorCode: denial.code,
        },
      } as RpcEnvelope;
    }
    const attestation = caller?.authorization;
    if (
      !attestation ||
      !this.directRpcNonces.consume(attestation.nonce, attestation.expiresAt, authorityAcceptedAt)
    ) {
      return {
        from: envelope.target,
        target: envelope.from,
        delivery: { caller: caller ?? { callerId: "", callerKind: "unknown" } },
        provenance: envelope.provenance ?? [],
        message: {
          type: "response",
          requestId: message?.requestId ?? "",
          error: `${method ?? "<unknown>"}: host authority attestation was replayed`,
          errorCode: "EACCES",
        },
      } as RpcEnvelope;
    }
    // Legacy receiver guards remain until the generated parity suite proves
    // shared enforcement is at least as restrictive for every call and event.
    this.assertInboundAllowed(caller, "call");
    const prev = {
      verifiedCaller: this.currentVerifiedCaller,
      callerId: this.currentRpcCallerId,
      callerKind: this.currentRpcCallerKind,
      callerPanelId: this.currentRpcCallerPanelId,
      requestId: this.currentRpcRequestId,
      idempotencyKey: this.currentRpcIdempotencyKey,
    };
    this.currentVerifiedCaller = caller;
    this.currentRpcCallerId = caller?.callerId ?? null;
    this.currentRpcCallerKind = caller?.callerKind ?? null;
    this.currentRpcCallerPanelId = caller?.callerPanelId ?? null;
    this.currentRpcRequestId = message?.requestId ?? null;
    this.currentRpcIdempotencyKey = envelope.delivery.idempotencyKey ?? null;
    try {
      return await connectionless.respond(envelope);
    } finally {
      this.currentVerifiedCaller = prev.verifiedCaller;
      this.currentRpcCallerId = prev.callerId;
      this.currentRpcCallerKind = prev.callerKind;
      this.currentRpcCallerPanelId = prev.callerPanelId;
      this.currentRpcRequestId = prev.requestId;
      this.currentRpcIdempotencyKey = prev.idempotencyKey;
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
