import {
  rpcErrorKindOf,
  responseEnvelopeFor,
  type RpcEnvelope,
  type RpcStreamRequest,
} from "@vibestudio/rpc";
import type { StreamFrameType } from "@vibestudio/rpc/protocol/bulkMux";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
} from "@vibestudio/rpc/protocol/streamCodec";
import {
  parseServiceMethod,
  type CallerKind,
  type ServiceContext,
  type ServiceDispatcher,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WsServerMessage } from "@vibestudio/shared/ws/protocol";
import type { StreamFrame } from "../services/egressProxy.js";
import type { WsClientState } from "./connectionRegistry.js";
import type { AuthenticatedHttpRpcCaller, HttpRpcAdmission } from "./httpRpcHandler.js";

const SERVER_RESPONDER = { callerId: "main", callerKind: "server" as const };
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
  verifiedCaller(caller: AuthenticatedHttpRpcCaller): VerifiedCaller;
  authorizeRelay(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method: string
  ): RelayAuthorization;
  createHttpContext(
    caller: AuthenticatedHttpRpcCaller,
    extras: Omit<ServiceContext, "caller">
  ): ServiceContext;
  createWsContext(
    client: WsClientState,
    request: RpcStreamRequest,
    extras: StreamContextExtras
  ): ServiceContext;
  sendWs(client: WsClientState, message: WsServerMessage): void;
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

function streamKey(callerId: string, connectionId: string, requestId: string): string {
  return `${callerId}\x00${connectionId}\x00${requestId}`;
}

/** Owns streaming RPC admission, framing, proxy dispatch, and cancellation. */
export class StreamingRelay {
  private readonly wsStreamAborts = new Map<string, AbortController>();

  constructor(private readonly deps: StreamingRelayDeps) {}

  cancel(client: WsClientState, requestId: string): void {
    this.wsStreamAborts
      .get(streamKey(client.caller.runtime.id, client.connectionId, requestId))
      ?.abort();
  }

  abortConnection(callerId: string, connectionId: string): void {
    const keyPrefix = streamKey(callerId, connectionId, "");
    for (const [key, controller] of this.wsStreamAborts) {
      if (!key.startsWith(keyPrefix)) continue;
      controller.abort();
      this.wsStreamAborts.delete(key);
    }
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
    const targetId = envelope.target;
    if (targetId && targetId !== "main") {
      const authorization = this.deps.authorizeRelay(callerId, callerKind, targetId, method);
      if (!authorization.ok) {
        writeJson(res, 403, { error: authorization.reason, errorCode: "EACCES" });
        return;
      }
      writeJson(res, 400, { error: "HTTP RPC streaming currently supports targetId 'main' only" });
      return;
    }

    const args = request.args ?? [];
    const idempotencyKey = envelope.delivery?.idempotencyKey;
    const readOnly = envelope.delivery?.readOnly === true;
    if (method !== "credentials.proxyFetch") {
      await this.handleHttpServiceResponse(
        res,
        admission.caller,
        request,
        args,
        idempotencyKey,
        readOnly
      );
      return;
    }

    const proxyContext = this.deps.createHttpContext(admission.caller, {
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    });
    const validation = await this.validateProxyFetch({ method, args, context: proxyContext });
    if (!validation.ok) {
      writeJson(res, validation.status, { error: validation.error });
      return;
    }

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());
    res.on("close", () => abortController.abort());
    const emitFrame = await this.httpFrameWriter(res);
    res.writeHead(200, STREAM_HEADERS);

    try {
      await validation.egress.forwardProxyFetchStream(
        { caller: this.deps.verifiedCaller(admission.caller), ...validation.proxyParams },
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
      res.end();
    }
  }

  async handleWsRequest(
    client: WsClientState,
    request: RpcStreamRequest,
    envelope: RpcEnvelope
  ): Promise<void> {
    const emitFrame = this.wsFrameWriter(client, request, envelope);
    const shim = client.ws as unknown as {
      takeInboundBody?: (requestId: string) => ReadableStream<Uint8Array> | undefined;
    };
    const inboundBody = shim.takeInboundBody?.(request.requestId);
    const idempotencyKey = envelope.delivery.idempotencyKey;
    const readOnly = envelope.delivery.readOnly === true;
    const parsed = parseServiceMethod(request.method);

    if (parsed && request.method !== "credentials.proxyFetch") {
      const abortController = this.register(client, request.requestId);
      try {
        const context = this.deps.createWsContext(client, request, {
          ...(request.requestId ? { requestId: request.requestId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(readOnly ? { readOnly: true } : {}),
          ...(inboundBody ? { body: inboundBody } : {}),
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
          });
        } catch {
          // The client may already be gone.
        }
      } finally {
        this.unregister(client, request.requestId);
      }
      return;
    }

    const proxyContext = this.deps.createWsContext(client, request, {
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    });
    const validation = await this.validateProxyFetch({
      method: request.method,
      args: request.args,
      context: proxyContext,
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
    if (inboundBody && validation.proxyParams.body !== undefined) {
      await emitFrame({
        kind: "error",
        status: 400,
        message:
          "proxyFetch request declared both a streamed body (bodyStreamId) and an args body — send exactly one",
        errorKind: "protocol",
      });
      return;
    }

    const abortController = this.register(client, request.requestId);
    try {
      await validation.egress.forwardProxyFetchStream(
        {
          caller: client.caller,
          ...validation.proxyParams,
          ...(inboundBody ? { body: inboundBody } : {}),
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
      this.unregister(client, request.requestId);
    }
  }

  private async validateProxyFetch(request: {
    method: string;
    args: unknown[];
    context: ServiceContext;
  }): Promise<ProxyFetchValidation> {
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
    try {
      await this.deps.dispatcher.assertAuthority(
        request.context,
        "credentials",
        "proxyFetch",
        request.args
      );
    } catch (error) {
      return {
        ok: false,
        status: 403,
        error: error instanceof Error ? error.message : String(error),
      };
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
    caller: AuthenticatedHttpRpcCaller,
    request: RpcStreamRequest,
    args: unknown[],
    idempotencyKey: string | undefined,
    readOnly: boolean
  ): Promise<void> {
    const parsed = parseServiceMethod(request.method);
    if (!parsed) {
      writeJson(res, 400, { error: `Invalid method format: "${request.method}"` });
      return;
    }
    let response: Response;
    try {
      const context = this.deps.createHttpContext(caller, {
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      });
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
        })
      ).catch(() => {});
      res.end();
      return;
    }

    res.writeHead(200, STREAM_HEADERS);
    try {
      await this.pipeResponseToHttpFrames(response, res);
    } finally {
      res.end();
    }
  }

  private register(client: WsClientState, requestId: string): AbortController {
    const controller = new AbortController();
    this.wsStreamAborts.set(
      streamKey(client.caller.runtime.id, client.connectionId, requestId),
      controller
    );
    return controller;
  }

  private unregister(client: WsClientState, requestId: string): void {
    this.wsStreamAborts.delete(streamKey(client.caller.runtime.id, client.connectionId, requestId));
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
          })
        );
      }
    };
  }

  private wsFrameWriter(
    client: WsClientState,
    request: RpcStreamRequest,
    envelope: RpcEnvelope
  ): (frame: StreamFrame) => Promise<void> | void {
    const sendTextFrame = (frameType: number, payload: string): void => {
      this.deps.sendWs(client, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "stream-frame",
          requestId: request.requestId,
          fromId: "main",
          frameType,
          payload,
        }),
      });
    };
    const shim = client.ws as unknown as {
      sendStreamFrame?: (
        requestId: string,
        frameType: StreamFrameType,
        payload: Uint8Array
      ) => Promise<void> | false;
    };
    const sendBinaryFrame = shim.sendStreamFrame?.bind(shim);
    const utf8Json = (value: unknown): Uint8Array =>
      new TextEncoder().encode(JSON.stringify(value));

    return (frame): Promise<void> | void => {
      if (sendBinaryFrame) {
        let result: Promise<void> | false;
        if (frame.kind === "head") {
          result = sendBinaryFrame(
            request.requestId,
            FRAME_HEAD,
            utf8Json({
              status: frame.status,
              statusText: frame.statusText,
              headerPairs: frame.headerPairs,
              finalUrl: frame.finalUrl,
            })
          );
        } else if (frame.kind === "chunk") {
          result = sendBinaryFrame(request.requestId, FRAME_DATA, frame.bytes);
        } else if (frame.kind === "end") {
          result = sendBinaryFrame(
            request.requestId,
            FRAME_END,
            utf8Json({ bytesIn: frame.bytesIn })
          );
        } else {
          result = sendBinaryFrame(
            request.requestId,
            FRAME_ERROR,
            utf8Json({
              status: frame.status,
              message: frame.message,
              code: frame.code,
              errorKind: frame.errorKind,
            })
          );
        }
        return result === false ? undefined : result;
      }

      if (frame.kind === "head") {
        sendTextFrame(
          FRAME_HEAD,
          JSON.stringify({
            status: frame.status,
            statusText: frame.statusText,
            headerPairs: frame.headerPairs,
            finalUrl: frame.finalUrl,
          })
        );
      } else if (frame.kind === "chunk") {
        sendTextFrame(FRAME_DATA, Buffer.from(frame.bytes).toString("base64"));
      } else if (frame.kind === "end") {
        sendTextFrame(FRAME_END, JSON.stringify({ bytesIn: frame.bytesIn }));
      } else {
        sendTextFrame(
          FRAME_ERROR,
          JSON.stringify({
            status: frame.status,
            message: frame.message,
            code: frame.code,
            errorKind: frame.errorKind,
          })
        );
      }
    };
  }

  private writeHttpBytes(res: ServerResponse, bytes: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const writable = res.write(bytes, (error) => {
        if (error) reject(error);
      });
      if (writable) resolve();
      else res.once("drain", resolve);
    });
  }

  private async pipeResponseToHttpFrames(response: Response, res: ServerResponse): Promise<void> {
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
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytesIn += next.value.byteLength;
          await emitFrame({ kind: "chunk", bytes: next.value });
        }
      } catch (error) {
        await emitFrame({
          kind: "error",
          status: 502,
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
          errorKind: rpcErrorKindOf(error, "transport"),
        });
        return;
      } finally {
        reader.releaseLock();
      }
    }
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
