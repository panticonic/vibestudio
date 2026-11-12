import {
  createBridgeStreamRelay,
  stampEnvelopeCaller,
  type BridgeBodyChunk,
  type BridgeStreamOpen,
  type BridgeStreamRelay,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import type { DecodedFramedStream } from "@vibestudio/rpc/protocol/streamCodec";

/**
 * The shell bridge of a headless-hosted panel.
 *
 * A panel reaches its server through `__vibestudioShell`: Electron's preload on desktop, the React-Native postMessage
 * bridge on mobile. Headless Chromium has neither, and its page origin is the panel asset façade, which serves immutable
 * GET content only; a page cannot open its own WebSocket to a server that is reachable only over Iroh. So the host
 * supplies the bridge itself, as mobile does: the page gets a `__vibestudioShell` whose messages cross a CDP runtime
 * binding, and the host relays them on the panel's own logical session (the same principal and lease connection
 * `__vibestudioPanelInit` names), stamping the identity the server authenticated. Streams use the shared bridge
 * stream relay, so bodies are ack-gated in both directions.
 */

/** The runtime binding the page posts through. */
export const SHELL_BINDING = "__vibestudioShellPost";

/** The page function the host calls to deliver one message. */
const DELIVER = "__vibestudioShellDeliver";

/** The panel's logical session on the server, as the bridge uses it. */
export interface PanelShellSession {
  callerId(): string | null;
  send(envelope: RpcEnvelope): void | Promise<void>;
  onMessage(listener: (envelope: RpcEnvelope) => void): () => void;
  streamReadable?(
    envelope: RpcEnvelope,
    signal: AbortSignal,
    body: ReadableStream<Uint8Array> | null
  ): Promise<DecodedFramedStream>;
  ready?(): Promise<void>;
  close(): Promise<void>;
}

/** Page to host. */
type PageMessage =
  | { t: "hello" }
  | { t: "envelope"; envelope: RpcEnvelope }
  | { t: "streamOpen"; msg: BridgeStreamOpen }
  | { t: "streamBodyChunk"; msg: BridgeBodyChunk }
  | { t: "streamAbort"; opId: string }
  | { t: "streamAck"; opId: string; seq: number };

/** The page script: installs `__vibestudioShell` before any panel code runs. */
export function shellBridgeScript(): string {
  return `(() => {
  const post = (message) => globalThis.${SHELL_BINDING}(JSON.stringify(message));
  const envelopeHandlers = new Set();
  const streamHandlers = new Set();
  const eventListeners = new Map();
  const recoveryHandlers = { resubscribe: new Set(), "cold-recover": new Set() };
  const bodyWaiters = new Map();
  let nextListener = 1;
  let ready;
  const readyPromise = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  globalThis.${DELIVER} = (json) => {
    const message = JSON.parse(json);
    switch (message.t) {
      case "envelope": {
        for (const handler of [...envelopeHandlers]) handler(message.envelope);
        const body = message.envelope && message.envelope.message;
        if (body && body.type === "event" && typeof body.event === "string") {
          for (const listener of [...eventListeners.values()]) {
            try { listener(body.event, body.payload); } catch (error) { console.error(error); }
          }
        }
        return;
      }
      case "stream":
        for (const handler of [...streamHandlers]) handler(message.message);
        return;
      case "bodyAck": {
        const key = message.bodyId + ":" + message.seq;
        const waiter = bodyWaiters.get(key);
        bodyWaiters.delete(key);
        if (!waiter) return;
        if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve();
        return;
      }
      case "ready":
        if (message.error) ready.reject(new Error(message.error)); else ready.resolve();
        return;
      case "recovery":
        for (const handler of [...(recoveryHandlers[message.kind] || [])]) Promise.resolve(handler()).catch(console.error);
        return;
    }
  };
  globalThis.__vibestudioShell = {
    ready: () => readyPromise,
    postEnvelope: (envelope) => post({ t: "envelope", envelope }),
    onEnvelope: (handler) => { envelopeHandlers.add(handler); return () => envelopeHandlers.delete(handler); },
    onRecovery: (kind, handler) => {
      const set = recoveryHandlers[kind];
      if (!set) return () => {};
      set.add(handler);
      return () => set.delete(handler);
    },
    addEventListener: (handler) => { const id = nextListener++; eventListeners.set(id, handler); return id; },
    removeEventListener: (id) => { eventListeners.delete(id); },
    getPanelInit: async () => globalThis.__vibestudioPanelInit,
    streamChunkFormat: "base64",
    streamOpen: (msg) => post({ t: "streamOpen", msg }),
    streamBodyChunk: (msg) => new Promise((resolve, reject) => {
      bodyWaiters.set(msg.bodyId + ":" + msg.seq, { resolve, reject });
      post({ t: "streamBodyChunk", msg });
    }),
    streamAbort: (opId) => post({ t: "streamAbort", opId }),
    streamAck: (opId, seq) => post({ t: "streamAck", opId, seq }),
    onStreamMessage: (handler) => { streamHandlers.add(handler); return () => streamHandlers.delete(handler); },
  };
  // The panel waits for the bridge to be ready before it sends anything: opening its session is the host's answer to this.
  post({ t: "hello" });
})();`;
}

/** The slice of the CDP connection the bridge needs. */
export interface ShellBridgeCdp {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  onEvent(
    listener: (event: { method: string; params: unknown; sessionId?: string }) => void
  ): () => void;
}

/**
 * One panel's bridge: the binding on its management session, and the logical session it relays to. The session opens
 * with the page's first message, so a panel that never starts holds no connection.
 */
export class PanelShellBridge {
  private session: PanelShellSession | null = null;
  private opening: Promise<PanelShellSession> | null = null;
  private relay: BridgeStreamRelay | null = null;
  private stopEvents: (() => void) | null = null;
  private stopSession: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly cdp: ShellBridgeCdp,
    private readonly cdpSessionId: string,
    private readonly openSession: () => Promise<PanelShellSession>,
    private readonly report: (message: string, error: unknown) => void = () => undefined
  ) {}

  /** Add the binding; the page script is added by the page host with the panel's init script. */
  async install(): Promise<void> {
    await this.cdp.send("Runtime.addBinding", { name: SHELL_BINDING }, this.cdpSessionId);
    this.stopEvents = this.cdp.onEvent((event) => {
      if (event.sessionId !== this.cdpSessionId || event.method !== "Runtime.bindingCalled") return;
      const params = event.params as { name?: string; payload?: string };
      if (params.name !== SHELL_BINDING || typeof params.payload !== "string") return;
      void this.receive(JSON.parse(params.payload) as PageMessage).catch((error) =>
        this.report("panel shell bridge message failed", error)
      );
    });
  }

  private deliver(message: unknown): void {
    if (this.closed) return;
    this.cdp
      .send(
        "Runtime.evaluate",
        { expression: `${DELIVER}(${JSON.stringify(JSON.stringify(message))})` },
        this.cdpSessionId
      )
      .catch((error) => {
        if (!this.closed) this.report("panel shell bridge delivery failed", error);
      });
  }

  private connect(): Promise<PanelShellSession> {
    this.opening ??= (async () => {
      try {
        const session = await this.openSession();
        await session.ready?.();
        if (this.closed) {
          await session.close();
          throw new Error("panel shell bridge closed");
        }
        this.session = session;
        this.relay = createBridgeStreamRelay({
          chunkFormat: "base64",
          openStream: (envelope, signal, body) => {
            if (!session.streamReadable) throw new Error("This panel session cannot stream.");
            return session.streamReadable(this.stamp(session, envelope), signal, body);
          },
          sendToPanel: (message) => this.deliver({ t: "stream", message }),
        });
        this.stopSession = session.onMessage((envelope) =>
          this.deliver({ t: "envelope", envelope })
        );
        this.deliver({ t: "ready" });
        return session;
      } catch (error) {
        this.deliver({ t: "ready", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    })();
    return this.opening;
  }

  private stamp(session: PanelShellSession, envelope: RpcEnvelope): RpcEnvelope {
    const callerId = session.callerId();
    if (!callerId) throw new Error("The panel session is not authenticated yet.");
    return stampEnvelopeCaller(envelope, { callerId, callerKind: "panel" });
  }

  private async receive(message: PageMessage): Promise<void> {
    const session = await this.connect();
    switch (message.t) {
      case "hello":
        return;
      case "envelope":
        await session.send(this.stamp(session, message.envelope));
        return;
      case "streamOpen":
        this.relay!.open(message.msg);
        return;
      case "streamBodyChunk":
        try {
          await this.relay!.pushBodyChunk(message.msg);
          this.deliver({ t: "bodyAck", bodyId: message.msg.bodyId, seq: message.msg.seq });
        } catch (error) {
          this.deliver({
            t: "bodyAck",
            bodyId: message.msg.bodyId,
            seq: message.msg.seq,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      case "streamAbort":
        this.relay!.abort(message.opId);
        return;
      case "streamAck":
        this.relay!.ack(message.opId, message.seq);
        return;
    }
  }

  /** The panel is unloaded: end its streams and its session. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopEvents?.();
    this.stopSession?.();
    this.relay?.destroy("panel unloaded");
    const session = this.session ?? (await this.opening?.catch(() => null)) ?? null;
    await session?.close();
  }
}
