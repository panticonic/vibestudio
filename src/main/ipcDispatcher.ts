import { workspaceRpcDestination } from "@vibestudio/rpc";
/**
 * IPC Dispatcher — replaces Electron-side RpcServer for shell communication.
 *
 * Listens on ipcMain for RPC messages from the shell renderer. Electron-local
 * services dispatch in-process; everything else forwards to the server.
 */

import { ipcMain, type WebContents } from "electron";
import { createDevLogger } from "@vibestudio/dev-log";
import {
  createBridgeStreamRelay,
  bytesToBase64,
  isRpcConnectionLost,
  responseEnvelopeFor,
  stampEnvelopeCaller,
  rpcErrorDataOf,
  rpcErrorKindOf,
  RpcBoundaryError,
  type BridgeBodyChunk,
  type BridgeStreamOpen,
  type BridgeStreamRelay,
  type AuthenticatedCaller,
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
import {
  createHostCaller,
  createVerifiedCaller,
  type ServiceDispatcher,
  type VerifiedCodeIdentity,
} from "@vibestudio/shared/serviceDispatcher";
import {
  UiSessions,
  type NativeIpcCaller,
  type WorkspaceIpcRuntime,
  type ResolveUiRuntime,
} from "./uiSessions.js";
export type { NativeIpcCaller, WorkspaceIpcRuntime, ResolveUiRuntime } from "./uiSessions.js";
import type { PanelSession, ServerClient } from "./serverClient.js";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import { createIpcResponsivenessReporter } from "./ipcResponsiveness.js";
import { SESSION_CONNECTION_LOST_CODE } from "@vibestudio/rpc/protocol/remoteSession";

const MAIN_CALLER = { callerId: "main", callerKind: "server" as const };
const HUB_CALLER = { callerId: "hub", callerKind: "server" as const };
const log = createDevLogger("IpcDispatcher");

type PanelRuntimeConnection = { runtimeEntityId: string; connectionId: string };

type PanelSessionEntry = {
  session: PanelSession;
  leaseKey: string;
};

type ActiveIpcStream = {
  abort: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
};

function panelRuntimeConnectionKey(conn: PanelRuntimeConnection): string {
  return `${conn.runtimeEntityId}\u0000${conn.connectionId}`;
}

function localVerifiedCaller(
  callerId: string,
  callerKind: CallerKind,
  code: VerifiedCodeIdentity | null
) {
  return callerKind === "shell"
    ? createHostCaller(callerId, "shell")
    : createVerifiedCaller(callerId, callerKind, code);
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
  if (envelope.destination) options.destination = envelope.destination;
  if (envelope.delivery.idempotencyKey) options.idempotencyKey = envelope.delivery.idempotencyKey;
  if (envelope.delivery.readOnly === true) options.readOnly = true;
  return options.destination || options.idempotencyKey || options.readOnly ? options : undefined;
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
  /** Retire document admission before releasing its backing RPC transports. */
  retireDocuments?: () => Promise<void>;
  /** Authenticated workspace owning this IPC runtime; never inferred from a renderer envelope. */
  workspaceId: string;
  /** Electron-local service dispatcher */
  dispatcher: ServiceDispatcher;
  /** Server client for forwarding server-service calls */
  serverClient: ServerClient;
  getShellWebContents: () => WebContents | null;
  resolveCallerForWebContents: (webContentsId: number) => NativeIpcCaller | null;
  resolveWorkspaceRuntime?: (
    workspaceId: string
  ) => WorkspaceIpcRuntime | Promise<WorkspaceIpcRuntime>;
  resolveUiRuntime?: ResolveUiRuntime;
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
}

export class IpcDispatcher {
  private deps: IpcDispatcherDeps;
  private shuttingDown = false;
  private readonly uiSessions: UiSessions;
  private readonly uiStreamRelays = new Map<string, BridgeStreamRelay>();
  private readonly uiDestroyHooked = new Set<number>();
  private readonly appMessageBridges = new Map<string, () => void>();
  /** One relay session per panel principal (callerId = panel view id). */
  private readonly panelSessions = new Map<string, Promise<PanelSessionEntry>>();
  /** webContents ids with a destroy teardown attached (so we attach it once). */
  private readonly panelDestroyHooked = new Set<number>();
  /** §1.6 upload relays, one per panel principal (see @vibestudio/rpc bridgeStream.ts). */
  private readonly panelStreamRelays = new Map<string, BridgeStreamRelay>();
  /** Response streams carried by ordinary RPC envelopes over Electron IPC. */
  private readonly activeIpcStreams = new Map<string, ActiveIpcStream>();
  private readonly ipcStreamDestroyHooked = new Set<number>();
  private readonly responsiveness = createIpcResponsivenessReporter({
    onReport: (report) => {
      const methods = report.methods
        .map(({ method, count }) => `${method}${count > 1 ? `×${count}` : ""}`)
        .join(",");
      log.warn(
        `[responsiveness] ipc-rpc ${report.kind} ` +
          `caller=${report.callerKind}:${report.callerId} count=${report.count} ` +
          `maxElapsedMs=${report.maxElapsedMs.toFixed(1)} methods=${methods}`
      );
    },
  });

  constructor(deps: IpcDispatcherDeps) {
    this.deps = deps;
    this.uiSessions = new UiSessions(
      deps.resolveUiRuntime ?? (async () => null),
      (caller, envelope) => {
        const sender = deps.getWebContentsForCaller(caller.callerId);
        if (sender && !sender.isDestroyed()) sender.send("vibestudio:rpc:message", envelope);
      }
    );

    ipcMain.on("vibestudio:rpc:send", (event, envelope: RpcEnvelope) => {
      // Window teardown removes view ownership before Chromium has destroyed
      // every renderer. Late renderer messages are expected during that small
      // interval; dropping them lets destruction reject the renderer-side
      // promises once, instead of feeding retry loops with synthetic
      // "unresolved sender" responses and flooding shutdown logs.
      if (this.shuttingDown || event.senderFrame !== event.sender.mainFrame) return;
      const caller = this.deps.resolveCallerForWebContents(event.sender.id);
      if (!caller) {
        console.warn(
          `[IpcDispatcher] Rejecting vibestudio:rpc:send from unresolved sender ` +
            `(webContentsId=${event.sender.id})`
        );
        this.rejectRequestEnvelope(
          event.sender,
          envelope,
          "The panel or app is no longer attached."
        );
        return;
      }
      void this.routeEnvelope(event.sender, caller, envelope).catch((error: unknown) => {
        const attested = stampEnvelopeCaller(envelope, {
          callerId: caller.runtimeId ?? caller.callerId,
          callerKind: caller.callerKind,
          workspaceId: caller.workspaceId ?? this.deps.workspaceId,
        });
        const addressedWorkspaceId =
          envelope.destination?.kind === "workspace" && envelope.destination.workspaceId
            ? envelope.destination.workspaceId
            : undefined;
        this.rejectRequestEnvelope(
          event.sender,
          attested,
          error,
          addressedWorkspaceId ?? caller.workspaceId ?? this.deps.workspaceId
        );
      });
    });

    // §1.6 upload hop: a panel's streaming REQUEST body crosses the bridge as
    // sequenced chunk messages (postMessage/contextBridge have no stream type);
    // the relay reassembles it and feeds the panel session's first-class
    // streamReadable(). invoke()-backed channels reject loudly on bad callers /
    // malformed messages — a body is never silently dropped.
    ipcMain.handle("vibestudio:rpc:stream-open", (event, msg: BridgeStreamOpen) => {
      if (event.senderFrame !== event.sender.mainFrame)
        throw new Error("RPC requires the top-level document");
      const owner = this.deps.resolveCallerForWebContents(event.sender.id);
      if (owner?.callerKind === "app") {
        return this.uiSessions
          .require(
            owner,
            msg.envelope.destination ?? {
              kind: "workspace",
              workspaceId: owner.workspaceId ?? this.deps.workspaceId,
            }
          )
          .then(() => {
            const current = this.deps.resolveCallerForWebContents(event.sender.id);
            if (
              event.sender.isDestroyed() ||
              !current ||
              current.callerId !== owner.callerId ||
              current.runtimeId !== owner.runtimeId ||
              current.workspaceId !== owner.workspaceId
            )
              throw new Error("Desktop app document retired");
            this.hookUiTeardown(event.sender, owner);
            this.ensureUiStreamRelay(event.sender, owner).open(msg);
          })
          .catch((error: unknown) => {
            // A workspace server that is briefly away is a transport condition
            // of THIS stream, not a bad caller. invoke() reduces a rejection to
            // its message, which strips the connection-loss identity every
            // renderer recovery path keys on: the shell then logged unhandled
            // rejections and "recovery failed" warnings while its own retry was
            // working. Report it on the stream's typed error channel, which the
            // renderer already rebuilds into a RemoteRpcError, and keep loud
            // rejection for everything that is genuinely a caller fault.
            if (!isRpcConnectionLost(error)) throw error;
            if (event.sender.isDestroyed()) return;
            event.sender.send("vibestudio:rpc:stream-message", {
              kind: "error",
              opId: msg.opId,
              message: error instanceof Error ? error.message : String(error),
              errorKind: "transport",
              code: SESSION_CONNECTION_LOST_CODE,
            });
          });
      }
      const caller = this.requirePanelCaller(event.sender.id, "stream-open");
      this.ensurePanelStreamRelay(event.sender, caller.callerId).open(msg);
      return undefined;
    });
    ipcMain.handle("vibestudio:rpc:stream-body-chunk", (event, msg: BridgeBodyChunk) => {
      const owner = this.deps.resolveCallerForWebContents(event.sender.id);
      if (owner?.callerKind === "app") {
        const relay = this.uiStreamRelays.get(owner.callerId);
        if (!relay) throw new Error("No admitted workspace UI upload stream");
        return relay.pushBodyChunk(msg);
      }
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
      if (this.shuttingDown) return;
      const caller = this.deps.resolveCallerForWebContents(event.sender.id);
      if (!caller) return;
      (caller.callerKind === "panel" ? this.panelStreamRelays : this.uiStreamRelays)
        .get(caller.callerId)
        ?.abort(String(opId));
    });
    ipcMain.on("vibestudio:rpc:stream-ack", (event, payload: { opId?: unknown; seq?: unknown }) => {
      if (this.shuttingDown) return;
      const caller = this.deps.resolveCallerForWebContents(event.sender.id);
      if (!caller) return;
      (caller.callerKind === "panel" ? this.panelStreamRelays : this.uiStreamRelays)
        .get(caller.callerId)
        ?.ack(String(payload?.opId), Number(payload?.seq));
    });
  }

  private async sourceRuntime(caller: NativeIpcCaller): Promise<WorkspaceIpcRuntime> {
    const workspaceId = caller.workspaceId ?? this.deps.workspaceId;
    if (workspaceId === this.deps.workspaceId) return this.deps;
    const runtime = await this.deps.resolveWorkspaceRuntime?.(workspaceId);
    if (!runtime || runtime.workspaceId !== workspaceId)
      throw new Error("Native sender workspace is unavailable");
    return runtime;
  }

  private async routeEnvelope(
    sender: WebContents,
    caller: NativeIpcCaller,
    envelope: RpcEnvelope
  ): Promise<void> {
    if (envelope.destination)
      envelope = stampEnvelopeCaller(envelope, {
        callerId: caller.runtimeId ?? caller.callerId,
        callerKind: caller.callerKind,
        workspaceId: caller.workspaceId ?? this.deps.workspaceId,
      });
    {
      const uiRuntime = await this.uiSessions.admit(
        caller,
        envelope.destination ?? {
          kind: "workspace",
          workspaceId: caller.workspaceId ?? this.deps.workspaceId,
        }
      );
      if (uiRuntime) {
        if (sender.isDestroyed() || this.shuttingDown) return;
        this.hookUiTeardown(sender, caller);
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
            this.activeIpcStreams.has(
              this.ipcStreamKey(sender.id, message.requestId, workspaceRuntime.workspaceId)
            ))
        ) {
          await this.handleEnvelope(
            sender,
            caller.callerId,
            "shell",
            envelope,
            workspaceRuntime!,
            caller.runtimeId ?? caller.callerId
          );
        } else {
          const session = await this.uiSessions.session(caller, uiRuntime);
          await session.send(this.uiSessions.envelope(caller, uiRuntime, envelope));
        }
        return;
      }
    }
    if (envelope.destination?.kind === "hub")
      throw new RpcBoundaryError("This renderer is not admitted as hub UI", "access");
    const runtime = await this.sourceRuntime(caller);
    if (envelope.destination) {
      envelope = stampEnvelopeCaller(envelope, {
        callerId: caller.runtimeId ?? caller.callerId,
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
        this.activeIpcStreams.has(
          this.ipcStreamKey(sender.id, message.requestId, runtime.workspaceId)
        );
      if (local || cancelLocal) {
        await this.handleEnvelope(
          sender,
          caller.callerId,
          caller.callerKind,
          stampEnvelopeCaller(envelope, {
            callerId: caller.runtimeId ?? caller.callerId,
            callerKind: caller.callerKind,
            workspaceId: runtime.workspaceId,
          }),
          runtime,
          caller.runtimeId ?? caller.callerId
        );
        return;
      }
      // Remote operations retain the panel's dedicated principal and session.
      this.relayPanelEnvelope(sender, caller.callerId, envelope, runtime);
      return;
    }
    if (caller.callerKind !== "shell" && caller.callerKind !== "app") {
      console.warn(
        `[IpcDispatcher] Rejecting vibestudio:rpc:send from unauthorized sender ` +
          `(webContentsId=${sender.id}, kind=${caller.callerKind})`
      );
      this.rejectRequestEnvelope(sender, envelope, "This sender is not authorized for RPC.");
      return;
    }
    if (caller.callerKind === "app") {
      this.ensureAppMessageBridge(caller.callerId, runtime, caller.runtimeId ?? caller.callerId);
    }
    if (envelope.target !== "main") {
      if (caller.callerKind !== "app") {
        this.rejectRequestEnvelope(
          sender,
          envelope,
          "Only a hosted workspace app can address workspace runtime targets."
        );
        return;
      }
      void runtime.serverClient
        .sendAs(
          { callerId: caller.runtimeId ?? caller.callerId, callerKind: caller.callerKind },
          stampEnvelopeCaller(envelope, {
            callerId: caller.runtimeId ?? caller.callerId,
            callerKind: caller.callerKind,
          })
        )
        .catch((error: unknown) => {
          this.rejectRequestEnvelope(sender, envelope, error);
        });
      return;
    }
    void this.handleEnvelope(
      sender,
      caller.callerId,
      caller.callerKind,
      envelope,
      runtime,
      caller.runtimeId ?? caller.callerId
    );
  }

  private ensureUiStreamRelay(sender: WebContents, caller: NativeIpcCaller): BridgeStreamRelay {
    const existing = this.uiStreamRelays.get(caller.callerId);
    if (existing) return existing;
    const relay = createBridgeStreamRelay({
      chunkFormat: "binary",
      openStream: async (envelope, signal, body) => {
        const runtime = await this.uiSessions.require(
          caller,
          envelope.destination ?? {
            kind: "workspace",
            workspaceId: caller.workspaceId ?? this.deps.workspaceId,
          }
        );
        const workspace = runtime.workspace;
        const local = workspace
          ? await this.openLocalBridgeStream(caller, envelope, signal, body, workspace)
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
      sendToPanel: (message) => {
        if (!sender.isDestroyed()) sender.send("vibestudio:rpc:stream-message", message);
      },
    });
    this.uiStreamRelays.set(caller.callerId, relay);
    return relay;
  }

  private async openLocalBridgeStream(
    caller: NativeIpcCaller,
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
      caller.browser ||
      envelope.target !== "main" ||
      dot <= 0 ||
      (envelope.destination &&
        workspaceRpcDestination(envelope.destination) !== runtime.workspaceId) ||
      !runtime.dispatcher.hasService(request.method.slice(0, dot))
    )
      return null;
    const result = await runtime.dispatcher.dispatch(
      {
        caller: localVerifiedCaller(
          caller.callerId,
          caller.callerKind === "app" ? "shell" : caller.callerKind,
          this.deps.getCodeIdentityForCaller?.(caller.callerId) ?? null
        ),
        requestId: request.requestId,
        signal,
        ...(body ? { body } : {}),
        ...(envelope.delivery.idempotencyKey
          ? { idempotencyKey: envelope.delivery.idempotencyKey }
          : {}),
        ...(envelope.delivery.readOnly ? { readOnly: true } : {}),
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

  /** Identity replacement/revocation must release sessions before reusing a native view. */
  async revokeUiCaller(callerId: string): Promise<void> {
    const sender = this.deps.getWebContentsForCaller(callerId);
    if (sender) {
      const prefix = `${sender.id}\u0000`;
      for (const [key, active] of this.activeIpcStreams) {
        if (!key.startsWith(prefix)) continue;
        active.abort.abort();
        void active.reader?.cancel().catch(() => undefined);
        this.activeIpcStreams.delete(key);
      }
    }
    this.uiStreamRelays.get(callerId)?.destroy("Workspace UI admission revoked");
    this.uiStreamRelays.delete(callerId);
    await this.uiSessions.closeCaller(callerId);
  }

  private hookUiTeardown(sender: WebContents, caller: NativeIpcCaller): void {
    if (this.uiDestroyHooked.has(sender.id)) return;
    this.uiDestroyHooked.add(sender.id);
    sender.once("destroyed", () => {
      this.uiDestroyHooked.delete(sender.id);
      void this.revokeUiCaller(caller.callerId);
    });
  }

  /**
   * Stop accepting renderer work before views and the shared Iroh session are
   * dismantled. This is a lifecycle barrier, not just log suppression: every
   * owned stream, panel session, and app event subscription is released while
   * its backing transport still exists.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const documentRetirement = this.deps.retireDocuments?.();
    for (const relay of this.uiStreamRelays.values()) relay.destroy("Desktop app shutting down");
    this.uiStreamRelays.clear();
    await this.uiSessions.close();

    for (const unsubscribe of this.appMessageBridges.values()) unsubscribe();
    this.appMessageBridges.clear();

    for (const active of this.activeIpcStreams.values()) {
      active.abort.abort();
      void active.reader?.cancel().catch(() => undefined);
    }
    this.activeIpcStreams.clear();

    for (const relay of this.panelStreamRelays.values()) {
      relay.destroy("desktop app shutting down");
    }
    this.panelStreamRelays.clear();

    await documentRetirement;
    const sessions = [...this.panelSessions.values()];
    this.panelSessions.clear();
    await Promise.allSettled(
      sessions.map(async (entry) => {
        const resolved = await entry;
        await resolved.session.close();
      })
    );
  }

  retirePanelDocument(callerId: string): void {
    const pending = this.panelSessions.get(callerId);
    this.panelSessions.delete(callerId);
    if (pending) void pending.then((entry) => entry.session.close()).catch(() => {});
    this.panelStreamRelays.get(callerId)?.destroy("Website document retired");
    this.panelStreamRelays.delete(callerId);
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
   * session stream (`streamReadable`) and ships the response back over
   * `vibestudio:rpc:stream-message` with ack-gated chunks.
   */
  private ensurePanelStreamRelay(sender: WebContents, callerId: string): BridgeStreamRelay {
    const existing = this.panelStreamRelays.get(callerId);
    if (existing) return existing;
    const frame = sender.mainFrame;
    const documentId = this.deps.resolveCallerForWebContents(sender.id)?.documentId;
    const isCurrent = () =>
      !sender.isDestroyed() &&
      sender.mainFrame === frame &&
      this.deps.resolveCallerForWebContents(sender.id)?.documentId === documentId &&
      this.panelStreamRelays.get(callerId) === relay;
    const relay = createBridgeStreamRelay({
      chunkFormat: "binary",
      openStream: async (envelope, signal, body) => {
        if (!isCurrent()) throw new Error("Panel document retired");
        const caller = this.deps.resolveCallerForWebContents(sender.id);
        if (!caller || caller.callerKind !== "panel") throw new Error("Panel document retired");
        const runtime = await this.sourceRuntime(caller);
        if (!isCurrent() || signal.aborted) throw new Error("Panel document retired");
        const local = await this.openLocalBridgeStream(caller, envelope, signal, body, runtime);
        if (local) return local;
        const session = await this.ensurePanelSession(sender, callerId);
        if (!isCurrent()) throw new Error("Panel document retired");
        const conn = this.requirePanelRuntimeConnection(callerId);
        if (typeof session.streamReadable !== "function") {
          throw new Error("Streaming request bodies are unavailable on this panel's host session");
        }
        return session.streamReadable(
          stampEnvelopeCaller(envelope, { callerId: conn.runtimeEntityId, callerKind: "panel" }),
          signal,
          body
        );
      },
      sendToPanel: (msg) => {
        const wc = this.deps.getWebContentsForCaller(callerId);
        if (wc === sender && isCurrent()) wc.send("vibestudio:rpc:stream-message", msg);
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

  /** Relay an authenticated workspace session's event to its shell UI client. */
  sendEventToShell(workspaceId: string, event: string, payload: unknown): void {
    if (this.shuttingDown) return;
    const wc = this.deps.getShellWebContents();
    if (wc && !wc.isDestroyed()) {
      wc.send(
        "vibestudio:rpc:message",
        envelopeFor(workspaceId, "shell", "main", {
          type: "event",
          fromId: "main",
          event,
          payload,
        })
      );
    }
  }

  private async handleEnvelope(
    sender: WebContents,
    callerId: string,
    callerKind: CallerKind,
    envelope: RpcEnvelope,
    runtime: WorkspaceIpcRuntime = this.deps,
    runtimeId = callerId
  ): Promise<void> {
    const message = envelope.message;
    const targetId = envelope.target;
    if (message.type === "stream-cancel") {
      this.cancelIpcStream(sender.id, message, runtime.workspaceId);
      return;
    }
    if (message.type === "stream-request" && targetId === "main") {
      await this.handleStreamRequest(
        sender,
        callerId,
        callerKind,
        envelope,
        message,
        runtime,
        runtimeId
      );
      return;
    }
    if (message.type === "request" && targetId === "main") {
      const req = message as RpcRequest;
      const callOptions = callOptionsFromEnvelope(envelope);
      const dotIndex = req.method.indexOf(".");
      if (dotIndex === -1) {
        this.sendResponse(
          sender,
          envelope,
          {
            type: "response",
            requestId: req.requestId,
            error: `Invalid method format: ${req.method}`,
            errorKind: "protocol",
          },
          runtime.workspaceId
        );
        return;
      }
      const service = req.method.slice(0, dotIndex);
      const method = req.method.slice(dotIndex + 1);
      const startedAt = performance.now();
      let outcome: "ok" | "error" = "ok";

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
          const ctx = {
            caller: localVerifiedCaller(
              callerId,
              callerKind,
              this.deps.getCodeIdentityForCaller?.(callerId) ?? null
            ),
            requestId: req.requestId,
            ...(callOptions?.idempotencyKey ? { idempotencyKey: callOptions.idempotencyKey } : {}),
            ...(callOptions?.readOnly ? { readOnly: true } : {}),
          };
          result = await runtime.dispatcher.dispatch(ctx, service, method, req.args);
        } else {
          // Server is the default owner so newly registered userland/workerd
          // services are reachable without a shared routing-list update.
          if (callerKind === "shell") {
            // electron-main / bootstrap launch gate are native-host `shell`
            // principals — they reach the server on the admin connection.
            // Hosted workspace chrome is an `app` and takes the app branch
            // below; there is no longer a shell→app panelTree proxy.
            result = await callServer(runtime.serverClient, service, method, req.args, callOptions);
          } else if (callerKind === "app") {
            try {
              this.deps.authorizeAppServerCall?.(callerId, service, method, req.args);
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              const code = (cause as { code?: unknown } | null)?.code;
              throw new RpcBoundaryError(
                message,
                "access",
                typeof code === "string" ? code : undefined,
                cause
              );
            }
            result = await callServerAs(
              runtime.serverClient,
              { callerId: runtimeId, callerKind },
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
        this.sendResponse(
          sender,
          envelope,
          {
            type: "response",
            requestId: req.requestId,
            result,
          },
          runtime.workspaceId
        );
      } catch (err) {
        outcome = "error";
        const error = err instanceof Error ? err.message : String(err);
        const errorCode = (err as { code?: string })?.code;
        this.sendResponse(
          sender,
          envelope,
          {
            type: "response",
            requestId: req.requestId,
            error,
            errorKind: rpcErrorKindOf(err, "internal"),
            ...(errorCode ? { errorCode } : {}),
            ...(rpcErrorDataOf(err) !== undefined ? { errorData: rpcErrorDataOf(err) } : {}),
          },
          runtime.workspaceId
        );
      } finally {
        const elapsedMs = performance.now() - startedAt;
        this.responsiveness.observe({
          callerId,
          callerKind,
          method: `${service}.${method}`,
          outcome,
          elapsedMs,
        });
      }
    }
  }

  private ipcStreamKey(
    webContentsId: number,
    requestId: string,
    workspaceId = this.deps.workspaceId
  ): string {
    return `${webContentsId}\u0000${workspaceId}\u0000${requestId}`;
  }

  private cancelIpcStream(
    webContentsId: number,
    message: RpcStreamCancel,
    workspaceId: string
  ): void {
    const key = this.ipcStreamKey(webContentsId, message.requestId, workspaceId);
    const active = this.activeIpcStreams.get(key);
    if (!active) return;
    active.abort.abort();
    void active.reader?.cancel().catch(() => {});
  }

  private hookIpcStreamTeardown(sender: WebContents): void {
    if (this.ipcStreamDestroyHooked.has(sender.id)) return;
    this.ipcStreamDestroyHooked.add(sender.id);
    sender.once("destroyed", () => {
      this.ipcStreamDestroyHooked.delete(sender.id);
      const prefix = `${sender.id}\u0000`;
      for (const [key, active] of this.activeIpcStreams) {
        if (!key.startsWith(prefix)) continue;
        active.abort.abort();
        void active.reader?.cancel().catch(() => {});
        this.activeIpcStreams.delete(key);
      }
    });
  }

  private sendStreamFrame(
    sender: WebContents,
    requestEnvelope: RpcEnvelope,
    requestId: string,
    frameType: number,
    payload: string,
    responderWorkspaceId = this.deps.workspaceId,
    responder: AuthenticatedCaller = { ...MAIN_CALLER, workspaceId: responderWorkspaceId }
  ): void {
    if (sender.isDestroyed()) throw new Error("RPC stream renderer was destroyed");
    const frame: RpcStreamFrameMessage = {
      type: "stream-frame",
      requestId,
      fromId: "main",
      frameType,
      payload,
    };
    sender.send(
      "vibestudio:rpc:message",
      responseEnvelopeFor(this.workspaceReplyEnvelope(requestEnvelope), responder, frame)
    );
  }

  private async handleStreamRequest(
    sender: WebContents,
    callerId: string,
    callerKind: CallerKind,
    envelope: RpcEnvelope,
    request: RpcStreamRequest,
    runtime: WorkspaceIpcRuntime = this.deps,
    runtimeId = callerId
  ): Promise<void> {
    const key = this.ipcStreamKey(sender.id, request.requestId, runtime.workspaceId);
    if (this.activeIpcStreams.has(key)) {
      this.sendStreamFrame(
        sender,
        envelope,
        request.requestId,
        FRAME_ERROR,
        JSON.stringify({
          status: 409,
          message: `Duplicate streaming request id: ${request.requestId}`,
          errorKind: "protocol",
        }),
        runtime.workspaceId
      );
      return;
    }

    const dotIndex = request.method.indexOf(".");
    if (dotIndex === -1) {
      this.sendStreamFrame(
        sender,
        envelope,
        request.requestId,
        FRAME_ERROR,
        JSON.stringify({
          status: 400,
          message: `Invalid method format: ${request.method}`,
          errorKind: "protocol",
        }),
        runtime.workspaceId
      );
      return;
    }

    const service = request.method.slice(0, dotIndex);
    const method = request.method.slice(dotIndex + 1);
    const abort = new AbortController();
    const active: ActiveIpcStream = { abort, reader: null };
    this.activeIpcStreams.set(key, active);
    this.hookIpcStreamTeardown(sender);

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
            caller: localVerifiedCaller(
              callerId,
              callerKind,
              this.deps.getCodeIdentityForCaller?.(callerId) ?? null
            ),
            requestId: request.requestId,
            ...(envelope.delivery.idempotencyKey
              ? { idempotencyKey: envelope.delivery.idempotencyKey }
              : {}),
            ...(envelope.delivery.readOnly ? { readOnly: true } : {}),
          },
          service,
          method,
          request.args
        );
        if (!(result instanceof Response)) {
          throw new Error(`Streaming method ${request.method} did not return a Response`);
        }
        response = result;
      } else if (callerKind === "shell") {
        response = await runtime.serverClient.stream(service, method, request.args, {
          signal: abort.signal,
          ...(envelope.destination ? { destination: envelope.destination } : {}),
          ...(envelope.delivery.idempotencyKey
            ? { idempotencyKey: envelope.delivery.idempotencyKey }
            : {}),
          ...(envelope.delivery.readOnly ? { readOnly: true } : {}),
        });
      } else if (callerKind === "app") {
        this.deps.authorizeAppServerCall?.(callerId, service, method, request.args);
        response = await runtime.serverClient.streamAs(
          { callerId: runtimeId, callerKind },
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
        throw new Error(`Server RPC stream relay is not available for ${callerKind} callers`);
      }

      if (abort.signal.aborted) {
        await response.body?.cancel().catch(() => {});
        return;
      }

      this.sendStreamFrame(
        sender,
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
            sender,
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
          sender,
          envelope,
          request.requestId,
          FRAME_END,
          JSON.stringify({ bytesIn }),
          runtime.workspaceId
        );
      }
    } catch (error) {
      if (!abort.signal.aborted && !sender.isDestroyed()) {
        this.sendStreamFrame(
          sender,
          envelope,
          request.requestId,
          FRAME_ERROR,
          JSON.stringify({
            status: 502,
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
            errorKind: rpcErrorKindOf(error, "transport"),
            ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
          }),
          runtime.workspaceId
        );
      }
    } finally {
      active.reader?.releaseLock();
      this.activeIpcStreams.delete(key);
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
              workspaceId: envelope.delivery.caller.workspaceId ?? this.deps.workspaceId,
            },
          },
        }
      : envelope;
  }

  private sendResponse(
    sender: WebContents,
    requestEnvelope: RpcEnvelope,
    response: RpcResponse,
    responderWorkspaceId = this.deps.workspaceId,
    responder: AuthenticatedCaller = { ...MAIN_CALLER, workspaceId: responderWorkspaceId }
  ): void {
    if (!sender.isDestroyed()) {
      sender.send(
        "vibestudio:rpc:message",
        responseEnvelopeFor(this.workspaceReplyEnvelope(requestEnvelope), responder, response)
      );
    }
  }

  private rejectRequestEnvelope(
    sender: WebContents,
    envelope: RpcEnvelope,
    error: unknown,
    responderWorkspaceId = this.deps.workspaceId
  ): void {
    const messageText = error instanceof Error ? error.message : String(error);
    const errorKind = rpcErrorKindOf(error, "access");
    const errorCode = (error as { code?: unknown } | null)?.code;
    const errorData = rpcErrorDataOf(error);
    const message = envelope.message;
    const responder = envelope.destination?.kind === "hub" ? HUB_CALLER : undefined;
    if (message?.type === "stream-request") {
      // A stream has no response envelope, so silence here would strand the
      // renderer's pending reader forever. Fail it the same way an in-flight
      // stream failure does.
      if (sender.isDestroyed()) return;
      this.sendStreamFrame(
        sender,
        envelope,
        (message as RpcStreamRequest).requestId,
        FRAME_ERROR,
        JSON.stringify({
          status: errorKind === "access" ? 403 : 502,
          message: messageText,
          errorKind,
          ...(typeof errorCode === "string" ? { code: errorCode } : {}),
          ...(errorData !== undefined ? { errorData } : {}),
        }),
        responderWorkspaceId,
        responder
      );
      return;
    }
    if (message?.type !== "request") return;
    this.sendResponse(
      sender,
      envelope,
      {
        type: "response",
        requestId: (message as RpcRequest).requestId,
        error: messageText,
        errorKind,
        ...(typeof errorCode === "string" ? { errorCode } : {}),
        ...(errorData !== undefined ? { errorData } : {}),
      },
      responderWorkspaceId,
      responder
    );
  }

  /**
   * Route one envelope from a panel webview. The owning shell is always local;
   * every other target rides the panel's dedicated panel-principal session.
   * server→panel messages return via the session's onMessage (see
   * {@link ensurePanelSession}). A relay failure surfaces as an error response so
   * the panel's pending request rejects rather than hanging.
   */
  private relayPanelEnvelope(
    sender: WebContents,
    callerId: string,
    envelope: RpcEnvelope,
    runtime: WorkspaceIpcRuntime
  ): void {
    // `shell` names the panel's local owning host, never a server target. Keep
    // this decision independent of the event name so new shell capabilities
    // cannot accidentally acquire a second, remote route.
    if (
      envelope.target === "shell" &&
      (!envelope.destination ||
        workspaceRpcDestination(envelope.destination) === runtime.workspaceId)
    ) {
      if (envelope.message.type !== "event") {
        this.rejectRequestEnvelope(sender, envelope, "The local shell accepts events only");
        log.warn(`Rejected non-event envelope addressed to local shell from ${callerId}`);
        return;
      }
      const shell = this.deps.getShellWebContents();
      if (shell && !shell.isDestroyed()) {
        shell.send(
          "vibestudio:rpc:message",
          stampEnvelopeCaller(envelope, { callerId, callerKind: "panel" })
        );
      } else {
        log.warn(`Dropped local shell event from ${callerId}: shell renderer is unavailable`);
      }
      return;
    }
    void this.ensurePanelSession(sender, callerId)
      .then((session) => {
        const conn = this.requirePanelRuntimeConnection(callerId);
        return session.send(
          stampEnvelopeCaller(envelope, { callerId: conn.runtimeEntityId, callerKind: "panel" })
        );
      })
      .catch((err: unknown) => {
        const message = envelope.message;
        const errorCode = (err as { code?: string } | null)?.code;
        if (message?.type === "request") {
          this.sendResponse(sender, envelope, {
            type: "response",
            requestId: (message as RpcRequest).requestId,
            error: err instanceof Error ? err.message : String(err),
            errorKind: "transport",
            ...(errorCode ? { errorCode } : {}),
          });
        }
        if (errorCode !== SESSION_CONNECTION_LOST_CODE) {
          console.warn(
            `[IpcDispatcher] panel relay failed for ${callerId}: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        }
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
    const documentFrame = sender.mainFrame;
    const documentId = this.deps.resolveCallerForWebContents(sender.id)?.documentId;
    const opening: Promise<PanelSessionEntry> = this.sourceRuntime(
      this.deps.resolveCallerForWebContents(sender.id) ?? { callerId, callerKind: "panel" }
    )
      .then((runtime) =>
        runtime.serverClient.openPanelSession(conn.runtimeEntityId, conn.connectionId)
      )
      .then((session) => {
        // Deliver server→panel messages (responses, events, stream frames) to the
        // panel's current webContents.
        session.onMessage((env) => {
          const wc = this.deps.getWebContentsForCaller(callerId);
          if (
            wc &&
            !wc.isDestroyed() &&
            wc.mainFrame === documentFrame &&
            this.deps.resolveCallerForWebContents(sender.id)?.documentId === documentId
          )
            wc.send("vibestudio:rpc:message", env);
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

  private ensureAppMessageBridge(
    callerId: string,
    runtime: WorkspaceIpcRuntime,
    runtimeId: string
  ): void {
    if (this.appMessageBridges.has(callerId)) return;
    const unsubscribe = runtime.serverClient.addMessageListener(
      { callerId: runtimeId, callerKind: "app" },
      (envelope) => {
        const wc = this.deps.getWebContentsForCaller(callerId);
        if (!wc || wc.isDestroyed()) return;
        wc.send("vibestudio:rpc:message", envelope);
      }
    );
    this.appMessageBridges.set(callerId, unsubscribe);
  }
}
