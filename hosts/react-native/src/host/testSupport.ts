import { vi } from "vitest";
import type { RpcConnectionStatus, RpcEnvelope } from "@vibestudio/rpc";
import type { IrohClientSession } from "@vibestudio/rpc/transports/irohClient";
import type {
  OpenedSession,
  SessionCallerKind,
  SessionHandlers,
  SessionOpeners,
} from "./sessionRelay";

/** A logical session with the surface the relay uses; tests drive it from the server side. */
export class FakeSession {
  readonly sent: RpcEnvelope[] = [];
  readonly streams: Array<{ envelope: RpcEnvelope; body: ReadableStream<Uint8Array> | null }> = [];
  closed = false;
  private readonly messageHandlers = new Set<(envelope: RpcEnvelope) => void>();
  private readonly statusHandlers = new Set<(status: RpcConnectionStatus) => void>();
  private currentStatus: RpcConnectionStatus = "connected";
  streamResponse: () => Promise<{
    status: number;
    statusText: string;
    headers: [string, string][];
    finalUrl: string;
    body: ReadableStream<Uint8Array>;
  }> = async () => {
    throw new Error("no stream response configured");
  };

  constructor(
    readonly authenticatedCaller: string,
    readonly tokens: Array<() => Promise<string>> = []
  ) {}

  asSession(): IrohClientSession {
    return {
      callerId: () => this.authenticatedCaller,
      isClosed: () => this.closed,
      status: () => this.currentStatus,
      onStatusChange: (handler) => {
        this.statusHandlers.add(handler);
        return () => this.statusHandlers.delete(handler);
      },
      onMessage: (handler) => {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
      },
      ready: async () => undefined,
      send: async (envelope) => {
        this.sent.push(envelope);
      },
      streamReadable: async (envelope, _signal, body) => {
        this.streams.push({ envelope, body: body ?? null });
        return this.streamResponse();
      },
      close: async () => {
        this.closed = true;
      },
    } as unknown as IrohClientSession;
  }

  /** The server sends the client an envelope. */
  deliver(envelope: RpcEnvelope): void {
    for (const handler of [...this.messageHandlers]) handler(envelope);
  }

  setStatus(status: RpcConnectionStatus): void {
    this.currentStatus = status;
    for (const handler of [...this.statusHandlers]) handler(status);
  }
}

export interface OpenCall {
  kind: "principal" | "account-control" | "workspace" | "auxiliary";
  label: string;
  workspaceId?: string;
  connectionId?: string;
  getToken?: (signal?: AbortSignal) => Promise<string>;
  handlers: SessionHandlers;
  session: FakeSession;
  released: boolean;
}

/** Openers that record what the host opened and hand back controllable sessions. */
export function fakeOpeners(callerFor: (kind: OpenCall["kind"]) => string = (kind) => `fake:${kind}`) {
  const opened: OpenCall[] = [];
  const open = (
    kind: OpenCall["kind"],
    callerKind: SessionCallerKind,
    call: Omit<OpenCall, "kind" | "session" | "released">
  ): OpenedSession => {
    const session = new FakeSession(callerFor(kind));
    const record: OpenCall = { kind, ...call, session, released: false };
    opened.push(record);
    const build = (current: FakeSession, kindOfCaller: SessionCallerKind): OpenedSession => ({
      session: current.asSession(),
      callerKind: kindOfCaller,
      deviceId: "dev",
      serverId: "srv",
      waitUntilConnected: vi.fn(async () => undefined),
      onReconnectProgress: () => () => undefined,
      openAuxiliary: (label, getToken, handlers, connectionId) =>
        open("auxiliary", "panel", {
          label,
          getToken,
          handlers,
          ...(connectionId ? { connectionId } : {}),
        }),
      release: async () => {
        record.released = true;
        await current.asSession().close();
      },
    });
    return build(session, callerKind);
  };
  const openers: SessionOpeners = {
    principal: (label, getToken, handlers) =>
      open("principal", "client", { label, getToken, handlers }),
    accountControl: (label, handlers) => open("account-control", "shell", { label, handlers }),
    workspace: async (workspaceId, label, handlers) =>
      open("workspace", "shell", { workspaceId, label, handlers }),
  };
  return { openers, opened };
}
