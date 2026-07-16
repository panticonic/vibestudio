/**
 * Connectionless RPC client — the one shared assembly for off-socket targets
 * (workerd workers, both Durable Object bases). It runs the unified
 * `createRpcClient` core over the envelope-native `httpClientTransport`, and
 * layers the single connectionless extension the convergence keeps:
 * `callDeferred`.
 *
 * There is intentionally ONE builder so the two DurableObjectBase codebases
 * (`@vibestudio/durable` and `@workspace/runtime`) cannot drift their RPC wiring
 * again. The base feeds inbound POSTs to `respond`/`deliver` and dispatches via
 * the core's `handleEnvelope` (method calls flow through `rpc.exposeAll(...)`).
 */

import { createRpcClient } from "./client.js";
import {
  httpClientTransport,
  type ConnectionlessTransport,
  type HttpClientTransportConfig,
} from "./transports/httpClient.js";
import { envelopeFromMessage } from "./envelope.js";
import type {
  CallerKind,
  DeferrableRpcClient,
  DeferredCallAck,
  RpcEnvelope,
  RpcResponse,
} from "./types.js";
import type { AuthorityRequirement, PrincipalKind } from "./authority.js";

export interface ConnectionlessRpcConfig extends HttpClientTransportConfig {
  callerKind?: CallerKind | "unknown";
}

export interface ConnectionlessRpcClient {
  /** The unified client + `callDeferred`. Method calls dispatch via `exposeAll`. */
  client: DeferrableRpcClient;
  /**
   * Handle an inbound REQUEST envelope and return the response envelope (for the
   * DO `fetch` to return in the HTTP body). Returns null for non-request
   * messages (events/frames).
   */
  respond(envelope: RpcEnvelope): Promise<RpcEnvelope | null>;
  /** Feed an inbound envelope (event push, deferred reply) with no response. */
  deliver(envelope: RpcEnvelope): void;
}

function generateRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Per-class registry of `@rpc`-marked method names (own + inherited), keyed on the constructor. */
const RPC_EXPOSED_METHODS = Symbol.for("vibestudio.rpc.exposedMethods");
/** Per-class registry of direct method authority declarations. */
const RPC_METHOD_AUTHORITIES = Symbol.for("vibestudio.rpc.methodAuthorities");

type RpcExposedCtor = {
  [RPC_EXPOSED_METHODS]?: Set<string>;
  [RPC_METHOD_AUTHORITIES]?: Map<string, RpcAuthorityPolicy>;
};

/** Complete principal classes admitted to one direct RPC method. */
export type RpcAuthorityPolicy = (
  | { principals: ReadonlyArray<PrincipalKind>; requires?: never }
  | { requires: AuthorityRequirement; principals?: never }
) & {
  /** Direct-RPC effect classification. Unknown remains mutating by default. */
  sensitivity?: "read" | "write" | "admin" | "destructive";
};

type RpcMethodDecorator = <This, Args extends unknown[], Return>(
  value: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
) => void;

function registerRpc(target: object, name: string, authority?: RpcAuthorityPolicy): void {
  const ctor = (target as { constructor: RpcExposedCtor }).constructor;
  (ctor[RPC_EXPOSED_METHODS] ??= new Set<string>()).add(name);
  if (authority) {
    (ctor[RPC_METHOD_AUTHORITIES] ??= new Map<string, RpcAuthorityPolicy>()).set(name, authority);
  }
}

function applyRpc(context: ClassMethodDecoratorContext, authority?: RpcAuthorityPolicy): void {
  if (context.kind !== "method") {
    throw new Error(`@rpc may only decorate methods (got ${context.kind})`);
  }
  context.addInitializer(function (this: unknown) {
    registerRpc(this as object, String(context.name), authority);
  });
}

/**
 * `@rpc` — mark a DO method as reachable over RPC. Exposure is **opt-in / default-deny**: a method
 * with no `@rpc` is private to the DO and cannot be invoked over the (intentionally open) relay, so
 * forgetting it fails *loud* ("not exposed", caught by tests) rather than silently exposing a helper.
 *
 * Two forms:
 *   - `@rpc method() {}` — exposed with no direct authority and therefore not callable through the
 *     workspace relay.
 *   - `@rpc({ principals: ["user", "code"] }) method() {}` — exposed with a complete principal
 *     requirement. The workspace realm evaluates it against fresh host-attested facts and grants.
 *
 * Standard TC39 decorator (no `experimentalDecorators`, no reflect-metadata). It registers via
 * `addInitializer`, so inherited decorated methods land on the CONCRETE subclass's set (verified):
 * the base reads `rpcExposedMethodNames(this)` and exposes exactly those.
 */
export function rpc<This, Args extends unknown[], Return>(
  value: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>
): void;
export function rpc(authority: RpcAuthorityPolicy): RpcMethodDecorator;
export function rpc(arg0: unknown, arg1?: unknown): void | RpcMethodDecorator {
  // Bare usage: `@rpc method() {}` → (value, context).
  if (arg1 && typeof arg1 === "object" && "kind" in (arg1 as object)) {
    applyRpc(arg1 as ClassMethodDecoratorContext);
    return;
  }
  const authority = arg0 as RpcAuthorityPolicy;
  return (_value, context) => applyRpc(context as ClassMethodDecoratorContext, authority);
}

/** The set of `@rpc`-exposed method names for an instance's concrete class (own + inherited). */
export function rpcExposedMethodNames(instance: object): ReadonlySet<string> {
  const ctor = (instance as { constructor: RpcExposedCtor }).constructor;
  return ctor[RPC_EXPOSED_METHODS] ?? EMPTY_SET;
}

/** The authority declaration for `method`, or undefined for bare `@rpc`. */
export function rpcMethodAuthority(
  instance: object,
  method: string
): RpcAuthorityPolicy | undefined {
  const ctor = (instance as { constructor: RpcExposedCtor }).constructor;
  return ctor[RPC_METHOD_AUTHORITIES]?.get(method);
}
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Collect the callable methods of a class instance for `rpc.exposeAll(...)` — an **allow-list**: a
 * method is exposed only if its name is in `allowed` (the `@rpc`-marked set), it is a function on a
 * prototype below `frameworkBaseProto`. **Opt-in / default-deny**: a method is exposed only if its
 * name is in `allowed` (the `@rpc`-marked set), and it is not `__`-prefixed/`constructor`. Each
 * handler forwards `RpcRequestContext.args` positionally so an inbound envelope dispatched by the
 * core's `handleEnvelope` lands on the class method.
 *
 * SECURITY: anything not explicitly `@rpc` — every private/protected helper and all framework
 * plumbing (`dispatchInboundEnvelope`, state-KV, …) — is unreachable over the open relay, so a
 * forgotten `@rpc` fails loud ("not exposed") instead of silently exposing a helper. The
 * `frameworkBaseProto` boundary is a backstop against an erroneous allow-list entry naming a base
 * method.
 */
export function collectExposableMethods(
  instance: object,
  allowed: ReadonlySet<string>,
  frameworkBaseProto: object
): Record<string, (request: { args: unknown[] }) => unknown> {
  const methods: Record<string, (request: { args: unknown[] }) => unknown> = {};
  let proto: object | null = instance;
  while (proto && proto !== Object.prototype && proto !== frameworkBaseProto) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor" || name.startsWith("__")) continue;
      if (!allowed.has(name)) continue; // opt-in: only @rpc-marked methods are exposed
      if (name in methods) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      const fn = descriptor.value as (...args: unknown[]) => unknown;
      methods[name] = (request) => fn.apply(instance, request.args);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return methods;
}

function unwrapEnvelope(raw: unknown): RpcEnvelope | undefined {
  if (raw && typeof raw === "object" && "message" in raw) return raw as RpcEnvelope;
  return undefined;
}

export function createConnectionlessRpcClient(
  config: ConnectionlessRpcConfig
): ConnectionlessRpcClient {
  const transport: ConnectionlessTransport = httpClientTransport(config);
  const selfCaller = { callerId: config.selfId, callerKind: config.callerKind ?? "unknown" };
  const base = createRpcClient({
    selfId: config.selfId,
    transport,
    ...(config.callerKind ? { callerKind: config.callerKind } : {}),
  });

  async function callDeferred(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { requestId?: string; idempotencyKey?: string }
  ): Promise<DeferredCallAck> {
    // Caller-supplied requestId lets the DO persist its continuation BEFORE the
    // reply can arrive; otherwise generate one.
    const requestId = options?.requestId ?? generateRequestId();
    const envelope = envelopeFromMessage({
      selfId: config.selfId,
      from: config.selfId,
      target: targetId,
      caller: selfCaller,
      ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      message: {
        type: "request",
        requestId,
        fromId: config.selfId,
        method,
        args,
        // Explicit opt-in: only callDeferred callers may be completed out-of-band.
        deferrable: true,
      },
    });
    // Raw POST so we can read the `{deferred,requestId}` discriminator the core's
    // transparent `send()` path would swallow.
    const raw = (await transport.request(envelope)) as Record<string, unknown> | undefined;
    if (raw && raw["deferred"] === true) {
      return { status: "deferred", requestId: (raw["requestId"] as string) ?? requestId };
    }
    const responseEnvelope = unwrapEnvelope(raw);
    const responseMessage = responseEnvelope?.message as RpcResponse | undefined;
    if (responseMessage && responseMessage.type === "response" && "error" in responseMessage) {
      const err = new Error(responseMessage.error) as Error & { code?: string };
      if (responseMessage.errorCode) err.code = responseMessage.errorCode;
      throw err;
    }
    return {
      status: "completed",
      result: responseMessage && "result" in responseMessage ? responseMessage.result : undefined,
    };
  }

  const client: DeferrableRpcClient = Object.assign(base, { callDeferred });
  return {
    client,
    respond: (envelope) => transport.respond(envelope),
    deliver: (envelope) => transport.deliver(envelope),
  };
}
