import {
  RpcBoundaryError,
  rpcDestinationKey,
  stampEnvelopeCaller,
  type RpcEnvelope,
  type RpcDestination,
} from "@vibestudio/rpc";
import { FRAME_END, FRAME_ERROR } from "@vibestudio/rpc/protocol/streamCodec";
import type { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { HostUiSession, ServerClient } from "./serverClient.js";

/** Native ownership metadata, never supplied by the renderer. */
export interface NativeIpcCaller {
  callerId: string;
  browser?: boolean;
  documentId?: string;
  callerKind: "shell" | "panel" | "app";
  runtimeId?: string;
  workspaceId?: string;
}
export interface WorkspaceIpcRuntime {
  workspaceId: string;
  serverClient: ServerClient;
  dispatcher: ServiceDispatcher;
}
export interface UiIpcRuntime {
  destination: RpcDestination;
  serverClient: ServerClient;
  workspace?: WorkspaceIpcRuntime;
}
export type ResolveUiRuntime = (
  caller: NativeIpcCaller,
  destination: RpcDestination
) => Promise<UiIpcRuntime | null>;

type SessionEntry = {
  caller: NativeIpcCaller;
  runtime: UiIpcRuntime;
  session: HostUiSession;
  unsubscribe: () => void;
  pending: Map<string, { requestId: string; envelope: RpcEnvelope; stream: boolean }>;
  streamAborts: Set<AbortController>;
};

const CONNECTION_LOST_MESSAGE = "Connection lost before the response arrived";

/** Owns device/user sessions exclusively for native-admitted System chrome. */
export class UiSessions {
  private readonly sessions = new Map<string, Promise<SessionEntry>>();
  private closed = false;

  constructor(
    private readonly resolve: ResolveUiRuntime,
    private readonly deliver: (caller: NativeIpcCaller, envelope: RpcEnvelope) => void
  ) {}

  private key(caller: NativeIpcCaller, destination: RpcDestination): string {
    return JSON.stringify([caller.callerId, rpcDestinationKey(destination)]);
  }

  private deliverEnvelope(
    caller: NativeIpcCaller,
    runtime: UiIpcRuntime,
    envelope: RpcEnvelope
  ): void {
    this.deliver(caller, {
      ...envelope,
      ...(runtime.destination.kind === "hub" ? { from: "hub" } : {}),
      target: caller.runtimeId ?? caller.callerId,
      destination: caller.workspaceId
        ? { kind: "workspace", workspaceId: caller.workspaceId }
        : undefined,
      delivery: {
        ...envelope.delivery,
        caller:
          runtime.destination.kind === "hub"
            ? { callerId: "hub", callerKind: "server" }
            : { ...envelope.delivery.caller, workspaceId: runtime.destination.workspaceId },
      },
    });
  }

  async admit(caller: NativeIpcCaller, destination: RpcDestination): Promise<UiIpcRuntime | null> {
    if (this.closed) throw new Error("Workspace UI sessions are closed");
    const key = this.key(caller, destination);
    try {
      const runtime = await this.resolve(caller, destination);
      if (!runtime) {
        await this.closeEntry(key);
        return null;
      }
      if (rpcDestinationKey(runtime.destination) !== rpcDestinationKey(destination))
        throw new Error("UI admission returned another owner");
      if (
        runtime.workspace &&
        (destination.kind !== "workspace" ||
          runtime.workspace.workspaceId !== destination.workspaceId ||
          runtime.workspace.serverClient !== runtime.serverClient)
      )
        throw new Error("UI admission returned a mismatched native workspace");
      return runtime;
    } catch (error) {
      await this.closeEntry(key);
      throw error;
    }
  }

  async session(caller: NativeIpcCaller, runtime: UiIpcRuntime): Promise<HostUiSession> {
    const key = this.key(caller, runtime.destination);
    const existing = this.sessions.get(key);
    if (existing) {
      const entry = await existing;
      if (entry.runtime.serverClient === runtime.serverClient && !entry.session.isClosed?.())
        return entry.session;
      await this.closeEntry(key);
    }
    if (this.closed) throw new Error("Workspace UI sessions are closed");
    const opening = runtime.serverClient.openHostUiSession().then(async (session) => {
      if (this.closed || this.sessions.get(key) !== opening) {
        await session.close();
        throw new RpcBoundaryError(
          "Workspace UI session was released while opening",
          "transport",
          "CONNECTION_LOST"
        );
      }
      let deliveryTail: Promise<void> = Promise.resolve();
      const pending = new Map<
        string,
        { requestId: string; envelope: RpcEnvelope; stream: boolean }
      >();
      const streamAborts = new Set<AbortController>();
      const trackedSession: HostUiSession = {
        onMessage: (listener) => session.onMessage(listener),
        close: () => session.close(),
        ...(session.status ? { status: () => session.status!() } : {}),
        ...(session.isClosed ? { isClosed: () => session.isClosed!() } : {}),
        ...(session.streamReadable
          ? {
              streamReadable: async (envelope, signal, body) => {
                const abort = new AbortController();
                const onAbort = () => abort.abort(signal?.reason);
                if (signal?.aborted) onAbort();
                else signal?.addEventListener("abort", onAbort, { once: true });
                streamAborts.add(abort);
                let uploadDone = !body;
                let responseDone = false;
                const cleanup = () => {
                  streamAborts.delete(abort);
                  signal?.removeEventListener("abort", onAbort);
                };
                const cleanupIfDone = () => {
                  if (uploadDone && responseDone) cleanup();
                };
                const uploadReader = body?.getReader();
                let uploadReleased = false;
                const releaseUpload = () => {
                  if (!uploadReader || uploadReleased) return;
                  uploadReleased = true;
                  uploadReader.releaseLock();
                };
                const ownedBody = uploadReader
                  ? new ReadableStream<Uint8Array>({
                      async pull(controller) {
                        try {
                          const chunk = await uploadReader.read();
                          if (chunk.done) {
                            uploadDone = true;
                            cleanupIfDone();
                            releaseUpload();
                            controller.close();
                          } else controller.enqueue(chunk.value);
                        } catch (error) {
                          uploadDone = true;
                          cleanupIfDone();
                          releaseUpload();
                          controller.error(error);
                        }
                      },
                      async cancel(reason) {
                        uploadDone = true;
                        cleanupIfDone();
                        try {
                          await uploadReader.cancel(reason);
                        } finally {
                          releaseUpload();
                        }
                      },
                    })
                  : null;
                try {
                  const response = await session.streamReadable!(envelope, abort.signal, ownedBody);
                  const reader = response.body.getReader();
                  let released = false;
                  const release = () => {
                    if (released) return;
                    released = true;
                    reader.releaseLock();
                  };
                  return {
                    ...response,
                    body: new ReadableStream<Uint8Array>({
                      async pull(controller) {
                        try {
                          const chunk = await reader.read();
                          if (chunk.done) {
                            responseDone = true;
                            cleanupIfDone();
                            release();
                            controller.close();
                          } else controller.enqueue(chunk.value);
                        } catch (error) {
                          responseDone = true;
                          abort.abort(error);
                          uploadDone = true;
                          void uploadReader?.cancel(error).finally(releaseUpload);
                          cleanup();
                          release();
                          controller.error(error);
                        }
                      },
                      async cancel(reason) {
                        try {
                          abort.abort(reason);
                          uploadDone = true;
                          void uploadReader?.cancel(reason).finally(releaseUpload);
                          await reader.cancel(reason);
                        } finally {
                          responseDone = true;
                          cleanup();
                          release();
                        }
                      },
                    }),
                  };
                } catch (error) {
                  cleanup();
                  throw error;
                }
              },
            }
          : {}),
        async send(envelope) {
          const message = envelope.message;
          let trackedRequestId: string | undefined;
          if (message.type === "request" || message.type === "stream-request") {
            trackedRequestId = message.requestId;
            pending.set(message.requestId, {
              requestId: message.requestId,
              envelope,
              stream: message.type === "stream-request",
            });
          } else if (message.type === "stream-cancel" || message.type === "request-cancel") {
            trackedRequestId = message.requestId;
            pending.delete(message.requestId);
          }
          try {
            await session.send(envelope);
          } catch (error) {
            if (trackedRequestId) pending.delete(trackedRequestId);
            throw error;
          }
        },
      };
      const unsubscribe = session.onMessage((envelope) => {
        deliveryTail = deliveryTail
          .then(() => this.admit(caller, runtime.destination))
          .then(async (current) => {
            if (!current || this.sessions.get(key) !== opening) return;
            if (current.serverClient !== runtime.serverClient) {
              await this.closeEntry(key);
              return;
            }
            const message = envelope.message;
            if (
              message.type === "response" ||
              (message.type === "stream-frame" &&
                (message.frameType === FRAME_END || message.frameType === FRAME_ERROR))
            )
              pending.delete(message.requestId);
            this.deliverEnvelope(caller, runtime, envelope);
          })
          .catch(() => undefined);
      });
      return { caller, runtime, session: trackedSession, unsubscribe, pending, streamAborts };
    });
    this.sessions.set(key, opening);
    try {
      return (await opening).session;
    } catch (error) {
      if (this.sessions.get(key) === opening) this.sessions.delete(key);
      throw error;
    }
  }

  envelope(caller: NativeIpcCaller, runtime: UiIpcRuntime, envelope: RpcEnvelope): RpcEnvelope {
    return stampEnvelopeCaller(
      {
        ...envelope,
        destination: runtime.destination.kind === "workspace" ? runtime.destination : undefined,
      },
      {
        callerId: caller.runtimeId ?? caller.callerId,
        callerKind: "shell",
        ...(runtime.destination.kind === "workspace"
          ? { workspaceId: runtime.destination.workspaceId }
          : {}),
      }
    );
  }

  async require(caller: NativeIpcCaller, destination: RpcDestination): Promise<UiIpcRuntime> {
    const runtime = await this.admit(caller, destination);
    if (!runtime)
      throw new RpcBoundaryError("This renderer is not admitted as workspace UI", "access");
    return runtime;
  }

  private async closeEntry(key: string): Promise<void> {
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    if (!pending) return;
    try {
      const entry = await pending;
      entry.unsubscribe();
      for (const abort of entry.streamAborts) abort.abort(CONNECTION_LOST_MESSAGE);
      entry.streamAborts.clear();
      for (const { requestId, envelope, stream } of entry.pending.values()) {
        try {
          this.deliverEnvelope(entry.caller, entry.runtime, {
            ...envelope,
            from: envelope.target,
            target: envelope.from,
            message: stream
              ? {
                  type: "stream-frame",
                  requestId,
                  fromId: envelope.target,
                  frameType: FRAME_ERROR,
                  payload: JSON.stringify({
                    message: CONNECTION_LOST_MESSAGE,
                    code: "CONNECTION_LOST",
                    errorKind: "transport",
                  }),
                }
              : {
                  type: "response",
                  requestId,
                  error: CONNECTION_LOST_MESSAGE,
                  errorCode: "CONNECTION_LOST",
                  errorKind: "transport",
                },
          });
        } catch {
          /* Renderer teardown can race terminal delivery; the session still closes below. */
        }
      }
      entry.pending.clear();
      await entry.session.close();
    } catch {
      /* A failed opening already owns its cleanup. */
    }
  }

  async closeCaller(callerId: string): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()]
        .filter((key) => JSON.parse(key)[0] === callerId)
        .map((key) => this.closeEntry(key))
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map((key) => this.closeEntry(key)));
  }
}
