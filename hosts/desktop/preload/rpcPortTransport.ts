/**
 * The renderer's RPC transport: one `MessagePort` straight to the connection
 * process (docs/client-hosts-and-clients-plan.md §5.1.1).
 *
 * The document asks main for its port once; main attests which principal the
 * document is, hands one end of a `MessageChannelMain` to the connection
 * process and the other end here, and never sees the traffic again. Envelopes,
 * bridge streams and their acknowledgements all travel on that port.
 *
 * The port's end is authoritative. When the connection process ends or the
 * host closes this document's session, every request and stream still waiting
 * for an answer settles with the reason, so nothing waits on a connection that
 * is gone.
 */

import { ipcRenderer } from "electron";
import {
  RpcBoundaryError,
  deserializeRpcFailure,
  responseEnvelopeFor,
  serializeRpcFailure,
  type BridgeBodyChunk,
  type BridgeStreamMessage,
  type BridgeStreamOpen,
  type BridgeStreamShellSurface,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import { FRAME_END, FRAME_ERROR } from "@vibestudio/rpc/protocol/streamCodec";
import type { PanelBootObservation } from "@vibestudio/shared/panel/observation";
import {
  RPC_PORT_GRANT_CHANNEL,
  RPC_PORT_LOST_CHANNEL,
  RPC_PORT_REQUEST_CHANNEL,
  type HostToRenderer,
  type RendererToHost,
  type RpcPortGrant,
} from "../connection/rendererPortProtocol.js";
import type { TransportBridge } from "./wsTransport.js";

type EnvelopeHandler = (envelope: RpcEnvelope) => void;

/** The subset of `ipcRenderer` this transport uses. */
export interface RpcPortIpc {
  send(channel: string, ...args: unknown[]): void;
  on(
    channel: string,
    listener: (event: { ports: readonly RendererPort[] }, ...args: any[]) => void
  ): unknown;
}

/** The subset of the DOM `MessagePort` this transport uses. */
export interface RendererPort {
  postMessage(message: unknown): void;
  close(): void;
  start?(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  addEventListener?(event: "close", listener: () => void): void;
}

export interface RpcPortTransportOptions {
  ipc?: RpcPortIpc;
  /**
   * The workspace this document's principal is registered in. A request that is
   * failed locally is answered the way the host answers it, so the document's
   * RPC client accepts the reply.
   */
  homeWorkspaceId?: string;
}

export interface RpcPortTransport {
  transport: TransportBridge & { observeBoot(boot: PanelBootObservation): void };
  streams: BridgeStreamShellSurface;
  /** Ask for this document's port. Sends made until it arrives are held. */
  open(): void;
  /** End this document's session on purpose: waiting work fails with `reason`. */
  close(reason: string): void;
}

type State =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "open"; port: RendererPort }
  | { kind: "lost"; error: Error };

function connectionLost(reason: string): RpcBoundaryError {
  return new RpcBoundaryError(reason, "transport", "CONNECTION_LOST");
}

export function createRpcPortTransport(options: RpcPortTransportOptions = {}): RpcPortTransport {
  const ipc: RpcPortIpc = options.ipc ?? (ipcRenderer as unknown as RpcPortIpc);
  const listeners = new Set<EnvelopeHandler>();
  const recoveryListeners = new Map<string, Set<(workspaceId?: string) => void | Promise<void>>>();
  let bootFailure: Error | undefined;
  const registration = new Map<
    string,
    { ready: Promise<void>; resolve(): void; reject(error: Error): void }
  >();
  const registered = (kind: string) => {
    let gate = registration.get(kind);
    if (!gate) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const ready = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      void ready.catch(() => undefined);
      gate = { ready, resolve, reject };
      if (bootFailure) reject(bootFailure);
      registration.set(kind, gate);
    }
    return gate;
  };

  // -------------------------------------------------------------------------
  // The port
  // -------------------------------------------------------------------------

  let state: State = { kind: "idle" };
  let nextReply = 1;
  const outbox: Array<{ message: RendererToHost; resolve(): void; reject(error: unknown): void }> =
    [];
  const replies = new Map<number, { resolve(): void; reject(error: unknown): void }>();
  /** Requests whose answer has not arrived: failed locally if the port ends first. */
  const pending = new Map<string, { envelope: RpcEnvelope; stream: boolean }>();
  const activeOps = new Set<string>();
  const streamSubscribers = new Set<(message: BridgeStreamMessage) => void>();
  let opened: { resolve(): void; reject(error: unknown): void }[] = [];

  const lose = (reason: string): void => {
    if (state.kind === "lost") return;
    const error = connectionLost(reason);
    const previous = state;
    state = { kind: "lost", error };
    if (previous.kind === "open") {
      previous.port.onmessage = null;
      try {
        previous.port.close();
      } catch {
        // Already closed.
      }
    }
    for (const waiter of opened.splice(0)) waiter.reject(error);
    for (const held of outbox.splice(0)) {
      // A held request fails through its own send(); it needs no second answer.
      if (held.message.t === "send") {
        const message = held.message.envelope.message;
        if (message.type === "request" || message.type === "stream-request")
          pending.delete(message.requestId);
      }
      held.reject(error);
    }
    for (const reply of replies.values()) reply.reject(error);
    replies.clear();
    const failed = [...pending.values()];
    pending.clear();
    for (const { envelope, stream } of failed) deliverLocalFailure(envelope, stream, error);
    const failure = serializeRpcFailure(error, "transport");
    for (const opId of [...activeOps]) {
      activeOps.delete(opId);
      dispatchStream({ kind: "error", opId, error: failure });
    }
  };

  const deliverLocalFailure = (envelope: RpcEnvelope, stream: boolean, error: Error): void => {
    const message = envelope.message;
    if (message.type !== "request" && message.type !== "stream-request") return;
    const failure = serializeRpcFailure(error, "transport");
    const destination = envelope.destination;
    const home = options.homeWorkspaceId;
    const origin =
      destination && home
        ? envelope.delivery.caller.workspaceId
          ? envelope
          : {
              ...envelope,
              delivery: {
                ...envelope.delivery,
                caller: { ...envelope.delivery.caller, workspaceId: home },
              },
            }
        : envelope;
    const responder =
      destination?.kind === "hub"
        ? { callerId: "hub", callerKind: "server" as const }
        : {
            callerId: "main",
            callerKind: "server" as const,
            ...(destination?.kind === "workspace" ? { workspaceId: destination.workspaceId } : {}),
          };
    let reply: RpcEnvelope;
    try {
      reply = responseEnvelopeFor(
        origin,
        responder,
        stream
          ? {
              type: "stream-frame",
              requestId: message.requestId,
              fromId: envelope.target,
              frameType: FRAME_ERROR,
              payload: JSON.stringify({ status: 502, error: failure }),
            }
          : { type: "response", requestId: message.requestId, error: failure }
      );
    } catch {
      // A request this document could not attribute has no reply address.
      return;
    }
    dispatchEnvelope(reply);
  };

  const dispatchEnvelope = (envelope: RpcEnvelope): void => {
    for (const listener of [...listeners]) {
      try {
        listener(envelope);
      } catch (error) {
        console.error("Error in RPC transport message handler:", error);
      }
    }
  };

  const dispatchStream = (message: BridgeStreamMessage): void => {
    for (const subscriber of [...streamSubscribers]) {
      if (streamSubscribers.has(subscriber)) subscriber(message);
    }
  };

  const settlePending = (envelope: RpcEnvelope): void => {
    const message = envelope.message;
    if (message.type === "response") pending.delete(message.requestId);
    else if (
      message.type === "stream-frame" &&
      (message.frameType === FRAME_END || message.frameType === FRAME_ERROR)
    )
      pending.delete(message.requestId);
  };

  const receive = (message: HostToRenderer): void => {
    switch (message.t) {
      case "message":
        settlePending(message.envelope);
        dispatchEnvelope(message.envelope);
        return;
      case "stream-message":
        if (message.message.kind === "end" || message.message.kind === "error")
          activeOps.delete(message.message.opId);
        dispatchStream(message.message);
        return;
      case "reply": {
        const reply = replies.get(message.id);
        if (!reply) return;
        replies.delete(message.id);
        if (message.error) reply.reject(deserializeRpcFailure(message.error));
        else reply.resolve();
        return;
      }
      case "closed":
        lose(message.reason);
        return;
    }
  };

  const attach = (port: RendererPort): void => {
    state = { kind: "open", port };
    port.onmessage = (event) => receive(event.data as HostToRenderer);
    port.addEventListener?.("close", () => lose("The connection to the host ended"));
    port.start?.();
    for (const waiter of opened.splice(0)) waiter.resolve();
    for (const held of outbox.splice(0)) {
      port.postMessage(held.message);
      held.resolve();
    }
  };

  ipc.on(RPC_PORT_GRANT_CHANNEL, (event, grant: RpcPortGrant | undefined) => {
    if (state.kind !== "opening") {
      // A grant nobody is waiting for (the document gave up): release it.
      for (const port of event.ports) port.close();
      return;
    }
    const [port] = event.ports;
    if (!port || grant?.error) {
      lose(grant?.error ?? "The host did not provide a connection");
      return;
    }
    attach(port);
  });
  ipc.on(RPC_PORT_LOST_CHANNEL, (_event, reason: string) => lose(reason));

  const open = (): void => {
    if (state.kind === "opening" || state.kind === "open") return;
    state = { kind: "opening" };
    ipc.send(RPC_PORT_REQUEST_CHANNEL);
  };

  /** Resolves once a port is open; rejects with why none can be. */
  const whenOpen = (): Promise<void> => {
    if (state.kind === "open") return Promise.resolve();
    if (state.kind === "idle" || state.kind === "lost") open();
    return new Promise((resolve, reject) => opened.push({ resolve, reject }));
  };

  const post = (message: RendererToHost): Promise<void> => {
    if (state.kind === "open") {
      state.port.postMessage(message);
      return Promise.resolve();
    }
    if (state.kind === "idle" || state.kind === "lost") open();
    return new Promise((resolve, reject) => outbox.push({ message, resolve, reject }));
  };

  /** A request answered by a `reply` message (the former `ipcRenderer.invoke`). */
  const invoke = (build: (id: number) => RendererToHost): Promise<void> => {
    const id = nextReply++;
    const answered = new Promise<void>((resolve, reject) => replies.set(id, { resolve, reject }));
    void post(build(id)).catch((error: unknown) => {
      const reply = replies.get(id);
      replies.delete(id);
      reply?.reject(error);
    });
    return answered;
  };

  // -------------------------------------------------------------------------
  // Recovery (a lifecycle signal from main, not RPC traffic)
  // -------------------------------------------------------------------------

  ipc.on(
    "vibestudio:rpc:recovery",
    (_event, kind: string, workspaceId?: string, requestId?: string) => {
      // The runtime's first registration is its readiness edge. A renderer
      // still evaluating its modules cannot acknowledge recovery yet.
      const runRecovery = async () => {
        // A connection that ended is replaced before the document recovers on it.
        if (state.kind === "lost") await whenOpen();
        for (;;) {
          if (bootFailure) throw bootFailure;
          const handlers = [...(recoveryListeners.get(kind) ?? [])];
          if (handlers.length > 0) {
            return Promise.allSettled(handlers.map(async (handler) => handler(workspaceId)));
          }
          await registered(kind).ready;
        }
      };
      const reportFailure = (reason: unknown) => {
        if (!requestId) {
          console.error("Renderer recovery failed:", reason);
          return;
        }
        const error = reason as { message?: unknown; code?: unknown; errorKind?: unknown } | null;
        ipc.send("vibestudio:rpc:recovered", requestId, {
          message: typeof error?.message === "string" ? error.message : String(reason),
          ...(typeof error?.code === "string" ? { code: error.code } : {}),
          ...(typeof error?.errorKind === "string" ? { errorKind: error.errorKind } : {}),
        });
      };
      void runRecovery().then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          reportFailure(failure.reason);
        } else if (requestId) ipc.send("vibestudio:rpc:recovered", requestId);
      }, reportFailure);
    }
  );

  // -------------------------------------------------------------------------
  // Surfaces
  // -------------------------------------------------------------------------

  const transport: RpcPortTransport["transport"] = {
    observeBoot(boot) {
      if (boot.phase !== "failed") return;
      bootFailure = new Error(boot.message ?? "Panel bootstrap failed");
      bootFailure.name = boot.errorName ?? "Error";
      if (boot.stack) bootFailure.stack = boot.stack;
      for (const gate of registration.values()) gate.reject(bootFailure);
    },
    async send(envelope: RpcEnvelope): Promise<void> {
      const message = envelope.message;
      if (message.type === "request" || message.type === "stream-request") {
        pending.set(message.requestId, { envelope, stream: message.type === "stream-request" });
      } else if (message.type === "stream-cancel" || message.type === "request-cancel") {
        pending.delete(message.requestId);
      }
      try {
        await post({ t: "send", envelope });
      } catch (error) {
        if (message.type === "request" || message.type === "stream-request") {
          pending.delete(message.requestId);
        }
        throw error;
      }
    },
    onMessage(handler: EnvelopeHandler): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    onRecovery(kind, handler): () => void {
      let handlers = recoveryListeners.get(kind);
      if (!handlers) recoveryListeners.set(kind, (handlers = new Set()));
      handlers.add(handler);
      registered(kind).resolve();
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) registration.delete(kind);
      };
    },
  };

  const streams: BridgeStreamShellSurface = {
    streamChunkFormat: "binary",
    streamOpen: (message: BridgeStreamOpen) => {
      activeOps.add(message.opId);
      return invoke((id) => ({ t: "stream-open", id, message })).catch((error: unknown) => {
        activeOps.delete(message.opId);
        throw error;
      });
    },
    streamBodyChunk: (message: BridgeBodyChunk) =>
      invoke((id) => ({ t: "stream-body", id, message })),
    streamAbort: (opId: string) => {
      activeOps.delete(opId);
      if (state.kind === "open") state.port.postMessage({ t: "stream-abort", opId });
    },
    streamAck: (opId: string, seq: number) => {
      if (state.kind === "open") state.port.postMessage({ t: "stream-ack", opId, seq });
    },
    onStreamMessage(handler: (message: BridgeStreamMessage) => void) {
      // Wrap each subscription so registering one callback twice still gives
      // each caller independent, idempotent release ownership.
      const subscriber = (message: BridgeStreamMessage) => handler(message);
      streamSubscribers.add(subscriber);
      return () => {
        streamSubscribers.delete(subscriber);
      };
    },
  };

  return {
    transport,
    streams,
    open,
    close: lose,
  };
}
