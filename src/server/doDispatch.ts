/**
 * DODispatch -- source-scoped HTTP dispatch to Durable Objects.
 *
 * Replaces WorkerRouter with a simpler model:
 * - DORef identifies a DO by source + className + objectKey
 * - dispatch() makes HTTP POST to /_w/{source}/{className}/{objectKey}/{method}
 * - No participant maps, no harness maps, no action types
 *
 * The `/_w/` URL scheme uses 2-segment source paths (e.g., "workers/agent-worker"),
 * so the generated workerd router can parse deterministically:
 *   segments[0]+segments[1] = source
 *   segment[2] = className
 *   segment[3] = objectKey
 *   rest = method path
 */

import { constantTimeStringEqual, type TokenManager } from "@vibestudio/shared/tokenManager";
import { RemoteRpcError, type AgentExecutionTestPolicy, type RpcErrorKind } from "@vibestudio/rpc";
import type { DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import type {
  AlarmDoDispatcher,
  DoAlarmDispatchResult,
  DORef,
  HeldDoDispatcher,
  LifecycleDoDispatcher,
  LifecyclePrepareInput,
  LifecyclePrepareResult,
  LifecycleResumeInput,
} from "@vibestudio/shared/doDispatcher";
import { assertPresent } from "../lintHelpers";
import { isInternalDOSource } from "./internalDOs/internalDoLoader.js";
import { describeWorkerdFetchFailure, getWorkerdConnectionDispatcher } from "./workerdRpcRelay.js";

/** Canonical string key for a DORef, used for maps and logging. */
export function doRefKey(ref: DORef): string {
  return `${ref.source}:${ref.className}/${ref.objectKey}`;
}

/**
 * Pack a userland DO ref into a single object key for the UniversalDO facet
 * host: `source|className|userKey`, each segment `encodeURIComponent`-escaped
 * (which escapes `|`), so the split back is unambiguous. Mirrored by the
 * generated `universal-do` host's `decodeKey`.
 */
export function encodeUniversalKey(ref: DORef): string {
  return [ref.source, ref.className, ref.objectKey].map(encodeURIComponent).join("|");
}

/**
 * Build the workerd dispatch URL for a DO method call.
 *  - Internal DOs (WorkspaceDO, …) keep static per-class namespaces: `/_w/…`.
 *  - Userland DOs route through the UniversalDO facet host: `/_u/{packedKey}/…`.
 */
export function doRefUrl(ref: DORef, method: string): string {
  const methodPath = method.split("/").map(encodeURIComponent).join("/");
  if (!isInternalDOSource(ref.source)) {
    return `/_u/${encodeURIComponent(encodeUniversalKey(ref))}/${methodPath}`;
  }
  const sourcePath = ref.source.split("/").map(encodeURIComponent).join("/");
  return `/_w/${sourcePath}/${encodeURIComponent(ref.className)}/${encodeURIComponent(ref.objectKey)}/${methodPath}`;
}

// ---------------------------------------------------------------------------
// postToDOWithToken — standalone dispatch with per-instance identity token
// ---------------------------------------------------------------------------

export interface PostToDOWithTokenDeps {
  tokenManager: TokenManager;
  workerdUrl: string;
  workerdGatewayToken: string;
  /**
   * Per-process dispatch secret stamped onto internal `/_w/` dispatches as
   * the `X-Vibestudio-Dispatch-Secret` header. The auto-generated workerd router
   * validates this header when present, while allowing public DO routes that
   * cannot know the process-private secret.
   *
   * Optional because public route paths and some tests do not need it.
   */
  dispatchSecret?: string;
}

export interface DOCallerEnvelope {
  callerId: string;
  callerKind: "server" | "worker" | "panel" | "do" | "shell" | "unknown";
  callerPanelId?: string;
  /**
   * Owning user (WP4 §2.4), populated from the `AuthenticatedCaller.userId` so a
   * Channel-DO / workspace-DO handler reads `env.caller.userId` for attribution
   * (WP6/WP7 message authorship, WP5 GAD actor). ATTRIBUTION ONLY — the DO never
   * re-validates it as a capability (authority gates on the instance token /
   * code identity, WP0 §6). Absent for server-originated and bootstrap dispatches.
   */
  userId?: string;
  /** Fresh host mediation bound to this exact method and DO object. */
  authorization?: DirectAuthorityAttestation;
}

/**
 * Dispatch an RPC method call to a Durable Object via HTTP POST,
 * attaching a per-instance identity token (X-Instance-Token) and
 * optional parent ID (X-Parent-Id) header.
 *
 * The instance ID used for token minting is "do:{source}:{className}:{objectKey}".
 */
export async function postToDOWithToken(
  ref: DORef,
  method: string,
  args: unknown[],
  deps: PostToDOWithTokenDeps,
  callerId?: string,
  caller?: DOCallerEnvelope,
  signal?: AbortSignal
): Promise<unknown> {
  // 1. Build the instance ID for this DO: "do:{source}:{className}:{objectKey}"
  const instanceId = `do:${ref.source}:${ref.className}:${ref.objectKey}`;

  // 2. Mint/retrieve a per-instance token
  const token = deps.tokenManager.ensureToken(instanceId, "worker");

  // 3. Build URL: workerdUrl + doRefUrl(ref, method)
  const url = `${deps.workerdUrl}${doRefUrl(ref, method)}`;

  // 4. POST with identity in the body envelope (not headers, which workerd may strip
  // on internal subrequests from the router to DO stubs).
  const envelope = {
    args,
    __instanceToken: token,
    __instanceId: instanceId,
    __parentId: callerId ?? undefined,
    __caller: caller ?? undefined,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${deps.workerdGatewayToken}`,
  };
  if (deps.dispatchSecret) {
    headers["X-Vibestudio-Dispatch-Secret"] = deps.dispatchSecret;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
      signal,
      // The method's owner defines its semantic lifetime. In particular,
      // `__alarm` may legitimately await an agent model effect, so Undici's
      // response-header/body defaults must never become a hidden deadline.
      dispatcher: getWorkerdConnectionDispatcher(),
    } as RequestInit);
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("DO dispatch aborted");
    }
    const wrapped = new Error(
      `DO dispatch fetch to ${url} failed: ${describeWorkerdFetchFailure(error)}`
    ) as Error & { cause?: unknown };
    wrapped.cause = error;
    throw wrapped;
  }

  if (!res.ok) {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as {
        error?: unknown;
        errorKind?: unknown;
        errorCode?: unknown;
        errorData?: unknown;
      };
      if (typeof parsed.error === "string") {
        const kind: RpcErrorKind =
          parsed.errorKind === "access" ||
          parsed.errorKind === "service" ||
          parsed.errorKind === "transport" ||
          parsed.errorKind === "protocol" ||
          parsed.errorKind === "application" ||
          parsed.errorKind === "internal"
            ? parsed.errorKind
            : "application";
        throw new RemoteRpcError(
          parsed.error,
          kind,
          typeof parsed.errorCode === "string" ? parsed.errorCode : undefined,
          parsed.errorData
        );
      }
    } catch (error) {
      if (error instanceof RemoteRpcError) throw error;
    }
    throw new Error(`DO dispatch failed (${res.status}): ${body}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// verifyInstanceTokenEnvelope — server-side guard for inbound DO requests
// ---------------------------------------------------------------------------

export interface InstanceTokenEnvelope {
  args?: unknown;
  __instanceToken?: unknown;
  __instanceId?: unknown;
  __parentId?: unknown;
  __caller?: unknown;
}

export interface VerifyInstanceTokenResult {
  ok: boolean;
  reason?: string;
  /** When ok, the resolved parentId (caller) attribution. */
  parentId?: string | undefined;
}

/**
 * Verify the `__instanceToken` envelope attached by `postToDOWithToken`.
 *
 * The envelope is attached because workerd's HTTP router strips arbitrary
 * headers on internal subrequests, so we cannot use a plain bearer header.
 * The legitimate path is:
 *
 *   gateway-process: ensureToken(instanceId, "worker") → token T
 *   gateway-process: POST /_w/.../method body={ args, __instanceToken: T,
 *                                               __instanceId, __parentId }
 *   workerd-process: must verify T against the same TokenManager.
 *
 * Today there is no workerd-side verifier (audit finding #29). This helper
 * is a server-side guard that callers MUST invoke before dispatching the
 * envelope into a DO method handler:
 *
 *   - Validates `__instanceToken` is present and matches the token issued
 *     to `__instanceId` in the in-process TokenManager.
 *   - Returns the verified `__parentId` so the DO handler can use it as
 *     the caller attribution (overwriting any value provided in `args`).
 *
 * Wave-2 status (audit 4.8): the receiver inside workerd is the
 * build-compiled router worker (see `src/server/workerdPrograms/router.ts`).
 * The generated router requires `X-Vibestudio-Dispatch-Secret` for every
 * `/_w/` DO dispatch. `DODispatch` supplies it for server-originated calls,
 * and the gateway supplies it only after route-registry auth/rewrites for
 * public DO routes. The TokenManager-based envelope check below is the
 * server-side guard intended for any *in-process* code path that wants
 * to validate the envelope (e.g., test harnesses, future direct-dispatch
 * shims), but workerd itself never calls it — the runtime is bundled JS
 * with no link to the host TokenManager. The router-level shared-secret
 * check is the production-grade enforcement.
 */
export function verifyInstanceTokenEnvelope(
  envelope: InstanceTokenEnvelope,
  tokenManager: TokenManager
): VerifyInstanceTokenResult {
  const { __instanceToken, __instanceId, __parentId } = envelope;
  if (typeof __instanceToken !== "string" || __instanceToken.length === 0) {
    return { ok: false, reason: "missing __instanceToken" };
  }
  if (typeof __instanceId !== "string" || __instanceId.length === 0) {
    return { ok: false, reason: "missing __instanceId" };
  }
  const entry = tokenManager.validateToken(__instanceToken);
  if (!entry) {
    return { ok: false, reason: "unknown __instanceToken" };
  }
  // Constant-time compare of the verified token's callerId against the
  // claimed __instanceId — callerId is server-controlled (it comes from
  // tokenManager) and __instanceId is attacker-controllable, so the
  // comparison itself does not expose a secret, but we use constant-time
  // for consistency with other token compares.
  if (!constantTimeStringEqual(entry.callerId, __instanceId)) {
    return { ok: false, reason: "instanceId/token mismatch" };
  }
  const parentId = typeof __parentId === "string" && __parentId.length > 0 ? __parentId : undefined;
  return { ok: true, parentId };
}

// ---------------------------------------------------------------------------
// DODispatch — generic HTTP POST dispatch to DOs
// ---------------------------------------------------------------------------

export class DODispatch implements AlarmDoDispatcher, HeldDoDispatcher, LifecycleDoDispatcher {
  private tokenManager: TokenManager | null = null;
  private getWorkerdUrl: (() => string) | null = null;
  private getDispatchSecret: (() => string) | null = null;
  private getWorkerdGatewayToken: (() => string) | null = null;
  private authorityAttester:
    | ((
        ref: DORef,
        method: string,
        args: readonly unknown[]
      ) => DirectAuthorityAttestation | Promise<DirectAuthorityAttestation>)
    | null = null;
  private authorityParentRunner:
    | (<T>(
        receiverRuntimeId: string,
        authorization: DirectAuthorityAttestation,
        invoke: () => Promise<T>
      ) => Promise<T>)
    | null = null;

  /**
   * Set the TokenManager for per-instance identity tokens.
   * When set (along with workerdUrl), dispatch() will use postToDOWithToken
   * to attach X-Instance-Token and X-Parent-Id headers.
   */
  setTokenManager(tm: TokenManager): void {
    this.tokenManager = tm;
  }

  /**
   * Set a function that returns the current base workerd URL
   * (e.g. "http://127.0.0.1:8787"). Called on each dispatch so the
   * port can be resolved dynamically.
   */
  setGetWorkerdUrl(fn: () => string): void {
    this.getWorkerdUrl = fn;
  }

  /**
   * Set a function that returns the current per-process dispatch secret
   * (`WorkerdManager.getDispatchSecret()`). Stamped onto every `/_w/`
   * request as `X-Vibestudio-Dispatch-Secret` and verified by the
   * auto-generated workerd router worker. Closes audit finding 4.8.
   *
   * Called on each dispatch so a workerd restart that rotates the secret
   * is picked up without re-wiring.
   */
  setGetDispatchSecret(fn: () => string): void {
    this.getDispatchSecret = fn;
  }

  setGetWorkerdGatewayToken(fn: () => string): void {
    this.getWorkerdGatewayToken = fn;
  }

  setAuthorityAttester(
    fn: (
      ref: DORef,
      method: string,
      args: readonly unknown[]
    ) => DirectAuthorityAttestation | Promise<DirectAuthorityAttestation>
  ): void {
    this.authorityAttester = fn;
  }

  setAuthorityParentRunner(
    fn: <T>(
      receiverRuntimeId: string,
      authorization: DirectAuthorityAttestation,
      invoke: () => Promise<T>
    ) => Promise<T>
  ): void {
    this.authorityParentRunner = fn;
  }

  private async serverCaller(
    ref: DORef,
    method: string,
    args: readonly unknown[],
    testPolicy?: AgentExecutionTestPolicy
  ): Promise<DOCallerEnvelope> {
    if (!this.authorityAttester) {
      throw new Error("DODispatch requires a host authority attester");
    }
    const authorization = await this.authorityAttester(ref, method, args);
    return {
      callerId: "main",
      callerKind: "server",
      authorization: testPolicy
        ? {
            ...authorization,
            context: { ...authorization.context, testPolicy },
          }
        : authorization,
    };
  }

  /**
   * Dispatch a method call to a DO via HTTP POST.
   * Returns the parsed JSON response (type depends on the DO method).
   *
   * A dispatch is attempted exactly once. Lifecycle owners prepare the DO
   * before invoking it; this transport must not replay a semantic call or
   * recreate infrastructure after its entity has retired.
   */
  async dispatch(ref: DORef, method: string, ...args: unknown[]): Promise<unknown> {
    return this.withProgressReport(`${doRefKey(ref)}.${method}`, () =>
      this.dispatchImpl(ref, method, args)
    );
  }

  /**
   * Like `dispatch`, but labels a deliberately long-running handler (the
   * EvalDO's `executeRun`) so slow-call reporting is informational and coarse.
   * All process-local DO dispatches leave semantic lifetime to their owner;
   * this method expresses observability intent, not a separate transport path.
   */
  async dispatchHeld(ref: DORef, method: string, ...args: unknown[]): Promise<unknown> {
    // A held call is INTENTIONALLY long (the eval runs for its whole duration),
    // so report coarse liveness at info level. Warning/error streams are
    // reserved for calls whose duration is actually anomalous.
    return this.withProgressReport(
      `${doRefKey(ref)}.${method} (held)`,
      () => this.dispatchImpl(ref, method, args),
      300_000,
      "working",
      console.info
    );
  }

  /**
   * Slow-call watchdog: a DO call that never returns (loader stall, deadlock,
   * dead workerd socket) otherwise hangs its caller with zero output. Warns
   * every `intervalMs` (default 10s) while the call is pending so the offender is named in the log.
   */
  private async withProgressReport<T>(
    label: string,
    fn: () => Promise<T>,
    intervalMs = 10_000,
    state: "working" | "slow" = "slow",
    report: (message: string) => void = console.warn
  ): Promise<T> {
    const startedAt = Date.now();
    let reported = false;
    const timer = setInterval(() => {
      reported = true;
      report(
        `[DODispatch] state=${state} ${label} has been active for ${Math.round((Date.now() - startedAt) / 1000)}s`
      );
    }, intervalMs);
    timer.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      if (reported && state === "working") {
        report(
          `[DODispatch] state=completed ${label} finished after ${Math.round((Date.now() - startedAt) / 1000)}s`
        );
      }
    }
  }

  private async dispatchImpl(ref: DORef, method: string, args: unknown[]): Promise<unknown> {
    if (!this.tokenManager || !this.getWorkerdUrl || !this.getWorkerdGatewayToken) {
      throw new Error("DODispatch requires token-backed workerd configuration");
    }

    // `DODispatch.dispatch` is the SERVER's internal service→DO channel (eval.run,
    // workspace methods, …), so the caller is always the server — stamp it so the
    // DO's converged envelope dispatch surfaces `callerKind: "server"` (e.g. the
    // EvalDO server-only gate). Mirrors dispatchLifecycle/dispatchAlarm.
    const buildDeps = (): PostToDOWithTokenDeps => ({
      tokenManager: assertPresent(this.tokenManager),
      workerdUrl: assertPresent(this.getWorkerdUrl)(),
      workerdGatewayToken: assertPresent(this.getWorkerdGatewayToken)(),
      dispatchSecret: this.getDispatchSecret ? this.getDispatchSecret() : undefined,
    });
    const serverCaller = await this.serverCaller(ref, method, args);
    return await postToDOWithToken(ref, method, args, buildDeps(), "main", serverCaller);
  }

  async dispatchLifecycle(
    ref: DORef,
    method: "prepare",
    arg: LifecyclePrepareInput
  ): Promise<LifecyclePrepareResult>;
  async dispatchLifecycle(ref: DORef, method: "resume", arg: LifecycleResumeInput): Promise<void>;
  async dispatchLifecycle(
    ref: DORef,
    method: "prepare" | "resume",
    arg: unknown
  ): Promise<unknown> {
    return this.withProgressReport(`${doRefKey(ref)}.__lifecycle/${method}`, () =>
      this.dispatchLifecycleImpl(ref, method, arg)
    );
  }

  private async dispatchLifecycleImpl(
    ref: DORef,
    method: "prepare" | "resume",
    arg: unknown
  ): Promise<unknown> {
    const lifecycleMethod = `__lifecycle/${method}`;
    if (!this.tokenManager || !this.getWorkerdUrl || !this.getWorkerdGatewayToken) {
      throw new Error("DODispatch requires token-backed workerd configuration");
    }
    const buildDeps = (): PostToDOWithTokenDeps => ({
      tokenManager: assertPresent(this.tokenManager),
      workerdUrl: assertPresent(this.getWorkerdUrl)(),
      workerdGatewayToken: assertPresent(this.getWorkerdGatewayToken)(),
      dispatchSecret: this.getDispatchSecret ? this.getDispatchSecret() : undefined,
    });
    const serverCaller = await this.serverCaller(ref, lifecycleMethod, [arg]);
    return await postToDOWithToken(ref, lifecycleMethod, [arg], buildDeps(), "main", serverCaller);
  }

  /**
   * Fire a server-driven `__alarm` on a DO. Mirrors `dispatchLifecycle`'s
   * server-caller envelope so the DO can gate `__alarm` to the server.
   */
  async dispatchAlarm(
    ref: DORef,
    signal?: AbortSignal,
    testPolicy?: AgentExecutionTestPolicy
  ): Promise<DoAlarmDispatchResult> {
    // Agent alarms own a complete model/tool turn and routinely wait longer
    // than a transport request. Report that as healthy work, not as a warning.
    return this.withProgressReport(
      `${doRefKey(ref)}.__alarm`,
      () => this.dispatchAlarmImpl(ref, signal, testPolicy),
      30_000,
      "working",
      console.info
    );
  }

  private async dispatchAlarmImpl(
    ref: DORef,
    signal?: AbortSignal,
    testPolicy?: AgentExecutionTestPolicy
  ): Promise<DoAlarmDispatchResult> {
    if (!this.tokenManager || !this.getWorkerdUrl || !this.getWorkerdGatewayToken) {
      throw new Error("DODispatch requires token-backed workerd configuration");
    }
    const buildDeps = (): PostToDOWithTokenDeps => ({
      tokenManager: assertPresent(this.tokenManager),
      workerdUrl: assertPresent(this.getWorkerdUrl)(),
      workerdGatewayToken: assertPresent(this.getWorkerdGatewayToken)(),
      dispatchSecret: this.getDispatchSecret ? this.getDispatchSecret() : undefined,
    });
    const serverCaller = await this.serverCaller(ref, "__alarm", [], testPolicy);
    const invoke = () =>
      postToDOWithToken(
        ref,
        "__alarm",
        [],
        buildDeps(),
        "main",
        serverCaller,
        signal
      ) as Promise<DoAlarmDispatchResult>;
    if (!testPolicy) return await invoke();
    if (!serverCaller.authorization || !this.authorityParentRunner) {
      throw new Error("DODispatch requires an authority parent runner for test-scoped alarms");
    }
    return await this.authorityParentRunner(
      `do:${ref.source}:${ref.className}:${ref.objectKey}`,
      serverCaller.authorization,
      invoke
    );
  }
}
