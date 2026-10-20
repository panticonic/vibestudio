import {
  formatRpcFailure,
  responseEnvelopeFor,
  RpcBoundaryError,
  serializeRpcFailure,
  type EnvelopeRpcTransport,
  type RpcCallOptions,
  type RpcEnvelope,
  type RpcRequest,
} from "@vibestudio/rpc";
import { createInternalRpcClient, type RpcWireClient } from "@vibestudio/rpc/internal";
import type { ScopedServerCaller, ServerClient } from "../main/serverClient.js";

/**
 * How a client window's direct server traffic is relayed: the one path the
 * renderer port takes for every request a client document makes as its
 * principal, and that the device driver takes to make the same call without a
 * document.
 */

/** The window a relayed call is made for. */
export interface ClientRelayWindow {
  /** The window instance (`instanceId` of its principal session). */
  callerId: string;
  /** The client principal every session of the window acts as. */
  runtimeId: string;
  capabilities: readonly string[] | undefined;
}

export type ClientRelayServer = Pick<ServerClient, "callAs">;

/** The principal session this window holds in a workspace. */
export function scopedClientCaller(
  window: Pick<ClientRelayWindow, "callerId" | "runtimeId">
): ScopedServerCaller {
  return { callerId: window.runtimeId, callerKind: "client", instanceId: window.callerId };
}

export function callOptionsFromEnvelope(envelope: RpcEnvelope): RpcCallOptions | undefined {
  const options: RpcCallOptions = {};
  if (envelope.destination) options.destination = envelope.destination;
  if (envelope.delivery.idempotencyKey) options.idempotencyKey = envelope.delivery.idempotencyKey;
  if (envelope.delivery.readOnly === true) options.readOnly = true;
  return options.destination || options.idempotencyKey || options.readOnly ? options : undefined;
}

/**
 * Cross-client approval confidentiality: a client may call `shellApproval` only
 * while it holds the `approval-surface` capability, otherwise it could
 * enumerate and silently grant or deny another principal's approvals.
 */
export function authorizeClientServerCall(
  callerId: string,
  capabilities: readonly string[] | undefined,
  service: string
): void {
  if (service !== "shellApproval") return;
  if (!capabilities?.includes("approval-surface")) {
    throw new Error(`shellApproval is only available to an approval surface, not ${callerId}`);
  }
}

/** {@link authorizeClientServerCall}, refused as an access failure at the RPC boundary. */
export function authorizeClientRelay(window: ClientRelayWindow, service: string): void {
  try {
    authorizeClientServerCall(window.callerId, window.capabilities, service);
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    throw new RpcBoundaryError(
      formatRpcFailure(cause),
      "access",
      typeof code === "string" ? code : undefined,
      cause
    );
  }
}

/** One call as the window's client principal, on the session it holds in `server`'s workspace. */
export function callAsClient(
  server: ClientRelayServer,
  window: Pick<ClientRelayWindow, "callerId" | "runtimeId">,
  service: string,
  method: string,
  args: unknown[],
  options?: RpcCallOptions
): Promise<unknown> {
  const scoped = scopedClientCaller(window);
  return options
    ? server.callAs(scoped, service, method, args, options)
    : server.callAs(scoped, service, method, args);
}

/**
 * The RPC client of a client window's own direct path to one workspace: the
 * client the window's renderer creates (`authorityAcquisition: "wait"`) over a
 * transport that relays each request exactly as the renderer port does. A call
 * that raises an authority acquisition therefore waits on
 * `authority.awaitDecision` as the same principal and retries the original call.
 */
export function createClientWindowRpc(
  server: ClientRelayServer,
  window: ClientRelayWindow,
  workspaceId: string
): { rpc: RpcWireClient; close(): void } {
  const handlers = new Set<(envelope: RpcEnvelope) => void>();
  const lifetime = new AbortController();
  const respond = (
    request: RpcEnvelope,
    message: RpcRequest,
    outcome: { result: unknown } | { error: unknown }
  ) => {
    const response =
      "error" in outcome
        ? {
            type: "response" as const,
            requestId: message.requestId,
            error: serializeRpcFailure(outcome.error, "internal"),
          }
        : { type: "response" as const, requestId: message.requestId, result: outcome.result };
    const envelope = responseEnvelopeFor(
      request,
      { callerId: "main", callerKind: "server", workspaceId },
      response
    );
    for (const handler of [...handlers]) handler(envelope);
  };
  const transport: EnvelopeRpcTransport = {
    async send(envelope) {
      const message = envelope.message;
      // Cancellation is not relayed by the renderer port either.
      if (message.type === "request-cancel") return;
      if (message.type !== "request" || envelope.target !== "main") {
        throw new Error(
          `A client window's direct relay carries unary requests to the server, not ${message.type}`
        );
      }
      void (async () => {
        const dot = message.method.indexOf(".");
        try {
          if (dot === -1)
            throw new RpcBoundaryError(`Invalid method format: ${message.method}`, "protocol");
          const service = message.method.slice(0, dot);
          authorizeClientRelay(window, service);
          const result = await callAsClient(
            server,
            window,
            service,
            message.method.slice(dot + 1),
            message.args,
            callOptionsFromEnvelope(envelope)
          );
          respond(envelope, message, { result });
        } catch (error) {
          respond(envelope, message, { error });
        }
      })();
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const rpc = createInternalRpcClient({
    selfId: window.runtimeId,
    callerKind: "client",
    workspaceId,
    authorityAcquisition: "wait",
    lifetime: lifetime.signal,
    transport,
  });
  return {
    rpc,
    close: () => lifetime.abort(new Error("The client window's relay is closed")),
  };
}
