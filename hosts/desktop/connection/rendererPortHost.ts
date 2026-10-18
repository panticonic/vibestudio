import { createDevLogger } from "@vibestudio/dev-log";
import {
  createBridgeStreamRelay,
  bytesToBase64,
  deserializeRpcFailure,
  formatRpcFailure,
  isPanelRuntimeLeaseConflict,
  isRpcConnectionLost,
  responseEnvelopeFor,
  rpcErrorKindOf,
  RpcBoundaryError,
  serializeRpcFailure,
  stampEnvelopeCaller,
  workspaceRpcDestination,
  type AuthenticatedCaller,
  type BridgeBodyChunk,
  type BridgeStreamOpen,
  type BridgeStreamRelay,
  type RpcCallOptions,
  type RpcEnvelope,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
  type RpcStreamCancel,
  type RpcStreamFrameMessage,
  type RpcStreamRequest,
} from "@vibestudio/rpc";
import {
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  FRAME_HEAD,
} from "@vibestudio/rpc/protocol/streamCodec";
import { SESSION_CONNECTION_LOST_CODE } from "@vibestudio/rpc/protocol/remoteSession";
import type { HubWorkspaceEntry } from "@vibestudio/service-schemas/hubControl";
import type { MessagePortLike } from "./controlChannel.js";
import type { HostCall } from "./hostServices.js";
import type { ClientBindingState, PortBindingState } from "./connectionProtocol.js";
import {
  UiSessions,
  type NativeIpcCaller,
  type UiIpcRuntime,
  type WorkspaceIpcRuntime,
} from "./uiSessions.js";
import type { HostToRenderer, RendererToHost } from "./rendererPortProtocol.js";
import type {
  ConnectedServerClient,
  PanelSession,
  ScopedServerCaller,
} from "../main/serverClient.js";
import { createIpcResponsivenessReporter } from "../main/ipcResponsiveness.js";

const MAIN_CALLER = { callerId: "main", callerKind: "server" as const };
const HUB_CALLER = { callerId: "hub", callerKind: "server" as const };
const log = createDevLogger("RendererPortHost");

export interface PanelRuntimeConnection {
  runtimeEntityId: string;
  connectionId: string;
}

export interface RendererPortHostDeps {
  /** The System workspace this connection was established for. */
  workspaceId: string;
  hubControlClient: ConnectedServerClient;
  /**
   * The runtime of one workspace: this process's client for it and the
   * host-owned services main registered for it. Rejects when the workspace is
   * not (or no longer) available.
   */
  resolveWorkspace(workspaceId: string): Promise<WorkspaceIpcRuntime>;
  /** The lease a panel's session redeems, or undefined until the panel has one. */
  panelRuntimeConnection(callerId: string): Promise<PanelRuntimeConnection | undefined>;
}

type PanelSessionEntry = { session: PanelSession; leaseKey: string };

type ActiveLocalStream = {
  abort: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
};

function panelRuntimeConnectionKey(conn: PanelRuntimeConnection): string {
  return `${conn.runtimeEntityId}\u0000${conn.connectionId}`;
}

function envelopeFor(
  workspaceId: string,
  target: string,
  from: string,
  message: RpcMessage
): RpcEnvelope {
  const caller = {
    workspaceId,
    callerId: from,
    callerKind: from === "main" ? ("server" as const) : ("unknown" as const),
  };
  return { from, target, delivery: { caller }, provenance: [caller], message };
}

function callOptionsFromEnvelope(envelope: RpcEnvelope): RpcCallOptions | undefined {
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

/** What identifies one bound renderer document to the host. */
export interface BoundPort {
  caller: NativeIpcCaller;
  state: PortBindingState;
}

/**
 * Owns every renderer port bound to a session. Main creates a port per
 * renderer document and the connection process serves it: envelopes a renderer
 * sends here go straight to that principal's server session, the server's
 * messages come straight back, and the traffic never crosses main.
 *
 * A session is bound to the principal main attested when it handed out the
 * port. Nothing a renderer sends can change who it acts as.
 */
export class RendererPortHost {
  private readonly sessions = new Set<RendererPortSession>();
  /** The principal session a running client's window holds from the start, by window id. */
  private readonly heldSessions = new Map<string, () => Promise<void>>();
  private readonly clientScopes = new Map<string, { refs: number; scoped: ScopedServerCaller }>();
  private shuttingDown = false;
  readonly responsiveness = createIpcResponsivenessReporter({
    onReport: (report) => {
      const methods = report.methods
        .map(({ method, count }) => `${method}${count > 1 ? `×${count}` : ""}`)
        .join(",");
      log.warn(
        `[responsiveness] rpc ${report.kind} ` +
          `caller=${report.callerKind}:${report.callerId} count=${report.count} ` +
          `maxElapsedMs=${report.maxElapsedMs.toFixed(1)} methods=${methods}`
      );
    },
  });

  constructor(readonly deps: RendererPortHostDeps) {}

  /** Serve `port` as the session of the principal main attested for it. */
  bind(port: MessagePortLike, bound: BoundPort): void {
    if (this.shuttingDown) {
      port.close();
      throw new Error("Renderer sessions are closed");
    }
    const session = new RendererPortSession(this, port, bound);
    this.sessions.add(session);
    session.start();
  }

  /** A client window's capabilities or sealed identity changed. */
  updateClient(callerId: string, client: ClientBindingState): void {
    for (const session of this.sessions) if (session.callerId === callerId) session.client = client;
  }

  /** Every session of `callerId` ends (its window was destroyed). */
  async release(callerId: string, reason: string): Promise<void> {
    const held = this.heldSessions.get(callerId);
    this.heldSessions.delete(callerId);
    await Promise.all([
      held?.(),
      this.closeWhere((session) => session.callerId === callerId, reason),
    ]);
  }

  /** A document's session ends because the document was retired. */
  retire(callerId: string, reason: string): Promise<void> {
    return this.release(callerId, reason);
  }

  /** Identity replacement or revocation: drop UI admissions, keep the document. */
  async revokeUi(callerId: string): Promise<void> {
    await Promise.all(
      [...this.sessions]
        .filter((session) => session.callerId === callerId)
        .map((session) => session.revokeUi())
    );
  }

  /** Deliver an event from main to the panel-hosting client's document. */
  sendEventToShell(workspaceId: string, event: string, payload: unknown): void {
    if (this.shuttingDown) return;
    const envelope = envelopeFor(workspaceId, "shell", "main", {
      type: "event",
      fromId: "main",
      event,
      payload,
    });
    for (const session of this.sessions) {
      if (session.hostsPanels) session.post({ t: "message", envelope });
    }
  }

  chromeSessions(): RendererPortSession[] {
    return [...this.sessions].filter((session) => session.hostsPanels);
  }

  /** The workspace-scoped session a client principal's window shares across its documents. */
  acquireClientScope(
    window: { callerId: string; runtimeId: string },
    runtime: WorkspaceIpcRuntime
  ): { scoped: ScopedServerCaller; release(): Promise<void> } {
    const scoped = {
      callerId: window.runtimeId,
      callerKind: "client" as const,
      instanceId: window.callerId,
    };
    const entry = this.clientScopes.get(window.callerId) ?? { refs: 0, scoped };
    entry.refs += 1;
    this.clientScopes.set(window.callerId, entry);
    let released = false;
    return {
      scoped,
      release: async () => {
        if (released) return;
        released = true;
        const current = this.clientScopes.get(window.callerId);
        if (!current) return;
        current.refs -= 1;
        if (current.refs > 0) return;
        this.clientScopes.delete(window.callerId);
        await runtime.serverClient.releaseClientSession(scoped);
      },
    };
  }

  /**
   * A running client always holds its principal session, whether or not any
   * document ever makes an RPC: the server's authoritative close
   * (`trust-revoked`, `retired`) is observed on it and reaches the host's one
   * reaction path. The window's end releases it.
   */
  async holdClientSession(caller: NativeIpcCaller): Promise<void> {
    if (this.shuttingDown) throw new Error("Renderer sessions are closed");
    if (this.heldSessions.has(caller.callerId)) return;
    const runtime = await this.deps.resolveWorkspace(caller.workspaceId ?? this.deps.workspaceId);
    const scope = this.acquireClientScope(
      { callerId: caller.callerId, runtimeId: caller.runtimeId ?? caller.callerId },
      runtime
    );
    this.heldSessions.set(caller.callerId, scope.release);
    try {
      await runtime.serverClient.openClientSession(scope.scoped);
    } catch (error) {
      this.heldSessions.delete(caller.callerId);
      await scope.release();
      throw error;
    }
  }

  /** Close every session; the connection is going away. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const held = [...this.heldSessions.values()];
    this.heldSessions.clear();
    await Promise.all([
      ...held.map((release) => release()),
      this.closeWhere(() => true, "The desktop app is shutting down"),
    ]);
  }

  /** Forget a session that closed itself. */
  forget(session: RendererPortSession): void {
    this.sessions.delete(session);
  }

  private async closeWhere(
    predicate: (session: RendererPortSession) => boolean,
    reason: string
  ): Promise<void> {
    const ended = [...this.sessions].filter(predicate);
    await Promise.allSettled(ended.map((session) => session.close(reason)));
  }

  /**
   * Whether this client window acts as the device in routed workspaces.
   * A client holds `device-session` only when the server granted it to a
   * trusted client, and only the System workspace's client may use it.
   */
  async resolveUi(
    session: RendererPortSession,
    caller: NativeIpcCaller,
    destination: import("@vibestudio/rpc").RpcDestination
  ): Promise<UiIpcRuntime | null> {
    const client = session.client;
    if (caller.callerKind !== "client" || !client?.capabilities.includes("device-session")) {
      return null;
    }
    const identity = { workspaceId: client.workspaceId, runtimeId: client.principalId };
    const code = {
      executionDigest: client.executionDigest,
      effectiveVersion: client.effectiveVersion,
    };
    const members = async (): Promise<HubWorkspaceEntry[]> =>
      (await this.deps.hubControlClient.call(
        "hubControl",
        "listWorkspaces",
        []
      )) as HubWorkspaceEntry[];
    const admitted = (entries: HubWorkspaceEntry[]): boolean => {
      const system = entries.find((entry) => entry.privateRole === "system");
      if (system?.workspaceId !== identity.workspaceId) return false;
      return (
        destination.kind !== "workspace" ||
        entries.some((entry) => entry.workspaceId === destination.workspaceId)
      );
    };
    const first = await members();
    if (!admitted(first) || identity.workspaceId !== this.deps.workspaceId) return null;
    const workspace =
      destination.kind === "workspace"
        ? await this.deps.resolveWorkspace(destination.workspaceId)
        : undefined;
    const target: UiIpcRuntime = {
      destination,
      serverClient: workspace?.serverClient ?? this.deps.hubControlClient,
      ...(workspace ? { workspace } : {}),
    };
    // The window may have changed while membership and the runtime resolved.
    const current = session.client;
    if (
      !current?.capabilities.includes("device-session") ||
      current.workspaceId !== identity.workspaceId ||
      current.principalId !== identity.runtimeId ||
      current.executionDigest !== code.executionDigest ||
      current.effectiveVersion !== code.effectiveVersion
    ) {
      return null;
    }
    if (!admitted(await members())) return null;
    return target;
  }
}

/**
 * One renderer document's session. It owns every resource the document holds
 * in the connection process, so the document's end (port closed, window
 * destroyed, host retirement) releases all of it and nothing else.
 */
export class RendererPortSession {
  client: ClientBindingState | undefined;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly uiSessions: UiSessions;
  private uiStreamRelay: BridgeStreamRelay | null = null;
  private panelStreamRelay: BridgeStreamRelay | null = null;
  private panelSession: Promise<PanelSessionEntry> | null = null;
  private clientBridge: { unsubscribe: () => void; release: () => Promise<void> } | null = null;
  private readonly activeStreams = new Map<string, ActiveLocalStream>();

  constructor(
    private readonly host: RendererPortHost,
    private readonly port: MessagePortLike,
    private readonly bound: BoundPort
  ) {
    this.client = bound.state.client;
    this.uiSessions = new UiSessions(
      (caller, destination) => host.resolveUi(this, caller, destination),
      (_caller, envelope) => this.post({ t: "message", envelope })
    );
  }

  get caller(): NativeIpcCaller {
    return this.bound.caller;
  }

  get callerId(): string {
    return this.bound.caller.callerId;
  }

  get runtimeId(): string {
    return this.bound.caller.runtimeId ?? this.bound.caller.callerId;
  }

  get hostsPanels(): boolean {
    return this.bound.state.hostsPanels;
  }

  start(): void {
    this.port.on("message", (event) => this.receive(event.data as RendererToHost));
    // The renderer going away is the authoritative end of this session.
    this.port.on("close", () => void this.close("The renderer document ended"));
    this.port.start();
  }

  post(message: HostToRenderer): void {
    if (this.closed) return;
    try {
      this.port.postMessage(message);
    } catch (error) {
      log.warn(`Could not deliver to ${this.callerId}: ${formatRpcFailure(error)}`);
    }
  }

  /** End the session: release everything it owns, tell the renderer why, close the port. */
  close(reason: string): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.teardown(reason);
    return this.closing;
  }

  private async teardown(reason: string): Promise<void> {
    if (this.closed) return;
    const notify = !this.closed;
    if (notify) {
      try {
        this.port.postMessage({ t: "closed", reason } satisfies HostToRenderer);
      } catch {
        // The renderer is already gone.
      }
    }
    this.closed = true;
    this.host.forget(this);
    this.uiStreamRelay?.destroy(reason);
    this.panelStreamRelay?.destroy(reason);
    for (const active of this.activeStreams.values()) {
      active.abort.abort();
      void active.reader?.cancel().catch(() => undefined);
    }
    this.activeStreams.clear();
    const bridge = this.clientBridge;
    this.clientBridge = null;
    bridge?.unsubscribe();
    const panel = this.panelSession;
    this.panelSession = null;
    const results = await Promise.allSettled([
      this.uiSessions.close(),
      bridge?.release(),
      panel?.then((entry) => entry.session.close()),
    ]);
    try {
      this.port.close();
    } catch {
      // Already closed.
    }
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
      log.warn(
        `Releasing ${this.callerId} left ${failures.length} failure(s): ${failures.map(formatRpcFailure).join("; ")}`
      );
    }
  }

  /** Identity replacement/revocation must release UI sessions before the view is reused. */
  async revokeUi(): Promise<void> {
    for (const [key, active] of this.activeStreams) {
      active.abort.abort();
      void active.reader?.cancel().catch(() => undefined);
      this.activeStreams.delete(key);
    }
    this.uiStreamRelay?.destroy("Workspace UI admission revoked");
    this.uiStreamRelay = null;
    await this.uiSessions.closeCaller(this.callerId);
  }

  private receive(message: RendererToHost): void {
    if (this.closed) return;
    switch (message.t) {
      case "send": {
        const envelope = message.envelope;
        void this.routeEnvelope(envelope).catch((error: unknown) => {
          const attested = stampEnvelopeCaller(envelope, {
            callerId: this.runtimeId,
            callerKind: this.caller.callerKind,
            workspaceId: this.caller.workspaceId ?? this.host.deps.workspaceId,
          });
          const addressed =
            envelope.destination?.kind === "workspace" && envelope.destination.workspaceId
              ? envelope.destination.workspaceId
              : undefined;
          this.rejectRequestEnvelope(
            attested,
            error,
            addressed ?? this.caller.workspaceId ?? this.host.deps.workspaceId
          );
        });
        return;
      }
      case "stream-open":
        void this.streamOpen(message.message).then(
          () => this.post({ t: "reply", id: message.id }),
          (error: unknown) =>
            this.post({ t: "reply", id: message.id, error: serializeRpcFailure(error, "access") })
        );
        return;
      case "stream-body":
        void this.streamBody(message.message).then(
          () => this.post({ t: "reply", id: message.id }),
          (error: unknown) =>
            this.post({ t: "reply", id: message.id, error: serializeRpcFailure(error, "access") })
        );
        return;
      case "stream-abort":
        (this.caller.callerKind === "panel" ? this.panelStreamRelay : this.uiStreamRelay)?.abort(
          String(message.opId)
        );
        return;
      case "stream-ack":
        (this.caller.callerKind === "panel" ? this.panelStreamRelay : this.uiStreamRelay)?.ack(
          String(message.opId),
          Number(message.seq)
        );
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Streams opened by the renderer (uploads and bridge streams)
  // -------------------------------------------------------------------------

  private async streamOpen(msg: BridgeStreamOpen): Promise<void> {
    if (this.caller.callerKind === "client") {
      const owner = this.caller;
      try {
        await this.uiSessions.require(
          owner,
          msg.envelope.destination ?? {
            kind: "workspace",
            workspaceId: owner.workspaceId ?? this.host.deps.workspaceId,
          }
        );
        if (this.closed) throw new Error("Desktop app document retired");
        this.ensureUiStreamRelay(owner).open(msg);
      } catch (error) {
        // A workspace server that is briefly away is a transport condition of
        // THIS stream, not a bad caller. Report it on the stream's typed error
        // channel, which the renderer already rebuilds into a RemoteRpcError, and
        // keep loud rejection for everything that is genuinely a caller fault.
        if (!isRpcConnectionLost(error)) throw error;
        if (this.closed) return;
        this.post({
          t: "stream-message",
          message: {
            kind: "error",
            opId: msg.opId,
            error: serializeRpcFailure(error, "transport"),
          },
        });
      }
      return;
    }
    this.ensurePanelStreamRelay().open(msg);
  }

  private streamBody(msg: BridgeBodyChunk): Promise<void> {
    const relay = this.caller.callerKind === "client" ? this.uiStreamRelay : this.panelStreamRelay;
    if (!relay) {
      return Promise.reject(
        new Error(
          this.caller.callerKind === "client"
            ? "No admitted workspace UI upload stream"
            : `No open bridge upload stream for panel ${this.callerId}`
        )
      );
    }
    // The returned promise IS the backpressure: it resolves once the host's
    // reassembly buffer is back under the watermark.
    return relay.pushBodyChunk(msg);
  }

  private ensureUiStreamRelay(caller: NativeIpcCaller): BridgeStreamRelay {
    if (this.uiStreamRelay) return this.uiStreamRelay;
    const relay = createBridgeStreamRelay({
      chunkFormat: "binary",
      openStream: async (envelope, signal, body) => {
        const runtime = await this.uiSessions.require(
          caller,
          envelope.destination ?? {
            kind: "workspace",
            workspaceId: caller.workspaceId ?? this.host.deps.workspaceId,
          }
        );
        const workspace = runtime.workspace;
        const local = workspace
          ? await this.openLocalBridgeStream(envelope, signal, body, workspace)
          : null;
        if (local) return local;
        const session = await this.uiSessions.session(caller, runtime);
        if (!session.streamReadable) throw new Error("Workspace UI upload transport unavailable");
        return session.streamReadable(
          this.uiSessions.envelope(caller, runtime, envelope),
          signal,
          body
        );
      },
      sendToPanel: (message) => this.post({ t: "stream-message", message }),
    });
    this.uiStreamRelay = relay;
    return relay;
  }

  private ensurePanelStreamRelay(): BridgeStreamRelay {
    if (this.panelStreamRelay) return this.panelStreamRelay;
    const isCurrent = () => !this.closed && this.panelStreamRelay === relay;
    const relay = createBridgeStreamRelay({
      chunkFormat: "binary",
      openStream: async (envelope, signal, body) => {
        if (!isCurrent()) throw new Error("Panel document retired");
        const runtime = await this.sourceRuntime();
        if (!isCurrent() || signal.aborted) throw new Error("Panel document retired");
        const local = await this.openLocalBridgeStream(envelope, signal, body, runtime);
        if (local) return local;
        const session = await this.ensurePanelSession();
        if (!isCurrent()) throw new Error("Panel document retired");
        const conn = await this.requirePanelRuntimeConnection();
        if (typeof session.streamReadable !== "function") {
          throw new Error("Streaming request bodies are unavailable on this panel's host session");
        }
        return session.streamReadable(
          stampEnvelopeCaller(envelope, { callerId: conn.runtimeEntityId, callerKind: "panel" }),
          signal,
          body
        );
      },
      sendToPanel: (message) => {
        if (isCurrent()) this.post({ t: "stream-message", message });
      },
    });
    this.panelStreamRelay = relay;
    return relay;
  }

  private async openLocalBridgeStream(
    envelope: RpcEnvelope,
    signal: AbortSignal,
    body: ReadableStream<Uint8Array> | null,
    runtime: WorkspaceIpcRuntime
  ) {
    if (signal.aborted) throw new Error("Bridge stream retired");
    const request = envelope.message;
    if (request.type !== "stream-request") return null;
    const dot = request.method.indexOf(".");
    if (
      this.caller.browser ||
      envelope.target !== "main" ||
      dot <= 0 ||
      (envelope.destination &&
        workspaceRpcDestination(envelope.destination) !== runtime.workspaceId) ||
      !runtime.dispatcher.hasService(request.method.slice(0, dot))
    )
      return null;
    const result = await runtime.dispatcher.dispatch(
      {
        ...this.hostCall(runtime.workspaceId, request.requestId, envelope),
        signal,
        body,
      },
      request.method.slice(0, dot),
      request.method.slice(dot + 1),
      request.args
    );
    if (!(result instanceof Response)) {
      throw new Error(`Streaming method ${request.method} did not return a Response`);
    }
    return {
      status: result.status,
      statusText: result.statusText,
      finalUrl: result.url,
      headers: Array.from(result.headers.entries()),
      body:
        result.body ??
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
  }

  // -------------------------------------------------------------------------
  // Envelope routing
  // -------------------------------------------------------------------------

  private hostCall(
    workspaceId: string,
    requestId: string,
    envelope: RpcEnvelope
  ): Omit<HostCall, "signal" | "body"> {
    return {
      workspaceId,
      callerId: this.callerId,
      callerKind: this.caller.callerKind,
      requestId,
      ...(envelope.delivery.idempotencyKey
        ? { idempotencyKey: envelope.delivery.idempotencyKey }
        : {}),
      ...(envelope.delivery.readOnly ? { readOnly: true } : {}),
    };
  }

  private sourceRuntime(): Promise<WorkspaceIpcRuntime> {
    return this.host.deps.resolveWorkspace(this.caller.workspaceId ?? this.host.deps.workspaceId);
  }

  private async routeEnvelope(envelope: RpcEnvelope): Promise<void> {
    const caller = this.caller;
    const workspaceId = caller.workspaceId ?? this.host.deps.workspaceId;
    if (envelope.destination)
      envelope = stampEnvelopeCaller(envelope, {
        callerId: this.runtimeId,
        callerKind: caller.callerKind,
        workspaceId,
      });
    {
      const uiRuntime = await this.uiSessions.admit(
        caller,
        envelope.destination ?? { kind: "workspace", workspaceId }
      );
      if (uiRuntime) {
        if (this.closed) return;
        const message = envelope.message;
        const method = "method" in message ? message.method : "";
        const workspaceRuntime = uiRuntime.workspace;
        const local =
          workspaceRuntime &&
          envelope.target === "main" &&
          workspaceRuntime.dispatcher.hasService(method.split(".")[0] ?? "");
        if (
          local ||
          (workspaceRuntime &&
            message.type === "stream-cancel" &&
            this.activeStreams.has(this.streamKey(message.requestId, workspaceRuntime.workspaceId)))
        ) {
          await this.handleEnvelope(envelope, workspaceRuntime!);
        } else {
          const session = await this.uiSessions.session(caller, uiRuntime);
          await session.send(this.uiSessions.envelope(caller, uiRuntime, envelope));
        }
        return;
      }
    }
    if (envelope.destination?.kind === "hub")
      throw new RpcBoundaryError("This renderer is not admitted as hub UI", "access");
    const runtime = await this.sourceRuntime();
    if (envelope.destination) {
      envelope = stampEnvelopeCaller(envelope, {
        callerId: this.runtimeId,
        callerKind: caller.callerKind,
        workspaceId: runtime.workspaceId,
      });
    }
    if (caller.callerKind === "panel") {
      // Service ownership belongs to the host. The renderer sends the same
      // envelope for native and server services and never needs a routing API.
      const message = envelope.message;
      const method = "method" in message ? message.method : "";
      const dot = method.indexOf(".");
      const local =
        envelope.target === "main" &&
        (message.type === "request" || message.type === "stream-request") &&
        (!envelope.destination ||
          workspaceRpcDestination(envelope.destination) === runtime.workspaceId) &&
        dot > 0 &&
        runtime.dispatcher.hasService(method.slice(0, dot));
      if (local && caller.browser)
        throw new RpcBoundaryError("This native endpoint is closed to websites", "access");
      const cancelLocal =
        message.type === "stream-cancel" &&
        this.activeStreams.has(this.streamKey(message.requestId, runtime.workspaceId));
      if (local || cancelLocal) {
        await this.handleEnvelope(
          stampEnvelopeCaller(envelope, {
            callerId: this.runtimeId,
            callerKind: caller.callerKind,
            workspaceId: runtime.workspaceId,
          }),
          runtime
        );
        return;
      }
      // Remote operations retain the panel's dedicated principal and session.
      this.relayPanelEnvelope(envelope, runtime);
      return;
    }
    if (caller.callerKind !== "client") {
      log.warn(
        `Rejecting rpc from unauthorized sender (${this.callerId}, kind=${caller.callerKind})`
      );
      this.rejectRequestEnvelope(envelope, "This sender is not authorized for RPC.");
      return;
    }
    await this.ensureClientMessageBridge(runtime);
    if (envelope.target !== "main") {
      void runtime.serverClient
        .sendAs(
          { callerId: this.runtimeId, callerKind: caller.callerKind, instanceId: this.callerId },
          stampEnvelopeCaller(envelope, { callerId: this.runtimeId, callerKind: caller.callerKind })
        )
        .catch((error: unknown) => {
          this.rejectRequestEnvelope(envelope, error);
        });
      return;
    }
    void this.handleEnvelope(envelope, runtime);
  }

  private streamKey(requestId: string, workspaceId: string): string {
    return `${workspaceId}\u0000${requestId}`;
  }

  private cancelLocalStream(message: RpcStreamCancel, workspaceId: string): void {
    const active = this.activeStreams.get(this.streamKey(message.requestId, workspaceId));
    if (!active) return;
    active.abort.abort();
    void active.reader?.cancel().catch(() => {});
  }

  private async handleEnvelope(envelope: RpcEnvelope, runtime: WorkspaceIpcRuntime): Promise<void> {
    const message = envelope.message;
    const targetId = envelope.target;
    if (message.type === "stream-cancel") {
      this.cancelLocalStream(message, runtime.workspaceId);
      return;
    }
    if (message.type === "stream-request" && targetId === "main") {
      await this.handleStreamRequest(envelope, message, runtime);
      return;
    }
    if (message.type === "request" && targetId === "main") {
      const req = message as RpcRequest;
      const callOptions = callOptionsFromEnvelope(envelope);
      const dotIndex = req.method.indexOf(".");
      if (dotIndex === -1) {
        this.sendResponse(
          envelope,
          {
            type: "response",
            requestId: req.requestId,
            error: { message: `Invalid method format: ${req.method}`, errorKind: "protocol" },
          },
          runtime.workspaceId
        );
        return;
      }
      const service = req.method.slice(0, dotIndex);
      const method = req.method.slice(dotIndex + 1);
      const startedAt = performance.now();
      let outcome: "ok" | "error" = "ok";
      const callerKind = this.caller.callerKind;
      const call = this.hostCall(runtime.workspaceId, req.requestId, envelope);

      try {
        let result: unknown;
        if (runtime.dispatcher.hasService(service)) {
          if (
            envelope.destination &&
            workspaceRpcDestination(envelope.destination) !== runtime.workspaceId
          ) {
            throw new RpcBoundaryError(
              "Native services require the destination workspace's admitted UI host",
              "access"
            );
          }
          // A registered Electron endpoint has one explicit local owner. All
          // other names belong to the authenticated workspace session.
          result = await runtime.dispatcher.dispatch(call, service, method, req.args);
        } else {
          // Server is the default owner so newly registered userland/workerd
          // services are reachable without a shared routing-list update.
          if (callerKind === "client") {
            try {
              authorizeClientServerCall(this.callerId, this.client?.capabilities, service);
            } catch (cause) {
              const text = formatRpcFailure(cause);
              const code = (cause as { code?: unknown } | null)?.code;
              throw new RpcBoundaryError(
                text,
                "access",
                typeof code === "string" ? code : undefined,
                cause
              );
            }
            try {
              const scoped = {
                callerId: this.runtimeId,
                callerKind,
                instanceId: this.callerId,
              };
              result = callOptions
                ? await runtime.serverClient.callAs(scoped, service, method, req.args, callOptions)
                : await runtime.serverClient.callAs(scoped, service, method, req.args);
            } catch (error) {
              // Observe the executed server boundary, never a pre-dispatch authorization refusal.
              runtime.dispatcher.observeFailure(call, service, method, error);
              throw error;
            }
          } else {
            throw new Error(`Server RPC relay is not available for ${callerKind} callers`);
          }
        }
        this.sendResponse(
          envelope,
          { type: "response", requestId: req.requestId, result },
          runtime.workspaceId
        );
      } catch (err) {
        outcome = "error";
        this.sendResponse(
          envelope,
          {
            type: "response",
            requestId: req.requestId,
            error: serializeRpcFailure(err, "internal"),
          },
          runtime.workspaceId
        );
      } finally {
        this.host.responsiveness.observe({
          callerId: this.callerId,
          callerKind,
          method: `${service}.${method}`,
          outcome,
          elapsedMs: performance.now() - startedAt,
        });
      }
    }
  }

  private workspaceReplyEnvelope(envelope: RpcEnvelope): RpcEnvelope {
    return envelope.destination
      ? {
          ...envelope,
          delivery: {
            ...envelope.delivery,
            caller: {
              ...envelope.delivery.caller,
              workspaceId: envelope.delivery.caller.workspaceId ?? this.host.deps.workspaceId,
            },
          },
        }
      : envelope;
  }

  private sendResponse(
    requestEnvelope: RpcEnvelope,
    response: RpcResponse,
    responderWorkspaceId = this.host.deps.workspaceId,
    responder: AuthenticatedCaller = { ...MAIN_CALLER, workspaceId: responderWorkspaceId }
  ): void {
    this.post({
      t: "message",
      envelope: responseEnvelopeFor(
        this.workspaceReplyEnvelope(requestEnvelope),
        responder,
        response
      ),
    });
  }

  private sendStreamFrame(
    requestEnvelope: RpcEnvelope,
    requestId: string,
    frameType: number,
    payload: string,
    responderWorkspaceId = this.host.deps.workspaceId,
    responder: AuthenticatedCaller = { ...MAIN_CALLER, workspaceId: responderWorkspaceId }
  ): void {
    if (this.closed) throw new Error("RPC stream renderer was destroyed");
    const frame: RpcStreamFrameMessage = {
      type: "stream-frame",
      requestId,
      fromId: "main",
      frameType,
      payload,
    };
    this.post({
      t: "message",
      envelope: responseEnvelopeFor(this.workspaceReplyEnvelope(requestEnvelope), responder, frame),
    });
  }

  private async handleStreamRequest(
    envelope: RpcEnvelope,
    request: RpcStreamRequest,
    runtime: WorkspaceIpcRuntime
  ): Promise<void> {
    const key = this.streamKey(request.requestId, runtime.workspaceId);
    if (this.activeStreams.has(key)) {
      this.sendStreamFrame(
        envelope,
        request.requestId,
        FRAME_ERROR,
        JSON.stringify({
          status: 409,
          error: {
            message: `Duplicate streaming request id: ${request.requestId}`,
            errorKind: "protocol",
          },
        }),
        runtime.workspaceId
      );
      return;
    }

    const dotIndex = request.method.indexOf(".");
    if (dotIndex === -1) {
      this.sendStreamFrame(
        envelope,
        request.requestId,
        FRAME_ERROR,
        JSON.stringify({
          status: 400,
          error: { message: `Invalid method format: ${request.method}`, errorKind: "protocol" },
        }),
        runtime.workspaceId
      );
      return;
    }

    const service = request.method.slice(0, dotIndex);
    const method = request.method.slice(dotIndex + 1);
    const abort = new AbortController();
    const active: ActiveLocalStream = { abort, reader: null };
    this.activeStreams.set(key, active);

    try {
      let response: Response;
      if (runtime.dispatcher.hasService(service)) {
        if (
          envelope.destination &&
          workspaceRpcDestination(envelope.destination) !== runtime.workspaceId
        ) {
          throw new RpcBoundaryError(
            "Native services require the destination workspace's admitted UI host",
            "access"
          );
        }
        const result = await runtime.dispatcher.dispatch(
          {
            ...this.hostCall(runtime.workspaceId, request.requestId, envelope),
            signal: abort.signal,
          },
          service,
          method,
          request.args
        );
        if (!(result instanceof Response)) {
          throw new Error(`Streaming method ${request.method} did not return a Response`);
        }
        response = result;
      } else if (this.caller.callerKind === "client") {
        authorizeClientServerCall(this.callerId, this.client?.capabilities, service);
        response = await runtime.serverClient.streamAs(
          { callerId: this.runtimeId, callerKind: "client", instanceId: this.callerId },
          service,
          method,
          request.args,
          {
            signal: abort.signal,
            ...(envelope.destination ? { destination: envelope.destination } : {}),
            ...(envelope.delivery.idempotencyKey
              ? { idempotencyKey: envelope.delivery.idempotencyKey }
              : {}),
            ...(envelope.delivery.readOnly ? { readOnly: true } : {}),
          }
        );
      } else {
        throw new Error(
          `Server RPC stream relay is not available for ${this.caller.callerKind} callers`
        );
      }

      if (abort.signal.aborted) {
        await response.body?.cancel().catch(() => {});
        return;
      }

      this.sendStreamFrame(
        envelope,
        request.requestId,
        FRAME_HEAD,
        JSON.stringify({
          status: response.status,
          statusText: response.statusText,
          headerPairs: Array.from(response.headers.entries()),
          finalUrl: response.url,
        }),
        runtime.workspaceId
      );

      let bytesIn = 0;
      if (response.body) {
        const reader = response.body.getReader();
        active.reader = reader;
        while (true) {
          if (abort.signal.aborted) return;
          const next = await reader.read();
          if (next.done) break;
          bytesIn += next.value.byteLength;
          this.sendStreamFrame(
            envelope,
            request.requestId,
            FRAME_DATA,
            bytesToBase64(next.value),
            runtime.workspaceId
          );
        }
      }
      if (!abort.signal.aborted) {
        this.sendStreamFrame(
          envelope,
          request.requestId,
          FRAME_END,
          JSON.stringify({ bytesIn }),
          runtime.workspaceId
        );
      }
    } catch (error) {
      if (!abort.signal.aborted && !this.closed) {
        this.sendStreamFrame(
          envelope,
          request.requestId,
          FRAME_ERROR,
          JSON.stringify({ status: 502, error: serializeRpcFailure(error, "transport") }),
          runtime.workspaceId
        );
      }
    } finally {
      active.reader?.releaseLock();
      this.activeStreams.delete(key);
    }
  }

  private rejectRequestEnvelope(
    envelope: RpcEnvelope,
    error: unknown,
    responderWorkspaceId = this.host.deps.workspaceId
  ): void {
    const errorKind = rpcErrorKindOf(error, "access");
    const message = envelope.message;
    const responder = envelope.destination?.kind === "hub" ? HUB_CALLER : undefined;
    if (message?.type === "stream-request") {
      // A stream has no response envelope, so silence here would strand the
      // renderer's pending reader forever. Fail it the same way an in-flight
      // stream failure does.
      if (this.closed) return;
      this.sendStreamFrame(
        envelope,
        (message as RpcStreamRequest).requestId,
        FRAME_ERROR,
        JSON.stringify({
          status: errorKind === "access" ? 403 : 502,
          error: serializeRpcFailure(error, "access"),
        }),
        responderWorkspaceId,
        responder
      );
      return;
    }
    if (message?.type !== "request") return;
    this.sendResponse(
      envelope,
      {
        type: "response",
        requestId: (message as RpcRequest).requestId,
        error: serializeRpcFailure(error, "access"),
      },
      responderWorkspaceId,
      responder
    );
  }

  // -------------------------------------------------------------------------
  // Panel documents
  // -------------------------------------------------------------------------

  /**
   * Route one envelope from a panel document. The owning shell is always
   * local; every other target rides the panel's dedicated panel-principal
   * session. A relay failure surfaces as an error response so the panel's
   * pending request rejects rather than hanging.
   */
  private relayPanelEnvelope(envelope: RpcEnvelope, runtime: WorkspaceIpcRuntime): void {
    // `shell` names the panel's local owning host, never a server target. Keep
    // this decision independent of the event name so new shell capabilities
    // cannot accidentally acquire a second, remote route.
    if (
      envelope.target === "shell" &&
      (!envelope.destination ||
        workspaceRpcDestination(envelope.destination) === runtime.workspaceId)
    ) {
      if (envelope.message.type !== "event") {
        this.rejectRequestEnvelope(envelope, "The local shell accepts events only");
        log.warn(`Rejected non-event envelope addressed to local shell from ${this.callerId}`);
        return;
      }
      const shells = this.host.chromeSessions();
      if (shells.length === 0) {
        log.warn(`Dropped local shell event from ${this.callerId}: shell renderer is unavailable`);
        return;
      }
      const stamped = stampEnvelopeCaller(envelope, {
        callerId: this.callerId,
        callerKind: "panel",
      });
      for (const shell of shells) shell.post({ t: "message", envelope: stamped });
      return;
    }
    void this.ensurePanelSession()
      .then(async (session) => {
        const conn = await this.requirePanelRuntimeConnection();
        return session.send(
          stampEnvelopeCaller(envelope, { callerId: conn.runtimeEntityId, callerKind: "panel" })
        );
      })
      .catch((err: unknown) => {
        const message = envelope.message;
        const errorCode = (err as { code?: string } | null)?.code;
        if (message?.type === "request") {
          this.sendResponse(envelope, {
            type: "response",
            requestId: (message as RpcRequest).requestId,
            error: serializeRpcFailure(err, "transport"),
          });
        }
        // A lost session and a lease that moved are both transitions the next
        // attempt resolves; only an unrecognised failure is worth reporting.
        if (errorCode !== SESSION_CONNECTION_LOST_CODE && !isPanelRuntimeLeaseConflict(err)) {
          log.warn(`panel relay failed for ${this.callerId}: ${formatRpcFailure(err)}`);
        }
      });
  }

  private async requirePanelRuntimeConnection(): Promise<PanelRuntimeConnection> {
    const conn = await this.host.deps.panelRuntimeConnection(this.callerId);
    if (!conn) throw new Error(`No runtime lease for panel ${this.callerId}`);
    return conn;
  }

  /**
   * Open (or reuse) the relay session for a panel principal, redeeming its
   * runtime lease. Only a TERMINALLY closed session (lease revoke / session
   * teardown) is dropped and re-opened on the current lease; a transport blip
   * is transient and the transport auto-reopens sessions (§3.3).
   */
  private async ensurePanelSession(): Promise<PanelSession> {
    let conn: PanelRuntimeConnection;
    try {
      conn = await this.requirePanelRuntimeConnection();
    } catch (err) {
      const pending = this.panelSession;
      this.panelSession = null;
      if (pending) void pending.then((entry) => entry.session.close()).catch(() => undefined);
      throw err;
    }
    if (this.closed) throw new Error("Panel document retired");
    const expectedLeaseKey = panelRuntimeConnectionKey(conn);
    const existing = this.panelSession;
    if (existing) {
      const entry = await existing;
      // Liveness = NOT terminally closed — deliberately NOT the transport
      // status (§3.3): a routine pipe reconnect reads "connecting" while the
      // transport auto-reopens its logical sessions, and recycling on that
      // transient state would terminally close a healthy session and re-mint
      // a grant on every blip. Only a terminal close (lease revoke, session
      // teardown) recycles.
      if (entry.leaseKey === expectedLeaseKey && !(entry.session.isClosed?.() ?? false)) {
        return entry.session;
      }
      if (this.panelSession === existing) this.panelSession = null;
      entry.session.close();
      return this.ensurePanelSession();
    }
    const opening: Promise<PanelSessionEntry> = this.sourceRuntime()
      .then((runtime) =>
        runtime.serverClient.openPanelSession(conn.runtimeEntityId, conn.connectionId)
      )
      .then((session) => {
        // Server→panel messages (responses, events, stream frames) go to this document.
        session.onMessage((envelope) => this.post({ t: "message", envelope }));
        return { session, leaseKey: expectedLeaseKey };
      })
      .catch((err: unknown) => {
        if (this.panelSession === opening) this.panelSession = null;
        throw err;
      });
    this.panelSession = opening;
    return (await opening).session;
  }

  /** This window's own session of its client principal delivers server messages to this document. */
  private async ensureClientMessageBridge(runtime: WorkspaceIpcRuntime): Promise<void> {
    if (this.clientBridge) return;
    const scope = this.host.acquireClientScope(this, runtime);
    const unsubscribe = runtime.serverClient.addMessageListener(scope.scoped, (envelope) =>
      this.post({ t: "message", envelope })
    );
    this.clientBridge = { unsubscribe, release: scope.release };
  }
}

/** Rebuild a control-channel failure into the error the waiting caller sees. */
export function hostFailure(failure: Parameters<typeof deserializeRpcFailure>[0]): Error {
  return deserializeRpcFailure(failure);
}
