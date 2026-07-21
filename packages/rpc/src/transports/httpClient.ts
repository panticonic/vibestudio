import type { EnvelopeRpcTransport, RpcEnvelope, RpcRequest } from "../types.js";
import { decodeFramedResponseToStreaming } from "../protocol/streamCodec.js";

const rpcFetch = globalThis.fetch.bind(globalThis);

export interface HttpClientTransportConfig {
  selfId: string;
  serverUrl: string;
  authToken: string;
  fetch?: typeof fetch;
  runtimeIdHeader?: string;
  /**
   * Optional watchdog for inbound request handlers. Omitted or `<= 0` means no
   * transport deadline; callers that need a bounded probe can opt in with a
   * positive value.
   */
  respondTimeoutMs?: number;
}

/**
 * The connectionless transport surface: the standard `EnvelopeRpcTransport`
 * plus the off-socket extras a Durable Object base needs.
 *
 * - `request(envelope)` — POST an envelope to `/rpc` and return the RAW server
 *   JSON (a response envelope, or a `{deferred,requestId}` ack). Used by the
 *   `callDeferred` extension, which must inspect the deferral discriminator
 *   that `send()` swallows.
 * - `deliver(envelope)` — feed an inbound envelope to the core's listeners
 *   (server→DO event push, deferred replies) with no response expected.
 * - `respond(envelope)` — feed an inbound REQUEST and capture the response
 *   envelope the core produces, so the DO's `fetch` can return it synchronously
 *   in the HTTP body (the server's relay reads the result from that body).
 */
export type ConnectionlessTransport = EnvelopeRpcTransport & {
  request(envelope: RpcEnvelope): Promise<unknown>;
  deliver(envelope: RpcEnvelope): void;
  respond(envelope: RpcEnvelope): Promise<RpcEnvelope | null>;
  stream(
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null
  ): Promise<Response>;
};

function describeFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (!cause) return message;
  return `${message} (cause: ${describeFetchCause(cause)})`;
}

function describeFetchCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const fields = cause as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    address?: unknown;
    port?: unknown;
  };
  const parts = [`${cause.name}: ${cause.message}`];
  for (const key of ["code", "errno", "syscall", "address", "port"] as const) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(" ");
}

function rpcFetchError(url: string, error: unknown, attempts?: number): Error {
  const retryText = attempts && attempts > 1 ? ` after ${attempts} attempts` : "";
  const wrapped = new Error(
    `RPC fetch to ${url} failed${retryText}: ${describeFetchFailure(error)}`
  ) as Error & { cause?: unknown };
  wrapped.cause = error;
  return wrapped;
}

function abortError(signal: AbortSignal): Error {
  // `AbortSignal.reason` is implemented by every runtime supported by the RPC
  // package, but React Native's TypeScript library still exposes the older
  // AbortSignal declaration. Keep that declaration gap at this transport
  // boundary instead of weakening either the mobile compiler or cancellation
  // semantics for every caller.
  const reason = (signal as AbortSignal & { readonly reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error("RPC call aborted");
}

export function httpClientTransport(config: HttpClientTransportConfig): ConnectionlessTransport {
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  // One-shot captures for inbound requests delivered via `respond()`: the core
  // produces a response envelope by calling `send()`, which resolves the
  // matching capture instead of POSTing it back to the server.
  const captures = new Map<string, (envelope: RpcEnvelope) => void>();
  const fetchImpl = config.fetch ?? rpcFetch;
  const runtimeIdHeader = config.runtimeIdHeader ?? "X-vibestudio-Runtime-Id";
  const rpcUrl = `${config.serverUrl}/rpc`;
  const streamUrl = `${config.serverUrl}/rpc/stream`;

  async function postEnvelope(envelope: RpcEnvelope, signal?: AbortSignal): Promise<unknown> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(rpcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.authToken}`,
            [runtimeIdHeader]: config.selfId,
          },
          body: JSON.stringify(envelope),
          signal: signal as RequestInit["signal"],
        });
      } catch (error) {
        if (signal?.aborted) {
          throw abortError(signal);
        }
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
          continue;
        }
        throw rpcFetchError(rpcUrl, error, maxRetries);
      }
      if (response.status >= 500 && attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        continue;
      }
      if (response.status === 401) throw new Error("RPC authentication failed");
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `RPC endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`
        );
      }
      return response.json();
    }
    throw new Error("RPC request failed after retries");
  }

  function deliverToListeners(envelope: RpcEnvelope): void {
    for (const listener of listeners) listener(envelope);
  }

  return {
    async send(envelope, signal): Promise<void> {
      // A response envelope whose requestId matches a pending inbound `respond`
      // is the answer to a request the server POSTed to us — resolve the capture
      // locally instead of POSTing it back to the server.
      const message = envelope.message;
      if (message.type === "response") {
        const capture = captures.get(message.requestId);
        if (capture) {
          captures.delete(message.requestId);
          capture(envelope);
          return;
        }
        // There is no `/rpc` route for raw response envelopes; the original
        // held request already settled (for example via an explicit watchdog) or
        // was never captured. Posting it only creates a misleading HTTP 400.
        console.warn(
          `[httpClientTransport:${config.selfId}] dropping unmatched response ` +
            `(requestId=${message.requestId})`
        );
        return;
      }
      const response = (await postEnvelope(envelope, signal)) as unknown;
      const returnedEnvelope = response as RpcEnvelope | undefined;
      if (
        returnedEnvelope &&
        typeof returnedEnvelope === "object" &&
        "message" in returnedEnvelope
      ) {
        deliverToListeners(returnedEnvelope);
      }
    },
    onMessage(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    request(envelope): Promise<unknown> {
      return postEnvelope(envelope);
    },
    deliver(envelope): void {
      deliverToListeners(envelope);
    },
    respond(inbound): Promise<RpcEnvelope | null> {
      const message = inbound.message;
      if (message.type !== "request" && message.type !== "stream-request") {
        // Events / frames / cancels expect no response — just deliver them.
        deliverToListeners(inbound);
        return Promise.resolve(null);
      }
      const requestId = (message as RpcRequest).requestId;
      const timeoutMs = config.respondTimeoutMs ?? 0;
      return new Promise<RpcEnvelope | null>((resolve) => {
        // No implicit transport deadline: handlers that wait for human approval
        // can legitimately outlive short RPC watchdogs. Positive `respondTimeoutMs`
        // remains as an explicit opt-in for tests/probes.
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                captures.delete(requestId);
                // Resolve with a REJECTING response envelope, not `null`. The
                // server's relay reads this body and delivers it to the original
                // caller; a `null` here was unwrapped downstream to `undefined`,
                // silently handing the caller a wrong (empty) result instead of
                // an error (silent-drop class). The held exemption above (`<= 0`)
                // is untouched.
                console.warn(
                  `[httpClientTransport:${config.selfId}] respond() timed out after ${timeoutMs}ms ` +
                    `for "${(message as RpcRequest).method}" (requestId=${requestId})`
                );
                resolve({
                  from: inbound.target,
                  target: inbound.from,
                  delivery: { caller: { callerId: inbound.target, callerKind: "unknown" } },
                  provenance: inbound.provenance ?? [],
                  message: {
                    type: "response",
                    requestId,
                    error: `Handler timed out after ${timeoutMs}ms`,
                    errorKind: "transport",
                    errorCode: "RESPOND_TIMEOUT",
                  },
                });
              }, timeoutMs)
            : null;
        captures.set(requestId, (responseEnvelope) => {
          if (timer) clearTimeout(timer);
          resolve(responseEnvelope);
        });
        deliverToListeners(inbound);
      });
    },
    async stream(envelope, signal, body): Promise<Response> {
      if (body) {
        // The HTTP transport POSTs the envelope JSON to /rpc/stream — there is
        // no channel for a separate streaming request body (plan §1.6: fail
        // loud, never a silent drop or base64 fallback).
        throw new Error(
          "Streaming request bodies (uploads) require the WebRTC transport; the HTTP transport cannot stream a request body"
        );
      }
      let response: Response;
      try {
        response = await fetchImpl(streamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.authToken}`,
            [runtimeIdHeader]: config.selfId,
          },
          body: JSON.stringify(envelope),
          // Cast bridges the DOM vs React-Native `AbortSignal` identity clash when this
          // module is typechecked under the RN-lib mobile program; identity under host lib.
          signal: (signal ?? undefined) as RequestInit["signal"],
        });
      } catch (error) {
        throw rpcFetchError(streamUrl, error);
      }
      if (response.status === 401) throw new Error("RPC streaming authentication failed");
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `RPC streaming endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`
        );
      }
      if (!response.body) throw new Error("RPC streaming response has no body");
      return decodeFramedResponseToStreaming(response.body, "", signal ?? null);
    },
    status: () => "connected",
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };
}
