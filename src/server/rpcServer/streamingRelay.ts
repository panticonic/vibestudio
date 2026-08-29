import {
  rpcErrorDataOf,
  rpcErrorKindOf,
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
import type { WsClientState } from "./connectionRegistry.js";
import type { AuthenticatedHttpRpcCaller, HttpRpcAdmission } from "./httpRpcHandler.js";

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

type StreamContextExtras = Omit<
  ServiceContext,
  "caller" | "connectionId" | "wsClient" | "chainCaller"
>;

export interface StreamingRelayDeps {
  dispatcher: ServiceDispatcher;
  egressProxy?: EgressStreamProxy;
  authenticateHttp(req: IncomingMessage): HttpRpcAdmission;
  verifiedCaller(
    caller: Omit<AuthenticatedHttpRpcCaller, "agentBinding"> & {
      agentBinding?: AuthenticatedHttpRpcCaller["agentBinding"] | RuntimeAgentBinding;
    },
    request: RpcStreamRequest,
    subject?: UserSubject
  ): VerifiedCaller;
  authorizeRelay(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method: string
  ): RelayAuthorization;
  createSessionContext(
    client: WsClientState,
    request: RpcStreamRequest,
    caller: VerifiedCaller,
    extras: StreamContextExtras
  ): ServiceContext;
  resolveCausalParent(
    caller: VerifiedCaller,
    request: Pick<RpcStreamRequest, "causalParent" | "parentRequestId">
  ): Promise<RpcCausalParent | undefined>;
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
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Owns streaming RPC admission, framing, proxy dispatch, and cancellation. */
export class StreamingRelay {
  private readonly sessionStreamAborts = new WeakMap<WsClientState, Map<string, AbortController>>();
  private readonly httpStreamAborts = new Set<AbortController>();

  constructor(private readonly deps: StreamingRelayDeps) {}

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
    for (const controller of this.httpStreamAborts) controller.abort(error);
  }

  private trackHttp(controller: AbortController): () => void {
    this.httpStreamAborts.add(controller);
    return () => this.httpStreamAborts.delete(controller);
  }

  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const admission = this.deps.authenticateHttp(req);
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

    let envelope: RpcEnvelope;
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString()) as RpcEnvelope;
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const request = envelope.message as RpcStreamRequest | undefined;
    const method = request?.method;
    if (!method) {
      writeJson(res, 400, { error: "Missing method" });
      return;
    }

    const { callerId, callerKind } = admission.caller;
    let verifiedCaller: VerifiedCaller;
    try {
      verifiedCaller = this.deps.verifiedCaller(admission.caller, request);
    } catch (error) {
      writeJson(res, 403, {
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
      });
      return;
    }
    let causalParent: RpcCausalParent | undefined;
    try {
      causalParent = await this.deps.resolveCausalParent(verifiedCaller, request);
    } catch (error) {
      writeJson(res, 403, {
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
      });
      return;
    }
    const targetId = envelope.target;
    if (targetId && targetId !== "main" && targetId !== "server") {
      const authorization = this.deps.authorizeRelay(callerId, callerKind, targetId, method);
      if (!authorization.ok) {
        writeJson(res, 403, { error: authorization.reason, errorCode: "EACCES" });
        return;
      }
      const abortController = new AbortController();
      const releaseAbort = this.trackHttp(abortController);
      req.on("aborted", () => abortController.abort());
      res.on("close", () => abortController.abort());
      try {
        const response = await this.deps.relayTargetStream(
          verifiedCaller,
          envelope,
          request,
          causalParent,
          abortController.signal
        );
        res.writeHead(200, STREAM_HEADERS);
        await this.pipeResponseToHttpFrames(response, res, abortController.signal);
      } catch (error) {
        if (!res.headersSent) res.writeHead(200, STREAM_HEADERS);
        const emitFrame = await this.httpFrameWriter(res);
        await emitFrame({
          kind: "error",
          status: 502,
          message: error instanceof Error ? error.message : String(error),
          errorKind: rpcErrorKindOf(error, "transport"),
          ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
        }).catch(() => {});
      } finally {
        releaseAbort();
        res.end();
      }
      return;
    }

    const args = request.args ?? [];
    const idempotencyKey = envelope.delivery?.idempotencyKey;
    const readOnly = envelope.delivery?.readOnly === true;
    if (method !== "credentials.proxyFetch") {
      await this.handleHttpServiceResponse(
        req,
        res,
        verifiedCaller,
        request,
        args,
        idempotencyKey,
        readOnly,
        causalParent
      );
      return;
    }

    const validation = this.validateProxyFetch({ method, args });
    if (!validation.ok) {
      writeJson(res, validation.status, { error: validation.error });
      return;
    }
    const abortController = new AbortController();
    const releaseAbort = this.trackHttp(abortController);
    req.on("aborted", () => abortController.abort());
    res.on("close", () => abortController.abort());
    const emitFrame = await this.httpFrameWriter(res);

    const context: ServiceContext = {
      caller: verifiedCaller,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(causalParent ? { causalParent } : {}),
      signal: abortController.signal,
      // Streaming is an alternate transport for the same semantic service
      // invocation. Unlike the unary RPC core it cannot return EACQUIRE and
      // replay an arbitrary response/request stream safely, so the host keeps
      // the invocation parked at the shared authority boundary until the
      // decision settles. This flag is server-owned; no wire field can enable
      // it for an unverified caller.
      authorityAcquisition: "wait",
    };
    try {
      await this.deps.dispatcher.assertAuthority(context, "credentials", "proxyFetch", args);
    } catch (error) {
      writeJson(res, 403, {
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
        ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
      });
      releaseAbort();
      return;
    }
    res.writeHead(200, STREAM_HEADERS);

    try {
      await validation.egress.forwardProxyFetchStream(
        { caller: context.caller, ...validation.proxyParams },
        emitFrame,
        abortController.signal
      );
    } catch (error) {
      try {
        await emitFrame({
          kind: "error",
          status: 502,
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
          errorKind: "transport",
        });
      } catch {
        // The connection may already be closed.
      }
    } finally {
      releaseAbort();
      res.end();
    }
  }

  async handleSessionRequest(
    client: WsClientState,
    request: RpcStreamRequest,
    envelope: RpcEnvelope
  ): Promise<void> {
    const emitFrame = this.sessionFrameWriter(client, request, envelope);
    const inboundBody = client.uploadBodies?.take(request.requestId);
    // The socket authenticates the resident runtime. Evaluated execution is a
    // narrower, per-run admission carried by the individual request, so resolve
    // the invocation caller for every stream just as the unary path does.
    let invocationCaller: VerifiedCaller;
    try {
      invocationCaller = this.deps.verifiedCaller(
        {
          callerId: client.caller.runtime.id,
          callerKind: client.caller.runtime.kind,
          ...(client.caller.agentBinding ? { agentBinding: client.caller.agentBinding } : {}),
        },
        request,
        client.caller.subject
      );
    } catch (error) {
      await emitFrame({
        kind: "error",
        status: 403,
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
        errorKind: "access",
      });
      return;
    }
    let causalParent: RpcCausalParent | undefined;
    try {
      causalParent = await this.deps.resolveCausalParent(invocationCaller, request);
    } catch (error) {
      await emitFrame({
        kind: "error",
        status: 403,
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
        errorKind: "access",
      });
      return;
    }
    const effectiveInboundBody = inboundBody ?? client.ws.takeInboundBody(request.requestId);
    const idempotencyKey = envelope.delivery.idempotencyKey;
    const readOnly = envelope.delivery.readOnly === true;
    const targetId = envelope.target;
    if (targetId && targetId !== "main" && targetId !== "server") {
      if (effectiveInboundBody) {
        await emitFrame({
          kind: "error",
          status: 400,
          message: "Streaming request bodies cannot be relayed to another RPC endpoint",
          errorKind: "protocol",
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
          message: authorization.reason,
          code: "EACCES",
          errorKind: "access",
        });
        return;
      }
      const abortController = this.register(client, request.requestId);
      try {
        const response = await this.deps.relayTargetStream(
          invocationCaller,
          envelope,
          request,
          causalParent,
          abortController.signal
        );
        await this.pipeResponseToWsFrames(response, emitFrame, abortController.signal);
      } catch (error) {
        try {
          await emitFrame({
            kind: "error",
            status: 502,
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
            errorKind: rpcErrorKindOf(error, "transport"),
            ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
          });
        } catch {
          // The client may already be gone.
        }
      } finally {
        this.unregister(client, request.requestId, abortController);
      }
      return;
    }
    const parsed = parseServiceMethod(request.method);

    if (parsed && request.method !== "credentials.proxyFetch") {
      const abortController = this.register(client, request.requestId);
      try {
        const context = this.deps.createSessionContext(client, request, invocationCaller, {
          ...(request.requestId ? { requestId: request.requestId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(readOnly ? { readOnly: true } : {}),
          ...(effectiveInboundBody ? { body: effectiveInboundBody } : {}),
          ...(causalParent ? { causalParent } : {}),
          authorityAcquisition: "wait",
        });
        const result = await this.deps.dispatcher.dispatch(
          context,
          parsed.service,
          parsed.method,
          request.args
        );
        if (!(result instanceof Response)) {
          await emitFrame({
            kind: "error",
            status: 500,
            message: `Streaming service ${request.method} did not return a Response`,
            errorKind: "internal",
          });
          return;
        }
        await this.pipeResponseToWsFrames(result, emitFrame, abortController.signal);
      } catch (error) {
        try {
          await emitFrame({
            kind: "error",
            status: 502,
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
            errorKind: rpcErrorKindOf(error, "internal"),
            ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
          });
        } catch {
          // The client may already be gone.
        }
      } finally {
        this.unregister(client, request.requestId, abortController);
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
        message: validation.error,
        errorKind: validation.status === 403 ? "access" : "protocol",
      });
      return;
    }
    if (effectiveInboundBody && validation.proxyParams.body !== undefined) {
      await emitFrame({
        kind: "error",
        status: 400,
        message:
          "proxyFetch request declared both a streamed body (bodyStreamId) and an args body — send exactly one",
        errorKind: "protocol",
      });
      return;
    }

    const context = this.deps.createSessionContext(client, request, invocationCaller, {
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(effectiveInboundBody ? { body: effectiveInboundBody } : {}),
      ...(causalParent ? { causalParent } : {}),
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
      await emitFrame({
        kind: "error",
        status: 403,
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
        errorKind: "access",
        ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
      });
      return;
    }

    const abortController = this.register(client, request.requestId);
    try {
      await validation.egress.forwardProxyFetchStream(
        {
          caller: context.caller,
          ...validation.proxyParams,
          ...(effectiveInboundBody ? { body: effectiveInboundBody } : {}),
        },
        emitFrame,
        abortController.signal
      );
    } catch (error) {
      try {
        await emitFrame({
          kind: "error",
          status: 502,
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
          errorKind: "transport",
        });
      } catch {
        // The client may already be gone.
      }
    } finally {
      this.unregister(client, request.requestId, abortController);
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
    req: IncomingMessage,
    res: ServerResponse,
    caller: VerifiedCaller,
    request: RpcStreamRequest,
    args: unknown[],
    idempotencyKey: string | undefined,
    readOnly: boolean,
    causalParent: RpcCausalParent | undefined
  ): Promise<void> {
    const parsed = parseServiceMethod(request.method);
    if (!parsed) {
      writeJson(res, 400, { error: `Invalid method format: "${request.method}"` });
      return;
    }
    const abortController = new AbortController();
    const releaseAbort = this.trackHttp(abortController);
    req.once("aborted", () => abortController.abort());
    res.once("close", () => abortController.abort());
    let response: Response;
    try {
      const context: ServiceContext = {
        caller,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...(causalParent ? { causalParent } : {}),
        signal: abortController.signal,
        authorityAcquisition: "wait",
      };
      const result = await this.deps.dispatcher.dispatch(
        context,
        parsed.service,
        parsed.method,
        args
      );
      if (!(result instanceof Response)) {
        writeJson(res, 500, {
          error: `Streaming service ${request.method} did not return a Response`,
        });
        releaseAbort();
        return;
      }
      response = result;
    } catch (error) {
      res.writeHead(200, STREAM_HEADERS);
      const codec = await import("@vibestudio/credential-client/streamFraming");
      await this.writeHttpBytes(
        res,
        codec.encodeErrorFrame({
          status: 502,
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
          errorKind: rpcErrorKindOf(error, "internal"),
          ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
        })
      ).catch(() => {});
      res.end();
      releaseAbort();
      return;
    }

    res.writeHead(200, STREAM_HEADERS);
    try {
      await this.pipeResponseToHttpFrames(response, res, abortController.signal);
    } finally {
      releaseAbort();
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
    return controller;
  }

  private unregister(client: WsClientState, requestId: string, controller: AbortController): void {
    const streams = this.sessionStreamAborts.get(client);
    if (streams?.get(requestId) !== controller) return;
    streams.delete(requestId);
    if (streams.size === 0) this.sessionStreamAborts.delete(client);
  }

  private async httpFrameWriter(
    res: ServerResponse
  ): Promise<(frame: StreamFrame) => Promise<void>> {
    const codec = await import("@vibestudio/credential-client/streamFraming");
    return async (frame): Promise<void> => {
      if (frame.kind === "head") {
        await this.writeHttpBytes(
          res,
          codec.encodeHeadFrame({
            status: frame.status,
            statusText: frame.statusText,
            headerPairs: frame.headerPairs,
            finalUrl: frame.finalUrl,
          })
        );
      } else if (frame.kind === "chunk") {
        await this.writeHttpBytes(res, codec.encodeDataFrame(frame.bytes));
      } else if (frame.kind === "end") {
        await this.writeHttpBytes(res, codec.encodeEndFrame({ bytesIn: frame.bytesIn }));
      } else {
        await this.writeHttpBytes(
          res,
          codec.encodeErrorFrame({
            status: frame.status,
            message: frame.message,
            code: frame.code,
            errorKind: frame.errorKind,
            ...(frame.errorData !== undefined ? { errorData: frame.errorData } : {}),
          })
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
      return client.ws.sendStreamFrame(envelope, frame);
    };
  }

  private writeHttpBytes(res: ServerResponse, bytes: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        res.off("drain", succeed);
        res.off("close", closed);
        res.off("error", fail);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const closed = (): void => {
        fail(
          Object.assign(new Error("HTTP response closed during stream write"), {
            code: "ECONNRESET",
          })
        );
      };
      res.once("close", closed);
      res.once("error", fail);
      try {
        if (res.write(bytes)) succeed();
        else res.once("drain", succeed);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async pipeResponseToHttpFrames(
    response: Response,
    res: ServerResponse,
    signal?: AbortSignal
  ): Promise<void> {
    const emitFrame = await this.httpFrameWriter(res);
    await emitFrame({
      kind: "head",
      status: response.status,
      statusText: response.statusText,
      headerPairs: Array.from(response.headers.entries()),
      finalUrl: response.url,
    });
    let bytesIn = 0;
    if (response.body) {
      const reader = response.body.getReader();
      const cancel = (): void => {
        void reader.cancel(signal?.reason).catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytesIn += next.value.byteLength;
          await emitFrame({ kind: "chunk", bytes: next.value });
        }
      } catch (error) {
        if (signal?.aborted) return;
        await emitFrame({
          kind: "error",
          status: 502,
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
          errorKind: rpcErrorKindOf(error, "transport"),
          ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
        });
        return;
      } finally {
        signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    }
    if (signal?.aborted) return;
    await emitFrame({ kind: "end", bytesIn });
  }

  private async pipeResponseToWsFrames(
    response: Response,
    emitFrame: (frame: StreamFrame) => Promise<void> | void,
    signal: AbortSignal
  ): Promise<void> {
    const assertOpen = (): void => {
      if (signal.aborted) throw new Error("Streaming RPC cancelled by client");
    };
    assertOpen();
    await emitFrame({
      kind: "head",
      status: response.status,
      statusText: response.statusText,
      headerPairs: Array.from(response.headers.entries()),
      finalUrl: response.url,
    });
    let bytesIn = 0;
    if (response.body) {
      const reader = response.body.getReader();
      const onAbort = (): void => void reader.cancel().catch(() => {});
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          assertOpen();
          const next = await reader.read();
          if (next.done) break;
          bytesIn += next.value.byteLength;
          await emitFrame({ kind: "chunk", bytes: next.value });
        }
        assertOpen();
      } finally {
        signal.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
    }
    await emitFrame({ kind: "end", bytesIn });
  }
}
