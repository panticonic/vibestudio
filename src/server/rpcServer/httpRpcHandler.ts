import {
  rpcErrorDataOf,
  rpcErrorKindOf,
  responseEnvelopeFor,
  type RpcEnvelope,
  type RpcEvent,
  type RpcRequest,
  type RpcRequestCancel,
} from "@vibestudio/rpc";
import type { AgentBinding } from "@vibestudio/identity/types";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_RPC_MAX_BODY_BYTES = 256 * 1024 * 1024;
const SERVER_RESPONDER = { callerId: "main", callerKind: "server" as const };
const JSON_HEADERS = { "Content-Type": "application/json" };

export interface AuthenticatedHttpRpcCaller {
  callerId: string;
  callerKind: CallerKind;
  agentBinding?: AgentBinding;
}

export type HttpRpcAdmission =
  | { ok: true; caller: AuthenticatedHttpRpcCaller }
  | { ok: false; status: number; body: Record<string, unknown> };

export interface HttpRpcHandlerDeps {
  maxBodyBytes: number;
  authenticate(req: IncomingMessage): HttpRpcAdmission;
  handleStreamingRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleRequest(
    caller: AuthenticatedHttpRpcCaller,
    envelope: RpcEnvelope,
    message: RpcRequest,
    signal: AbortSignal
  ): Promise<unknown>;
  handleEvent(
    caller: AuthenticatedHttpRpcCaller,
    envelope: RpcEnvelope,
    message: RpcEvent
  ): Promise<void>;
}

export function resolveRpcMaxBodyBytes(raw: string | undefined): number {
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return DEFAULT_RPC_MAX_BODY_BYTES;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** HTTP transport adapter for the server's canonical RPC dispatch callbacks. */
export class HttpRpcHandler {
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly activeBodies = new Set<IncomingMessage>();
  private readonly activeResponses = new Set<ServerResponse>();

  constructor(private readonly deps: HttpRpcHandlerDeps) {}

  private requestKey(caller: AuthenticatedHttpRpcCaller, requestId: string): string {
    return `${caller.callerKind}:${caller.callerId}\u0000${requestId}`;
  }

  private cancelRequest(caller: AuthenticatedHttpRpcCaller, message: RpcRequestCancel): boolean {
    const key = this.requestKey(caller, message.requestId);
    const active = this.activeRequests.get(key);
    if (!active) return false;
    active.abort(new Error("RPC call aborted by caller"));
    return true;
  }

  /** Abort every HTTP RPC owned by this transport generation. */
  stop(reason = "RPC server shutting down"): void {
    const error = new Error(reason);
    for (const request of this.activeRequests.values()) request.abort(error);
    for (const req of this.activeBodies) req.destroy(error);
    for (const res of this.activeResponses) res.destroy(error);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.activeBodies.add(req);
    this.activeResponses.add(res);
    const releaseTransport = (): void => {
      this.activeBodies.delete(req);
      this.activeResponses.delete(res);
    };
    req.once("close", releaseTransport);
    res.once("close", releaseTransport);
    if (req.method === "POST" && req.url === "/rpc/stream") {
      try {
        await this.deps.handleStreamingRequest(req, res);
      } finally {
        releaseTransport();
      }
      return;
    }
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404);
      res.end();
      releaseTransport();
      return;
    }

    // Admission is deliberately header-only and must precede request-body
    // consumption. An invalid caller never receives a body-sized allocation.
    const admission = this.deps.authenticate(req);
    if (!admission.ok) {
      writeJson(res, admission.status, admission.body);
      req.resume();
      releaseTransport();
      return;
    }

    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    for await (const chunk of req) {
      const bytes = chunk as Buffer;
      bodyBytes += bytes.length;
      if (this.deps.maxBodyBytes > 0 && bodyBytes > this.deps.maxBodyBytes) {
        writeJson(res, 413, {
          error:
            `RPC body exceeds ${this.deps.maxBodyBytes} bytes ` +
            "(use streaming RPC/bulk transfer for large payloads, or raise " +
            "VIBESTUDIO_RPC_MAX_BODY_BYTES)",
        });
        req.destroy();
        releaseTransport();
        return;
      }
      chunks.push(bytes);
    }

    let envelope: RpcEnvelope;
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString()) as RpcEnvelope;
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      releaseTransport();
      return;
    }

    // Envelope caller fields are self-reported. Only `admission.caller`,
    // derived at the host boundary, reaches the dispatch callbacks.
    const message = envelope.message;
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      writeJson(res, 400, { error: "Expected an RpcEnvelope body with a message" });
      releaseTransport();
      return;
    }

    if (message.type === "event") {
      try {
        await this.deps.handleEvent(admission.caller, envelope, message);
        writeJson(res, 200, {});
      } catch (error) {
        writeJson(res, 200, { error: error instanceof Error ? error.message : String(error) });
      }
      releaseTransport();
      return;
    }

    if (message.type === "request-cancel") {
      if (this.cancelRequest(admission.caller, message)) {
        writeJson(res, 200, {});
      } else {
        // HTTP request cancellation normally rides the original fetch's
        // AbortSignal. A standalone cancel has no ordering relation to a
        // request on another connection, so never retain speculative state or
        // silently evict another cancellation: report that no active target
        // exists.
        writeJson(res, 409, { error: "RPC request is not active" });
      }
      releaseTransport();
      return;
    }

    if (message.type !== "request") {
      writeJson(res, 400, { error: `Unsupported /rpc message type: ${message.type}` });
      releaseTransport();
      return;
    }

    const requestKey = this.requestKey(admission.caller, message.requestId);
    const abort = new AbortController();
    const abortDisconnectedTransport = (): void => {
      if (!abort.signal.aborted) {
        abort.abort(new Error("HTTP RPC caller disconnected"));
      }
    };
    req.once("aborted", abortDisconnectedTransport);
    res.once("close", abortDisconnectedTransport);
    this.activeRequests.set(requestKey, abort);
    if (req.aborted) abortDisconnectedTransport();
    try {
      const result = await this.deps.handleRequest(
        admission.caller,
        envelope,
        message,
        abort.signal
      );
      writeJson(
        res,
        200,
        responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: message.requestId,
          // `undefined` is the in-process result of a void RPC, but JSON drops
          // object properties whose value is undefined. The wire contract
          // requires every successful response to carry `result`, so encode
          // void explicitly instead of emitting a malformed success envelope.
          result: result === undefined ? null : result,
        })
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      const errorStack = error instanceof Error ? error.stack : undefined;
      writeJson(
        res,
        200,
        responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: message.requestId,
          error: errorMessage,
          errorKind: rpcErrorKindOf(error, "internal"),
          ...(errorCode ? { errorCode } : {}),
          ...(errorStack ? { errorStack } : {}),
          ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
        })
      );
    } finally {
      req.removeListener("aborted", abortDisconnectedTransport);
      res.removeListener("close", abortDisconnectedTransport);
      if (this.activeRequests.get(requestKey) === abort) {
        this.activeRequests.delete(requestKey);
      }
      releaseTransport();
    }
  }
}
