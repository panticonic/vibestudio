/**
 * ConnectionManager — Headless PubSub connection lifecycle.
 *
 * PubSub connection lifecycle — connect, disconnect, event loop, roster.
 * Manages connect/disconnect, event loop, roster, reconnect.
 */

import { connectViaRpc } from "@workspace/pubsub";
import type {
  PubSubClient,
  RosterUpdate,
  IncomingEvent,
  MethodDefinition,
  ChannelConfig,
} from "@workspace/pubsub";
import type { ChatParticipantMetadata, ConnectionConfig } from "./types.js";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * Client-supplied participant metadata for connecting (WP6 §5). `handle` is
 * OPTIONAL here: a human panel no longer asserts one — the channel derives the
 * authoritative identity (`user:<userId>`, account handle/displayName) from the
 * host-verified subject on the caller envelope (WP6 §3). What the client sends
 * is a panel LABEL for its own UI, not identity. Agents/vessels still supply
 * their own descriptor (they are not human accounts).
 */
export type ClientParticipantMetadata = Partial<ChatParticipantMetadata> &
  Pick<ChatParticipantMetadata, "name" | "type">;

export interface ConnectionCallbacks {
  onEvent?: (event: IncomingEvent) => void;
  onRoster?: (roster: RosterUpdate<ChatParticipantMetadata>) => void;
  onError?: (error: Error) => void;
  onReconnect?: () => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export interface ConnectionConnectOptions {
  channelId: string;
  methods: Record<string, MethodDefinition>;
  channelConfig?: ChannelConfig;
  contextId?: string;
}

export class ConnectionManager {
  private config: ConnectionConfig;
  private metadata: ClientParticipantMetadata;
  private callbacks: ConnectionCallbacks;
  private _client: PubSubClient<ChatParticipantMetadata> | null = null;
  private _status: ConnectionStatus = "disconnected";
  private _clientId: string | null = null;
  private unsubscribers: Array<() => void> = [];
  private connectAbortController: AbortController | null = null;

  constructor(opts: {
    config: ConnectionConfig;
    metadata: ClientParticipantMetadata;
    callbacks: ConnectionCallbacks;
  }) {
    this.config = opts.config;
    this.metadata = opts.metadata;
    this.callbacks = opts.callbacks;
  }

  get client(): PubSubClient<ChatParticipantMetadata> | null {
    return this._client;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get connected(): boolean {
    return this._status === "connected";
  }

  get clientId(): string | null {
    return this._clientId;
  }

  async connect(options: ConnectionConnectOptions): Promise<PubSubClient<ChatParticipantMetadata>> {
    const { channelId, methods, channelConfig, contextId } = options;

    if (!this.config.rpc) {
      const error = new Error("PubSub RPC configuration not available");
      this.callbacks.onError?.(error);
      this.setStatus("error");
      throw error;
    }

    // Close existing connection if any
    this.disconnect();
    this.setStatus("connecting");
    const readyAbort = new AbortController();
    this.connectAbortController = readyAbort;

    let newClient: PubSubClient<ChatParticipantMetadata> | null = null;
    try {
      newClient = connectViaRpc<ChatParticipantMetadata>({
        rpc: this.config.rpc,
        channel: channelId,
        contextId,
        channelConfig,
        // No asserted HUMAN handle (WP6 §5): the channel stamps human identity
        // from the host-verified subject, ignoring client-supplied handles.
        // Agents/headless workers still pass their own descriptor through.
        ...(this.metadata.handle !== undefined ? { handle: this.metadata.handle } : {}),
        name: this.metadata.name,
        type: this.metadata.type,
        reconnect: true,
        clientId: this.config.clientId,
        protocol: this.config.protocol,
        // Roster reads stay `ChatParticipantMetadata` (the channel fills the
        // authoritative handle); only the OUTBOUND label may omit it.
        metadata: this.metadata as ChatParticipantMetadata,
        methods,
        replayMode: "stream",
        replayMessageLimit: this.config.replayMessageLimit ?? 10_000,
        recoveryCoordinator: this.config.recoveryCoordinator,
      });

      // Wait for the initial replay to complete
      await newClient.ready(readyAbort.signal);
      if (this.connectAbortController !== readyAbort) {
        newClient.close();
        throw new Error("Connection attempt was superseded");
      }
      this.connectAbortController = null;

      this._client = newClient;
      this._clientId = newClient.clientId ?? null;
      console.info("[ConnectionManager] channel replay connected", {
        channelId,
        requestedContextId: contextId ?? null,
        resolvedContextId: newClient.contextId ?? null,
        replayMessageLimit: this.config.replayMessageLimit ?? 10_000,
        totalMessageCount: newClient.totalMessageCount ?? null,
        envelopeCount: newClient.envelopeCount ?? null,
        firstEnvelopeSeq: newClient.firstEnvelopeSeq ?? null,
        hasMoreBefore: newClient.hasMoreBefore ?? null,
      });

      const unsubs: Array<() => void> = [];

      // Set up unified event handling
      const eventIterator = newClient.events({ includeReplay: true, includeSignals: true });
      let eventLoopRunning = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let eventIteratorRef: AsyncIterableIterator<any> | null = eventIterator;

      void (async () => {
        try {
          for await (const event of eventIterator) {
            if (!eventLoopRunning) break;
            try {
              this.callbacks.onEvent?.(event as IncomingEvent);
            } catch (callbackError) {
              console.error("[ConnectionManager] Event callback error:", callbackError);
            }
          }
        } catch (streamError) {
          console.error("[ConnectionManager] Event stream error:", streamError);
          this.callbacks.onError?.(
            streamError instanceof Error ? streamError : new Error(String(streamError))
          );
        } finally {
          eventIteratorRef = null;
        }
      })();
      unsubs.push(() => {
        eventLoopRunning = false;
        eventIteratorRef?.return?.();
        eventIteratorRef = null;
      });

      // Set up roster handler
      unsubs.push(
        newClient.onRoster((roster: RosterUpdate<ChatParticipantMetadata>) => {
          try {
            this.callbacks.onRoster?.(roster);
          } catch (rosterError) {
            console.error("[ConnectionManager] Roster callback error:", rosterError);
          }
        })
      );

      // Set up reconnect handler
      unsubs.push(
        newClient.onReconnect(() => {
          try {
            this.callbacks.onReconnect?.();
          } catch (reconnectError) {
            console.error("[ConnectionManager] Reconnect callback error:", reconnectError);
          }
        })
      );

      this.unsubscribers = unsubs;
      this.setStatus("connected");
      return newClient;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      newClient?.close();
      if (readyAbort.signal.aborted && this.connectAbortController !== readyAbort) {
        throw error;
      }
      if (this.connectAbortController === readyAbort) {
        this.connectAbortController = null;
      }
      this.callbacks.onError?.(error);
      this.setStatus("error");
      this.disconnect();
      throw error;
    }
  }

  disconnect(): void {
    this.connectAbortController?.abort();
    this.connectAbortController = null;

    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    if (this._client) {
      this._client.close();
    }
    this._client = null;
    this._clientId = null;
    this.setStatus("disconnected");
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.callbacks.onStatusChange?.(status);
  }
}
