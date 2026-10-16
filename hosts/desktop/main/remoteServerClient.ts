import { createDevLogger } from "@vibestudio/dev-log";
import {
  formatRpcFailure,
  type DecodedFramedStream,
  type RpcCallOptions,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import type { EventName, EventPayloads } from "@vibestudio/shared/events";
import type { RemoteTransportDiagnostics } from "@vibestudio/shared/types";
import { ControlChannel, StreamReply } from "../connection/controlChannel.js";
import type { ClientState } from "../connection/connectionProtocol.js";
import type {
  ClientPrincipalSessions,
  ConnectionStatus,
  HostServiceHandler,
  HostStreamHandler,
  ScopedServerCaller,
  ServerClient,
} from "./serverClient.js";

const log = createDevLogger("RemoteServerClient");

/** Statuses for which a response may not carry a body. */
const BODYLESS_STATUS = new Set([101, 204, 205, 304]);

type StreamHead = {
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;
};

function withoutLocalOptions<T extends object>(
  options: T | undefined
): {
  wire: Omit<T, "signal" | "body"> | undefined;
  signal?: AbortSignal;
  body?: ReadableStream<Uint8Array> | null;
} {
  if (!options) return { wire: undefined };
  const { signal, body, ...wire } = options as T & {
    signal?: AbortSignal;
    body?: ReadableStream<Uint8Array> | null;
  };
  return { wire: wire as Omit<T, "signal" | "body">, signal, body };
}

/**
 * A {@link ServerClient} whose connection lives in the connection utility
 * process. Main's own calls (menus, browser import, panel orchestration) go to
 * the server through the control channel; renderer traffic never does.
 *
 * It carries exactly the connection's own state: status, diagnostics, whether
 * it was retired. When the utility process ends, the channel's failure is the
 * authoritative end of every client and settles each pending call with the exit
 * reason.
 */
export class RemoteServerClient implements ServerClient {
  private state: ClientState;
  private ended: Error | null = null;
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly recoveryListeners = new Set<
    (kind: "resubscribe" | "cold-recover") => void | Promise<void>
  >();
  private readonly eventListeners = new Map<string, Set<(payload: never) => void>>();
  private readonly hostMethods = new Map<string, HostServiceHandler>();
  private readonly hostStreams = new Map<string, HostStreamHandler>();
  private principalSessions: ClientPrincipalSessions | null = null;
  nudge?: () => void;

  constructor(
    private readonly channel: ControlChannel,
    state: ClientState
  ) {
    this.state = state;
    if (state.canNudge) {
      this.nudge = () => {
        void this.channel.request("client.nudge", { handle: this.handle }).catch(() => undefined);
      };
    }
  }

  get handle(): number {
    return this.state.handle;
  }

  // -------------------------------------------------------------------------
  // Observed state, pushed by the connection process
  // -------------------------------------------------------------------------

  /** The connection process reported a status or diagnostics change. */
  applyState(state: ClientState): void {
    const changed = state.status !== this.state.status;
    this.state = state;
    if (changed) for (const listener of [...this.statusListeners]) listener(state.status);
  }

  applyDiagnostics(diagnostics: RemoteTransportDiagnostics | null): void {
    this.state = { ...this.state, diagnostics };
  }

  deliverEvent(event: string, payload: unknown): void {
    for (const listener of [...(this.eventListeners.get(event) ?? [])]) {
      (listener as (payload: unknown) => void)(payload);
    }
  }

  async runRecovery(kind: "resubscribe" | "cold-recover"): Promise<void> {
    for (const listener of [...this.recoveryListeners]) await listener(kind);
  }

  invokeHostMethod(method: string, args: unknown[], signal: AbortSignal): unknown {
    const handler = this.hostMethods.get(method);
    if (!handler) throw new Error(`No host method ${method}`);
    return handler({ args, signal });
  }

  async invokeHostStream(method: string, args: unknown[], signal: AbortSignal): Promise<Response> {
    const handler = this.hostStreams.get(method);
    if (!handler) throw new Error(`No host stream ${method}`);
    return handler({ args, signal });
  }

  sessionEnded(caller: ScopedServerCaller, reason: string): void {
    this.principalSessions?.sessionEnded(caller, reason);
  }

  grantConnection(principalId: string): Promise<string> {
    if (!this.principalSessions) {
      return Promise.reject(new Error("Client principal sessions are not admitted"));
    }
    return this.principalSessions.connectionGrant(principalId);
  }

  /** The connection process ended: this client is finished, with the exit as the reason. */
  end(reason: Error): void {
    if (this.ended) return;
    this.ended = reason;
    const wasConnected = this.state.status !== "disconnected";
    this.state = { ...this.state, status: "disconnected", closed: true };
    if (wasConnected) for (const listener of [...this.statusListeners]) listener("disconnected");
  }

  // -------------------------------------------------------------------------
  // ServerClient
  // -------------------------------------------------------------------------

  isClosed(): boolean {
    return this.ended !== null || this.state.closed;
  }

  isConnected(): boolean {
    return this.state.status === "connected";
  }

  getConnectionStatus(): ConnectionStatus {
    return this.state.status;
  }

  transportDiagnostics(): RemoteTransportDiagnostics | null {
    return this.state.diagnostics;
  }

  onRecovery(listener: (kind: "resubscribe" | "cold-recover") => void | Promise<void>): () => void {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  }

  onConnectionStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  call(
    service: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown> {
    const { wire, signal } = withoutLocalOptions(options);
    return this.channel.request(
      "client.call",
      { handle: this.handle, service, method, args, options: wire },
      { signal }
    );
  }

  callTarget(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown> {
    const { wire, signal } = withoutLocalOptions(options);
    return this.channel.request(
      "client.call",
      { handle: this.handle, target: targetId, service: "", method, args, options: wire },
      { signal }
    );
  }

  callAs(
    caller: ScopedServerCaller,
    service: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown> {
    const { wire, signal } = withoutLocalOptions(options);
    return this.channel.request(
      "client.call",
      { handle: this.handle, as: caller, service, method, args, options: wire },
      { signal }
    );
  }

  async stream(
    service: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions
  ): Promise<Response> {
    const { wire, signal, body } = withoutLocalOptions(options);
    const reply = await this.channel.requestStream<StreamHead>(
      "client.stream",
      { handle: this.handle, service, method, args, options: wire, readable: false },
      { signal, body }
    );
    return new Response(BODYLESS_STATUS.has(reply.head.status) ? null : reply.body, {
      status: reply.head.status,
      statusText: reply.head.statusText,
      headers: reply.head.headers,
    });
  }

  async streamReadable(
    service: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions
  ): Promise<DecodedFramedStream> {
    const { wire, signal, body } = withoutLocalOptions(options);
    const reply = await this.channel.requestStream<StreamHead>(
      "client.stream",
      { handle: this.handle, service, method, args, options: wire, readable: true },
      { signal, body }
    );
    return {
      status: reply.head.status,
      statusText: reply.head.statusText,
      headers: reply.head.headers,
      finalUrl: reply.head.url,
      body: reply.body,
    };
  }

  onDirectEvent<E extends EventName>(
    event: E,
    listener: (payload: EventPayloads[E]) => void
  ): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      this.eventListeners.set(event, (listeners = new Set()));
      this.fireAndObserve(
        this.channel.request("client.subscribe", { handle: this.handle, event }),
        `subscribe to ${event}`
      );
    }
    listeners.add(listener as (payload: never) => void);
    return () => {
      const current = this.eventListeners.get(event);
      if (!current?.delete(listener as (payload: never) => void) || current.size > 0) return;
      this.eventListeners.delete(event);
      if (this.ended) return;
      this.fireAndObserve(
        this.channel.request("client.unsubscribe", { handle: this.handle, event }),
        `unsubscribe from ${event}`
      );
    };
  }

  exposeHostMethod(method: string, handler: HostServiceHandler): void {
    this.hostMethods.set(method, handler);
    this.fireAndObserve(
      this.channel.request("client.expose", { handle: this.handle, method, stream: false }),
      `expose ${method}`
    );
  }

  exposeHostStream(method: string, handler: HostStreamHandler): void {
    this.hostStreams.set(method, handler);
    this.fireAndObserve(
      this.channel.request("client.expose", { handle: this.handle, method, stream: true }),
      `expose ${method}`
    );
  }

  setClientPrincipalSessions(sessions: ClientPrincipalSessions | null): void {
    this.principalSessions = sessions;
    this.fireAndObserve(
      this.channel.request("client.principal-sessions", {
        handle: this.handle,
        enabled: sessions !== null,
      }),
      "set client principal sessions"
    );
  }

  close(): Promise<void> {
    if (this.ended) return Promise.resolve();
    return this.channel.request("client.close", { handle: this.handle });
  }

  /**
   * A registration or subscription has no caller waiting for it. If it fails
   * while the channel is alive the failure is logged where it happens; if the
   * channel has ended, that end is already the reported failure.
   */
  private fireAndObserve(operation: Promise<unknown>, what: string): void {
    operation.catch((error: unknown) => {
      if (this.channel.isClosed) return;
      log.error(`Could not ${what}: ${formatRpcFailure(error)}`);
    });
  }
}

/**
 * Every {@link RemoteServerClient} of one control channel, and the routing of
 * what the connection process pushes about them.
 */
export class RemoteServerClients {
  private readonly clients = new Map<number, RemoteServerClient>();

  constructor(private readonly channel: ControlChannel) {
    channel.on("client.status", (state: ClientState) =>
      this.clients.get(state.handle)?.applyState(state)
    );
    channel.on("client.event", (event: { handle: number; event: string; payload: unknown }) =>
      this.clients.get(event.handle)?.deliverEvent(event.event, event.payload)
    );
    channel.on(
      "client.session-ended",
      (event: { handle: number; caller: ScopedServerCaller; reason: string }) =>
        this.clients.get(event.handle)?.sessionEnded(event.caller, event.reason)
    );
    channel.handle("client.recovery", ({ handle, kind }) => {
      const client = this.clients.get(handle);
      return client ? client.runRecovery(kind) : undefined;
    });
    channel.handle("clients.connection-grant", ({ handle, principalId }) => {
      const client = this.clients.get(handle);
      if (!client) throw new Error("This server client is no longer available");
      return client.grantConnection(principalId);
    });
    channel.handle("host.call", ({ handle, method, args }, context) => {
      const client = this.clients.get(handle);
      if (!client) throw new Error("This server client is no longer available");
      return client.invokeHostMethod(method, args, context.signal);
    });
    channel.handle("host.stream", async ({ handle, method, args }, context) => {
      const client = this.clients.get(handle);
      if (!client) throw new Error("This server client is no longer available");
      const response = await client.invokeHostStream(method, args, context.signal);
      return new StreamReply(
        {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
        },
        response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
      );
    });
    channel.onClose((reason) => {
      for (const client of this.clients.values()) client.end(reason);
    });
  }

  /** The client for a state the connection process reported, created once per handle. */
  adopt(state: ClientState): RemoteServerClient {
    const existing = this.clients.get(state.handle);
    if (existing) {
      existing.applyState(state);
      return existing;
    }
    const client = new RemoteServerClient(this.channel, state);
    this.clients.set(state.handle, client);
    if (this.channel.closedReason) client.end(this.channel.closedReason);
    return client;
  }

  /** The connection process released this handle; forget it. */
  forget(handle: number): void {
    this.clients.delete(handle);
  }

  get(handle: number): RemoteServerClient | undefined {
    return this.clients.get(handle);
  }
}
