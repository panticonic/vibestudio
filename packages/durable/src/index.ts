import {
  collectExposableMethods,
  envelopeFromMessage,
  rpcExposedMethodNames,
  rpcErrorDataOf,
  rpcErrorKindOf,
  rpcMethodAuthority,
  rpc,
  type AuthenticatedCaller,
  type AuthorizationContext,
  type ConnectionlessRpcClient,
  type RpcClient,
  type RpcEnvelope,
  type RpcEvent,
  type RpcRequest,
  type ResolvedRpcAuthority,
} from "@vibestudio/rpc";
import {
  DIRECT_AUTHORITY_ACCEPTED_AT_HEADER,
  createInternalConnectionlessRpcClient,
  type AttestedCaller,
} from "@vibestudio/rpc/internal";
import {
  DurableDirectRpcNonceLedger,
  directRpcInvalidAttestationFailure,
  directRpcDenial,
  directRpcInvocationResourceKey,
  eventIntakeAuthority,
  hostControlDenial,
  type EventIntakeRule,
  type HostControlDenial,
} from "@vibestudio/shared/directRpcEnforcement";
import {
  DURABLE_WORK_READY_HEADER,
  encodeDurableWorkReady,
  type DurableWorkQueue,
} from "@vibestudio/shared/durableWork";
import {
  acceptResidentChannelDelivery,
  acceptResidentChannelInvocation,
  cancelResidentChannelInvocation,
  inspectResidentSessions,
  registerResidentSession,
  type ResidentChannelDeliveryInput,
  type ResidentChannelInvocationInput,
  type ResidentChannelCancellationInput,
  type ResidentSessionReceiver,
} from "@vibestudio/shared/residentSession";
import { bindMethodCapability, allOf, anyOf, capability } from "@vibestudio/shared/authorization";
import {
  describeArgsValidationError,
  invalidArgumentsErrorData,
  type MethodSchema,
  type ServiceMethodSchemas,
} from "@vibestudio/shared/typedServiceClient";
import {
  dispatchWithDurableObjectSchemaGuard,
  durableObjectSchemaDescriptor,
  installDurableObjectSchema,
  validateDurableObjectSchemaIndexes,
} from "./schema.js";
import { InvocationContext } from "./invocation-context.js";
import { DurableWorkReadiness } from "./durable-work-readiness.js";
export { DurableWorkReadiness } from "./durable-work-readiness.js";

// Re-export the `@rpc` exposure decorator so DO authors import it alongside the base.
export { rpc, schemaRpc } from "@vibestudio/rpc";

/** RPC methods supplied by the Durable Object framework rather than a
 * product service schema. Contract tests use this boundary to distinguish
 * inherited host/channel plumbing from a built-in's typed product surface. */
export const DURABLE_OBJECT_FRAMEWORK_RPC_METHODS: ReadonlySet<string> = new Set([
  "durableWorkCapabilities",
  "acceptChannelDelivery",
  "acceptChannelInvocation",
  "cancelChannelInvocation",
]);

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

/** Typed authoring facade over the raw workerd SQL cursor. */
export interface TypedSqlStorage {
  exec<Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): {
    toArray(): Row[];
    one(): Row;
  };
}

export interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

export type { SchemaSqlStorage } from "./schema.js";
export { InvocationContext } from "./invocation-context.js";

export interface LifecyclePrepareInput {
  epoch: string;
  /** Release only activation resources, or perform terminal entity release. */
  mode: "suspend" | "retire";
  reason: string;
  /** Remaining preparation budget; zero means the caller imposes no deadline. */
  deadlineMs: number;
}

interface RpcInvocationContext {
  verifiedCaller: AttestedCaller | null;
  /**
   * The host attestation is a one-invocation continuation, not ambient
   * authority for async resources spawned by that invocation.
   */
  authorityActive: boolean;
  callerId: string | null;
  callerKind: string | null;
  callerPanelId: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  readyQueues: Set<DurableWorkQueue>;
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
  static rpcMethods?: ServiceMethodSchemas;

  protected ctx: DurableObjectContext;
  protected sql: TypedSqlStorage;
  private readonly directRpcNonces: DurableDirectRpcNonceLedger;
  protected env: Record<string, unknown>;

  private schemaReady = false;
  private schemaPreparationError: unknown = null;
  private connectionless: ConnectionlessRpcClient | null = null;
  private currentObjectKey: string | null = null;
  private readonly invocationContext = new InvocationContext<RpcInvocationContext>();
  private readonly durableWorkReadiness: DurableWorkReadiness;

  constructor(ctx: DurableObjectContext, env: unknown) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql as TypedSqlStorage;
    this.directRpcNonces = new DurableDirectRpcNonceLedger({
      exec: (query, ...bindings) => this.sql.exec(query, ...bindings),
      transactionSync: (callback) => this.ctx.storage.transactionSync(callback),
    });
    this.env = env as Record<string, unknown>;
    this.durableWorkReadiness = new DurableWorkReadiness(
      {
        get: (key) => this.getStateValue(key),
        set: (key, value) => this.setStateValue(key, value),
        transaction: (callback) => this.ctx.storage.transactionSync(callback),
      },
      crypto.randomUUID()
    );
  }

  protected abstract createTables(): void;

  /** Activation-local initialization that requires the committed schema. */
  protected afterSchemaReady(): void {}

  /**
   * Optional receiver binding for schema-declared code principals. Product
   * policy remains in `rpcMethods`; a concrete service may bind each method's
   * generic code relationship to its intended provider source.
   */
  protected rpcSchemaCodeSource(_method: string, _wireMethod: MethodSchema): string | null {
    return null;
  }

  protected rpcAuthorityDeclaration(
    method: string,
    wireMethod: MethodSchema | undefined
  ): ResolvedRpcAuthority | null {
    if (!wireMethod) return rpcMethodAuthority(this, method) ?? null;
    const authority = wireMethod.authority;
    const tier = wireMethod.tier;
    const sensitivity = wireMethod.access?.sensitivity;
    const methodCapability = wireMethod.capability;
    if (!authority || !tier || !sensitivity) {
      throw new Error(
        `${this.constructor.name}.${method} has an incomplete typed receiver authority declaration`
      );
    }
    const effect = wireMethod.directEffect;
    if (!effect && !methodCapability) {
      throw new Error(
        `${this.constructor.name}.${method} has an incomplete typed receiver authority declaration`
      );
    }
    const resolvedEffect =
      effect ??
      ({
        kind: "host-capability" as const,
        capability: methodCapability!,
        resource: { kind: "receiver-object" as const },
      } as const);
    if (!("principals" in authority)) {
      if (!methodCapability) {
        throw new Error(
          `${this.constructor.name}.${method} has an incomplete typed receiver authority declaration`
        );
      }
      if (authority.additional?.length || authority.prepared) {
        throw new Error(
          `${this.constructor.name}.${method} uses host-service-only prepared authority`
        );
      }
      return {
        requires: bindMethodCapability(authority.requirement, methodCapability),
        effect: resolvedEffect,
        tier: tier.tier,
        sensitivity,
        ...(tier.session === "codeOnly" ? { codeOnly: true } : {}),
      };
    }
    const codeSource = this.rpcSchemaCodeSource(method, wireMethod);
    if (!codeSource || !authority.principals.includes("code")) {
      return {
        principals: authority.principals,
        effect: resolvedEffect,
        tier: tier.tier,
        sensitivity,
        ...(tier.session === "codeOnly" ? { codeOnly: true } : {}),
      };
    }
    const unconstrained = authority.principals.filter((principal) => principal !== "code");
    if (!methodCapability) {
      throw new Error(
        `${this.constructor.name}.${method} has an incomplete typed receiver authority declaration`
      );
    }
    return {
      requires: anyOf(
        ...unconstrained.map((principal) => capability(principal, methodCapability)),
        allOf(capability("code", methodCapability), {
          kind: "relationship",
          name: "code-source",
          value: codeSource,
        })
      ),
      effect: resolvedEffect,
      tier: tier.tier,
      sensitivity,
      ...(tier.session === "codeOnly" ? { codeOnly: true } : {}),
    };
  }

  protected requiredTables(): readonly string[] {
    return [];
  }

  protected schemaIndexDefinitions(): readonly string[] | undefined {
    return undefined;
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
    const indexes = this.schemaIndexDefinitions();
    if (indexes) validateDurableObjectSchemaIndexes(this.sql, this.requiredTables(), indexes);
  }

  protected ensureReady(): void {
    if (this.schemaPreparationError !== null) {
      const error = this.schemaPreparationError;
      this.schemaPreparationError = null;
      throw error;
    }
    if (this.schemaReady) return;
    this.ensureSchema();
    if (this.env["VIBESTUDIO_SCHEMA_PROBE"] !== true) this.afterSchemaReady();
    this.schemaReady = true;
  }

  private ensureSchema(): void {
    installDurableObjectSchema({
      className: this.constructor.name,
      version: (this.constructor as typeof DurableObjectBase).schemaVersion,
      storage: this.ctx.storage,
      schemaTables: this.requiredTables(),
      createSchema: () => this.createTables(),
      validateSchema: () => this.validateSchema(),
    });
  }

  /** Constructor-time schema preparation whose failure remains fetch-guarded. */
  protected prepareSchemaForActivation(): void {
    try {
      this.ensureReady();
    } catch (error) {
      this.schemaPreparationError = error;
    }
  }

  private schemaDescriptorResponse(): Response {
    const definition = {
      className: this.constructor.name,
      version: (this.constructor as typeof DurableObjectBase).schemaVersion,
      storage: this.ctx.storage,
      schemaTables: this.requiredTables(),
      createSchema: () => this.createTables(),
      validateSchema: () => this.validateSchema(),
    };
    return Response.json(durableObjectSchemaDescriptor(definition));
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

  private parseRequestBody(body: string): {
    args: unknown[];
    error?: string;
    caller?: AttestedCaller | null;
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
                    authorization: record["authorization"] as AttestedCaller["authorization"],
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
   * the shared connectionless transport. The DO's own public methods are `exposeAll`'d
   * onto it so inbound envelopes dispatched via `handleEnvelope` reach the class
   * method (`respond`/`deliver` are wired in `fetch`).
   */
  protected get rpc(): RpcClient {
    return this.connectionlessClient().client;
  }

  private connectionlessClient(): ConnectionlessRpcClient {
    if (!this.connectionless) {
      const token = this.env["RPC_AUTH_TOKEN"];
      const source = this.env["WORKER_SOURCE"];
      const className = this.env["WORKER_CLASS_NAME"];
      const gatewayUrl = this.env["GATEWAY_URL"];
      const rpcFetch = this.env["RPC_FETCH"];
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
      const connectionless = createInternalConnectionlessRpcClient({
        selfId: this.rpcSelfId,
        serverUrl: gatewayUrl,
        authToken: token,
        callerKind: "do",
        ...(typeof rpcFetch === "function" ? { fetch: rpcFetch as typeof fetch } : {}),
        // Continue only the currently executing host-attested invocation.
        // The callback is evaluated when an outbound envelope is created, so
        // alarms and later requests cannot retain a completed parent's nonce.
        authorityParentNonce: () =>
          this.invocationContext.current()?.authorityActive
            ? this.invocationContext.current()?.verifiedCaller?.authorization?.nonce
            : undefined,
        ...(this.respondTimeoutMs !== undefined ? { respondTimeoutMs: this.respondTimeoutMs } : {}),
      });
      // Expose ONLY this DO's `@rpc`-marked methods (opt-in / default-deny). Private/protected helpers
      // and all framework plumbing (`dispatchInboundEnvelope`, state-KV, alarms) are unreachable over
      // the open relay; a forgotten `@rpc` fails loud ("not exposed"). The decorator allow-list is
      // the boundary, including the framework methods declared on this base.
      connectionless.client.exposeAll(
        collectExposableMethods(this, rpcExposedMethodNames(this), Object.prototype)
      );
      this.connectionless = connectionless;
    }
    return this.connectionless;
  }

  protected get caller(): AuthenticatedCaller | null {
    const caller = this.invocationContext.current()?.verifiedCaller;
    if (!caller) return null;
    return {
      callerId: caller.callerId,
      callerKind: caller.callerKind,
      ...(caller.callerPanelId ? { callerPanelId: caller.callerPanelId } : {}),
      ...(caller.userId ? { userId: caller.userId } : {}),
    };
  }

  /** Host-attested authority facts without replay-sensitive transport proof. */
  protected get authorization(): AuthorizationContext | null {
    return this.invocationContext.current()?.verifiedCaller?.authorization?.context ?? null;
  }

  protected get rpcCallerId(): string | null {
    return this.invocationContext.current()?.callerId ?? null;
  }

  protected get rpcCallerKind(): string | null {
    return this.invocationContext.current()?.callerKind ?? null;
  }

  protected get rpcCallerPanelId(): string | null {
    return this.invocationContext.current()?.callerPanelId ?? null;
  }

  protected get rpcRequestId(): string | null {
    return this.invocationContext.current()?.requestId ?? null;
  }

  protected get rpcIdempotencyKey(): string | null {
    return this.invocationContext.current()?.idempotencyKey ?? null;
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

  /**
   * Declare that this activation owns a live resource which must be released
   * before workerd replacement or server shutdown.
   *
   * Registration is part of acquiring the resource: callers await this write
   * before acknowledging ownership, so lifecycle discovery is complete rather
   * than a best-effort side channel.
   */
  protected async registerLifecycleRelease(detail?: unknown): Promise<void> {
    await this.rpc.call<void>("main", "workspace-state.lifecycleLeaseUpsert", [
      { ...this.lifecycleKey(), detail },
    ]);
  }

  /** Clear this activation's durable lifecycle ownership declaration. */
  protected async clearLifecycleRelease(): Promise<void> {
    await this.rpc.call<void>("main", "workspace-state.lifecycleLeaseClear", [this.lifecycleKey()]);
  }

  async fetch(request: Request): Promise<Response> {
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !this.currentObjectKey) {
      this.currentObjectKey = decodeURIComponent(segments[0]!);
    }
    const objectKey = this.currentObjectKey ?? this.ctx.id.name;
    if (!objectKey) throw new Error("Durable Object request has no exact object key");
    return dispatchWithDurableObjectSchemaGuard({
      request,
      identity: {
        source: String(this.env["WORKER_SOURCE"] ?? ""),
        className: String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name),
        objectKey,
      },
      ensureReady: () => this.ensureReady(),
      dispatch: () => this.dispatchFetch(request),
    });
  }

  private async dispatchFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !this.currentObjectKey) {
      this.currentObjectKey = decodeURIComponent(segments[0]!);
    }

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
    if (this.env["VIBESTUDIO_SCHEMA_PROBE"] === true) {
      return method === "__vibestudio_schema_descriptor"
        ? this.schemaDescriptorResponse()
        : new Response("Schema probes refuse application dispatch", { status: 403 });
    }
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
            return jsonResponse(
              {
                error: denial.reason,
                errorCode: denial.code,
                errorKind: "access",
                errorData: { authorityFailure: denial.failure },
              },
              403
            );
          }
          // Live module replacement may update the class schema while this
          // activation retains its previous schemaReady cache. Lifecycle is the
          // generation boundary, so revalidate the one current schema here.
          this.ensureSchema();
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
            return jsonResponse(
              {
                error: denial.reason,
                errorCode: denial.code,
                errorKind: "access",
                errorData: { authorityFailure: denial.failure },
              },
              403
            );
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
      const dispatched = await this.dispatchInboundEnvelope(envelope, authorityAcceptedAt);
      const responseEnvelope = dispatched.result;
      const responseMessage = responseEnvelope?.message;
      if (responseMessage?.type === "response" && "error" in responseMessage) {
        if (responseMessage.error.startsWith('Method "')) {
          return jsonResponse(
            { error: `Unknown method: ${method}` },
            404,
            this.workReadyHeaders(dispatched.readyQueues)
          );
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
          500,
          this.workReadyHeaders(dispatched.readyQueues)
        );
      }
      return jsonResponse(
        responseMessage?.type === "response" && "result" in responseMessage
          ? (responseMessage.result ?? null)
          : null,
        200,
        this.workReadyHeaders(dispatched.readyQueues)
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

  private hostControlDenial(method: string, authorityAcceptedAt: number): HostControlDenial | null {
    const attestation = this.invocationContext.current()?.verifiedCaller?.authorization ?? null;
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
      const reason =
        `${method}: host authority attestation nonce was replayed or is outside ` +
        "the receiver's retention bound";
      return {
        code: "EACCES",
        reason,
        failure: directRpcInvalidAttestationFailure(reason),
      };
    }
    return null;
  }

  /** Handle an `RpcEnvelope` POSTed to `__rpc`; returns a response envelope (or `{}` for events). */
  private async handleInboundEnvelope(
    request: Request,
    authorityAcceptedAt: number
  ): Promise<Response> {
    const envelope = (await request.json()) as RpcEnvelope;
    const message = envelope.message;
    if (message?.type === "event") {
      const caller = (envelope.delivery.caller as AttestedCaller | undefined) ?? null;
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
      if (denial) {
        return jsonResponse(
          {
            error: denial.reason,
            errorCode: denial.code,
            errorKind: "access",
            errorData: { authorityFailure: denial.failure },
          },
          403
        );
      }
      const attestation = caller?.authorization;
      if (
        !attestation ||
        !this.directRpcNonces.consume(attestation.nonce, attestation.expiresAt, authorityAcceptedAt)
      ) {
        const reason =
          `${method}: host authority attestation nonce was replayed or is outside ` +
          "the receiver's retention bound";
        return jsonResponse(
          {
            error: reason,
            errorCode: "EACCES",
            errorKind: "access",
            errorData: {
              authorityFailure: directRpcInvalidAttestationFailure(reason),
            },
          },
          403
        );
      }
      this.connectionlessClient().deliver(envelope);
      return jsonResponse({});
    }
    if (message?.type !== "request" && message?.type !== "stream-request") {
      // Correlated responses and stream frames are not new effectful event intake.
      this.connectionlessClient().deliver(envelope);
      return jsonResponse({});
    }
    if (message.type === "stream-request") {
      const dispatched = await this.dispatchInboundEnvelope(
        {
          ...envelope,
          message: { ...message, type: "request" } satisfies RpcRequest,
        },
        authorityAcceptedAt
      );
      const responseEnvelope = dispatched.result;
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
    const dispatched = await this.dispatchInboundEnvelope(envelope, authorityAcceptedAt);
    return jsonResponse(
      dispatched.result ?? {},
      200,
      this.workReadyHeaders(dispatched.readyQueues)
    );
  }

  /**
   * Dispatch an inbound request envelope through the converged core
   * (`respond` → `handleEnvelope` → `exposeAll`'d method), with the DO's
   * caller-context getters bound to `envelope.delivery.caller` for the duration.
   */
  private async dispatchInboundEnvelope(
    envelope: RpcEnvelope,
    authorityAcceptedAt: number
  ): Promise<{ result: RpcEnvelope | null; readyQueues: DurableWorkQueue[] }> {
    const connectionless = this.connectionlessClient();
    // An unattributed method-path call carries a synthetic empty caller; surface
    // it as a null caller context (matching the pre-convergence behavior) rather
    // than a forgeable `"unknown"` — methods that gate on `this.caller` rely on it.
    const rawCaller = envelope.delivery.caller;
    const caller = rawCaller && rawCaller.callerId !== "" ? (rawCaller as AttestedCaller) : null;
    const message = envelope.message as RpcRequest;
    const method = message?.method;
    const wireMethod = method
      ? (this.constructor as typeof DurableObjectBase).rpcMethods?.[method]
      : undefined;
    if (wireMethod && message) {
      const tupleItems = (wireMethod.args as unknown as { _def?: { items?: readonly unknown[] } })
        ._def?.items;
      const args = message.args ?? [];
      const paddedArgs = tupleItems
        ? [...args, ...Array(Math.max(0, tupleItems.length - args.length))]
        : args;
      const parsedArgs = wireMethod.args.safeParse(paddedArgs);
      if (!parsedArgs.success) {
        // The one shared formatter: same summary and structured issue list as
        // the main service dispatcher, so a direct receiver failure names the
        // method parameter exactly like a host-service failure does.
        const validation = describeArgsValidationError(parsedArgs.error, wireMethod);
        return {
          result: this.schemaDenialResponse(
            envelope,
            message,
            `Invalid arguments for ${method}: ${validation.summary}`,
            invalidArgumentsErrorData(this.constructor.name, method, validation.issues)
          ),
          readyQueues: [],
        };
      }
      message.args = parsedArgs.data as unknown[];
    }
    const audience = this.rpcSelfId;
    const declaration = method ? this.rpcAuthorityDeclaration(method, wireMethod) : null;
    const attestation = caller?.authorization ?? null;
    const resourceKey = directRpcInvocationResourceKey({
      audience,
      declaration,
      attestation,
      args: message?.args ?? [],
    });
    const denial = directRpcDenial({
      kind: "call",
      method: method ?? "",
      caller,
      attestation,
      declaration,
      audience,
      resourceKey,
      capability: caller?.authorization?.capability ?? "",
      now: authorityAcceptedAt,
    });
    if (denial) {
      return {
        result: {
          from: envelope.target,
          target: envelope.from,
          delivery: { caller: caller ?? { callerId: "", callerKind: "unknown" } },
          provenance: envelope.provenance ?? [],
          message: {
            type: "response",
            requestId: message?.requestId ?? "",
            error: denial.reason,
            errorCode: denial.code,
            errorKind: "access",
            errorData: { authorityFailure: denial.failure },
          },
        } as RpcEnvelope,
        readyQueues: [],
      };
    }
    if (
      !attestation ||
      !this.directRpcNonces.consume(attestation.nonce, attestation.expiresAt, authorityAcceptedAt)
    ) {
      const reason =
        `${method ?? "<unknown>"}: host authority attestation nonce was replayed or is outside ` +
        "the receiver's retention bound";
      return {
        result: {
          from: envelope.target,
          target: envelope.from,
          delivery: { caller: caller ?? { callerId: "", callerKind: "unknown" } },
          provenance: envelope.provenance ?? [],
          message: {
            type: "response",
            requestId: message?.requestId ?? "",
            error: reason,
            errorCode: "EACCES",
            errorKind: "access",
            errorData: {
              authorityFailure: directRpcInvalidAttestationFailure(reason),
            },
          },
        } as RpcEnvelope,
        readyQueues: [],
      };
    }
    const dispatched = await this.withRpcCaller(caller, message, envelope, () =>
      connectionless.respond(envelope)
    );
    const response = dispatched.result;
    if (
      wireMethod?.returns &&
      response?.message.type === "response" &&
      !("error" in response.message)
    ) {
      const parsedResult = wireMethod.returns.safeParse(response.message.result);
      if (!parsedResult.success) {
        return {
          result: this.schemaDenialResponse(
            envelope,
            message,
            `Invalid result from ${method}: ${parsedResult.error.message}`
          ),
          readyQueues: dispatched.readyQueues,
        };
      }
      response.message.result = parsedResult.data;
    }
    return dispatched;
  }

  private schemaDenialResponse(
    envelope: RpcEnvelope,
    message: RpcRequest,
    reason: string,
    errorData?: Record<string, unknown>
  ): RpcEnvelope {
    return {
      from: envelope.target,
      target: envelope.from,
      delivery: envelope.delivery,
      provenance: envelope.provenance ?? [],
      message: {
        type: "response",
        requestId: message.requestId,
        error: reason,
        errorCode: "EINVAL",
        errorKind: "protocol",
        ...(errorData ? { errorData } : {}),
      },
    } as RpcEnvelope;
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

  /**
   * Advance authoritative queue readiness and attach an opportunistic response
   * hint when a response exists. The durable generation is the correctness
   * mechanism; the response header only reduces dispatch latency.
   */
  protected markWorkReady(...queues: DurableWorkQueue[]): void {
    const unique = [...new Set(queues)];
    for (const queue of unique) this.invocationContext.current()?.readyQueues.add(queue);
    this.durableWorkReadiness.markReady(unique);
  }

  /** Immediate alarm edge while any committed generation is unacknowledged. */
  protected nextDurableWorkReadyEdgeAt(): number | null {
    return this.pendingDurableWorkReadyQueues().length > 0 ? Date.now() : null;
  }

  private pendingDurableWorkReadyQueues(): DurableWorkQueue[] {
    return this.durableWorkReadiness.pendingQueues(this.durableWorkQueues());
  }

  protected acknowledgeDurableWorkReady(queue: DurableWorkQueue): void {
    this.durableWorkReadiness.acknowledge(queue);
  }

  protected durableWorkReadinessDiagnostics() {
    return this.durableWorkReadiness.diagnostics(this.durableWorkQueues());
  }

  /** Framework queue capabilities are probed by the host during activation. */
  protected durableWorkQueues(): readonly DurableWorkQueue[] {
    return [];
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  durableWorkCapabilities(): DurableWorkQueue[] {
    return [...this.durableWorkQueues()];
  }

  /** Finite delivery into an explicitly resident in-memory operation. The
   * durable sender retains and retries its mailbox row while no receiver is
   * active; channel membership itself owns no stream or residency. */
  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async acceptChannelDelivery(input: ResidentChannelDeliveryInput): Promise<unknown> {
    return acceptResidentChannelDelivery(this.rpcSelfId, input);
  }

  @rpc({ principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
  async acceptChannelInvocation(input: ResidentChannelInvocationInput): Promise<unknown> {
    return acceptResidentChannelInvocation(this.rpcSelfId, input);
  }

  @rpc({ principals: ["code"], effect: { kind: "open" }, tier: "open", sensitivity: "write" })
  async cancelChannelInvocation(input: ResidentChannelCancellationInput): Promise<unknown> {
    return cancelResidentChannelInvocation(this.rpcSelfId, input);
  }

  /** Register the finite receiver in this exact Durable Object activation.
   * Guest/userland bundles must receive this capability from their owner; a
   * separately imported module registry lives in a different module graph. */
  protected registerResidentChannelSession(
    channelId: string,
    receiver: ResidentSessionReceiver
  ): () => void {
    return registerResidentSession(this.rpcSelfId, channelId, receiver);
  }

  protected residentSessionDiagnostics(): {
    active: number;
    receivers: Array<{ channelId: string; openedAt: number; ageMs: number }>;
  } {
    const receivers = inspectResidentSessions(this.rpcSelfId);
    return { active: receivers.length, receivers };
  }

  /**
   * Fence claims to one host worker and one concrete DO activation. A rebuilt
   * facet releases leases from its predecessor before claiming new work.
   */
  protected adoptDurableWorkWorkerGeneration(workerId: string): {
    adopted: boolean;
    previousWorkerId: string | null;
  } {
    return this.durableWorkReadiness.adoptWorker(workerId, (previousWorkerId, nextWorkerId) =>
      this.releaseDurableWorkClaims(previousWorkerId, nextWorkerId)
    );
  }

  protected releaseDurableWorkClaims(
    _previousWorkerId: string | null,
    _nextWorkerId: string
  ): void {}

  /** Optional domain alarm schedule recomputed after a successful RPC. */
  protected nextAlarmAfterRequest(): AlarmSchedule | null | undefined {
    return undefined;
  }

  private workReadyHeaders(queues?: Iterable<DurableWorkQueue>): Headers {
    const headers = new Headers({ "Content-Type": "application/json" });
    const encoded = encodeDurableWorkReady(
      queues ?? this.invocationContext.current()?.readyQueues ?? []
    );
    if (encoded) headers.set(DURABLE_WORK_READY_HEADER, encoded);
    return headers;
  }

  protected resetRpcClients(): void {
    this.connectionless = null;
  }

  async getState(): Promise<Record<string, unknown>> {
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return { state };
  }

  private async withCaller(
    caller: AttestedCaller | null,
    callback: () => Promise<Response>
  ): Promise<Response> {
    const context: RpcInvocationContext = {
      verifiedCaller: caller,
      authorityActive: true,
      callerId: caller?.callerId ?? null,
      callerKind: caller?.callerKind ?? null,
      callerPanelId: caller?.callerPanelId ?? null,
      requestId: null,
      idempotencyKey: null,
      readyQueues: new Set(),
    };
    try {
      const response = await this.invocationContext.run(context, callback);
      const headers = new Headers(response.headers);
      const encoded = encodeDurableWorkReady(context.readyQueues);
      if (encoded) headers.set(DURABLE_WORK_READY_HEADER, encoded);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } finally {
      context.authorityActive = false;
    }
  }

  private async withRpcCaller<T>(
    caller: AttestedCaller | null,
    message: RpcRequest,
    envelope: RpcEnvelope,
    callback: () => Promise<T>
  ): Promise<{ result: T; readyQueues: DurableWorkQueue[] }> {
    const context: RpcInvocationContext = {
      verifiedCaller: caller,
      authorityActive: true,
      callerId: caller?.callerId ?? null,
      callerKind: caller?.callerKind ?? null,
      callerPanelId: caller?.callerPanelId ?? null,
      requestId: message?.requestId ?? null,
      idempotencyKey: envelope.delivery.idempotencyKey ?? null,
      readyQueues: new Set(),
    };
    try {
      const result = await this.invocationContext.run(context, async () => {
        const value = await callback();
        const nextAlarm = this.nextAlarmAfterRequest();
        if (nextAlarm === null) this.deleteAlarm();
        else if (nextAlarm !== undefined) this.setAlarmAt(nextAlarm.wakeAt);
        return value;
      });
      return { result, readyQueues: [...context.readyQueues] };
    } finally {
      context.authorityActive = false;
    }
  }
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: headers ?? { "Content-Type": "application/json" },
  });
}
