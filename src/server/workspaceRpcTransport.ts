import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  encodeLengthPrefix,
  readFrame,
  writeFrame,
  MAX_ENVELOPE_FRAME_BYTES,
} from "@vibestudio/iroh-transport";
import type { ContextIntegrityFact, RpcEnvelope } from "@vibestudio/rpc";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

export const WORKSPACE_RPC_INTERNAL_ROUTE = "/_r/s/internal/workspace-rpc";
const CONTENT_TYPE = "application/vnd.vibestudio.rpc-envelopes";

/** Produced only by the source host, after authenticating the ordinary caller.
 * The envelope's provenance is descriptive; these separate facts authorize it. */
export interface WorkspaceRpcInvocation {
  envelope: RpcEnvelope;
  caller: VerifiedCaller;
  authorizingCaller: VerifiedCaller;
  contextIntegrity: ContextIntegrityFact | null;
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

function denied(message = "Cross-workspace RPC is not permitted"): Error {
  return Object.assign(new Error(message), { code: "EACCES" });
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
  if (
    !record(value) ||
    !verifiedCaller(value["caller"]) ||
    !verifiedCaller(value["authorizingCaller"]) ||
    value["caller"]["subject"]!.userId !== value["authorizingCaller"]["subject"]!.userId ||
    typeof value["operation"] !== "string" ||
    !value["operation"] ||
    (value["purpose"] !== "call" && value["purpose"] !== "discover") ||
    !record(value["envelope"]) ||
    !record(value["envelope"]["message"]) ||
    typeof value["envelope"]["from"] !== "string" ||
    typeof value["envelope"]["target"] !== "string" ||
    typeof value["envelope"]["targetWorkspaceId"] !== "string" ||
    !value["envelope"]["targetWorkspaceId"] ||
    !record(value["envelope"]["delivery"]) ||
    !record(value["envelope"]["delivery"]["caller"]) ||
    !Array.isArray(value["envelope"]["provenance"]) ||
    (value["contextIntegrity"] !== null && !record(value["contextIntegrity"]))
  )
    throw denied();
  const invocation = value as unknown as WorkspaceRpcInvocation;
  const message = invocation.envelope.message;
  if (
    !["request", "stream-request", "event", "stream-cancel", "request-cancel"]["includes"](
      message.type
    )
  ) {
    throw denied();
  }
  if (
    (message.type === "request" || message.type === "stream-request") &&
    (message.method !== invocation.operation || !Array.isArray(message.args))
  )
    throw denied();
  if (message.type !== "event" && (typeof message.requestId !== "string" || !message.requestId))
    throw denied();
  const attributed = invocation.envelope.delivery.caller;
  if (
    invocation.envelope.from !== invocation.caller.runtime.id ||
    ("fromId" in message && message.fromId !== invocation.caller.runtime.id) ||
    attributed.workspaceId !== invocation.caller.workspaceId ||
    attributed.callerId !== invocation.caller.runtime.id ||
    attributed.callerKind !== invocation.caller.runtime.kind ||
    attributed.userId !== invocation.caller.subject!.userId
  )
    throw denied();
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
    reply.targetWorkspaceId !== invocation.caller.workspaceId ||
    reply.target !== invocation.envelope.from ||
    reply.delivery.caller.workspaceId !== invocation.envelope.targetWorkspaceId
  )
    throw denied();
  const message = reply.message;
  if (message.type === "event") return; // Receiver owns its existing subscription authorization.
  const request = invocation.envelope.message;
  if (
    (message.type !== "response" && message.type !== "stream-frame") ||
    !("requestId" in request) ||
    message.requestId !== request.requestId
  )
    throw denied();
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
  const disconnect = () => {
    if (!res.writableFinished) controller.abort(new Error("Workspace RPC disconnected"));
  };
  req.on("aborted", disconnect);
  res.on("close", disconnect);
  try {
    if (req.method !== "POST") throw denied();
    options.authenticate();
    const reader = new FramedReader(req);
    const bytes = await readFrame(reader, MAX_ENVELOPE_FRAME_BYTES);
    const packet: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!record(packet) || typeof packet["body"] !== "boolean") throw denied();
    const invocation = parseWorkspaceRpcInvocation(packet["invocation"]);
    const hasBody = packet["body"];
    if (hasBody && invocation.envelope.message.type !== "stream-request") throw denied();
    const assertLive = () => {
      controller.signal.throwIfAborted();
      options.authenticate();
      options.assertLive(invocation);
    };
    assertLive();
    async function* upload() {
      for await (const chunk of reader.remaining()) {
        assertLive();
        yield chunk;
      }
    }
    if (!hasBody) {
      for await (const chunk of reader.remaining()) {
        assertLive();
        if (chunk.byteLength) throw denied();
      }
    }
    let writes = Promise.resolve();
    await options.dispatch({
      invocation,
      ...(hasBody
        ? { body: Readable.toWeb(Readable.from(upload())) as ReadableStream<Uint8Array> }
        : {}),
      signal: controller.signal,
      send(envelope) {
        const write = writes.then(async () => {
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
      const code = (error as { code?: string })?.code;
      res.writeHead(code === "EACCES" ? 403 : 400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            code === "EACCES"
              ? "Cross-workspace RPC is not permitted"
              : "Invalid workspace RPC transport",
          code: code ?? "EPROTOCOL",
        })
      );
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
      await response.body?.cancel();
      throw Object.assign(new Error("Cross-workspace RPC delivery failed"), {
        code: response.status === 401 || response.status === 403 ? "EACCES" : "ETRANSPORT",
      });
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
