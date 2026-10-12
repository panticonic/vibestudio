import { serializeRpcFailure } from "@vibestudio/rpc";
import { writeHttpBytes } from "../httpStreamWrite.js";
import * as codec from "@vibestudio/rpc/protocol/streamCodec";
import {
  BRIDGE_STREAM_CHUNK_BYTES,
  decodeRpcJson,
  stampEnvelopeCaller,
  type RpcCausalParent,
  type RpcEnvelope,
  type RpcStreamRequest,
} from "@vibestudio/rpc";
import {
  parseServiceMethod,
  type CallerKind,
  type ServiceContext,
  type ServiceDispatcher,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import type { UserSubject } from "@vibestudio/identity/types";
import type { RuntimeAgentBinding } from "@vibestudio/shared/runtime/entitySpec";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StreamFrame } from "../services/egressProxy.js";
import { encodeWebSocketStreamFrame } from "./sessionChannel.js";
import type { WsClientState } from "./connectionRegistry.js";
import type { AuthenticatedHttpRpcCaller, HttpRpcAdmission } from "./httpRpcHandler.js";

import { isLocalWorkspaceTarget, WORKSPACE_RPC_NOT_ADMITTED } from "./workspaceTarget.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const STREAM_HEADERS = {
  "Content-Type": "application/vnd.vibestudio.credentialed-fetch+binary",
  "Cache-Control": "no-store",
  "X-Accel-Buffering": "no",
};
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

type EgressStreamProxy = Pick<
  import("../services/egressProxy.js").EgressProxy,
  "forwardProxyFetchStream"
>;

type RelayAuthorization = { ok: true } | { ok: false; reason: string };

async function emitBoundedBodyFrames(
  bytes: Uint8Array,
  emitFrame: (frame: StreamFrame) => Promise<void> | void
): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength; offset += BRIDGE_STREAM_CHUNK_BYTES) {
    await emitFrame({
      kind: "chunk",
      bytes: bytes.subarray(offset, Math.min(offset + BRIDGE_STREAM_CHUNK_BYTES, bytes.byteLength)),
    });
  }
}

type StreamContextExtras = Omit<
  ServiceContext,
  "caller" | "connectionId" | "wsClient" | "chainCaller"
>;

export interface StreamingRelayDeps {
  workspaceId?: string;
  dispatcher: ServiceDispatcher;
  egressProxy?: EgressStreamProxy;
  authenticateHttp(req: IncomingMessage): HttpRpcAdmission | Promise<HttpRpcAdmission>;
  verifiedCaller(
    caller: Omit<AuthenticatedHttpRpcCaller, "agentBinding"> & {
      agentBinding?: AuthenticatedHttpRpcCaller["agentBinding"] | RuntimeAgentBinding;
    },
    request: RpcStreamRequest,
    subject?: UserSubject
  ): VerifiedCaller | Promise<VerifiedCaller>;
  authorizeRelay(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method: string
  ): RelayAuthorization;
  createHttpContext(
    caller: VerifiedCaller,
    request: RpcStreamRequest,
    extras: StreamContextExtras
  ): ServiceContext;
  createSessionContext(
    client: WsClientState,
    request: RpcStreamRequest,
    caller: VerifiedCaller,
    extras: StreamContextExtras
  ): ServiceContext;
  resolveCausalInvocation(
    caller: VerifiedCaller,
    request: Pick<RpcStreamRequest, "causalParent" | "parentRequestId">
  ): Promise<{ caller: VerifiedCaller; parent: RpcCausalParent | undefined }>;
  relayTargetStream(
    caller: VerifiedCaller,
    envelope: RpcEnvelope,
    request: RpcStreamRequest,
    causalParent: RpcCausalParent | undefined,
    signal: AbortSignal
  ): Promise<Response>;
}

type ProxyFetchParams = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  credentialId?: string;
};

type ProxyFetchValidation =
  | { ok: true; egress: EgressStreamProxy; proxyParams: ProxyFetchParams }
  | { ok: false; status: number; error: string };

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Owns streaming RPC admission, framing, proxy dispatch, and cancellation. */
export class StreamingRelay {
  private readonly sessionStreamAborts = new WeakMap<WsClientState, Map<string, AbortController>>();
  private readonly sessionRequestAborts = new Set<AbortController>();
  private readonly httpStreamAborts = new Set<AbortController>();
  private readonly activeHttpRequests = new Set<Promise<void>>();
  private readonly activeSessionRequests = new Set<Promise<void>>();
  private readonly retirementFailures: unknown[] = [];
  private httpAdmissionClosed: Error | null = null;

  constructor(private readonly deps: StreamingRelayDeps) {}

  async forwardWorkspaceResponse(
    response: Response,
    requestEnvelope: RpcEnvelope,
    responder: import("@vibestudio/rpc").AuthenticatedCaller,
    send: (envelope: RpcEnvelope) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    await this.pipeResponseToWsFrames(
      response,
      (frame) => {
        const encoded = encodeWebSocketStreamFrame(requestEnvelope, frame, responder);
        return send(encoded.envelope);
      },
      signal
    );
  }

  cancel(client: WsClientState, requestId: string): void {
    this.sessionStreamAborts.get(client)?.get(requestId)?.abort();
  }

  abortConnection(client: WsClientState): void {
    const streams = this.sessionStreamAborts.get(client);
    if (!streams) return;
    this.sessionStreamAborts.delete(client);
    for (const controller of streams.values()) {
      controller.abort();
    }
  }

  /** Abort streaming work that is not tied to an RPC WebSocket. */
  stop(reason = "RPC server shutting down"): void {
    const error = new Error(reason);
    this.httpAdmissionClosed ??= error;
    for (const controller of this.httpStreamAborts) controller.abort(error);
    for (const controller of this.sessionRequestAborts) controller.abort(error);
  }

  /** Join every HTTP stream request admitted before stop closed the owner. */
  async drain(): Promise<void> {
    await Promise.all([...this.activeHttpRequests, ...this.activeSessionRequests]);
    const failures = this.retirementFailures.splice(0);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Streaming HTTP request drain failed", {
        cause: failures[0],
      });
    }
  }

  private trackHttp(controller: AbortController): () => void {
    this.httpStreamAborts.add(controller);
    return () => this.httpStreamAborts.delete(controller);
  }

  private trackOwnedRequest(tasks: Set<Promise<void>>, operation: Promise<void>): void {
    let owned!: Promise<void>;
    owned = operation
      .then(
        () => undefined,
        (error: unknown) => {
          if (this.httpAdmissionClosed) this.retirementFailures.push(error);
        }
      )
      .finally(() => tasks.delete(owned));
    tasks.add(owned);
  }

  handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.httpAdmissionClosed) {
      writeJson(res, 503, { error: this.httpAdmissionClosed.message });
      return Promise.resolve();
    }
    const operation = this.handleOwnedHttpRequest(req, res);
    this.trackOwnedRequest(this.activeHttpRequests, operation);
    return operation;
  }

  private async handleOwnedHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const abortController = new AbortController();
    const releaseAbort = this.trackHttp(abortController);
    const abortForRequest = () => abortController.abort(new Error("HTTP request aborted"));
    const abortForResponse = () => abortController.abort(new Error("HTTP response closed"));
    const destroyIncompleteRequest = () => {
      if (!req.complete && !req.destroyed) {
        req.destroy(
          abortController.signal.reason instanceof Error ? abortController.signal.reason : undefined
        );
      }
    };
    req.once("aborted", abortForRequest);
    res.once("close", abortForResponse);
    abortController.signal.addEventListener("abort", destroyIncompleteRequest, { once: true });
    try {
      await this.handleHttpRequestOwned(req, res, abortController.signal);
    } catch (error) {
      if (!abortController.signal.aborted || error !== abortController.signal.reason) throw error;
    } finally {
      req.off("aborted", abortForRequest);
      res.off("close", abortForResponse);
      abortController.signal.removeEventListener("abort", destroyIncompleteRequest);
      releaseAbort();
    }
  }

  private async handleHttpRequestOwned(
    req: IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal
  ): Promise<void> {
    const isLive = () => !signal.aborted && !res.destroyed && !res.writableEnded;
    const admission = await this.deps.authenticateHttp(req);
    if (!isLive()) return;
    if (!admission.ok) {
      writeJson(res, admission.status, admission.body);
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const bytes = chunk as Buffer;
      total += bytes.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        writeJson(res, 413, { error: "Request body too large for streaming proxy fetch" });
        return;
      }
      chunks.push(bytes);
    }
    if (!isLive()) return;

    let envelope: RpcEnvelope;
    try {
      envelope = decodeRpcJson(Buffer.concat(chunks).toString()) as RpcEnvelope;
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    let request = envelope?.message as RpcStreamRequest | undefined;
    const method = request?.method;
    if (request?.type !== "stream-request" || !method) {
      writeJson(res, 400, { error: "Missing method" });
      return;
    }

    if (!isLocalWorkspaceTarget(envelope, this.deps.workspaceId)) {
      writeJson(res, 403, {
        error: serializeRpcFailure(
          Object.assign(new Error(WORKSPACE_RPC_NOT_ADMITTED), { code: "EACCES" })
        ),
      });
      return;
    }
    envelope = stampEnvelopeCaller(envelope, {
      callerId: admission.caller.callerId,
      callerKind: admission.caller.callerKind,
      ...(this.deps.workspaceId ? { workspaceId: this.deps.workspaceId } : {}),
    });
    request = envelope.message as RpcStreamRequest;

    const { callerId, callerKind } = admission.caller;
    let verifiedCaller: VerifiedCaller;
    try {
      verifiedCaller = await this.deps.verifiedCaller(admission.caller, request);
    } catch (error) {
      if (!isLive()) throw error;
      writeJson(res, 403, {
        error: serializeRpcFailure(error),
      });
      return;
    }
    if (!isLive()) return;
    let causalParent: RpcCausalParent | undefined;
    try {
      const causal = await this.deps.resolveCausalInvocation(verifiedCaller, request);
      verifiedCaller = causal.caller;
      causalParent = causal.parent;
    } catch (error) {
      if (!isLive()) throw error;
      writeJson(res, 403, {
        error: serializeRpcFailure(error),
      });
      return;
    }
    if (!isLive()) return;
    const targetId = envelope.target;
    if (targetId && targetId !== "main" && targetId !== "server") {
      const authorization = this.deps.authorizeRelay(callerId, callerKind, targetId, method);
      if (!authorization.ok) {
        writeJson(res, 403, {
          error: serializeRpcFailure(
            Object.assign(new Error(authorization.reason), { code: "EACCES" })
          ),
        });
        return;
      }
      try {
        const response = await this.deps.relayTargetStream(
          verifiedCaller,
          envelope,
          request,
          causalParent,
          signal
        );
        if (!isLive()) {
          await this.cancelOwnedResponse(response, signal.reason);
          return;
        }
        res.writeHead(200, STREAM_HEADERS);
        await this.pipeResponseToHttpFrames(response, res, signal);
      } catch (error) {
        if (!isLive()) {
          if (signal.aborted && error === signal.reason) return;
          throw error;
        }
        if (!res.headersSent) res.writeHead(200, STREAM_HEADERS);
        const emitFrame = await this.httpFrameWriter(res);
        await emitFrame({
          kind: "error",
          status: 502,
          error: serializeRpcFailure(error, "transport"),
        }).catch(() => {});
      } finally {
        if (!res.destroyed && !res.writableEnded) res.end();
      }
      return;
    }

    const args = request.args ?? [];
    const idempotencyKey = envelope.delivery?.idempotencyKey;
    const readOnly = envelope.delivery?.readOnly === true;
    if (method !== "credentials.proxyFetch") {
      await this.handleHttpServiceResponse(
        res,
        verifiedCaller,
        request,
        args,
        idempotencyKey,
        readOnly,
        causalParent,
        signal
      );
      return;
    }

    const validation = this.validateProxyFetch({ method, args });
    if (!validation.ok) {
      writeJson(res, validation.status, { error: validation.error });
      return;
    }
    const emitFrame = await this.httpFrameWriter(res);
    if (!isLive()) return;

    const context = this.deps.createHttpContext(verifiedCaller, request, {
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(causalParent ? { causalParent } : {}),
      signal,
      // Streaming is an alternate transport for the same semantic service
      // invocation. Unlike the unary RPC core it cannot return EACQUIRE and
      // replay an arbitrary response/request stream safely, so the host keeps
      // the invocation parked at the shared authority boundary until the
      // decision settles. This flag is server-owned; no wire field can enable
      // it for an unverified caller.
      authorityAcquisition: "wait",
    });
    try {
      await this.deps.dispatcher.assertAuthority(context, "credentials", "proxyFetch", args);
    } catch (error) {
      if (!isLive()) throw error;
      writeJson(res, 403, {
        error: serializeRpcFailure(error),
      });
      return;
    }
    if (!isLive()) return;
    res.writeHead(200, STREAM_HEADERS);

    try {
      await validation.egress.forwardProxyFetchStream(
        { caller: context.caller, ...validation.proxyParams },
        emitFrame,
        signal
      );
    } catch (error) {
      try {
        await emitFrame({
          kind: "error",
          status: 502,
          error: serializeRpcFailure(error, "transport"),
        });
      } catch {
        // The connection may already be closed.
      }
    } finally {
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }

  async handleSessionRequest(
    client: WsClientState,
    request: RpcStreamRequest,
    envelope: RpcEnvelope
  ): Promise<void> {
    if (this.httpAdmissionClosed) return;
    const abortController = this.register(client, request.requestId);
    const operation = (async () => {
      try {
        await this.handleSessionRequestOwned(client, request, envelope, abortController.signal);
      } finally {
        this.unregister(client, request.requestId, abortController);
      }
    })();
    this.trackOwnedRequest(this.activeSessionRequests, operation);
    return operation;
  }

  private async handleSessionRequestOwned(
    client: WsClientState,
    request: RpcStreamRequest,
    envelope: RpcEnvelope,
    signal: AbortSignal
  ): Promise<void> {
    const isLive = () => !signal.aborted && client.ws.readyState === client.ws.OPEN;
    const emitFrame = this.sessionFrameWriter(client, request, envelope);
    const inboundBody = client.uploadBodies?.take(request.requestId);
    // The socket authenticates the resident runtime. Evaluated execution is a
    // narrower, per-run admission carried by the individual request, so resolve
    // the invocation caller for every stream just as the unary path does.
    let invocationCaller: VerifiedCaller;
    try {
      invocationCaller = await this.deps.verifiedCaller(
        {
          callerId: client.caller.runtime.id,
          callerKind: client.caller.runtime.kind,
          ...(client.caller.agentBinding ? { agentBinding: client.caller.agentBinding } : {}),
        },
        request,
        client.caller.subject
      );
    } catch (error) {
      if (!isLive()) throw error;
      await emitFrame({ kind: "error", status: 403, error: serializeRpcFailure(error, "access") });
      return;
    }
    if (!isLive()) return;
    let causalParent: RpcCausalParent | undefined;
    try {
      const causal = await this.deps.resolveCausalInvocation(invocationCaller, request);
      invocationCaller = causal.caller;
      causalParent = causal.parent;
    } catch (error) {
      if (!isLive()) throw error;
      await emitFrame({ kind: "error", status: 403, error: serializeRpcFailure(error, "access") });
      return;
    }
    if (!isLive()) return;
    const effectiveInboundBody = inboundBody ?? client.ws.takeInboundBody(request.requestId);
    const idempotencyKey = envelope.delivery.idempotencyKey;
    const readOnly = envelope.delivery.readOnly === true;
    const targetId = envelope.target;
    if (targetId && targetId !== "main" && targetId !== "server") {
      if (effectiveInboundBody) {
        await emitFrame({
          kind: "error",
          status: 400,
          error: {
            message: "Streaming request bodies cannot be relayed to another RPC endpoint",
            errorKind: "protocol",
          },
        });
        return;
      }
      const authorization = this.deps.authorizeRelay(
        client.caller.runtime.id,
        client.caller.runtime.kind,
        targetId,
        request.method
      );
      if (!authorization.ok) {
        await emitFrame({
          kind: "error",
          status: 403,
          error: { message: authorization.reason, code: "EACCES", errorKind: "access" },
        });
        return;
      }
      try {
        const response = await this.deps.relayTargetStream(
          invocationCaller,
          envelope,
          request,
          causalParent,
          signal
        );
        if (!isLive()) {
          await this.cancelOwnedResponse(response, signal.reason);
          return;
        }
        await this.pipeResponseToWsFrames(response, emitFrame, signal);
      } catch (error) {
        if (!isLive()) {
          if (signal.aborted && error === signal.reason) return;
          throw error;
        }
        try {
          await emitFrame({
            kind: "error",
            status: 502,
            error: serializeRpcFailure(error, "transport"),
          });
        } catch {
          // The client may already be gone.
        }
      }
      return;
    }
    const parsed = parseServiceMethod(request.method);

    if (parsed && request.method !== "credentials.proxyFetch") {
      try {
        const context = this.deps.createSessionContext(client, request, invocationCaller, {
          ...(request.requestId ? { requestId: request.requestId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(readOnly ? { readOnly: true } : {}),
          ...(effectiveInboundBody ? { body: effectiveInboundBody } : {}),
          ...(causalParent ? { causalParent } : {}),
          signal,
          authorityAcquisition: "wait",
        });
        const result = await this.deps.dispatcher.dispatch(
          context,
          parsed.service,
          parsed.method,
          request.args
        );
        if (!isLive()) {
          if (result instanceof Response) await this.cancelOwnedResponse(result, signal.reason);
          return;
        }
        if (!(result instanceof Response)) {
          await emitFrame({
            kind: "error",
            status: 500,
            error: {
              message: `Streaming service ${request.method} did not return a Response`,
              errorKind: "internal",
            },
          });
          return;
        }
        await this.pipeResponseToWsFrames(result, emitFrame, signal, (error) =>
          this.deps.dispatcher.observeFailure(context, parsed.service, parsed.method, error)
        );
      } catch (error) {
        if (!isLive()) {
          if (signal.aborted && error === signal.reason) return;
          throw error;
        }
        try {
          await emitFrame({
            kind: "error",
            status: 502,
            error: serializeRpcFailure(error, "internal"),
          });
        } catch {
          // The client may already be gone.
        }
      }
      return;
    }

    const validation = this.validateProxyFetch({
      method: request.method,
      args: request.args,
    });
    if (!validation.ok) {
      await emitFrame({
        kind: "error",
        status: validation.status,
        error: {
          message: validation.error,
          errorKind: validation.status === 403 ? "access" : "protocol",
        },
      });
      return;
    }
    if (effectiveInboundBody && validation.proxyParams.body !== undefined) {
      await emitFrame({
        kind: "error",
        status: 400,
        error: {
          message:
            "proxyFetch request declared both a streamed body (bodyStreamId) and an args body — send exactly one",
          errorKind: "protocol",
        },
      });
      return;
    }

    const context = this.deps.createSessionContext(client, request, invocationCaller, {
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(effectiveInboundBody ? { body: effectiveInboundBody } : {}),
      ...(causalParent ? { causalParent } : {}),
      signal,
      authorityAcquisition: "wait",
    });
    try {
      await this.deps.dispatcher.assertAuthority(
        context,
        "credentials",
        "proxyFetch",
        request.args
      );
    } catch (error) {
      if (!isLive()) {
        if (signal.aborted && error === signal.reason) return;
        throw error;
      }
      await emitFrame({ kind: "error", status: 403, error: serializeRpcFailure(error, "access") });
      return;
    }
    if (!isLive()) return;

    try {
      await validation.egress.forwardProxyFetchStream(
        {
          caller: context.caller,
          ...validation.proxyParams,
          ...(effectiveInboundBody ? { body: effectiveInboundBody } : {}),
        },
        emitFrame,
        signal
      );
    } catch (error) {
      if (!isLive()) {
        if (signal.aborted && error === signal.reason) return;
        throw error;
      }
      try {
        await emitFrame({
          kind: "error",
          status: 502,
          error: serializeRpcFailure(error, "transport"),
        });
      } catch {
        // The client may already be gone.
      }
    }
  }

  private validateProxyFetch(request: { method: string; args: unknown[] }): ProxyFetchValidation {
    if (request.method !== "credentials.proxyFetch") {
      return {
        ok: false,
        status: 400,
        error: `Method '${request.method}' is not exposed on the streaming endpoint. Only 'credentials.proxyFetch' is allowed.`,
      };
    }
    if (!this.deps.egressProxy) {
      return { ok: false, status: 503, error: "Streaming proxy fetch is unavailable" };
    }
    const params = (request.args[0] ?? {}) as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      bodyBase64?: string;
      credentialId?: string;
    };
    if (!params.url || !params.method) {
      return { ok: false, status: 400, error: "Missing required params: url and method" };
    }
    return {
      ok: true,
      egress: this.deps.egressProxy,
      proxyParams: {
        url: params.url,
        method: params.method,
        headers: params.headers,
        body:
          params.bodyBase64 !== undefined
            ? new Uint8Array(Buffer.from(params.bodyBase64, "base64"))
            : params.body,
        credentialId: params.credentialId,
      },
    };
  }

  private async handleHttpServiceResponse(
    res: ServerResponse,
    caller: VerifiedCaller,
    request: RpcStreamRequest,
    args: unknown[],
    idempotencyKey: string | undefined,
    readOnly: boolean,
    causalParent: RpcCausalParent | undefined,
    signal: AbortSignal
  ): Promise<void> {
    const parsed = parseServiceMethod(request.method);
    if (!parsed) {
      writeJson(res, 400, { error: `Invalid method format: "${request.method}"` });
      return;
    }
    let response: Response;
    let context: ServiceContext;
    try {
      context = this.deps.createHttpContext(caller, request, {
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...(causalParent ? { causalParent } : {}),
        signal,
        authorityAcquisition: "wait",
      });
      const result = await this.deps.dispatcher.dispatch(
        context,
        parsed.service,
        parsed.method,
        args
      );
      if (signal.aborted || res.destroyed || res.writableEnded) {
        if (result instanceof Response) await this.cancelOwnedResponse(result, signal.reason);
        return;
      }
      if (!(result instanceof Response)) {
        writeJson(res, 500, {
          error: `Streaming service ${request.method} did not return a Response`,
        });
        return;
      }
      response = result;
    } catch (error) {
      if (signal.aborted || res.destroyed || res.writableEnded) return;
      res.writeHead(200, STREAM_HEADERS);
      await writeHttpBytes(
        res,
        codec.encodeErrorFrame({ status: 502, error: serializeRpcFailure(error, "internal") })
      ).catch(() => {});
      res.end();
      return;
    }

    res.writeHead(200, STREAM_HEADERS);
    try {
      await this.pipeResponseToHttpFrames(response, res, signal, (error) =>
        this.deps.dispatcher.observeFailure(context, parsed.service, parsed.method, error)
      );
    } finally {
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }

  private register(client: WsClientState, requestId: string): AbortController {
    let streams = this.sessionStreamAborts.get(client);
    if (!streams) {
      streams = new Map();
      this.sessionStreamAborts.set(client, streams);
    }
    streams.get(requestId)?.abort();
    const controller = new AbortController();
    streams.set(requestId, controller);
    this.sessionRequestAborts.add(controller);
    return controller;
  }

  private unregister(client: WsClientState, requestId: string, controller: AbortController): void {
    const streams = this.sessionStreamAborts.get(client);
    this.sessionRequestAborts.delete(controller);
    if (streams?.get(requestId) !== controller) return;
    streams.delete(requestId);
    if (streams.size === 0) this.sessionStreamAborts.delete(client);
  }

  private async cancelOwnedResponse(response: Response, reason: unknown): Promise<void> {
    try {
      await response.body?.cancel(reason);
    } catch (error) {
      const failures = reason === undefined || reason === error ? [error] : [reason, error];
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "Streaming response cancellation failed", {
        cause: failures[0],
      });
    }
  }

  private async httpFrameWriter(
    res: ServerResponse
  ): Promise<(frame: StreamFrame) => Promise<void>> {
    return async (frame): Promise<void> => {
      if (frame.kind === "head") {
        await writeHttpBytes(
          res,
          codec.encodeHeadFrame({
            status: frame.status,
            statusText: frame.statusText,
            headerPairs: frame.headerPairs,
            finalUrl: frame.finalUrl,
          })
        );
      } else if (frame.kind === "chunk") {
        await writeHttpBytes(res, codec.encodeDataFrame(frame.bytes));
      } else if (frame.kind === "end") {
        await writeHttpBytes(res, codec.encodeEndFrame({ bytesIn: frame.bytesIn }));
      } else {
        await writeHttpBytes(
          res,
          codec.encodeErrorFrame({ status: frame.status, error: frame.error })
        );
      }
    };
  }

  private sessionFrameWriter(
    client: WsClientState,
    request: RpcStreamRequest,
    envelope: RpcEnvelope
  ): (frame: StreamFrame) => Promise<void> | void {
    return (frame): Promise<void> | void => {
      if (frame.kind === "end" || frame.kind === "error") {
        client.uploadBodies?.fail(
          request.requestId,
          new Error("Streaming RPC response completed before its request body settled")
        );
      }
      return client.ws.sendStreamFrame(envelope, frame, {
        callerId: "main",
        callerKind: "server",
        workspaceId: this.deps.workspaceId,
      });
    };
  }

  private async consumeResponseBody(
    response: Response,
    emitFrame: (frame: StreamFrame) => Promise<void> | void,
    signal?: AbortSignal,
    onFailure?: (error: unknown) => unknown
  ): Promise<number> {
    const reader = response.body?.getReader();
    let cancellation: Promise<void> | undefined;
    const failures: unknown[] = [];
    const retainFailure = (error: unknown): void => {
      if (!failures.includes(error)) failures.push(error);
    };
    const cancel = (): void => {
      if (signal?.aborted) retainFailure(signal.reason);
      cancellation ??= (reader?.cancel(signal?.reason) ?? Promise.resolve()).catch(retainFailure);
    };
    let bytesIn = 0;
    let finished = !reader;
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      await emitFrame({
        kind: "head",
        status: response.status,
        statusText: response.statusText,
        headerPairs: Array.from(response.headers.entries()),
        finalUrl: response.url,
      });
      while (reader) {
        signal?.throwIfAborted();
        const next = await reader.read();
        signal?.throwIfAborted();
        if (next.done) {
          finished = true;
          break;
        }
        bytesIn += next.value.byteLength;
        await emitBoundedBodyFrames(next.value, emitFrame);
      }
    } catch (error) {
      retainFailure(error);
      if (!signal?.aborted) {
        try {
          onFailure?.(error);
        } catch (observerError) {
          retainFailure(observerError);
        }
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (!finished) cancel();
      await cancellation;
      reader?.releaseLock();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Streaming response read and cancellation failed", {
        cause: failures[0],
      });
    }
    return bytesIn;
  }

  private async pipeResponseToHttpFrames(
    response: Response,
    res: ServerResponse,
    signal?: AbortSignal,
    onFailure?: (error: unknown) => unknown
  ): Promise<void> {
    const emitFrame = await this.httpFrameWriter(res);
    let bytesIn: number;
    try {
      bytesIn = await this.consumeResponseBody(response, emitFrame, signal, onFailure);
    } catch (error) {
      if (signal?.aborted) throw error;
      try {
        await emitFrame({
          kind: "error",
          status: 502,
          error: serializeRpcFailure(error, "transport"),
        });
      } catch (deliveryError) {
        if (deliveryError === error) throw error;
        throw new AggregateError([error, deliveryError], "Streaming failure delivery failed", {
          cause: error,
        });
      }
      return;
    }
    signal?.throwIfAborted();
    await emitFrame({ kind: "end", bytesIn });
  }

  private async pipeResponseToWsFrames(
    response: Response,
    emitFrame: (frame: StreamFrame) => Promise<void> | void,
    signal: AbortSignal,
    onFailure?: (error: unknown) => unknown
  ): Promise<void> {
    const bytesIn = await this.consumeResponseBody(response, emitFrame, signal, onFailure);
    signal.throwIfAborted();
    await emitFrame({ kind: "end", bytesIn });
  }
}
