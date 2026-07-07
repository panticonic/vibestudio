/**
 * IPC Dispatcher — replaces Electron-side RpcServer for shell communication.
 *
 * Listens on ipcMain for RPC messages from the shell renderer. Electron-local
 * services dispatch in-process; everything else forwards to the server.
 */

import { ipcMain, type WebContents } from "electron";
import {
  ELECTRON_LOCAL_SERVICE_NAMES,
  createBridgeStreamRelay,
  responseEnvelopeFor,
  stampEnvelopeCaller,
  type BridgeBodyChunk,
  type BridgeStreamOpen,
  type BridgeStreamRelay,
  type RpcCallOptions,
  type RpcEnvelope,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "@vibestudio/rpc";
import {
  createVerifiedCaller,
  type ServiceDispatcher,
  type VerifiedCodeIdentity,
} from "@vibestudio/shared/serviceDispatcher";
import type { PanelSession, ServerClient } from "./serverClient.js";
import type { EventService, Subscriber } from "@vibestudio/shared/eventsService";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import type { WebSocket } from "ws";
import { assertPresent } from "../lintHelpers";

/** Electron-main services that are not owned by the Vibestudio server process. */
const ELECTRON_LOCAL_SERVICES: ReadonlySet<string> = new Set(ELECTRON_LOCAL_SERVICE_NAMES);

const MAIN_CALLER = { callerId: "main", callerKind: "server" as const };

type PanelRuntimeConnection = { runtimeEntityId: string; connectionId: string };

type PanelSessionEntry = {
  session: PanelSession;
  leaseKey: string;
};

function panelRuntimeConnectionKey(conn: PanelRuntimeConnection): string {
  return `${conn.runtimeEntityId}\u0000${conn.connectionId}`;
}

function envelopeFor(target: string, from: string, message: RpcMessage): RpcEnvelope {
  const caller = {
    callerId: from,
    callerKind: from === "main" ? ("server" as const) : ("unknown" as const),
  };
  return {
    from,
    target,
    delivery: { caller },
    provenance: [caller],
    message,
  };
}

function callOptionsFromEnvelope(envelope: RpcEnvelope): RpcCallOptions | undefined {
  const options: RpcCallOptions = {};
  if (envelope.delivery.idempotencyKey) options.idempotencyKey = envelope.delivery.idempotencyKey;
  if (envelope.delivery.readOnly === true) options.readOnly = true;
  return options.idempotencyKey || options.readOnly ? options : undefined;
}

function callServer(
  serverClient: ServerClient,
  service: string,
  method: string,
  args: unknown[],
  options: RpcCallOptions | undefined
): Promise<unknown> {
  return options
    ? serverClient.call(service, method, args, options)
    : serverClient.call(service, method, args);
}

function callServerAs(
  serverClient: ServerClient,
  caller: { callerId: string; callerKind: CallerKind },
  service: string,
  method: string,
  args: unknown[],
  options: RpcCallOptions | undefined
): Promise<unknown> {
  return options
    ? serverClient.callAs(caller, service, method, args, options)
    : serverClient.callAs(caller, service, method, args);
}

export interface IpcDispatcherDeps {
  /** Electron-local service dispatcher */
  dispatcher: ServiceDispatcher;
  /** Server client for forwarding server-service calls */
  serverClient: ServerClient;
  getShellWebContents: () => WebContents | null;
  resolveCallerForWebContents: (
    webContentsId: number
  ) => { callerId: string; callerKind: "shell" | "panel" | "app" } | null;
  getCodeIdentityForCaller?: (callerId: string) => VerifiedCodeIdentity | null;
  getWebContentsForCaller: (callerId: string) => WebContents | null;
  /**
   * Runtime entity id + lease connectionId for a panel, used to open its
   * per-panel relay session. Undefined until the panel's runtime lease exists.
   */
  getPanelRuntimeConnection?: (panelId: string) => PanelRuntimeConnection | undefined;
  authorizeAppServerCall?: (
    callerId: string,
    service: string,
    method: string,
    args: readonly unknown[]
  ) => void;
  onServerRpcResult?: (event: {
    callerId: string;
    callerKind: CallerKind;
    service: string;
    method: string;
    args: readonly unknown[];
    result: unknown;
  }) => Promise<void> | void;
  /** EventService for registering IPC-backed shell subscriber */
  eventService: EventService;
}

/**
 * IPC-backed subscriber for shell event delivery.
 * Implements the Subscriber interface used by EventService, delivering
 * events via webContents.send instead of WebSocket.
 */
class IpcSubscriber implements Subscriber {
  private destroyed = false;
  private destroyHandlers: (() => void)[] = [];

  constructor(
    private getWebContents: () => WebContents | null,
    private readonly callerId: string,
    readonly callerKind: CallerKind
  ) {}

  get isAlive(): boolean {
    const wc = this.getWebContents();
    return !this.destroyed && !!wc && !wc.isDestroyed();
  }

  send(channel: string, payload: unknown): void {
    if (!this.isAlive) return;
    const wc = assertPresent(this.getWebContents());
    // Deliver as an RPC event message that the shell transport understands
    wc.send(
      "vibestudio:rpc:message",
      envelopeFor(this.callerId, "main", {
        type: "event",
        fromId: "main",
        event: channel,
        payload,
      })
    );
  }

  isBoundTo(_ws: WebSocket): boolean {
    // IPC subscriber is never bound to a WebSocket
    return false;
  }

  onDestroyed(handler: () => void): void {
    this.destroyHandlers.push(handler);
  }

  destroy(): void {
    this.destroyed = true;
    for (const handler of this.destroyHandlers) handler();
  }
}

export class IpcDispatcher {
  private deps: IpcDispatcherDeps;
  private readonly appMessageBridges = new Map<string, () => void>();
  private readonly appEventSubscribers = new Map<string, IpcSubscriber>();
  /** One relay session per panel principal (callerId = panel view id). */
  private readonly panelSessions = new Map<string, Promise<PanelSessionEntry>>();
  /** webContents ids with a destroy teardown attached (so we attach it once). */
  private readonly panelDestroyHooked = new Set<number>();
  /** §1.6 upload relays, one per panel principal (see @vibestudio/rpc bridgeStream.ts). */
  private readonly panelStreamRelays = new Map<string, BridgeStreamRelay>();

  constructor(deps: IpcDispatcherDeps) {
    this.deps = deps;

    // Register an IPC-backed subscriber for the shell so EventService can push
    // events to it without requiring a WebSocket connection.
    const shellSubscriber = new IpcSubscriber(deps.getShellWebContents, "shell", "shell");
    deps.eventService.registerSubscriber("shell", shellSubscriber);

    ipcMain.on("vibestudio:rpc:send", (event, envelope: RpcEnvelope) => {
      const caller = this.deps.resolveCallerForWebContents(event.sender.id);
      if (!caller) {
        console.warn(
          `[IpcDispatcher] Rejecting vibestudio:rpc:send from unresolved sender ` +
            `(webContentsId=${event.sender.id})`
        );
        return;
      }
      if (caller.callerKind === "panel") {
        // A panel's FULL RPC surface (requests, routed DO calls, events, streams)
        // rides a dedicated panel-principal session — handleEnvelope's request→main
        // path is shell/app only. Desktop analogue of the mobile bridge relay.
        this.relayPanelEnvelope(event.sender, caller.callerId, envelope);
        return;
      }
      if (caller.callerKind !== "shell" && caller.callerKind !== "app") {
        console.warn(
          `[IpcDispatcher] Rejecting vibestudio:rpc:send from unauthorized sender ` +
            `(webContentsId=${event.sender.id}, kind=${caller.callerKind})`
        );
        return;
      }
      if (caller.callerKind === "app") {
        this.ensureAppMessageBridge(caller.callerId);
        this.ensureAppEventSubscriber(caller.callerId);
      }
      this.handleEnvelope(event.sender, caller.callerId, caller.callerKind, envelope);
    });

    // §1.6 upload hop: a panel's streaming REQUEST body crosses the bridge as
    // sequenced chunk messages (postMessage/contextBridge have no stream type);
    // the relay reassembles it and feeds the panel session's first-class
    // streamReadable(). invoke()-backed channels reject loudly on bad callers /
    // malformed messages — a body is never silently dropped.
    ipcMain.handle("vibestudio:rpc:stream-open", (event, msg: BridgeStreamOpen) => {
      const caller = this.requirePanelCaller(event.sender.id, "stream-open");
      this.ensurePanelStreamRelay(event.sender, caller.callerId).open(msg);
    });
    ipcMain.handle("vibestudio:rpc:stream-body-chunk", (event, msg: BridgeBodyChunk) => {
      const caller = this.requirePanelCaller(event.sender.id, "stream-body-chunk");
      const relay = this.panelStreamRelays.get(caller.callerId);
      if (!relay) {
        throw new Error(`No open bridge upload stream for panel ${caller.callerId}`);
      }
      // The returned promise IS the backpressure: it resolves once the host's
      // reassembly buffer is back under the watermark.
      return relay.pushBodyChunk(msg);
    });
    ipcMain.on("vibestudio:rpc:stream-abort", (event, opId: unknown) => {
      const caller = this.deps.resolveCallerForWebContents(event.sender.id);
      if (!caller || caller.callerKind !== "panel") return;
      this.panelStreamRelays.get(caller.callerId)?.abort(String(opId));
    });
    ipcMain.on("vibestudio:rpc:stream-ack", (event, payload: { opId?: unknown; seq?: unknown }) => {
      const caller = this.deps.resolveCallerForWebContents(event.sender.id);
      if (!caller || caller.callerKind !== "panel") return;
      this.panelStreamRelays.get(caller.callerId)?.ack(String(payload?.opId), Number(payload?.seq));
    });
  }

  private requirePanelCaller(
    webContentsId: number,
    what: string
  ): { callerId: string; callerKind: "panel" } {
    const caller = this.deps.resolveCallerForWebContents(webContentsId);
    if (!caller || caller.callerKind !== "panel") {
      throw new Error(
        `Rejecting ${what} from non-panel sender ` +
          `(webContentsId=${webContentsId}, kind=${caller?.callerKind ?? "unresolved"})`
      );
    }
    return { callerId: caller.callerId, callerKind: "panel" };
  }

  /**
   * One §1.6 upload relay per panel principal. The relay opens the panel's
   * session stream (`streamReadable` — WebRTC only; the loopback WS session has
   * none and uploads fail LOUDLY) and ships the response back over
   * `vibestudio:rpc:stream-message` with ack-gated chunks.
   */
  private ensurePanelStreamRelay(sender: WebContents, callerId: string): BridgeStreamRelay {
    const existing = this.panelStreamRelays.get(callerId);
    if (existing) return existing;
    const relay = createBridgeStreamRelay({
      chunkFormat: "binary",
      openStream: async (envelope, signal, body) => {
        const session = await this.ensurePanelSession(sender, callerId);
        const conn = this.requirePanelRuntimeConnection(callerId);
        if (typeof session.streamReadable !== "function") {
          throw new Error(
            "Streaming request bodies (uploads) require the WebRTC transport; " +
              "this panel's host session cannot stream a request body"
          );
        }
        return session.streamReadable(
          stampEnvelopeCaller(envelope, { callerId: conn.runtimeEntityId, callerKind: "panel" }),
          signal,
          body
        );
      },
      sendToPanel: (msg) => {
        const wc = this.deps.getWebContentsForCaller(callerId);
        if (wc && !wc.isDestroyed()) wc.send("vibestudio:rpc:stream-message", msg);
      },
    });
    this.panelStreamRelays.set(callerId, relay);
    sender.once("destroyed", () => {
      if (this.panelStreamRelays.get(callerId) === relay) {
        this.panelStreamRelays.delete(callerId);
      }
      relay.destroy("panel webview destroyed");
    });
    return relay;
  }

  /**
   * Send an event to the shell renderer.
   */
  sendToShell(fromId: string, message: RpcMessage): void {
    const wc = this.deps.getShellWebContents();
    if (wc && !wc.isDestroyed()) {
      wc.send("vibestudio:rpc:message", envelopeFor("shell", fromId, message));
    }
  }

  /**
   * Broadcast a server event to the shell (e.g., build:complete).
   */
  broadcastEvent(event: string, payload: unknown): void {
    this.sendToShell("main", {
      type: "event",
      fromId: "main",
      event,
      payload,
    });
  }

  private async handleEnvelope(
    sender: WebContents,
    callerId: string,
    callerKind: CallerKind,
    envelope: RpcEnvelope
  ): Promise<void> {
    const message = envelope.message;
    const targetId = envelope.target;
    if (message.type === "request" && targetId === "main") {
      const req = message as RpcRequest;
      const callOptions = callOptionsFromEnvelope(envelope);
      const dotIndex = req.method.indexOf(".");
      if (dotIndex === -1) {
        this.sendResponse(sender, envelope, {
          type: "response",
          requestId: req.requestId,
          error: `Invalid method format: ${req.method}`,
        });
        return;
      }
      const service = req.method.slice(0, dotIndex);
      const method = req.method.slice(dotIndex + 1);

      try {
        let result: unknown;
        if (ELECTRON_LOCAL_SERVICES.has(service)) {
          // Dispatch locally to Electron services. The dispatcher itself
          // enforces policy via checkServiceAccess (single choke-point).
          const ctx = {
            caller: createVerifiedCaller(
              callerId,
              callerKind,
              this.deps.getCodeIdentityForCaller?.(callerId) ?? null
            ),
            requestId: req.requestId,
            ...(callOptions?.idempotencyKey ? { idempotencyKey: callOptions.idempotencyKey } : {}),
            ...(callOptions?.readOnly ? { readOnly: true } : {}),
          };
          result = await this.deps.dispatcher.dispatch(ctx, service, method, req.args);
        } else {
          // Server is the default owner so newly registered userland/workerd
          // services are reachable without a shared routing-list update.
          if (callerKind === "shell") {
            // electron-main / bootstrap launch gate are native-host `shell`
            // principals — they reach the server on the admin connection.
            // Hosted workspace chrome is an `app` and takes the app branch
            // below; there is no longer a shell→app panelTree proxy.
            result = await callServer(
              this.deps.serverClient,
              service,
              method,
              req.args,
              callOptions
            );
          } else if (callerKind === "app") {
            this.deps.authorizeAppServerCall?.(callerId, service, method, req.args);
            result = await callServerAs(
              this.deps.serverClient,
              { callerId, callerKind },
              service,
              method,
              req.args,
              callOptions
            );
          } else {
            throw new Error(`Server RPC relay is not available for ${callerKind} callers`);
          }
        }
        await this.deps.onServerRpcResult?.({
          callerId,
          callerKind,
          service,
          method,
          args: req.args,
          result,
        });
        this.sendResponse(sender, envelope, {
          type: "response",
          requestId: req.requestId,
          result,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const errorCode = (err as { code?: string })?.code;
        this.sendResponse(sender, envelope, {
          type: "response",
          requestId: req.requestId,
          error,
          ...(errorCode ? { errorCode } : {}),
        });
      }
    }
  }

  private sendResponse(
    sender: WebContents,
    requestEnvelope: RpcEnvelope,
    response: RpcResponse
  ): void {
    if (!sender.isDestroyed()) {
      sender.send(
        "vibestudio:rpc:message",
        responseEnvelopeFor(requestEnvelope, MAIN_CALLER, response)
      );
    }
  }

  /**
   * Relay one envelope from a panel webview onto its dedicated panel-principal
   * session — requests, routed DO calls, events, and streams all ride it.
   * server→panel messages return via the session's onMessage (see
   * {@link ensurePanelSession}). A relay failure surfaces as an error response so
   * the panel's pending request rejects rather than hanging.
   */
  private relayPanelEnvelope(sender: WebContents, callerId: string, envelope: RpcEnvelope): void {
    void this.ensurePanelSession(sender, callerId)
      .then((session) => {
        const conn = this.requirePanelRuntimeConnection(callerId);
        return session.send(
          stampEnvelopeCaller(envelope, { callerId: conn.runtimeEntityId, callerKind: "panel" })
        );
      })
      .catch((err: unknown) => {
        const message = envelope.message;
        if (message?.type === "request") {
          this.sendResponse(sender, envelope, {
            type: "response",
            requestId: (message as RpcRequest).requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        console.warn(
          `[IpcDispatcher] panel relay failed for ${callerId}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  private requirePanelRuntimeConnection(callerId: string): PanelRuntimeConnection {
    const conn = this.deps.getPanelRuntimeConnection?.(callerId);
    if (!conn) throw new Error(`No runtime lease for panel ${callerId}`);
    return conn;
  }

  /**
   * Open (or reuse) the relay session for a panel principal, redeeming its runtime
   * lease. Only a TERMINALLY closed session (lease revoke / session teardown) is
   * dropped and re-opened on the current lease; a transport blip is transient and
   * the transport auto-reopens sessions (§3.3). The session is closed when the
   * panel webview is destroyed.
   */
  private ensurePanelSession(sender: WebContents, callerId: string): Promise<PanelSession> {
    let conn: PanelRuntimeConnection;
    try {
      conn = this.requirePanelRuntimeConnection(callerId);
    } catch (err) {
      const pending = this.panelSessions.get(callerId);
      this.panelSessions.delete(callerId);
      if (pending) void pending.then((entry) => entry.session.close()).catch(() => undefined);
      return Promise.reject(err);
    }
    const expectedLeaseKey = panelRuntimeConnectionKey(conn);
    const existing = this.panelSessions.get(callerId);
    if (existing) {
      return existing.then((entry) => {
        // Liveness = NOT terminally closed — deliberately NOT the transport
        // status (§3.3): a routine pipe reconnect reads "connecting" while the
        // transport auto-reopens its logical sessions, and recycling on that
        // transient state would terminally close a healthy session and re-mint
        // a grant on every blip. Only a terminal close (lease revoke, session
        // teardown) recycles.
        if (entry.leaseKey === expectedLeaseKey && !(entry.session.isClosed?.() ?? false)) {
          return entry.session;
        }
        if (this.panelSessions.get(callerId) === existing) this.panelSessions.delete(callerId);
        entry.session.close();
        return this.ensurePanelSession(sender, callerId);
      });
    }
    // Tear down the relay when the panel webview is destroyed — attached once per
    // webContents (not per session re-open), closing whichever session is current.
    if (!this.panelDestroyHooked.has(sender.id)) {
      this.panelDestroyHooked.add(sender.id);
      sender.once("destroyed", () => {
        this.panelDestroyHooked.delete(sender.id);
        const pending = this.panelSessions.get(callerId);
        this.panelSessions.delete(callerId);
        if (pending) void pending.then((entry) => entry.session.close()).catch(() => undefined);
      });
    }
    const opening: Promise<PanelSessionEntry> = this.deps.serverClient
      .openPanelSession(conn.runtimeEntityId, conn.connectionId)
      .then((session) => {
        // Deliver server→panel messages (responses, events, stream frames) to the
        // panel's current webContents.
        session.onMessage((env) => {
          const wc = this.deps.getWebContentsForCaller(callerId);
          if (wc && !wc.isDestroyed()) wc.send("vibestudio:rpc:message", env);
        });
        return { session, leaseKey: expectedLeaseKey };
      })
      .catch((err: unknown) => {
        this.panelSessions.delete(callerId);
        throw err;
      });
    this.panelSessions.set(callerId, opening);
    return opening.then((entry) => entry.session);
  }

  private ensureAppMessageBridge(callerId: string): void {
    if (this.appMessageBridges.has(callerId)) return;
    const unsubscribe = this.deps.serverClient.addMessageListener(
      { callerId, callerKind: "app" },
      (envelope) => {
        const wc = this.deps.getWebContentsForCaller(callerId);
        if (!wc || wc.isDestroyed()) return;
        wc.send("vibestudio:rpc:message", envelope);
      }
    );
    this.appMessageBridges.set(callerId, unsubscribe);
  }

  private ensureAppEventSubscriber(callerId: string): void {
    const existing = this.appEventSubscribers.get(callerId);
    if (existing?.isAlive) return;
    existing?.destroy();
    const subscriber = new IpcSubscriber(
      () => this.deps.getWebContentsForCaller(callerId),
      callerId,
      "app"
    );
    subscriber.onDestroyed(() => this.appEventSubscribers.delete(callerId));
    this.appEventSubscribers.set(callerId, subscriber);
    this.deps.eventService.registerSubscriber(callerId, subscriber);
  }
}
