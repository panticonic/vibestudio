import type {
  EnvelopeRpcTransport,
  RpcConnectionStatus,
  RpcEnvelope,
  RpcMessage,
} from "../types.js";
import type {
  WsAuthSuccessResultMessage,
  WsClientMessage,
  WsServerMessage,
} from "../protocol/wsProtocol.js";
import { WS_STREAM_REQUEST_BODY_CAPABILITY } from "../protocol/wsProtocol.js";
import type { RecoveryKind } from "../protocol/recoveryCoordinator.js";
import type { WsLike, WsTransportAdapter } from "../protocol/wsAdapter.js";
import { TERMINAL_CLOSE_CODES } from "../protocol/closeCodes.js";
import { RPC_CONTRACT_VERSION } from "../protocol/contractVersion.js";
import {
  normalizeRpcClientLabel,
  requestRpcWebSocketAdmission,
  rpcWebSocketAdmissionUrl,
} from "../protocol/rpcWebSocketAdmission.js";
import { webSocketAuthProtocol } from "../protocol/webSocketAuthProtocol.js";
import { base64ToBytes, bytesToBase64 } from "../base64.js";
import {
  decodeFramedStream,
  encodeFrame,
  FRAME_DATA,
  FRAME_END,
  FRAME_ERROR,
  type FrameType,
} from "../protocol/streamCodec.js";

export interface WsClientTransportConfig {
  selfId: string;
  getWsUrl: () => string;
  adapter: WsTransportAdapter;
  connectionId?: string;
  reconnect?: boolean;
  terminalCloseCodes?: number[];
  getAuthMessageFields?: () => Partial<Extract<WsClientMessage, { type: "ws:auth" }>>;
  routeTarget?: (targetId: string) => string;
  onRecovery?: (kind: RecoveryKind) => void | Promise<void>;
  /**
   * Fired on a successful auth-result. Carries the optional `deviceCredential`
   * the server issues only when this session authenticated by redeeming a
   * one-time pairing code — the caller persists it to reconnect (`refresh:…`).
   */
  onAuthResult?: (msg: WsAuthSuccessResultMessage) => void;
  logPrefix?: string;
}

const OPEN = 1;
const UPLOAD_CHUNK_BYTES = 256 * 1024;

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorWithCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function wsClientTransport(config: WsClientTransportConfig): EnvelopeRpcTransport & {
  connect(): void;
  connectAndWait(timeoutMs?: number | null): Promise<void>;
  close(): Promise<void>;
  onRecovery(kind: RecoveryKind, handler: () => void | Promise<void>): () => void;
} {
  const connectionId = config.connectionId ?? randomId();
  const messageListeners = new Set<(envelope: RpcEnvelope) => void>();
  const statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  const recoveryListeners = new Map<RecoveryKind, Set<() => void | Promise<void>>>();
  let socket: WsLike | null = null;
  let authenticated = false;
  let closed = false;
  let status: RpcConnectionStatus = "disconnected";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let admissionAbortController: AbortController | null = null;
  let generation = 0;
  let hasConnectedBefore = false;
  let lastSeenBootId: string | null = null;
  let authToken: string | null = null;
  let firstConnectPromise: Promise<void> | null = null;
  let firstConnectResolve: (() => void) | null = null;
  let firstConnectReject: ((error: Error) => void) | null = null;
  let supportsStreamRequestBodies = false;
  const textEncoder = new TextEncoder();
  const nativeStreams = new Map<
    string,
    {
      controller: ReadableStreamDefaultController<Uint8Array>;
      uploadAbort: AbortController | null;
    }
  >();
  const uploadAcks = new Map<
    string,
    Map<number, { resolve: () => void; reject: (error: Error) => void }>
  >();

  const abortUpload = (requestId: string, error: Error): void => {
    const pending = uploadAcks.get(requestId);
    uploadAcks.delete(requestId);
    for (const acknowledgement of pending?.values() ?? []) acknowledgement.reject(error);
  };

  const failNativeStreams = (error: Error): void => {
    for (const entry of nativeStreams.values()) {
      entry.uploadAbort?.abort(error);
      try {
        entry.controller.error(error);
      } catch {
        // already closed
      }
    }
    nativeStreams.clear();
    for (const pending of uploadAcks.values()) {
      for (const acknowledgement of pending.values()) acknowledgement.reject(error);
    }
    uploadAcks.clear();
  };

  const sendWireMessage = (message: WsClientMessage): void => {
    const current = socket;
    if (!current || current.readyState !== OPEN || !authenticated) {
      throw errorWithCode("Not connected to server", "CONNECTION_LOST");
    }
    current.send(JSON.stringify(message));
  };

  const sendEnvelope = async (envelope: RpcEnvelope, streamBody = false): Promise<void> => {
    const target = config.routeTarget?.(envelope.target) ?? envelope.target;
    const routedEnvelope = target === envelope.target ? envelope : { ...envelope, target };
    if (streamBody && target !== "main" && target !== "server") {
      throw new Error("WebSocket request bodies cannot be routed to another RPC endpoint");
    }
    const message: WsClientMessage =
      target === "main" || target === "server"
        ? {
            type: "ws:rpc",
            envelope: routedEnvelope,
            ...(streamBody ? { streamBody: true as const } : {}),
          }
        : { type: "ws:route", envelope: routedEnvelope };
    sendWireMessage(message);
  };

  const waitForUploadAck = (requestId: string, seq: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let pending = uploadAcks.get(requestId);
      if (!pending) {
        pending = new Map();
        uploadAcks.set(requestId, pending);
      }
      pending.set(seq, { resolve, reject });
    });
  };

  const sendUploadChunk = async (
    requestId: string,
    seq: number,
    fields: { payload?: string; done?: boolean; error?: string }
  ): Promise<void> => {
    const acknowledged = waitForUploadAck(requestId, seq);
    try {
      sendWireMessage({ type: "ws:stream-body-chunk", requestId, seq, ...fields });
    } catch (error) {
      const pending = uploadAcks.get(requestId);
      const acknowledgement = pending?.get(seq);
      pending?.delete(seq);
      if (pending?.size === 0) uploadAcks.delete(requestId);
      acknowledgement?.reject(asError(error));
    }
    try {
      await acknowledged;
    } catch (error) {
      throw Object.assign(asError(error), { code: "UPLOAD_TRANSPORT_FAILED" });
    }
  };

  const pumpUpload = async (
    requestId: string,
    body: ReadableStream<Uint8Array>,
    abort: AbortController
  ): Promise<void> => {
    const reader = body.getReader();
    const cancelReader = () => void reader.cancel(abort.signal.reason).catch(() => undefined);
    abort.signal.addEventListener("abort", cancelReader, { once: true });
    let seq = 0;
    try {
      while (!abort.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (let offset = 0; offset < value.byteLength; offset += UPLOAD_CHUNK_BYTES) {
          if (abort.signal.aborted) return;
          const chunk = value.subarray(
            offset,
            Math.min(offset + UPLOAD_CHUNK_BYTES, value.byteLength)
          );
          await sendUploadChunk(requestId, seq++, { payload: bytesToBase64(chunk) });
        }
      }
      if (!abort.signal.aborted) await sendUploadChunk(requestId, seq, { done: true });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "UPLOAD_TRANSPORT_FAILED") {
        abort.abort(error);
      } else if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        await sendUploadChunk(requestId, seq, { error: message }).catch(() => undefined);
      }
    } finally {
      abort.signal.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }
  };

  const routeNativeStreamFrame = (envelope: RpcEnvelope): void => {
    const frame = envelope.message;
    if (frame.type !== "stream-frame") return;
    const entry = nativeStreams.get(frame.requestId);
    if (!entry) return;
    const payload =
      frame.frameType === FRAME_DATA
        ? base64ToBytes(frame.payload)
        : textEncoder.encode(frame.payload);
    entry.controller.enqueue(encodeFrame(frame.frameType as FrameType, payload));
    if (frame.frameType === FRAME_END || frame.frameType === FRAME_ERROR) {
      nativeStreams.delete(frame.requestId);
      const completion = new Error("Streaming RPC response completed");
      entry.uploadAbort?.abort(completion);
      abortUpload(frame.requestId, completion);
      entry.controller.close();
    }
  };

  const setStatus = (next: RpcConnectionStatus): void => {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener(next);
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const emitRecovery = (kind: RecoveryKind): void => {
    void config.onRecovery?.(kind);
    for (const listener of recoveryListeners.get(kind) ?? []) {
      try {
        void listener();
      } catch (error) {
        console.error("[wsClientTransport] Recovery listener failed:", error);
      }
    }
  };

  const scheduleReconnect = (socketGeneration: number): void => {
    if (closed) return;
    clearReconnectTimer();
    const jitter = Math.random() * 500;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt) + jitter, 30_000);
    reconnectAttempt += 1;
    setStatus("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed || socketGeneration !== generation) return;
      void openSocket();
    }, delay);
  };

  const scheduleAdmissionRetry = (socketGeneration: number, retryAfterMs: number): void => {
    if (closed) return;
    clearReconnectTimer();
    setStatus("connecting");
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        if (closed || socketGeneration !== generation) return;
        void openSocket();
      },
      Math.max(0, retryAfterMs)
    );
  };

  const failAuthentication = (reason: string): void => {
    const error = new Error(reason);
    firstConnectReject?.(error);
    firstConnectReject = null;
    firstConnectResolve = null;
    firstConnectPromise = null;
    closed = true;
    authenticated = false;
    supportsStreamRequestBodies = false;
    setStatus("disconnected");
    socket?.close(4006, "Authentication failed");
  };

  const handleAuthFailure = async (
    rejectedToken: string,
    reason: string,
    socketGeneration: number
  ): Promise<void> => {
    if (!config.adapter.refreshAuthToken) {
      failAuthentication(`Server auth failed: ${reason}`);
      return;
    }
    try {
      const refreshedAuthToken = await config.adapter.refreshAuthToken();
      if (refreshedAuthToken === rejectedToken) {
        failAuthentication("Auth refresh returned the rejected token");
        return;
      }
      if (closed || socketGeneration !== generation) return;
      authToken = refreshedAuthToken;
      const oldSocket = socket;
      const nextGeneration = ++generation;
      oldSocket?.close(4000, "Refreshing auth token");
      reconnectAttempt = 0;
      setTimeout(() => {
        if (closed || nextGeneration !== generation) return;
        void openSocket();
      }, 0);
    } catch (error) {
      console.warn("[wsClientTransport] Auth refresh failed:", error);
      failAuthentication(
        `Auth refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleServerMessage = (msg: WsServerMessage): void => {
    switch (msg.type) {
      case "ws:auth-result": {
        if (!msg.success) {
          const rejectedToken = authToken;
          if (rejectedToken) {
            void handleAuthFailure(
              rejectedToken,
              msg.error ?? "Server rejected RPC authentication",
              generation
            );
          } else {
            failAuthentication(msg.error ?? "Server rejected RPC authentication");
          }
          return;
        }
        if (msg.contractVersion !== RPC_CONTRACT_VERSION) {
          const error = new Error(
            `RPC contract mismatch: server ${String(msg.contractVersion)} (want ${RPC_CONTRACT_VERSION})`
          );
          closed = true;
          firstConnectReject?.(error);
          firstConnectResolve = null;
          firstConnectReject = null;
          setStatus("disconnected");
          socket?.close(4005, "Incompatible RPC contract");
          return;
        }
        const previousBootId = lastSeenBootId;
        const nextBootId = msg.serverBootId ?? null;
        const isReconnect = hasConnectedBefore;
        authenticated = true;
        supportsStreamRequestBodies =
          msg.transportCapabilities?.includes(WS_STREAM_REQUEST_BODY_CAPABILITY) === true;
        hasConnectedBefore = true;
        firstConnectResolve?.();
        firstConnectResolve = null;
        firstConnectReject = null;
        lastSeenBootId = nextBootId;
        reconnectAttempt = 0;
        setStatus("connected");
        config.onAuthResult?.(msg);
        if (
          msg.sessionDirty === true ||
          (isReconnect && previousBootId && nextBootId && previousBootId !== nextBootId)
        ) {
          emitRecovery("cold-recover");
        } else {
          emitRecovery("resubscribe");
        }
        return;
      }
      case "ws:rpc":
      case "ws:routed": {
        const envelope = msg.envelope;
        if (!envelope?.message) return;
        routeNativeStreamFrame(envelope);
        for (const listener of messageListeners) listener(envelope);
        return;
      }
      case "ws:routed-response-error": {
        // The server could not deliver our routed request to the target. Turn
        // the explicit error frame into a rejecting `response` so the pending
        // call settles instead of hanging forever (silent-drop class).
        const prefix = config.logPrefix ?? "wsClientTransport";
        console.warn(
          `[${prefix}] routed request to ${msg.targetId} failed (requestId=${msg.requestId}): ${msg.error}`
        );
        const errorMessage: RpcMessage = {
          type: "response",
          requestId: msg.requestId,
          error: msg.error,
          errorKind: msg.errorKind,
          ...(msg.errorCode ? { errorCode: msg.errorCode } : {}),
          ...(msg.errorData !== undefined ? { errorData: msg.errorData } : {}),
        };
        const envelope: RpcEnvelope = {
          from: msg.targetId,
          target: config.selfId,
          delivery: { caller: { callerId: msg.targetId, callerKind: "unknown" } },
          provenance: [{ callerId: msg.targetId, callerKind: "unknown" }],
          message: errorMessage,
        };
        for (const listener of messageListeners) listener(envelope);
        return;
      }
      case "ws:routed-event-error": {
        // Fire-and-forget event could not be delivered. There is no pending
        // promise to reject, but the drop MUST be observable rather than silent.
        const prefix = config.logPrefix ?? "wsClientTransport";
        console.warn(
          `[${prefix}] routed event "${msg.event}" to ${msg.targetId} dropped: ${msg.error}`
        );
        return;
      }
      case "ws:stream-body-ack": {
        const pending = uploadAcks.get(msg.requestId);
        const acknowledgement = pending?.get(msg.seq);
        if (!acknowledgement) return;
        pending!.delete(msg.seq);
        if (pending!.size === 0) uploadAcks.delete(msg.requestId);
        if (msg.error) acknowledgement.reject(new Error(msg.error));
        else acknowledgement.resolve();
        return;
      }
    }
  };

  const openSocket = async (): Promise<void> => {
    const socketGeneration = ++generation;
    const prefix = config.logPrefix ?? "wsClientTransport";
    setStatus("connecting");
    authenticated = false;
    supportsStreamRequestBodies = false;

    let token: string;
    try {
      token = authToken ?? (await config.adapter.getAuthToken());
      authToken = token;
    } catch (error) {
      console.warn(`[${prefix}] Failed to get auth token:`, error);
      scheduleReconnect(socketGeneration);
      return;
    }

    const requestedAuthFields = config.getAuthMessageFields?.() ?? {};
    const {
      connectionId: refreshedConnectionId,
      clientLabel: requestedClientLabel,
      clientSessionId,
      clientPlatform,
    } = requestedAuthFields;
    const clientLabel = normalizeRpcClientLabel(requestedClientLabel);
    const effectiveConnectionId =
      typeof refreshedConnectionId === "string" && refreshedConnectionId.length > 0
        ? refreshedConnectionId
        : connectionId;
    const authFields = {
      ...(clientLabel === undefined ? {} : { clientLabel }),
      ...(clientSessionId === undefined ? {} : { clientSessionId }),
      ...(clientPlatform === undefined ? {} : { clientPlatform }),
      connectionId: effectiveConnectionId,
    };
    admissionAbortController?.abort();
    const attemptAdmissionController = new AbortController();
    admissionAbortController = attemptAdmissionController;
    let admission;
    try {
      admission = await (config.adapter.requestAdmission ?? requestRpcWebSocketAdmission)(
        rpcWebSocketAdmissionUrl(config.getWsUrl()),
        {
          credential: token,
          ...(authFields?.clientLabel ? { clientLabel: authFields.clientLabel } : {}),
          ...(authFields?.clientPlatform ? { clientPlatform: authFields.clientPlatform } : {}),
        },
        { signal: attemptAdmissionController.signal }
      );
    } catch (error) {
      if (closed || socketGeneration !== generation) return;
      console.warn(`[${prefix}] RPC WebSocket admission request failed:`, error);
      scheduleReconnect(socketGeneration);
      return;
    } finally {
      if (admissionAbortController === attemptAdmissionController) {
        admissionAbortController = null;
      }
    }
    if (closed || socketGeneration !== generation) return;
    if (!admission.ok) {
      if (admission.code === "admission_saturated") {
        scheduleAdmissionRetry(socketGeneration, admission.retryAfterMs ?? 1_000);
        return;
      }
      if (
        admission.code === "invalid_credential" ||
        admission.code === "admin_credential" ||
        admission.code === "pairing_invalid_or_expired"
      ) {
        await handleAuthFailure(token, admission.message, socketGeneration);
        return;
      }
      if (admission.code === "invalid_request") {
        failAuthentication(`RPC WebSocket admission failed: ${admission.message}`);
        return;
      }
      scheduleAdmissionRetry(socketGeneration, admission.retryAfterMs ?? 1_000);
      return;
    }
    const admissionGrant = admission.grant;

    let nextSocket: WsLike;
    try {
      nextSocket = config.adapter.createSocket(config.getWsUrl(), [
        webSocketAuthProtocol("rpc", admissionGrant),
      ]);
    } catch (error) {
      console.warn(`[${prefix}] Failed to create WebSocket:`, error);
      scheduleReconnect(socketGeneration);
      return;
    }
    socket = nextSocket;
    nextSocket.onopen = () => {
      if (socketGeneration !== generation || socket !== nextSocket) return;
      nextSocket.send(
        JSON.stringify({
          type: "ws:auth",
          contractVersion: RPC_CONTRACT_VERSION,
          token: admissionGrant,
          ...authFields,
        } satisfies WsClientMessage)
      );
    };
    nextSocket.onmessage = (event) => {
      if (socketGeneration !== generation || socket !== nextSocket) return;
      try {
        handleServerMessage(JSON.parse(String(event.data)) as WsServerMessage);
      } catch (error) {
        console.warn(`[${prefix}] Malformed message from server:`, error);
      }
    };
    nextSocket.onerror = (event) => {
      if (socketGeneration !== generation || socket !== nextSocket) return;
      console.warn(`[${prefix}] WebSocket error`, event);
    };
    nextSocket.onclose = (event) => {
      if (socketGeneration !== generation || socket !== nextSocket) return;
      authenticated = false;
      supportsStreamRequestBodies = false;
      const terminalCodes = config.terminalCloseCodes
        ? new Set(config.terminalCloseCodes)
        : TERMINAL_CLOSE_CODES;
      if (closed || terminalCodes.has(event.code ?? 0) || config.reconnect === false) {
        failNativeStreams(errorWithCode("Connection lost during streaming RPC", "CONNECTION_LOST"));
        setStatus("disconnected");
        return;
      }
      failNativeStreams(errorWithCode("Connection lost during streaming RPC", "CONNECTION_LOST"));
      scheduleReconnect(socketGeneration);
    };
  };

  return {
    connect(): void {
      closed = false;
      clearReconnectTimer();
      void openSocket();
    },
    connectAndWait(timeoutMs: number | null = 10_000): Promise<void> {
      if (socket?.readyState === OPEN && authenticated) return Promise.resolve();
      let shouldConnect = false;
      if (!firstConnectPromise) {
        firstConnectPromise = new Promise<void>((resolve, reject) => {
          firstConnectResolve = resolve;
          firstConnectReject = reject;
        });
        shouldConnect = !socket || status === "disconnected";
      }
      if (shouldConnect) this.connect();
      if (!firstConnectPromise) {
        throw new Error("RPC WebSocket connection promise was not initialized");
      }
      const pendingConnection = firstConnectPromise;
      return new Promise<void>((resolve, reject) => {
        const timeout =
          timeoutMs == null
            ? null
            : setTimeout(
                () =>
                  reject(
                    new Error(`Server WS connection timeout (${timeoutMs}ms): ${config.getWsUrl()}`)
                  ),
                timeoutMs
              );
        pendingConnection.then(
          () => {
            if (timeout) clearTimeout(timeout);
            resolve();
          },
          (error) => {
            if (timeout) clearTimeout(timeout);
            reject(error);
          }
        );
      });
    },
    async close(): Promise<void> {
      closed = true;
      failNativeStreams(errorWithCode("RPC client closed", "CONNECTION_LOST"));
      clearReconnectTimer();
      admissionAbortController?.abort();
      admissionAbortController = null;
      const current = socket;
      socket = null;
      authenticated = false;
      supportsStreamRequestBodies = false;
      setStatus("disconnected");
      if (!current || current.readyState >= 2) return;
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        current.onclose = done;
        current.close(1000, "Client closing");
        setTimeout(done, 2000);
      });
    },
    send: (envelope) => sendEnvelope(envelope),
    async streamReadable(envelope, signal, body, headTimeoutMs) {
      const request = envelope.message;
      if (request.type !== "stream-request") {
        throw new Error(`streamReadable() requires a stream-request envelope, got ${request.type}`);
      }
      if (signal?.aborted) throw new Error("Streaming RPC aborted by caller");
      if (nativeStreams.has(request.requestId)) {
        throw new Error(`Streaming RPC request id ${request.requestId} is already active`);
      }
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const uploadAbort = body ? new AbortController() : null;
      const cancelRemote = (): void => {
        const cancellation = new Error("Streaming RPC cancelled");
        uploadAbort?.abort(cancellation);
        abortUpload(request.requestId, cancellation);
        void sendEnvelope({
          from: envelope.from,
          target: envelope.target,
          delivery: envelope.delivery,
          provenance: envelope.provenance,
          message: {
            type: "stream-cancel",
            requestId: request.requestId,
            fromId: request.fromId,
          },
        }).catch(() => undefined);
      };
      const wireBody = new ReadableStream<Uint8Array>({
        start(next) {
          controller = next;
        },
        cancel() {
          nativeStreams.delete(request.requestId);
          cancelRemote();
        },
      });
      nativeStreams.set(request.requestId, { controller, uploadAbort });
      const onAbort = (): void => {
        const entry = nativeStreams.get(request.requestId);
        if (!entry) return;
        nativeStreams.delete(request.requestId);
        entry.uploadAbort?.abort(signal?.reason);
        abortUpload(request.requestId, new Error("Streaming RPC aborted by caller"));
        entry.controller.error(new Error("Streaming RPC aborted by caller"));
        cancelRemote();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (body && !supportsStreamRequestBodies) {
          throw new Error("Server does not support WebSocket streaming request bodies");
        }
        await sendEnvelope(envelope, body != null);
      } catch (error) {
        signal?.removeEventListener("abort", onAbort);
        nativeStreams.delete(request.requestId);
        uploadAbort?.abort(error);
        controller.error(error);
        throw error;
      }
      if (body && uploadAbort) void pumpUpload(request.requestId, body, uploadAbort);
      return decodeFramedStream(wireBody, "", signal, {
        headTimeoutMs,
        onBodyCancel: cancelRemote,
      }).finally(() => signal?.removeEventListener("abort", onAbort));
    },
    onMessage(handler) {
      messageListeners.add(handler);
      return () => messageListeners.delete(handler);
    },
    status: () => status,
    ready() {
      return this.connectAndWait();
    },
    onStatusChange(handler) {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },
    onRecovery(kind, handler) {
      let listeners = recoveryListeners.get(kind);
      if (!listeners) {
        listeners = new Set();
        recoveryListeners.set(kind, listeners);
      }
      listeners.add(handler);
      return () => {
        listeners?.delete(handler);
        if (listeners?.size === 0) recoveryListeners.delete(kind);
      };
    },
  };
}
