import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  encodeLengthPrefix,
  readFrame,
  writeFrame,
  MAX_ENVELOPE_FRAME_BYTES,
} from "@vibestudio/iroh-transport";
import {
  RemoteRpcError,
  RpcBoundaryError,
  attachRpcDiagnosticId,
  rpcDiagnosticIdOf,
  rpcErrorDataOf,
  rpcErrorKindOf,
  type RpcEnvelope,
  type RpcResponse,
} from "@vibestudio/rpc";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { authErrorStatus } from "./hostCore/auth/errors.js";

export const WORKSPACE_RPC_INTERNAL_ROUTE = "/_r/s/internal/workspace-rpc";
const CONTENT_TYPE = "application/vnd.vibestudio.rpc-envelopes";

/** Produced only by the source host, after authenticating the ordinary caller.
 * The envelope's provenance is descriptive; these separate facts authorize it. */
export interface WorkspaceRpcInvocation {
  envelope: RpcEnvelope;
  caller: VerifiedCaller;
  authorizingCaller: VerifiedCaller;
  /** Original method scope, retained for cancellation and subscription events. */
  operation: string;
  purpose: "call" | "discover";
}

export interface WorkspaceRpcDelivery {
  invocation: WorkspaceRpcInvocation;
  body?: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  /** Only replies and already authorized subscription events. Reverse calls
   * must enter the normal source admission path as a new invocation. */
  send(envelope: RpcEnvelope): Promise<void>;
}

function denied(message: string): Error {
  return new RpcBoundaryError(message, "access", "EACCES");
}

function malformed(message: string): Error {
  return new RpcBoundaryError(message, "protocol", "EPROTOCOL");
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function verifiedCaller(value: unknown): value is VerifiedCaller {
  return (
    record(value) &&
    typeof value["workspaceId"] === "string" &&
    !!value["workspaceId"] &&
    record(value["runtime"]) &&
    typeof value["runtime"]["id"] === "string" &&
    !!value["runtime"]["id"] &&
    typeof value["runtime"]["kind"] === "string" &&
    record(value["subject"]) &&
    typeof value["subject"]["userId"] === "string" &&
    !!value["subject"]["userId"] &&
    !value["hostOriginated"]
  );
}

/** Validate structure before trusting a host assertion. Authentication of the
 * installed child process is a separate, mandatory check at the HTTP boundary. */
export function parseWorkspaceRpcInvocation(value: unknown): WorkspaceRpcInvocation {
  if (!record(value)) throw malformed("Workspace RPC invocation must be an object");
  if (!verifiedCaller(value["caller"]) || !verifiedCaller(value["authorizingCaller"]))
    throw denied(
      "Workspace RPC requires an authenticated source caller and authorizing account user"
    );
  if (value["caller"].subject!.userId !== value["authorizingCaller"].subject!.userId)
    throw denied("Workspace RPC caller and authorizing caller belong to different account users");
  if (
    typeof value["operation"] !== "string" ||
    !value["operation"] ||
    (value["purpose"] !== "call" && value["purpose"] !== "discover") ||
    !record(value["envelope"]) ||
    !record(value["envelope"]["message"]) ||
    typeof value["envelope"]["from"] !== "string" ||
    typeof value["envelope"]["target"] !== "string" ||
    !record(value["envelope"]["destination"]) ||
    value["envelope"]["destination"]["kind"] !== "workspace" ||
    typeof value["envelope"]["destination"]["workspaceId"] !== "string" ||
    !value["envelope"]["destination"]["workspaceId"] ||
    !record(value["envelope"]["delivery"]) ||
    !record(value["envelope"]["delivery"]["caller"]) ||
    !Array.isArray(value["envelope"]["provenance"])
  )
    throw malformed(
      "Malformed workspace RPC invocation: expected operation, purpose, and workspace-addressed envelope"
    );
  const invocation = value as unknown as WorkspaceRpcInvocation;
  const message = invocation.envelope.message;
  if (
    !["request", "stream-request", "event", "stream-cancel", "request-cancel"]["includes"](
      message.type
    )
  ) {
    throw malformed(`Unsupported workspace RPC message type: ${message.type}`);
  }
  if (
    (message.type === "request" || message.type === "stream-request") &&
    message.method !== invocation.operation
  )
    throw denied("Workspace RPC method does not match its authorized operation");
  if (
    (message.type === "request" || message.type === "stream-request") &&
    !Array.isArray(message.args)
  )
    throw malformed("Workspace RPC request arguments must be an array");
  if (
    message.type !== "event" &&
    (!("requestId" in message) || typeof message.requestId !== "string" || !message.requestId)
  )
    throw malformed("Workspace RPC message has no request identifier");
  const attributed = invocation.envelope.delivery.caller;
  if (
    invocation.envelope.from !== invocation.caller.runtime.id ||
    ("fromId" in message && message.fromId !== invocation.caller.runtime.id) ||
    attributed.workspaceId !== invocation.caller.workspaceId ||
    attributed.callerId !== invocation.caller.runtime.id ||
    attributed.callerKind !== invocation.caller.runtime.kind ||
    attributed.userId !== invocation.caller.subject!.userId
  )
    throw denied("Workspace RPC envelope attribution does not match its authenticated caller");
  return invocation;
}

/** Incremental adapter for the existing length-prefixed frame codec. It retains
 * at most one input chunk; request uploads are never gathered in memory. */
class FramedReader {
  private pending: Uint8Array = new Uint8Array(0);
  private readonly iterator: AsyncIterator<Uint8Array>;
  constructor(input: AsyncIterable<Uint8Array>) {
    this.iterator = input[Symbol.asyncIterator]();
  }
  async readExact(length: number): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (!this.pending.byteLength) {
        const next = await this.iterator.next();
        if (next.done) throw new Error("Truncated workspace RPC frame");
        this.pending = next.value;
      }
      const take = Math.min(length - offset, this.pending.byteLength);
      output.set(this.pending.subarray(0, take), offset);
      this.pending = this.pending.subarray(take);
      offset += take;
    }
    return output;
  }
  async *remaining(): AsyncGenerator<Uint8Array> {
    if (this.pending.byteLength) {
      yield this.pending;
      this.pending = new Uint8Array(0);
    }
    while (true) {
      const next = await this.iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
  async nextFrame(): Promise<Uint8Array | null> {
    if (!this.pending.byteLength) {
      const next = await this.iterator.next();
      if (next.done) return null;
      this.pending = next.value;
    }
    return readFrame(this, MAX_ENVELOPE_FRAME_BYTES);
  }
}

function assertReply(invocation: WorkspaceRpcInvocation, reply: RpcEnvelope): void {
  if (
    !record(reply) ||
    !record(reply.message) ||
    !record(reply.delivery) ||
    !record(reply.delivery.caller) ||
    reply.destination?.kind !== "workspace" ||
    reply.destination.workspaceId !== invocation.caller.workspaceId ||
    reply.target !== invocation.envelope.from ||
    invocation.envelope.destination?.kind !== "workspace" ||
    reply.delivery.caller.workspaceId !== invocation.envelope.destination.workspaceId
  )
    throw denied(
      "Workspace RPC reply destination, target, or responder workspace does not match its invocation"
    );
  const message = reply.message;
  if (message.type === "event") return; // Receiver owns its existing subscription authorization.
  const request = invocation.envelope.message;
  if (
    (message.type !== "response" && message.type !== "stream-frame") ||
    !("requestId" in request) ||
    message.requestId !== request.requestId
  )
    throw malformed("Workspace RPC reply type or request identifier does not match its invocation");
}

export async function receiveWorkspaceRpcHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    authenticate(): void;
    assertLive(invocation: WorkspaceRpcInvocation): void;
    dispatch(delivery: WorkspaceRpcDelivery): Promise<void>;
  }
): Promise<void> {
  const controller = new AbortController();
  let phase = "authenticate";
  let requestId: string | undefined;
  const disconnect = () => {
    if (!res.writableFinished) controller.abort(new Error("Workspace RPC disconnected"));
  };
  req.on("aborted", disconnect);
  res.on("close", disconnect);
  try {
    if (req.method !== "POST") throw malformed("Workspace RPC transport requires POST");
    options.authenticate();
    phase = "read frame";
    const reader = new FramedReader(req);
    const bytes = await readFrame(reader, MAX_ENVELOPE_FRAME_BYTES);
    phase = "decode frame";
    const packet: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!record(packet) || typeof packet["body"] !== "boolean")
      throw malformed(
        "Workspace RPC packet must contain an invocation and a boolean body declaration"
      );
    phase = "parse invocation";
    const invocation = parseWorkspaceRpcInvocation(packet["invocation"]);
    if ("requestId" in invocation.envelope.message)
      requestId = invocation.envelope.message.requestId;
    const hasBody = packet["body"];
    if (hasBody && invocation.envelope.message.type !== "stream-request")
      throw malformed("Workspace RPC upload body requires a stream-request");
    const assertLive = () => {
      controller.signal.throwIfAborted();
      options.authenticate();
      options.assertLive(invocation);
    };
    phase = "check boundary";
    assertLive();
    async function* upload() {
      for await (const chunk of reader.remaining()) {
        assertLive();
        yield chunk;
      }
    }
    if (!hasBody) {
      phase = "read upload end";
      for await (const chunk of reader.remaining()) {
        assertLive();
        if (chunk.byteLength)
          throw malformed(
            "Workspace RPC packet declares no upload body but contains trailing payload"
          );
      }
    }
    let writes = Promise.resolve();
    phase = "dispatch";
    await options.dispatch({
      invocation,
      ...(hasBody
        ? { body: Readable.toWeb(Readable.from(upload())) as ReadableStream<Uint8Array> }
        : {}),
      signal: controller.signal,
      send(envelope) {
        const write = writes.then(async () => {
          phase = "send reply";
          assertLive();
          assertReply(invocation, envelope);
          const payload = Buffer.from(JSON.stringify(envelope));
          if (!res.headersSent) res.writeHead(200, { "Content-Type": CONTENT_TYPE });
          await writeFrame(
            {
              async writeAll(chunk) {
                assertLive();
                if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal });
              },
            },
            payload,
            MAX_ENVELOPE_FRAME_BYTES
          );
        });
        writes = write;
        return write;
      },
    });
    await writes;
    assertLive();
    if (!res.headersSent) res.writeHead(200, { "Content-Type": CONTENT_TYPE });
    res.end();
  } catch (error) {
    if (res.headersSent) res.destroy(error instanceof Error ? error : new Error(String(error)));
    else {
      const code = (error as { code?: unknown } | null)?.code;
      const errorKind = rpcErrorKindOf(
        error,
        code === "EACCES" || code === "UNAUTHORIZED"
          ? "access"
          : phase === "dispatch"
            ? "internal"
            : "protocol"
      );
      const status =
        authErrorStatus(error) ??
        (errorKind === "access" ? 403 : errorKind === "protocol" ? 400 : 500);
      const message = error instanceof Error ? error.message : String(error);
      const failure: Omit<Extract<RpcResponse, { error: string }>, "type" | "requestId"> & {
        requestId?: string;
      } = {
        ...(requestId ? { requestId } : {}),
        error: `${message} [Workspace RPC receiver :${req.socket.localPort}, ${phase}, HTTP ${status}]`,
        errorKind,
        ...(typeof code === "string" ? { errorCode: code } : {}),
        ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
        ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
        ...(rpcDiagnosticIdOf(error) ? { diagnosticId: rpcDiagnosticIdOf(error) } : {}),
      };
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(failure));
    }
  } finally {
    req.off("aborted", disconnect);
    res.off("close", disconnect);
    controller.abort(new Error("Workspace RPC delivery ended"));
  }
}

export async function forwardWorkspaceRpcHttp(options: {
  url: URL | string;
  runtimeToken: string;
  invocation: WorkspaceRpcInvocation;
  body?: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
  onEnvelope(envelope: RpcEnvelope): Promise<void> | void;
  assertLive?(): void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const invocation = parseWorkspaceRpcInvocation(options.invocation);
  const payload = Buffer.from(JSON.stringify({ invocation, body: !!options.body }));
  if (payload.byteLength > MAX_ENVELOPE_FRAME_BYTES)
    throw new Error("Workspace RPC envelope exceeds frame limit");
  const assertLive = () => {
    signal.throwIfAborted();
    options.assertLive?.();
  };
  async function* upload() {
    assertLive();
    yield encodeLengthPrefix(payload.byteLength);
    yield payload;
    if (options.body) {
      const reader = options.body.getReader();
      const cancel = () => {
        void reader.cancel(signal.reason).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          assertLive();
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    }
  }
  assertLive();
  let responseStream: Readable | undefined;
  try {
    const response = await (options.fetchImpl ?? fetch)(options.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.runtimeToken}`, "Content-Type": CONTENT_TYPE },
      body: Readable.toWeb(Readable.from(upload())) as ReadableStream<Uint8Array>,
      duplex: "half",
      signal,
    } as RequestInit & { duplex: "half" });
    if (!response.ok) {
      const context = `[Workspace RPC forwarding to ${new URL(options.url).origin}${new URL(options.url).pathname}, HTTP ${response.status}]`;
      const text = await response.text();
      let failure: unknown;
      try {
        failure = JSON.parse(text);
      } catch {
        // An infrastructure response may not speak RPC; retain its actual body.
      }
      if (record(failure) && typeof failure["error"] === "string") {
        const expectedId =
          "requestId" in invocation.envelope.message
            ? invocation.envelope.message.requestId
            : undefined;
        if (failure["requestId"] !== undefined && failure["requestId"] !== expectedId) {
          throw new RemoteRpcError(
            `Workspace RPC failure response has a different request identifier ${context}`,
            "protocol",
            "EPROTOCOL"
          );
        }
        const error = new RemoteRpcError(
          `${failure["error"]} ${context}`,
          rpcErrorKindOf(failure, "transport"),
          typeof failure["errorCode"] === "string" ? failure["errorCode"] : undefined,
          failure["errorData"]
        );
        if (typeof failure["errorStack"] === "string") error.stack = failure["errorStack"];
        if (typeof failure["diagnosticId"] === "string")
          attachRpcDiagnosticId(error, failure["diagnosticId"]);
        throw error;
      }
      throw new RemoteRpcError(
        `${response.statusText || "Cross-workspace RPC delivery failed"}: ${text} ${context}`,
        "transport",
        response.status === 401 || response.status === 403 ? "EACCES" : "ETRANSPORT"
      );
    }
    if (!response.body) throw new Error("Workspace RPC response is missing its envelope stream");
    responseStream = Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream<Uint8Array>
    );
    const reader = new FramedReader(responseStream);
    while (true) {
      const bytes = await reader.nextFrame();
      if (bytes === null) return;
      assertLive();
      const envelope = JSON.parse(Buffer.from(bytes).toString("utf8")) as RpcEnvelope;
      assertReply(invocation, envelope);
      await options.onEnvelope(envelope);
    }
  } finally {
    controller.abort(new Error("Workspace RPC forwarding ended"));
    responseStream?.destroy();
  }
}
