import { deserializeRpcFailure } from "../errors.js";
import type { EnvelopeRpcTransport, RpcEnvelope } from "../types.js";
import { decodeFramedResponseToStreaming } from "../protocol/streamCodec.js";
import { decodeRpcJson, encodeRpcJson } from "../wireJson.js";

// Do not capture ambient network authority at module evaluation time. Library
// bundles are routinely loaded inside confined eval realms even when the
// caller supplies an explicit transport. Resolve the ambient primitive only
// when that fallback is actually invoked.
const ambientRpcFetch: typeof fetch = (input, init) => {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("RPC HTTP transport requires an explicit fetch implementation");
  }
  return Reflect.apply(fetchImpl, globalThis, [input, init]) as Promise<Response>;
};

export interface HttpClientTransportConfig {
  selfId: string;
  workspaceId?: string;
  serverUrl: string;
  authToken: string;
  fetch?: typeof fetch;
  runtimeIdHeader?: string;
}

/** One admitted inbound invocation and its authoritative terminal response. */
export interface RpcInboundInvocation {
  /** Resolves only after the receiver core has registered the request owner. */
  admitted: Promise<void>;
  /** Resolves with the receiver's terminal response (or an explicit reaper response). */
  completion: Promise<RpcEnvelope | null>;
}

interface UnaryHttpRequest {
  admitted: Promise<void>;
  completion: Promise<void>;
}

/**
 * The connectionless transport surface: the standard `EnvelopeRpcTransport`
 * plus the off-socket extras a Durable Object base needs.
 *
 * - `request(envelope)` — POST an envelope to `/rpc` and return the raw server
 *   response envelope.
 * - `deliver(envelope)` — feed an inbound envelope to the core's listeners
 *   (server→DO event push) with no response expected.
 * - `respond(envelope)` — feed an inbound request to the core and return its
 *   admission barrier separately from its terminal response. HTTP adapters
 *   can acknowledge an admitted request while retaining the original response
 *   body until the handler and its cleanup finish.
 */
export type ConnectionlessTransport = EnvelopeRpcTransport & {
  request(envelope: RpcEnvelope): Promise<unknown>;
  deliver(envelope: RpcEnvelope): void;
  respond(envelope: RpcEnvelope): RpcInboundInvocation;
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

function rpcFetchError(url: string, error: unknown): Error {
  const wrapped = new Error(
    `RPC fetch to ${url} failed: ${describeFetchFailure(error)}`
  ) as Error & { cause?: unknown };
  wrapped.cause = error;
  return wrapped;
}

class HttpRpcResponseError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(`RPC endpoint returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpRpcResponseError";
  }
}

function isInactiveRequestCancellation(error: unknown): boolean {
  if (!(error instanceof HttpRpcResponseError) || error.status !== 409) return false;
  try {
    const body = decodeRpcJson(error.detail) as { error?: unknown };
    return body.error === "RPC request is not active";
  } catch {
    return false;
  }
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
  // A cancellation POST is allowed only after the corresponding request has
  // received its authenticated admission headers. This orders two independent
  // HTTP connections without retaining speculative unknown request ids.
  const requestAdmissions = new Map<string, Promise<void>>();
  const fetchImpl = config.fetch ?? ambientRpcFetch;
  const runtimeIdHeader = config.runtimeIdHeader ?? "X-vibestudio-Runtime-Id";
  const rpcUrl = `${config.serverUrl}/rpc`;
  const streamUrl = `${config.serverUrl}/rpc/stream`;

  // One POST per envelope. A request that reached the server may have taken
  // effect, so the transport never replays it; the first failure propagates.
  async function postEnvelope(envelope: RpcEnvelope, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.authToken}`,
          [runtimeIdHeader]: config.selfId,
        },
        body: encodeRpcJson(envelope),
        signal: signal as RequestInit["signal"],
      });
    } catch (error) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      throw rpcFetchError(rpcUrl, error);
    }
    if (response.status === 401) throw new Error("RPC authentication failed");
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new HttpRpcResponseError(response.status, detail);
    }
    return decodeRpcJson(await response.text());
  }

  function deliverToListeners(envelope: RpcEnvelope): void {
    for (const listener of listeners) listener(envelope);
  }

  function sendUnaryRequest(envelope: RpcEnvelope, signal?: AbortSignal): UnaryHttpRequest {
    let resolveAdmission!: () => void;
    let rejectAdmission!: (error: Error) => void;
    const admitted = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    // Admission rejection is also observed by completion. Mark the separately
    // exposed barrier handled when no cancellation races the initial request.
    void admitted.catch(() => {});
    const completion = (async () => {
      let response: Response;
      try {
        response = await fetchImpl(rpcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.authToken}`,
            [runtimeIdHeader]: config.selfId,
          },
          body: encodeRpcJson(envelope),
          signal: signal as RequestInit["signal"],
        });
      } catch (error) {
        const failure = signal?.aborted ? abortError(signal) : rpcFetchError(rpcUrl, error);
        rejectAdmission(failure);
        throw failure;
      }
      if (response.status === 401) {
        const failure = new Error("RPC authentication failed");
        rejectAdmission(failure);
        throw failure;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const failure = new Error(
          `RPC endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`
        );
        rejectAdmission(failure);
        throw failure;
      }

      // The server flushes headers only after registering its authenticated
      // request. This barrier orders a later cancellation POST. Completion still
      // owns and reads the original body so terminal failures propagate normally.
      resolveAdmission();
      deliverToListeners(decodeRpcJson(await response.text()) as RpcEnvelope);
    })();
    return { admitted, completion };
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
      if (message.type === "request") {
        const operation = sendUnaryRequest(envelope, signal);
        requestAdmissions.set(message.requestId, operation.admitted);
        try {
          await operation.completion;
        } finally {
          if (requestAdmissions.get(message.requestId) === operation.admitted) {
            requestAdmissions.delete(message.requestId);
          }
        }
        return;
      }
      if (message.type === "request-cancel") {
        await requestAdmissions.get(message.requestId);
      }
      let response: unknown;
      try {
        response = await postEnvelope(envelope, signal);
      } catch (error) {
        // The original request may finish between its terminal body and this
        // independent cancellation POST. The server's exact 409 means there is
        // no remaining invocation to cancel; every other delivery failure is
        // retained and joined by the caller with the original terminal receipt.
        if (message.type !== "request-cancel" || !isInactiveRequestCancellation(error)) {
          throw error;
        }
        return;
      }
      if (response && typeof response === "object" && "error" in response) {
        throw deserializeRpcFailure(response.error);
      }
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
    respond(inbound): RpcInboundInvocation {
      const message = inbound.message;
      if (message.type !== "request" && message.type !== "stream-request") {
        // Events / frames / cancels expect no response — just deliver them.
        deliverToListeners(inbound);
        return { admitted: Promise.resolve(), completion: Promise.resolve(null) };
      }
      const requestId = message.requestId;
      let admit!: () => void;
      let rejectCompletion!: (error: unknown) => void;
      const admitted = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const completion = new Promise<RpcEnvelope | null>((resolve, reject) => {
        rejectCompletion = reject;
        captures.set(requestId, (responseEnvelope) => {
          resolve(responseEnvelope);
        });
      });
      try {
        deliverToListeners(inbound);
        admit();
      } catch (error) {
        captures.delete(requestId);
        rejectCompletion(error);
      }
      return { admitted, completion };
    },
    async stream(envelope, signal, body): Promise<Response> {
      if (body) {
        // The HTTP transport POSTs the envelope JSON to /rpc/stream — there is
        // no channel for a separate streaming request body (plan §1.6: fail
        // loud, never a silent drop or base64 fallback).
        throw new Error(
          "Streaming request bodies (uploads) require the Iroh transport; the HTTP transport cannot stream a request body"
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
          body: encodeRpcJson(envelope),
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
