/**
 * HeadlessSession — Channel-message-driven headless agentic session wrapper.
 *
 * Provides a programmatic interface for spawning agent chats from skill
 * code, system tests, etc. Pi runs in-process inside the worker DO; this
 * wrapper subscribes a PubSubClient to the channel and reads persisted
 * channel messages (text, thinking, action, image, inline_ui) to expose
 * chat state.
 * Panel-local UI tools are not exposed by default because there is no browser
 * panel. Tests can opt into synthetic panel UI methods that publish the same
 * typed transcript events without doing browser rendering.
 *
 * Public API:
 *   - `HeadlessSession.create()` — wire up a session, no agent yet
 *   - `HeadlessSession.createWithAgent()` — full setup: connect client + subscribe DO
 *   - `send(text, opts)` — publish a user message
 *   - `waitForAgentMessage()` / `waitForIdle()` / `sendAndWait()` — test helpers
 *   - `messages`, `participants`, `connected`, `status` — getters
 *   - `snapshot()` — diagnostic snapshot
 *   - `dispose()` / `close()` — teardown
 */

import {
  ConnectionManager,
  chatMessagesFromChannelView,
  type ConnectionConfig,
  type AgentSubscriptionConfig,
  type ChatParticipantMetadata,
  type ChatMessage,
  type DirtyRepoDetails,
  type SubagentProgressEntry,
  unwrapChatMethodResult,
  type ChatMethodResult,
} from "@workspace/agentic-core";
import type {
  PubSubClient,
  Participant,
  ChannelConfig,
  MethodDefinition,
  AttachmentInput,
  AgentDebugPayload,
  IncomingEvent,
} from "@workspace/pubsub";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  createInitialChannelViewState,
  reduceChannelView,
  type ActorKind,
  type AgenticEvent,
  type ChannelEnvelope,
  type ChannelViewState,
} from "@workspace/agentic-protocol";
import { z } from "zod";
import {
  createHeadlessAgentContext,
  destroyHeadlessAgentContext,
  getRecommendedChannelConfig,
  retireHeadlessAgent,
  subscribeHeadlessAgent,
  unsubscribeHeadlessAgent,
} from "./channel.js";
import { HeadlessTurnObserver, type HeadlessTurnSnapshot } from "./turn-observer.js";

// ===========================================================================
// Types
// ===========================================================================

export interface SessionSnapshot {
  /** Durable channel that carried this headless conversation. */
  channelId: string | null;
  /** Runtime entity created for the subscribed agent. */
  agentEntityId: string | null;
  /** Runtime relay target for the subscribed agent. */
  agentTargetId: string | null;
  /** Context used by the subscribed agent (isolated unless explicitly inherited). */
  agentContextId: string | null;
  /** Whether this session created and owns the complete agent context lifecycle tree. */
  ownsAgentContext: boolean;
  messages: readonly ChatMessage[];
  invocations: Array<{
    id: string;
    name: string;
    status: string;
    args?: unknown;
    result?: unknown;
    consoleOutput?: string;
    progress?: SubagentProgressEntry[];
    error?: string;
  }>;
  debugEvents: readonly (AgentDebugPayload & { ts: number })[];
  /** Live/terminal state of the one acknowledged session teardown path. */
  cleanup: SessionCleanupState;
  cleanupErrors: readonly SessionCleanupError[];
  participants: Record<string, { name: string; type: string; handle: string; connected: boolean }>;
  localMethodNames: readonly string[];
  connected: boolean;
  duration: number;
  /** The report title set via the agent's `set_title` tool (null until set). */
  title: string | null;
  /** Durable provider/model requests and aggregate usage captured from the agent journal. */
  modelExecutionEvidence?: unknown;
  modelExecutionEvidenceError?: string;
}

export type SessionCleanupPhase =
  | "idle"
  | "unsubscribing-agent"
  | "capturing-model-evidence"
  | "disconnecting-client"
  | "destroying-agent-context"
  | "retiring-agent"
  | "complete";

export interface SessionCleanupState {
  phase: SessionCleanupPhase;
  phaseStartedAt: number;
  completedAt?: number;
}

export interface HeadlessSessionConfig {
  config: ConnectionConfig;
  metadata?: ChatParticipantMetadata;
}

export interface HeadlessWithAgentConfig extends HeadlessSessionConfig {
  rpcCall: (target: string, method: string, args: unknown[]) => Promise<unknown>;
  source: string;
  className: string;
  objectKey?: string;
  /** Omit to allocate a fresh isolated agent context explicitly. */
  contextId?: string;
  /** Exact host-attested authority policy for the isolated system-test case. */
  testPolicy?: import("@vibestudio/shared/authority/testPolicy").AgentExecutionTestPolicySpec;
  channelId?: string;
  channelConfig?: ChannelConfig;
  methods?: Record<string, MethodDefinition>;
  /**
   * Pi-native pass-through subscription config. Common keys: `model`,
   * `thinkingLevel`, `approvalLevel`, `systemPrompt`, and
   * `systemPromptMode`.
   */
  extraConfig?: AgentSubscriptionConfig;
  /**
   * Test-only harness mode: advertise panel-local UI methods from the headless
   * client and publish their typed UI events. This exercises agent/tool
   * integration without a browser renderer.
   */
  includeSyntheticPanelUiMethods?: boolean;
  /**
   * Test-only deterministic fault seam. The advertised validation probe rejects
   * its first well-formed call and accepts later calls, proving tool recovery
   * without asking a model to defeat its own generated schema.
   */
  includeValidationRetryProbeMethod?: boolean;
}

export interface HeadlessWaitOptions {
  debounce?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Fail immediately when the durable turn parks on one of these reasons. */
  terminalWaitingReasons?: readonly string[];
}

function invocationErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["error"] === "string") return record["error"];
    if (typeof record["message"] === "string") return record["message"];
    const details = record["details"];
    if (details && typeof details === "object") {
      const detailError = (details as Record<string, unknown>)["error"];
      if (typeof detailError === "string") return detailError;
    }
    const protocolContent = record["protocolContent"];
    if (Array.isArray(protocolContent)) {
      const text = protocolContent.find(
        (item) => item && typeof item === "object" && typeof item["text"] === "string"
      )?.["text"];
      if (typeof text === "string") return text;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return value == null ? fallback : String(value);
}

// ===========================================================================
// HeadlessSession
// ===========================================================================

const DEFAULT_METADATA: ChatParticipantMetadata = {
  name: "Headless Client",
  type: "headless",
  handle: "headless",
};

interface SessionCleanupError {
  phase: string;
  message: string;
  at: number;
}

interface MessageListener {
  (msg: ChatMessage): void;
}

export class HeadlessSession {
  private _connection: ConnectionManager;
  private _client: PubSubClient<ChatParticipantMetadata> | null = null;
  private _channelId: string | null = null;
  private _clientId: string;
  private _createdAt = Date.now();
  private _config: HeadlessSessionConfig;
  private _agentEntityId: string | null = null;
  private _agentTargetId: string | null = null;
  private _agentContextId: string | null = null;
  private _ownsAgentContext = false;
  private _agentRpcCall: HeadlessWithAgentConfig["rpcCall"] | null = null;

  // Channel message state (derived from persisted + live channel messages)
  private _chatMessages = new Map<string, ChatMessage>();
  private _chatMessageOrder: string[] = [];
  private _channelView: ChannelViewState = createInitialChannelViewState();
  private _hasIncomplete = false;
  private _participants: Record<string, Participant<ChatParticipantMetadata>> = {};
  private _debugEvents: Array<AgentDebugPayload & { ts: number }> = [];
  private _cleanupErrors: SessionCleanupError[] = [];
  private _cleanupState: SessionCleanupState = {
    phase: "idle",
    phaseStartedAt: Date.now(),
  };
  private _closePromise: Promise<void> | null = null;
  private _dirtyRepoWarnings = new Map<string, DirtyRepoDetails>();
  private _registeredMethodNames: string[] = [];
  private _modelExecutionEvidence: unknown;
  private _modelExecutionEvidenceError: string | undefined;
  private _disposed = false;
  private _consumeAbort: AbortController | null = null;
  /**
   * The session/report title set by the agent's `set_title` tool. A headless
   * session has no chat panel, so the title lives HERE (on the report wrapper),
   * not on a runtime entity or the channel config. The headless transport DO is
   * infrastructure, not the titled conversation, and must not borrow code
   * authority merely to mirror report metadata. Surfaced via `title` +
   * `snapshot()`.
   */
  private _title: string | null = null;

  // Listeners
  private _messageListeners = new Set<MessageListener>();

  private constructor(config: HeadlessSessionConfig) {
    this._config = config;
    this._clientId = config.config.clientId;

    this._connection = new ConnectionManager({
      config: config.config,
      metadata: config.metadata ?? DEFAULT_METADATA,
      callbacks: {
        onEvent: (event) => this.handleEvent(event),
      },
    });
  }

  private pubsubAgenticEventToEnvelope(wire: {
    pubsubId?: number;
    senderId?: string;
    senderMetadata?: { name?: string; type?: string; handle?: string };
    ts?: number;
    payload: AgenticEvent;
  }): ChannelEnvelope<AgenticEvent> {
    const participantId = wire.senderId ?? wire.payload.actor.id;
    const metadata = wire.senderMetadata;
    return {
      envelopeId: `pubsub:${wire.pubsubId ?? crypto.randomUUID()}` as never,
      channelId: (this._channelId ?? "headless") as never,
      seq: wire.pubsubId ?? 0,
      from: {
        kind: this.participantKind(metadata?.type),
        id: participantId,
        displayName: metadata?.name,
        participantId,
        metadata,
      },
      payload: wire.payload,
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      contentClass: "external",
      externalKeys: [`msg:${this._channelId ?? "headless"}/${wire.pubsubId ?? "unattributed"}`],
      publishedAt: new Date(wire.ts ?? Date.now()).toISOString(),
    };
  }

  private participantKind(type: string | undefined): "user" | "agent" | "panel" | "external" {
    if (type === "agent" || type === "headless") return "agent";
    if (type === "panel" || type === "client") return "panel";
    return "external";
  }

  /** Create a HeadlessSession with the given config (no agent yet). */
  static create(config: HeadlessSessionConfig): HeadlessSession {
    return new HeadlessSession(config);
  }

  /**
   * Convenience: create a channel, subscribe a DO agent, connect, all in one.
   */
  static async createWithAgent(config: HeadlessWithAgentConfig): Promise<HeadlessSession> {
    const channelId = config.channelId ?? `headless-${crypto.randomUUID()}`;
    const objectKey = config.objectKey ?? `headless-${crypto.randomUUID()}`;
    const session = new HeadlessSession(config);

    const defaultMethods = session.buildDefaultMethods();
    const syntheticPanelUiMethods = config.includeSyntheticPanelUiMethods
      ? session.buildSyntheticPanelUiMethods()
      : {};
    const validationRetryProbeMethods = config.includeValidationRetryProbeMethod
      ? session.buildValidationRetryProbeMethods()
      : {};
    const methods: Record<string, MethodDefinition> = {
      ...defaultMethods,
      ...syntheticPanelUiMethods,
      ...validationRetryProbeMethods,
      ...config.methods,
    };

    const channelConfig: ChannelConfig = {
      ...getRecommendedChannelConfig(),
      ...config.channelConfig,
    } as ChannelConfig;

    const ownsAgentContext = !config.contextId;
    const agentContextId =
      config.contextId ??
      (await createHeadlessAgentContext({
        rpcCall: config.rpcCall,
        ...(config.testPolicy ? { testPolicy: config.testPolicy } : {}),
      }));
    try {
      await session.connect(channelId, {
        channelConfig,
        contextId: agentContextId,
        methods,
      });
      const subscription = await subscribeHeadlessAgent({
        rpcCall: config.rpcCall,
        source: config.source,
        className: config.className,
        objectKey,
        channelId,
        contextId: agentContextId,
        extraConfig: config.extraConfig,
      });
      session._agentEntityId = subscription.entityId;
      session._agentTargetId = subscription.targetId;
      session._agentContextId = subscription.contextId;
      session._ownsAgentContext = ownsAgentContext;
      session._agentRpcCall = config.rpcCall;
    } catch (err) {
      await session.disconnect();
      if (ownsAgentContext) {
        try {
          await destroyHeadlessAgentContext({
            rpcCall: config.rpcCall,
            contextId: agentContextId,
          });
        } catch (cleanupError) {
          throw new AggregateError(
            [err, cleanupError],
            "Headless agent setup failed and its isolated context could not be reclaimed"
          );
        }
      }
      throw err;
    }

    return session;
  }

  // ===========================================================================
  // Default headless methods
  // ===========================================================================

  private buildDefaultMethods(): Record<string, MethodDefinition> {
    const methods: Record<string, MethodDefinition> = {};

    methods["set_title"] = {
      description: "Set the conversation title",
      parameters: z.object({ title: z.string().describe("The new title") }),
      execute: async (args: unknown) => {
        const { title } = args as { title: string };
        if (!title) return { ok: false, error: "Missing title" };
        // Headless context: there is no chat panel or user-facing runtime
        // entity. The title is report metadata, so keep it on the report
        // wrapper. Renaming the transport EvalDO would be the wrong identity;
        // updating channel config would also require panel/server authority.
        this._title = title;
        return { ok: true };
      },
    };

    return methods;
  }

  private actorKindFromMetadata(type: string | undefined): ActorKind {
    if (type === "agent" || type === "system" || type === "panel" || type === "external") {
      return type;
    }
    return "user";
  }

  private localActor() {
    const metadata = this._config.metadata ?? DEFAULT_METADATA;
    const id = this._client?.clientId ?? this._clientId ?? metadata.handle ?? "headless";
    return {
      kind: this.actorKindFromMetadata(metadata.type),
      id,
      displayName: metadata.name ?? id,
      metadata: { ...metadata },
    };
  }

  private async publishSyntheticPanelUiEvent(
    event: AgenticEvent<"ui.inline_rendered" | "ui.action_bar.updated">,
    idempotencyKey: string
  ): Promise<number | undefined> {
    const client = this._client;
    if (!client) return undefined;
    return client.publish(AGENTIC_EVENT_PAYLOAD_KIND, event, { idempotencyKey });
  }

  private buildSyntheticPanelUiMethods(): Record<string, MethodDefinition> {
    const methods: Record<string, MethodDefinition> = {};

    methods["inline_ui"] = {
      description:
        "Synthetic panel harness: render a persistent inline UI component in the chat transcript. Provide either TSX code or a context-relative path. Publishes the same typed inline UI event as the browser panel tool, but does not mount a browser renderer.",
      parameters: z.object({
        code: z.string().optional(),
        path: z.string().optional(),
        imports: z.record(z.string(), z.string()).optional(),
        props: z.record(z.unknown()).optional(),
      }),
      execute: async (args: unknown) => {
        const { code, path, imports, props } = args as {
          code?: string;
          path?: string;
          imports?: Record<string, string>;
          props?: Record<string, unknown>;
        };
        const trimmedPath = path?.trim();
        if (!trimmedPath && !code) return { ok: false, error: "Missing code or path" };

        const id = crypto.randomUUID();
        const source = trimmedPath
          ? { type: "file" as const, path: trimmedPath }
          : { type: "code" as const, code: code! };
        const eventPayload: AgenticEvent<"ui.inline_rendered">["payload"] = {
          protocol: AGENTIC_PROTOCOL_VERSION,
          uiType: "inline",
          id,
          source,
        };
        if (imports !== undefined) eventPayload.imports = imports;
        if (props !== undefined) eventPayload.props = props;
        await this.publishSyntheticPanelUiEvent(
          {
            kind: "ui.inline_rendered",
            actor: this.localActor(),
            payload: eventPayload,
            createdAt: new Date().toISOString(),
          },
          `synthetic-ui:inline:${id}`
        );
        return { ok: true, id };
      },
    };

    methods["load_action_bar"] = {
      description:
        "Synthetic panel harness: load, replace, or clear a compact panel action bar. Provide a context-relative TSX path unless clear is true. Publishes the same typed action-bar update event as the browser panel tool, but does not mount a browser renderer.",
      parameters: z.object({
        path: z.string().optional(),
        imports: z.record(z.string(), z.string()).optional(),
        props: z.record(z.unknown()).optional(),
        maxHeight: z.number().optional(),
        clear: z.boolean().optional(),
      }),
      execute: async (args: unknown) => {
        const { path, imports, props, maxHeight, clear } = args as {
          path?: string;
          imports?: Record<string, string>;
          props?: Record<string, unknown>;
          maxHeight?: number;
          clear?: boolean;
        };
        if (clear) {
          await this.publishSyntheticPanelUiEvent(
            {
              kind: "ui.action_bar.updated",
              actor: this.localActor(),
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                uiType: "action_bar",
                cleared: true,
                result: { ok: true },
              },
              createdAt: new Date().toISOString(),
            },
            `synthetic-ui:action-bar:clear:${crypto.randomUUID()}`
          );
          return { ok: true, cleared: true };
        }

        const trimmedPath = path?.trim();
        if (!trimmedPath) return { ok: false, error: "Missing path" };

        const id = crypto.randomUUID();
        const eventPayload: AgenticEvent<"ui.action_bar.updated">["payload"] = {
          protocol: AGENTIC_PROTOCOL_VERSION,
          uiType: "action_bar",
          id,
          source: { type: "file", path: trimmedPath },
          result: { ok: true },
        };
        if (imports !== undefined) eventPayload.imports = imports;
        if (props !== undefined) eventPayload.props = props;
        if (maxHeight !== undefined) eventPayload.maxHeight = maxHeight;
        await this.publishSyntheticPanelUiEvent(
          {
            kind: "ui.action_bar.updated",
            actor: this.localActor(),
            payload: eventPayload,
            createdAt: new Date().toISOString(),
          },
          `synthetic-ui:action-bar:${id}`
        );
        return { ok: true, id };
      },
    };

    return methods;
  }

  private buildValidationRetryProbeMethods(): Record<string, MethodDefinition> {
    let rejectedFirstCall = false;
    return {
      validation_retry_probe: {
        description:
          "Deterministic validation-recovery probe. Its first well-formed call is rejected as invalid arguments; after observing that error, call the same tool again to prove a corrected request can complete.",
        parameters: z
          .object({
            value: z.string().describe("A short value to validate"),
          })
          .strict(),
        execute: async ({ value }) => {
          if (!rejectedFirstCall) {
            rejectedFirstCall = true;
            throw new Error(
              "Invalid arguments for tool validation_retry_probe: injected first-call argument rejection"
            );
          }
          return { ok: true, recovered: true, value };
        },
      },
    };
  }

  // ===========================================================================
  // Event tracking (debug events)
  // ===========================================================================

  private handleEvent(event: IncomingEvent): void {
    if (event.type === "agent-debug") {
      const payload = (event as IncomingEvent & { payload: AgentDebugPayload }).payload;
      const ts = (event as IncomingEvent & { ts: number }).ts ?? Date.now();
      this._debugEvents.push({ ...payload, ts });

      // Dirty repo warnings
      if (
        payload.debugType === "lifecycle" &&
        payload.event === "warning" &&
        payload.reason === "dirty-repo"
      ) {
        const details = payload.details as DirtyRepoDetails | undefined;
        if (details) {
          this._dirtyRepoWarnings.set(payload.handle, details);
        }
      }
    }
  }

  // ===========================================================================
  // Connection lifecycle
  // ===========================================================================

  async connect(
    channelId: string,
    options?: {
      channelConfig?: ChannelConfig;
      contextId?: string;
      methods?: Record<string, MethodDefinition>;
    }
  ): Promise<void> {
    const methods = options?.methods ?? this.buildDefaultMethods();
    this._registeredMethodNames = Object.keys(methods).sort();

    this._client = await this._connection.connect({
      channelId,
      methods,
      ...(options?.channelConfig ? { channelConfig: options.channelConfig } : {}),
      ...(options?.contextId ? { contextId: options.contextId } : {}),
    });
    this._channelId = channelId;

    // Roster subscription
    this._client.onRoster?.((update) => {
      this._participants = { ...update.participants };
    });

    // Message stream → snapshot derivation
    this._consumeAbort = new AbortController();
    void this.consumeChannelMessages(this._consumeAbort.signal);
  }

  private async consumeChannelMessages(signal: AbortSignal): Promise<void> {
    if (!this._client) return;
    try {
      for await (const event of this._client.events({
        includeReplay: true,
        includeSignals: false,
      })) {
        if (signal.aborted) break;

        const wire = event as unknown as {
          type?: string;
          pubsubId?: number;
          senderId?: string;
          senderMetadata?: { name?: string; type?: string; handle?: string };
          ts?: number;
          payload?: AgenticEvent;
        };

        if (wire.type === AGENTIC_EVENT_PAYLOAD_KIND && wire.payload) {
          this._channelView = reduceChannelView(
            this._channelView,
            this.pubsubAgenticEventToEnvelope({
              pubsubId: wire.pubsubId,
              senderId: wire.senderId,
              senderMetadata: wire.senderMetadata,
              ts: wire.ts,
              payload: wire.payload,
            })
          );
          this._chatMessages.clear();
          this._chatMessageOrder = [];
          for (const msg of chatMessagesFromChannelView(this._channelView)) {
            this._chatMessages.set(msg.id, msg);
            this._chatMessageOrder.push(msg.id);
          }
          this.recomputeHasIncomplete();
          this.notifyListeners();
        }
      }
    } catch (err) {
      if (!signal.aborted) console.error("[HeadlessSession] message consumer error:", err);
    }
  }

  /** Scan all messages to determine if any are still incomplete (streaming). */
  private recomputeHasIncomplete(): void {
    for (const msg of this._chatMessages.values()) {
      if (!msg.complete) {
        this._hasIncomplete = true;
        return;
      }
    }
    this._hasIncomplete = false;
  }

  private notifyListeners(): void {
    const msgs = this.messages;
    if (msgs.length === 0) return;
    const latest = msgs[msgs.length - 1]!;
    for (const listener of this._messageListeners) {
      try {
        listener(latest);
      } catch (err) {
        console.error("[HeadlessSession] message listener threw:", err);
      }
    }
  }

  /**
   * Subscribe to message-state updates. Fires on every channel update,
   * including streaming deltas (so a renderer can show partial agent output).
   * Returns an unsubscribe function. Used by non-React renderers (e.g. the Ink
   * terminal chat) the same way the React hooks consume the message stream.
   */
  onMessage(listener: (msg: ChatMessage) => void): () => void {
    this._messageListeners.add(listener);
    return () => {
      this._messageListeners.delete(listener);
    };
  }

  async send(
    text: string,
    options?: {
      attachments?: AttachmentInput[];
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<string> {
    if (!this._client) throw new Error("Not connected");
    const result = await this._client.send(text, options);
    return result.messageId;
  }

  async interrupt(
    agentId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<void> {
    if (this._agentRpcCall && this._channelId) {
      await this._agentRpcCall(agentId, "interruptChannel", [this._channelId]);
      return;
    }
    if (!this._client) return;
    const handle = this._client.callMethod(agentId, "pause", {}, options);
    unwrapChatMethodResult(await handle.result);
  }

  async callMethod(participantId: string, method: string, args: unknown): Promise<unknown> {
    if (!this._client) throw new Error("Not connected");
    const handle = this._client.callMethod(participantId, method, args);
    const result = await (handle as { result: Promise<ChatMethodResult> }).result;
    return unwrapChatMethodResult(result);
  }

  async callMethodResult(
    participantId: string,
    method: string,
    args: unknown
  ): Promise<ChatMethodResult> {
    if (!this._client) throw new Error("Not connected");
    const handle = this._client.callMethod(participantId, method, args);
    return (handle as { result: Promise<ChatMethodResult> }).result;
  }

  /**
   * Capture durable proof of the model calls this agent actually executed.
   * Unlike creation config or live settings, this reads journaled
   * message.started/message.completed descriptors and usage.
   */
  async captureModelExecutionEvidence(): Promise<unknown> {
    const targetId = this._agentTargetId;
    if (!targetId) throw new Error("No subscribed agent is available for model execution evidence");
    const channelId = this._channelId;
    if (!channelId) throw new Error("No channel is available for model execution evidence");
    try {
      const evidence = this._agentRpcCall
        ? await this._agentRpcCall(targetId, "getModelExecutionEvidence", [channelId])
        : await this.callMethod(targetId, "getModelExecutionEvidence", {});
      this._modelExecutionEvidence = evidence;
      this._modelExecutionEvidenceError = undefined;
      return evidence;
    } catch (error) {
      this._modelExecutionEvidenceError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async loadEarlierMessages(): Promise<void> {
    /* no-op: channel replay delivers full persisted history */
  }

  async disconnect(): Promise<void> {
    if (this._consumeAbort) {
      this._consumeAbort.abort();
      this._consumeAbort = null;
    }
    try {
      await this._connection.disconnect();
    } catch (err) {
      this.recordCleanupError("disconnect", err);
    }
    this._client = null;
    this._channelId = null;
  }

  private recordCleanupError(phase: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[HeadlessSession] ${phase} failed:`, error);
    this._cleanupErrors.push({ phase, message, at: Date.now() });
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    await this.disconnect();
    this._messageListeners.clear();
  }

  close(options?: { onPhase?: (state: SessionCleanupState) => void }): Promise<void> {
    if (!this._closePromise) {
      this._closePromise = this.closeOnce(options);
    } else if (options?.onPhase) {
      options.onPhase({ ...this._cleanupState });
    }
    return this._closePromise;
  }

  private setCleanupPhase(
    phase: SessionCleanupPhase,
    onPhase?: (state: SessionCleanupState) => void
  ): void {
    const now = Date.now();
    this._cleanupState = {
      phase,
      phaseStartedAt: now,
      ...(phase === "complete" ? { completedAt: now } : {}),
    };
    onPhase?.({ ...this._cleanupState });
  }

  private async closeOnce(options?: {
    onPhase?: (state: SessionCleanupState) => void;
  }): Promise<void> {
    const entityId = this._agentEntityId;
    const targetId = this._agentTargetId;
    const contextId = this._agentContextId;
    const ownsContext = this._ownsAgentContext;
    const channelId = this._channelId;
    const rpcCall = this._agentRpcCall;

    const unsubscribe = async () => {
      if (!targetId || !channelId || !rpcCall) return;
      await unsubscribeHeadlessAgent({ rpcCall, targetId, channelId }).catch((err) => {
        this.recordCleanupError("unsubscribeHeadlessAgent", err);
      });
    };
    const cleanupRemote = async () => {
      if (!rpcCall) return;
      // A context minted for this launch is the lifecycle unit. Destroying it
      // recursively retires the root and descendants, so it has one owner and
      // no entity-level fallback path.
      if (ownsContext && contextId) {
        await destroyHeadlessAgentContext({ rpcCall, contextId }).catch((err) => {
          this.recordCleanupError("destroyHeadlessAgentContext", err);
        });
        return;
      }

      // In a caller-owned context, the session owns only its entity after the
      // subscription has been closed. Retirement observes the terminal result.
      if (!entityId) return;
      await retireHeadlessAgent({ rpcCall, entityId }).catch((err) => {
        this.recordCleanupError("retireHeadlessAgent", err);
      });
    };
    // Stop the agent's subscription before disconnecting the headless peer.
    // A participant-left envelope is ordinary channel input; leaving the agent
    // subscribed while the client departs can schedule a fresh model turn
    // after the test has already reached its terminal result.
    this.setCleanupPhase("unsubscribing-agent", options?.onPhase);
    await unsubscribe();
    // Close the agent's effect-admission boundary before collecting optional
    // diagnostics. A final transcript message is visible slightly before its
    // durable turn is fully quiescent; probing first left that window open for
    // a queued continuation to begin just as the owning context was retired.
    if (targetId && this._client && this._modelExecutionEvidence === undefined) {
      this.setCleanupPhase("capturing-model-evidence", options?.onPhase);
      await this.captureModelExecutionEvidence().catch((error) => {
        console.warn("[HeadlessSession] model execution evidence capture failed:", error);
      });
    }
    this._agentEntityId = null;
    this._agentTargetId = null;
    this._agentRpcCall = null;
    this.setCleanupPhase("disconnecting-client", options?.onPhase);
    await this.dispose();
    this.setCleanupPhase(
      ownsContext && contextId ? "destroying-agent-context" : "retiring-agent",
      options?.onPhase
    );
    await cleanupRemote();
    this.setCleanupPhase("complete", options?.onPhase);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ===========================================================================
  // State getters
  // ===========================================================================

  get messages(): readonly ChatMessage[] {
    return this._chatMessageOrder.map((id) => this._chatMessages.get(id)!);
  }

  get participants(): Readonly<Record<string, Participant<ChatParticipantMetadata>>> {
    return this._participants;
  }

  get allParticipants(): Readonly<Record<string, Participant<ChatParticipantMetadata>>> {
    return this._participants;
  }

  get connected(): boolean {
    return this._connection.connected;
  }

  get status(): string {
    return this._connection.status;
  }

  get channelId(): string | null {
    return this._channelId;
  }

  get agentEntityId(): string | null {
    return this._agentEntityId;
  }

  get agentTargetId(): string | null {
    return this._agentTargetId;
  }

  get agentContextId(): string | null {
    return this._agentContextId;
  }

  get ownsAgentContext(): boolean {
    return this._ownsAgentContext;
  }

  /** The report title set via the agent's `set_title` tool (null until set). */
  get title(): string | null {
    return this._title;
  }

  get debugEvents(): readonly (AgentDebugPayload & { ts: number })[] {
    return this._debugEvents;
  }

  get isStreaming(): boolean {
    return this._hasIncomplete;
  }

  get client(): PubSubClient<ChatParticipantMetadata> | null {
    return this._client;
  }

  // ===========================================================================
  // Snapshot
  // ===========================================================================

  snapshot(): SessionSnapshot {
    const now = Date.now();
    const participants: SessionSnapshot["participants"] = {};
    for (const [id, p] of Object.entries(this._participants)) {
      participants[id] = {
        name: p.metadata.name,
        type: p.metadata.type,
        handle: p.metadata.handle ?? id,
        connected: true,
      };
    }
    const invocations = this.messages
      .filter((message) => message.invocation)
      .map((message) => ({
        id: message.invocation!.id,
        name: message.invocation!.name,
        status: message.invocation!.execution.status,
        args: message.invocation!.arguments,
        result: message.invocation!.execution.result,
        consoleOutput: message.invocation!.execution.consoleOutput,
        progress: message.invocation!.execution.progress,
        error: message.invocation!.execution.isError
          ? invocationErrorMessage(
              message.invocation!.execution.result,
              message.invocation!.execution.description || "Invocation failed"
            )
          : undefined,
      }));
    return {
      channelId: this._channelId,
      agentEntityId: this._agentEntityId,
      agentTargetId: this._agentTargetId,
      agentContextId: this._agentContextId,
      ownsAgentContext: this._ownsAgentContext,
      messages: this.messages,
      invocations,
      debugEvents: this._debugEvents,
      cleanup: { ...this._cleanupState },
      cleanupErrors: [...this._cleanupErrors],
      participants,
      localMethodNames: this._registeredMethodNames,
      connected: this._connection.connected,
      duration: now - this._createdAt,
      title: this._title,
      ...(this._modelExecutionEvidence !== undefined
        ? { modelExecutionEvidence: this._modelExecutionEvidence }
        : {}),
      ...(this._modelExecutionEvidenceError
        ? { modelExecutionEvidenceError: this._modelExecutionEvidenceError }
        : {}),
    };
  }

  // ===========================================================================
  // Headless-specific
  // ===========================================================================

  getRecommendedChannelConfig() {
    return getRecommendedChannelConfig();
  }

  /**
   * Wait for a message from an agent (any non-self participant).
   */
  waitForAgentMessage(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ChatMessage> {
    return this.waitForTurn("response", opts);
  }

  /**
   * Wait for the agent to become idle (no new messages for `debounce` ms).
   */
  waitForIdle(opts?: HeadlessWaitOptions): Promise<ChatMessage> {
    return this.waitForTurn("settled", opts);
  }

  private turnSnapshot(): HeadlessTurnSnapshot {
    return { messages: this.messages, channelView: this._channelView };
  }

  private waitForTurn(
    completion: "response" | "settled",
    opts?: HeadlessWaitOptions
  ): Promise<ChatMessage> {
    const observer = new HeadlessTurnObserver(this._clientId, this.turnSnapshot(), {
      ...(opts?.terminalWaitingReasons
        ? { terminalWaitingReasons: opts.terminalWaitingReasons }
        : {}),
    });
    const debounceMs = opts?.debounce ?? 3_000;
    const label = completion === "response" ? "agent message" : "idle";

    return new Promise<ChatMessage>((resolve, reject) => {
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let finished = false;

      const cleanup = () => {
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        if (timeout !== undefined) clearTimeout(timeout);
        opts?.signal?.removeEventListener("abort", onAbort);
        this._messageListeners.delete(listener);
      };
      const succeed = (message: ChatMessage) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(message);
      };
      const fail = (reason: string) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error(`Agent failed: ${reason}`));
      };
      const evaluate = () => {
        if (finished) return;
        const observation = observer.observe(this.turnSnapshot());
        if (observation.terminal?.kind === "failed") {
          fail(observation.terminal.reason);
          return;
        }
        if (completion === "response" && observation.response) {
          succeed(observation.response);
          return;
        }
        if (completion === "settled" && observation.terminal?.kind === "succeeded") {
          if (debounceTimer === undefined) {
            debounceTimer = setTimeout(() => {
              debounceTimer = undefined;
              const settled = observer.observe(this.turnSnapshot()).terminal;
              if (settled?.kind === "failed") fail(settled.reason);
              else if (settled?.kind === "succeeded") succeed(settled.message);
            }, debounceMs);
          }
        }
      };
      const listener: MessageListener = () => evaluate();
      const onAbort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error(`waitFor${completion === "response" ? "AgentMessage" : "Idle"} aborted`));
      };

      this._messageListeners.add(listener);
      if (opts?.signal?.aborted) {
        onAbort();
        return;
      }
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(new Error(`Timed out waiting for ${label} after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      // Close the race between the baseline snapshot and listener registration.
      evaluate();
    });
  }

  async sendAndWait(text: string, opts?: HeadlessWaitOptions): Promise<ChatMessage> {
    const wait = this.waitForIdle(opts);
    await this.send(text);
    return wait;
  }
}
