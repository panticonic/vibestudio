/**
 * Agentic Chat Panel
 *
 * On mount without a channelName, auto-generates a channel and spawns the
 * default agent DO (AiChatWorker). The panel's own contextId is used
 * directly — no cross-context navigation needed.
 */

import {
  contextId,
  rpc,
  panel,
  buildPanelLink,
  createDurableObjectServiceClient,
  openPanel,
  notifications,
  extensions,
} from "@workspace/runtime";
import { recoveryCoordinator } from "@workspace/runtime/internal/diagnostics";
import { usePanelTheme, useStateArgs } from "@workspace/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Callout, Flex, Text, Theme } from "@radix-ui/themes";
import { AgenticChat, ErrorBoundary, ReviewAndPickSurface } from "@workspace/agentic-chat";
import type {
  ConnectionConfig,
  AgenticChatActions,
  ToolProvider,
  ForkNavHandlers,
  ReviewTarget,
  NewConversationOptions,
} from "@workspace/agentic-chat";
import { useAppTheme } from "@workspace/ui/panel";
import "@workspace/ui/tokens.css";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import type {
  AvailableAgent,
  ModelCatalog,
  AgentSubscriptionConfig,
  ConnectProviderResult,
} from "@workspace/agentic-core";
import { toPanelConnectRequest } from "@workspace/model-catalog/providerConnect";
import {
  DEFAULT_AGENT_MODEL_REF,
  LOCAL_MODELS_EXTENSION_ID,
  MODEL_SETTINGS_SERVICE_PROTOCOL,
  type DefaultAgentConfig,
  type ModelSettingsSnapshot,
} from "@workspace/model-catalog/catalog";
import type { DurableObjectServiceClient } from "@workspace/runtime";
import {
  appendInstalledAgent,
  buildAgentSubscriptionConfig,
  resolveChatContextId,
  sanitizeHandle,
} from "./bootstrap.js";
import { createAndSubscribeAgent } from "./agentLifecycle.js";

function detectHostPlatform(): "mobile" | "electron" {
  const explicitPlatform = (globalThis as { __vibestudioHostPlatform?: unknown })
    .__vibestudioHostPlatform;
  if (explicitPlatform === "mobile") {
    return "mobile";
  }
  if (typeof navigator !== "undefined" && /\bVibestudio-Mobile\//.test(navigator.userAgent)) {
    return "mobile";
  }
  return "electron";
}

/** Default DO worker source and class for the AI chat agent */
const DEFAULT_WORKER_SOURCE = "workers/agent-worker";
const DEFAULT_CLASS_NAME = "AiChatWorker";
const DEFAULT_HANDLE = "ai-chat";
const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const AGENT_SUBSCRIPTION_RETRY_DELAY_MS = 1_000;
const AGENT_SUBSCRIPTION_MAX_ATTEMPTS = 60;

/** Response shape from workers.listSources */
interface WorkerSourceEntry {
  name: string;
  source: string;
  title?: string;
  classes: Array<{ className: string }>;
  /** Present iff this worker declares itself a chat agent (manifest `agent` block). */
  agent?: {
    displayName?: string;
    description?: string;
    icon?: string;
    defaultConfig?: AgentSubscriptionConfig;
  };
}

interface ChannelParticipant {
  participantId: string;
  metadata: Record<string, unknown>;
}

interface ChannelDORef {
  source: string;
  className: string;
  objectKey: string;
}

function parseDoTargetId(participantId: string): ChannelDORef | null {
  if (!participantId.startsWith("do:")) return null;
  const body = participantId.slice(3);
  const slashIdx = body.indexOf("/");
  const colonAfterSlash = slashIdx >= 0 ? body.indexOf(":", slashIdx) : -1;
  if (colonAfterSlash === -1) return null;
  const source = body.slice(0, colonAfterSlash);
  const rest = body.slice(colonAfterSlash + 1);
  const nextColon = rest.indexOf(":");
  if (nextColon === -1) return null;
  return {
    source,
    className: rest.slice(0, nextColon),
    objectKey: rest.slice(nextColon + 1),
  };
}

async function getChannelDOParticipants(channelId: string): Promise<ChannelDORef[]> {
  const channelService = await rpc.call<{ kind: string; targetId?: string }>(
    "main",
    "workers.resolveService",
    [CHANNEL_SERVICE_PROTOCOL, channelId]
  );
  if (channelService.kind !== "durable-object" || !channelService.targetId) {
    throw new Error("Channel service must resolve to a Durable Object service");
  }
  const participants = await rpc.call<ChannelParticipant[]>(
    channelService.targetId,
    "getParticipants",
    []
  );
  return participants
    .map((p) => parseDoTargetId(p.participantId))
    .filter((p): p is ChannelDORef => p !== null);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Persisted per-agent record. `key` is the stable DO `objectKey` minted once
 *  when the user first adds the agent, so rehydration reuses the same entity
 *  row rather than spawning a fresh participant. */
interface InstalledAgent {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
  /** Per-agent subscription config (model, effort, etc.), layered over the
   *  global `agentConfig` on rehydration so switched/added agents come back
   *  on their own model. Excludes `handle` (stored separately above). */
  config?: Record<string, unknown>;
}

/** Type for chat panel state args */
interface ChatStateArgs {
  channelName?: string;
  channelConfig?: Record<string, unknown>;
  contextId?: string;
  installedAgents?: InstalledAgent[];
  agentSource?: string;
  agentClass?: string;
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** Send initialPrompt even if the channel already has history (e.g. a fork). */
  forceInitialPrompt?: boolean;
  /** System prompt for the agent harness */
  systemPrompt?: string;
  /** How systemPrompt interacts with Vibestudio base, workspace prompt, and skills */
  systemPromptMode?: "append" | "replace-vibestudio" | "replace";
  /** Extra subscription config for custom/test agents */
  agentConfig?: Record<string, unknown>;
  /** Context-relative TSX file to load into the panel-local action bar */
  actionBarFile?: string | null;
  /** Props for actionBarFile */
  actionBarProps?: Record<string, unknown> | null;
  /** Preferred max height for actionBarFile */
  actionBarMaxHeight?: number | null;
  /** Per-fork read cursors (channelId → last-seen head seq) for live badges. */
  forkCursors?: Record<string, number>;
}

/** Unsubscribe a DO from a channel via unified RPC. */
async function unsubscribeDOFromChannel(
  source: string,
  className: string,
  objectKey: string,
  channelId: string
): Promise<void> {
  const target = await rpc.call<{ targetId: string }>("main", "workers.resolveDurableObject", [
    source,
    className,
    objectKey,
  ]);
  await rpc.call(target.targetId, "unsubscribeChannel", [channelId]);
}

export default function ChatPanel() {
  const theme = usePanelTheme();
  const appTheme = useAppTheme();
  const stateArgs = useStateArgs<ChatStateArgs>();
  const resolvedContextId = resolveChatContextId(stateArgs.contextId, contextId);
  const initialPromptCaptured = useRef(stateArgs.initialPrompt);
  const modelSettingsServiceRef = useRef<DurableObjectServiceClient | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [workspaceDefaultModelRef, setWorkspaceDefaultModelRef] = useState<string | null>(null);
  const [workspaceDefaultAgentConfig, setWorkspaceDefaultAgentConfig] =
    useState<DefaultAgentConfig | null>(null);
  const catalogRef = useRef<ModelCatalog | null>(null);
  // "using the local fallback model" banner (design §8) — the ref it fell to,
  // or null; dismissible per session.
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [fallbackNoticeDismissed, setFallbackNoticeDismissed] = useState(false);

  const getModelSettingsService = useCallback(() => {
    modelSettingsServiceRef.current ??= createDurableObjectServiceClient(
      MODEL_SETTINGS_SERVICE_PROTOCOL
    );
    return modelSettingsServiceRef.current;
  }, []);

  const loadModelSettings = useCallback(async (): Promise<ModelSettingsSnapshot> => {
    const settings = await getModelSettingsService().call<ModelSettingsSnapshot>("getSettings");
    catalogRef.current = settings.catalog;
    setModelCatalog(settings.catalog);
    setWorkspaceDefaultModelRef(settings.defaultModel);
    setWorkspaceDefaultAgentConfig(settings.defaultAgentConfig);
    // Honest expectation-setting (design §8): when the default resolved to the
    // local floor because nothing else is usable, say so above the chat.
    setFallbackNotice(
      settings.defaultModelSource === "fallback" && settings.defaultModel.startsWith("local:")
        ? settings.defaultModel
        : null
    );
    return settings;
  }, [getModelSettingsService]);

  const resolveWorkspaceDefaultAgentConfig = useCallback(async (): Promise<DefaultAgentConfig> => {
    try {
      const settings = await loadModelSettings();
      return (
        settings.defaultAgentConfig ?? { model: settings.defaultModel || DEFAULT_AGENT_MODEL_REF }
      );
    } catch (err) {
      console.warn("[ChatPanel] Failed to load workspace model default:", err);
      return { model: DEFAULT_AGENT_MODEL_REF };
    }
  }, [loadModelSettings]);

  // Auto-bootstrap: when no channelName, mint one (channel only). The agent is
  // created lazily by the chat surface on the first message / initialPrompt.
  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const bootstrapAttempted = useRef(false);

  useEffect(() => {
    if (stateArgs.channelName || bootstrapAttempted.current || !resolvedContextId) return;
    bootstrapAttempted.current = true;

    void (async () => {
      // Channel-only bootstrap. Agent creation is deferred to the chat surface
      // for BOTH a typed first message AND an injected initialPrompt: the message
      // is held in the pre-send queue (AgenticChat → useDeferredAgent), which
      // spawns the agent with the chosen/default options and flushes it LIVE once
      // the agent joins — so the first message lands as a normal turn to a present
      // agent rather than backlog replay. Creating the channel here just lets the
      // composer connect; nothing else is persisted until an agent is added.
      const channelName = `chat-${crypto.randomUUID().slice(0, 8)}`;
      void panel.stateArgs.set({ channelName, contextId: resolvedContextId });
      setBootstrapChannel(channelName);
    })();
  }, [resolvedContextId, stateArgs.channelName]);

  // Agent subscription recovery: when a panel has a channel but no DO
  // participants, re-create+subscribe each persisted agent using its stable
  // `key` so we hit the same entity row idempotently. This also covers fresh
  // bootstrap, where server-side startup approvals/builds can briefly race
  // the first create+subscribe attempt.
  const rehydrationCheckedRef = useRef(false);
  useEffect(() => {
    if (rehydrationCheckedRef.current || !stateArgs.channelName || !resolvedContextId) return;
    rehydrationCheckedRef.current = true;
    let cancelled = false;

    const channelName = stateArgs.channelName;
    void (async () => {
      for (
        let attempt = 1;
        attempt <= AGENT_SUBSCRIPTION_MAX_ATTEMPTS && !cancelled;
        attempt += 1
      ) {
        try {
          const dos = await getChannelDOParticipants(channelName);
          console.info("[ChatPanel] agent rehydration participant check", {
            channelName,
            contextId: resolvedContextId,
            participantCount: dos.length,
            attempt,
          });
          if (dos.length > 0) return;

          const installedList = stateArgs.installedAgents ?? [];
          if (installedList.length === 0) return;
          const defaultAgentConfig = await resolveWorkspaceDefaultAgentConfig();
          console.warn("[ChatPanel] channel has no DO participants; rehydrating installed agents", {
            channelName,
            contextId: resolvedContextId,
            installedAgentCount: installedList.length,
            installedAgents: installedList.map((agent) => ({
              key: agent.key,
              source: agent.source,
              className: agent.className,
              handle: agent.handle,
            })),
          });

          for (const agent of installedList) {
            // Layer the per-agent persisted config over the global default so a
            // switched/added agent comes back on its own model after reload.
            const { subscribeConfig } = buildAgentSubscriptionConfig({
              handle: agent.handle,
              workspaceDefaultAgentConfig: defaultAgentConfig,
              globalConfig: stateArgs.agentConfig,
              perAgentConfig: agent.config,
              systemPrompt: stateArgs.systemPrompt,
              systemPromptMode: stateArgs.systemPromptMode,
            });
            await createAndSubscribeAgent({
              source: agent.source,
              className: agent.className,
              key: agent.key,
              channelId: channelName,
              channelContextId: resolvedContextId,
              config: subscribeConfig,
              replay: true,
            });
            console.info("[ChatPanel] rehydrated installed agent", {
              channelName,
              contextId: resolvedContextId,
              key: agent.key,
              source: agent.source,
              className: agent.className,
              handle: agent.handle,
            });
          }
          return;
        } catch (err) {
          if (attempt === AGENT_SUBSCRIPTION_MAX_ATTEMPTS) {
            console.warn(`[ChatPanel] Agent subscription recovery failed:`, err);
            return;
          }
          await delay(AGENT_SUBSCRIPTION_RETRY_DELAY_MS);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    stateArgs.channelName,
    stateArgs.installedAgents,
    stateArgs.agentConfig,
    stateArgs.systemPrompt,
    stateArgs.systemPromptMode,
    resolvedContextId,
    resolveWorkspaceDefaultAgentConfig,
  ]);

  // Build ConnectionConfig from runtime
  const config: ConnectionConfig = {
    clientId: panel.slotId,
    rpc,
    recoveryCoordinator,
  };

  const effectiveDefaultAgentConfig = useMemo<DefaultAgentConfig | null>(() => {
    const globalConfig = stateArgs.agentConfig ?? {};
    const model = typeof globalConfig["model"] === "string" ? globalConfig["model"] : undefined;
    const thinkingLevel =
      typeof globalConfig["thinkingLevel"] === "string"
        ? (globalConfig["thinkingLevel"] as DefaultAgentConfig["thinkingLevel"])
        : undefined;
    const approvalLevel =
      globalConfig["approvalLevel"] === 0 ||
      globalConfig["approvalLevel"] === 1 ||
      globalConfig["approvalLevel"] === 2
        ? globalConfig["approvalLevel"]
        : undefined;
    if (!model && !thinkingLevel && approvalLevel === undefined) return workspaceDefaultAgentConfig;
    return {
      ...(workspaceDefaultAgentConfig ?? {}),
      model: model ?? workspaceDefaultAgentConfig?.model ?? DEFAULT_AGENT_MODEL_REF,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(approvalLevel !== undefined ? { approvalLevel } : {}),
    };
  }, [stateArgs.agentConfig, workspaceDefaultAgentConfig]);

  const handleNewConversation = useCallback((options?: NewConversationOptions) => {
    const nextStateArgs: ChatStateArgs = {};
    if (options?.initialPrompt) nextStateArgs.initialPrompt = options.initialPrompt;
    if (options?.forceInitialPrompt !== undefined) {
      nextStateArgs.forceInitialPrompt = options.forceInitialPrompt;
    }
    if (options?.agentConfig) nextStateArgs.agentConfig = options.agentConfig;
    const hasStateArgs = Object.keys(nextStateArgs).length > 0;
    const stateArgsForLink: Record<string, unknown> = { ...nextStateArgs };
    window.location.href = buildPanelLink(
      "panels/chat",
      hasStateArgs ? { stateArgs: stateArgsForLink } : undefined
    );
  }, []);

  const handleFocusPanel = useCallback((panelId: string) => {
    void panel.focusPanel(panelId);
  }, []);

  const handleReloadPanel = useCallback(async (panelId: string) => {
    void panel.focusPanel(panelId);
  }, []);

  // Deep-link from a local model's red error dot in the picker (item 6) to the
  // Local Models panel, opened straight onto the failing server's log.
  const handleOpenLocalModelsLog = useCallback((server: "utility" | "main") => {
    void openPanel("panels/local-models", { focus: true, stateArgs: { openLog: server } });
  }, []);

  // Launch a Claude Code session as a linked agent in this conversation (§4.3):
  // prepare via the claude-code extension (resolves the channel's context,
  // ensures the vessel, mints the agent credential, writes the launch profile),
  // then open a context-scoped terminal running the returned argv. Both calls go
  // through `extensions.invoke` (untyped) so the panel needs no extension types.
  const handleOpenClaudeCode = useCallback(async (channelId: string) => {
    try {
      const prepared = (await extensions.invoke("@workspace-extensions/claude-code", "prepare", [
        { channelId },
      ])) as {
        contextId: string;
        contextFolder: string;
        env: Record<string, string>;
        argv: string[];
      };
      const [command, ...args] = prepared.argv;
      await extensions.invoke("@workspace-extensions/shell", "open", [
        {
          contextId: prepared.contextId,
          cwd: prepared.contextFolder,
          command: command ?? "claude",
          args,
          env: prepared.env,
          label: "Claude Code",
        },
      ]);
    } catch (err) {
      void notifications.show({
        type: "error",
        title: "Open Claude Code failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const handleActionBarFileChange = useCallback(
    (value: { path: string | null; props?: Record<string, unknown>; maxHeight?: number }) => {
      void panel.stateArgs.set({
        actionBarFile: value.path,
        actionBarProps: value.path ? (value.props ?? null) : null,
        actionBarMaxHeight: value.path ? (value.maxHeight ?? null) : null,
      });
    },
    []
  );

  // Fetch available worker sources (DO agents) on mount. Only sources that
  // declare an `agent` manifest block are chat agents — this filters out
  // service DOs (pubsub-channel, gad-store, fork, …).
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([]);
  useEffect(() => {
    rpc
      .call<WorkerSourceEntry[]>("main", "workers.listSources", [])
      .then((sources) => {
        const agents: AvailableAgent[] = [];
        for (const source of sources) {
          if (!source.agent) continue;
          for (const cls of source.classes) {
            agents.push({
              id: source.source,
              className: cls.className,
              name: source.agent.displayName ?? source.title ?? source.name,
              description: source.agent.description,
              icon: source.agent.icon,
              defaultConfig: source.agent.defaultConfig,
              proposedHandle: source.name.split("-")[0] ?? source.name,
            });
          }
        }
        setAvailableAgents(agents);
      })
      .catch((err) => {
        console.warn("[ChatPanel] Failed to load worker sources:", err);
      });
  }, []);

  // Availability (connected/startable/needs-setup) now arrives on every
  // catalog entry from the model-settings worker — one shared source for all
  // consumers (design §7.1). The old panel-scoped credential heuristic and
  // its deliberate scoping boundary are gone with it.
  useEffect(() => {
    void (async () => {
      try {
        await loadModelSettings();
      } catch (err) {
        console.warn("[ChatPanel] Failed to load model settings:", err);
      }
    })();
  }, [loadModelSettings]);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: number | null = null;

    const clearRefreshTimer = () => {
      if (refreshTimer === null) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    };
    const scheduleRefresh = () => {
      if (disposed || refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (disposed) return;
        void loadModelSettings().catch((err) => {
          console.warn(
            "[ChatPanel] Failed to refresh model settings after local model event:",
            err
          );
        });
      }, 500);
    };

    const subscriptions = [
      extensions.on(LOCAL_MODELS_EXTENSION_ID, "models.changed", scheduleRefresh),
      extensions.on(LOCAL_MODELS_EXTENSION_ID, "server.state", scheduleRefresh),
      extensions.on(LOCAL_MODELS_EXTENSION_ID, "download.progress", scheduleRefresh),
    ];

    return () => {
      disposed = true;
      clearRefreshTimer();
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [loadModelSettings]);

  /** Build the subscription config for a new agent: workspace defaults, global
   *  agentConfig, then the per-agent config, with the resolved handle last.
   *  Returns both the wire config and the per-agent config to persist. */
  const buildSubscribeConfig = useCallback(
    (
      handle: string,
      config: AgentSubscriptionConfig | undefined,
      defaultAgentConfig: DefaultAgentConfig
    ) =>
      buildAgentSubscriptionConfig({
        handle,
        workspaceDefaultAgentConfig: defaultAgentConfig,
        globalConfig: panel.stateArgs.get<ChatStateArgs>().agentConfig,
        perAgentConfig: config,
        systemPrompt: stateArgs.systemPrompt,
        systemPromptMode: stateArgs.systemPromptMode,
      }),
    [stateArgs.systemPrompt, stateArgs.systemPromptMode]
  );

  // The ONLY path that writes the workspace default agent config (model +
  // behavior). Driven by the explicit "Save as defaults" control.
  const saveDefaultAgentConfig = useCallback(
    async (config: DefaultAgentConfig): Promise<void> => {
      const settings = await getModelSettingsService().call<ModelSettingsSnapshot>(
        "setDefaultAgentConfig",
        config
      );
      catalogRef.current = settings.catalog;
      setModelCatalog(settings.catalog);
      setWorkspaceDefaultModelRef(settings.defaultModel);
      setWorkspaceDefaultAgentConfig(settings.defaultAgentConfig);
    },
    [getModelSettingsService]
  );

  const handleAddAgent = useCallback(
    async (
      channelName: string,
      channelContextId?: string,
      agentId?: string,
      config?: AgentSubscriptionConfig
    ) => {
      const activeContextId = resolveChatContextId(channelContextId, contextId);
      if (!activeContextId) {
        throw new Error("Cannot add an agent without a context ID");
      }
      // Resolve the agent type. An explicit agentId wins; otherwise honor a
      // caller-pinned stateArgs.agentSource/agentClass (programmatic opens — e.g.
      // the test-agent harness, or the onboarding chat — where the agent may not
      // be in the manifest gallery). Fall back to the DEFAULT chat agent, NOT
      // availableAgents[0] (whose identity + handle are non-deterministic).
      const matched = agentId
        ? availableAgents.find((a) => a.id === agentId || a.className === agentId)
        : undefined;
      const pinned = panel.stateArgs.get<ChatStateArgs>();
      const pinnedSource = !agentId ? pinned.agentSource : undefined;
      const pinnedClass = !agentId ? pinned.agentClass : undefined;
      const source = matched?.id ?? pinnedSource ?? DEFAULT_WORKER_SOURCE;
      const className = matched?.className ?? pinnedClass ?? DEFAULT_CLASS_NAME;
      // Derive the handle from the RESOLVED agent, then sanitize to the channel's
      // participant-handle rule so a manifest handle with spaces/punctuation (or a
      // stale handle leaked from a different agent's draft) can never produce an
      // invalid subscription.
      const handleFromClass =
        className === DEFAULT_CLASS_NAME
          ? DEFAULT_HANDLE
          : className.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
      const configHandle =
        typeof config?.["handle"] === "string" ? (config["handle"] as string) : "";
      const requestedHandle =
        configHandle.trim() || matched?.proposedHandle || handleFromClass || DEFAULT_HANDLE;
      const handle = `${sanitizeHandle(requestedHandle)}-${crypto.randomUUID().slice(0, 4)}`;
      // Mint key once and persist into installedAgents so rehydration reuses it.
      const agentKey = `${handle}-${crypto.randomUUID().slice(0, 8)}`;
      const defaultAgentConfig = await resolveWorkspaceDefaultAgentConfig();
      const { subscribeConfig, perAgent } = buildSubscribeConfig(
        handle,
        config,
        defaultAgentConfig
      );
      await createAndSubscribeAgent({
        source,
        className,
        key: agentKey,
        channelId: channelName,
        channelContextId: activeContextId,
        config: subscribeConfig,
        replay: true,
      });
      // The workspace default model is written ONLY via the explicit "Save as
      // default" control (onSaveDefaultModel) — never as a side-effect of adding an
      // agent, so a deferred/auto spawn (e.g. onboarding) can't silently change it.
      // Persist into stateArgs.installedAgents so the agent rehydrates on reload.
      // Read the latest snapshot (rather than the captured `stateArgs`) to avoid
      // clobbering concurrent additions.
      const currentArgs = panel.stateArgs.get<ChatStateArgs>();
      const nextInstalled = appendInstalledAgent(currentArgs.installedAgents, {
        agentId: className,
        handle,
        key: agentKey,
        source,
        className,
        ...(Object.keys(perAgent).length > 0 ? { config: perAgent } : {}),
      });
      await panel.stateArgs.set({ installedAgents: nextInstalled });
      return { agentId: source, handle };
    },
    [availableAgents, buildSubscribeConfig, resolveWorkspaceDefaultAgentConfig]
  );

  const handleReplaceAgent = useCallback(
    async (
      channelName: string,
      participantId: string,
      agentId?: string,
      config?: AgentSubscriptionConfig
    ) => {
      const activeContextId = resolveChatContextId(stateArgs.contextId, contextId);
      if (!activeContextId) {
        throw new Error("Cannot replace an agent without a context ID");
      }
      const target = parseDoTargetId(participantId);
      if (!target) {
        throw new Error(`Cannot resolve agent participant: ${participantId}`);
      }
      // Resolve the new agent type. When agentId is omitted (restart-with-model),
      // reuse the existing DO's source/className.
      const agent = agentId
        ? availableAgents.find((a) => a.id === agentId || a.className === agentId)
        : undefined;
      const source = agent?.id ?? target.source;
      const className = agent?.className ?? target.className;
      // Reuse the existing handle for a stable identity across the switch.
      const configHandle =
        typeof config?.["handle"] === "string" ? (config["handle"] as string) : "";
      const handle = configHandle.trim() || agent?.proposedHandle || DEFAULT_HANDLE;
      const agentKey = `${handle}-${crypto.randomUUID().slice(0, 8)}`;
      const defaultAgentConfig = await resolveWorkspaceDefaultAgentConfig();
      const { subscribeConfig, perAgent } = buildSubscribeConfig(
        handle,
        config,
        defaultAgentConfig
      );

      // Kick the exact DO, then invite the replacement (replay restores history).
      await unsubscribeDOFromChannel(
        target.source,
        target.className,
        target.objectKey,
        channelName
      );
      await createAndSubscribeAgent({
        source,
        className,
        key: agentKey,
        channelId: channelName,
        channelContextId: activeContextId,
        config: subscribeConfig,
        replay: true,
      });
      // Workspace default is written only via the explicit "Save as default"
      // control — switching an agent never changes it.
      // Rewrite the matching persisted record (matched by old objectKey) so reload
      // rehydrates the new model rather than the old one.
      const currentArgs = panel.stateArgs.get<ChatStateArgs>();
      const newRecord = {
        agentId: className,
        handle,
        key: agentKey,
        source,
        className,
        ...(Object.keys(perAgent).length > 0 ? { config: perAgent } : {}),
      };
      const existing = currentArgs.installedAgents ?? [];
      const replaced = existing.some((a) => a.key === target.objectKey);
      const nextInstalled = replaced
        ? existing.map((a) => (a.key === target.objectKey ? newRecord : a))
        : [...existing, newRecord];
      await panel.stateArgs.set({ installedAgents: nextInstalled });
      return { agentId: source, handle };
    },
    [availableAgents, buildSubscribeConfig, resolveWorkspaceDefaultAgentConfig]
  );

  const handleConnectProvider = useCallback(
    async (
      providerId: string,
      modelBaseUrl: string,
      opts?: { browser?: "internal" | "external" }
    ): Promise<ConnectProviderResult> => {
      const request = toPanelConnectRequest(providerId, modelBaseUrl, { browser: opts?.browser });
      if (!request) {
        return { ok: false, error: `No connect flow available for ${providerId}` };
      }
      try {
        await rpc.call("main", "credentials.connect", [request]);
        // Refetch the snapshot — availability is worker-computed, so the new
        // credential shows up as `ready` entries in the next catalog.
        await loadModelSettings();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [loadModelSettings]
  );

  const handlePersistAgentModel = useCallback(
    async (_channelName: string, participantId: string, model: string): Promise<void> => {
      const target = parseDoTargetId(participantId);
      if (!target) {
        throw new Error(`Cannot resolve agent participant: ${participantId}`);
      }
      const currentArgs = panel.stateArgs.get<ChatStateArgs>();
      const existing = currentArgs.installedAgents ?? [];
      const nextInstalled = existing.map((agent) => {
        if (agent.key !== target.objectKey) return agent;
        return {
          ...agent,
          config: {
            ...(agent.config ?? {}),
            model,
          },
        };
      });
      if (!existing.some((agent) => agent.key === target.objectKey)) {
        throw new Error(`No persisted agent record found for ${participantId}`);
      }
      await panel.stateArgs.set({ installedAgents: nextInstalled });
      // Per-agent model only — the workspace default is changed solely via the
      // explicit "Save as default" control.
    },
    []
  );

  const handleRemoveAgent = useCallback(async (channelName: string, handle: string) => {
    const channelWorkers = await getChannelDOParticipants(channelName);

    // Match by objectKey containing the handle prefix (objectKey is "{handle}-{uuid}")
    const match = channelWorkers.find((w) => w.objectKey.startsWith(handle));
    if (match) {
      await unsubscribeDOFromChannel(match.source, match.className, match.objectKey, channelName);
    } else {
      // Fallback: try to unsubscribe the first worker if only one is present
      // TODO: improve handle-to-objectKey resolution when multiple DOs are present
      console.warn(
        `[ChatPanel] No DO found matching handle "${handle}" on channel "${channelName}"`
      );
      if (channelWorkers.length === 1) {
        const w = channelWorkers[0]!;
        await unsubscribeDOFromChannel(w.source, w.className, w.objectKey, channelName);
      }
    }
  }, []);

  const chatActions: AgenticChatActions = useMemo(
    () => ({
      onNewConversation: handleNewConversation,
      onAddAgent: handleAddAgent,
      onReplaceAgent: handleReplaceAgent,
      onConnectProvider: handleConnectProvider,
      onPersistAgentModel: handlePersistAgentModel,
      onSaveDefaults: saveDefaultAgentConfig,
      onRemoveAgent: handleRemoveAgent,
      availableAgents,
      modelCatalog,
      defaultModelRef: workspaceDefaultModelRef,
      defaultAgentConfig: effectiveDefaultAgentConfig,
      onFocusPanel: handleFocusPanel,
      onReloadPanel: handleReloadPanel,
      onOpenClaudeCode: handleOpenClaudeCode,
      onOpenLocalModelsLog: handleOpenLocalModelsLog,
    }),
    [
      handleNewConversation,
      handleAddAgent,
      handleReplaceAgent,
      handleConnectProvider,
      handlePersistAgentModel,
      saveDefaultAgentConfig,
      handleRemoveAgent,
      availableAgents,
      modelCatalog,
      workspaceDefaultModelRef,
      effectiveDefaultAgentConfig,
      handleFocusPanel,
      handleReloadPanel,
      handleOpenClaudeCode,
      handleOpenLocalModelsLog,
    ]
  );

  // --- Fork navigation + review overlay ---------------------------------
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);

  // In-place fork switch: rebind the panel's channel + context and let the
  // useChatCore bootstrap effect (keyed on channelName/contextId) reconnect.
  const handleForkSwitch = useCallback(
    (forkChannelId: string, forkContextId: string) => {
      console.info("[ChatPanel] switching to fork", {
        fromChannelId: stateArgs.channelName ?? bootstrapChannel ?? null,
        fromContextId: resolvedContextId,
        forkChannelId,
        forkContextId,
      });
      initialPromptCaptured.current = undefined;
      rehydrationCheckedRef.current = false;
      void panel.stateArgs.set({ channelName: forkChannelId, contextId: forkContextId });
    },
    [bootstrapChannel, resolvedContextId, stateArgs.channelName]
  );

  // Side-by-side: open the fork in a fresh chat panel (news-panel shape).
  const handleOpenForkPanel = useCallback(
    (forkChannelId: string, forkContextId: string) => {
      console.info("[ChatPanel] opening fork panel", {
        fromChannelId: stateArgs.channelName ?? bootstrapChannel ?? null,
        fromContextId: resolvedContextId,
        forkChannelId,
        forkContextId,
      });
      void openPanel("panels/chat", {
        focus: true,
        stateArgs: { channelName: forkChannelId, contextId: forkContextId },
      });
    },
    [bootstrapChannel, resolvedContextId, stateArgs.channelName]
  );

  const handleReviewContext = useCallback((target: ReviewTarget) => {
    setReviewTarget(target);
  }, []);

  // Shell toast when a fork the user didn't initiate lands while unfocused.
  const handleExternalFork = useCallback(
    (fork: {
      forkedChannelId: string;
      forkedContextId: string;
      actorName: string;
      forkPointId: number;
    }) => {
      void notifications.show({
        type: "info",
        title: "Conversation forked",
        message: `${fork.actorName} forked from message ${fork.forkPointId}`,
        actions: [
          {
            label: "Switch",
            variant: "solid",
            onClick: () => handleForkSwitch(fork.forkedChannelId, fork.forkedContextId),
          },
        ],
      });
    },
    [handleForkSwitch]
  );

  const forkNav: ForkNavHandlers = useMemo(
    () => ({
      switchTo: handleForkSwitch,
      openInNewPanel: handleOpenForkPanel,
      reviewContext: handleReviewContext,
      onExternalFork: handleExternalFork,
    }),
    [handleForkSwitch, handleOpenForkPanel, handleReviewContext, handleExternalFork]
  );

  // Sandbox config — provides RPC and import loading to agentic-chat.
  const sandboxConfig = useMemo(() => createPanelSandboxConfig(rpc), []);

  // Tool provider: the panel advertises no local channel tools. eval now runs
  // server-side in the per-agent EvalDO (invoked by the agent's local tool);
  // all other operations use runtime APIs.
  const toolProvider: ToolProvider = useCallback(() => ({}), []);

  // Resolve channel name: from stateArgs (existing chat) or bootstrap (new chat)
  const channelName = stateArgs.channelName ?? bootstrapChannel;
  const panelMetadata = useMemo(
    () => ({
      name: channelName ?? "Channel",
      type: "panel" as const,
      hostPlatform: detectHostPlatform(),
    }),
    [channelName]
  );
  const installedAgents = stateArgs.installedAgents ?? undefined;

  // Still bootstrapping — show a brief loading indicator
  if (!channelName) {
    return (
      <ErrorBoundary surfaceName="chat panel">
        <Theme appearance={theme} {...appTheme}>
          <Flex
            align="center"
            justify="center"
            style={{
              minHeight: "100dvh",
              width: "100vw",
              maxWidth: "100%",
              boxSizing: "border-box",
              padding: 16,
              overflow: "hidden",
            }}
          >
            <Text size="2" color="gray">
              Starting chat...
            </Text>
          </Flex>
        </Theme>
      </ErrorBoundary>
    );
  }

  return (
    <>
      {fallbackNotice && !fallbackNoticeDismissed && (
        <Theme appearance={theme} {...appTheme}>
          <Callout.Root
            color="amber"
            size="1"
            style={{ borderRadius: 0, paddingTop: 6, paddingBottom: 6 }}
          >
            <Flex align="center" justify="between" gap="3" style={{ width: "100%" }}>
              <Callout.Text>
                No cloud provider connected — using <Text weight="medium">{fallbackNotice}</Text> on
                this device. Answers will be simpler than a frontier model's.
              </Callout.Text>
              <Flex gap="2" align="center" style={{ flexShrink: 0 }}>
                <Button size="1" variant="soft" onClick={() => setFallbackNoticeDismissed(true)}>
                  OK
                </Button>
              </Flex>
            </Flex>
          </Callout.Root>
        </Theme>
      )}
      <AgenticChat
        config={config}
        channelName={channelName}
        channelConfig={stateArgs.channelConfig}
        contextId={resolvedContextId}
        metadata={panelMetadata}
        tools={toolProvider}
        actions={chatActions}
        theme={theme}
        installedAgents={installedAgents}
        initialPrompt={initialPromptCaptured.current}
        forceInitialPrompt={stateArgs.forceInitialPrompt}
        forkNav={forkNav}
        sandbox={sandboxConfig}
        initialActionBarFile={stateArgs.actionBarFile ?? undefined}
        initialActionBarProps={stateArgs.actionBarProps ?? undefined}
        initialActionBarMaxHeight={stateArgs.actionBarMaxHeight ?? undefined}
        onActionBarFileChange={handleActionBarFileChange}
      />
      {reviewTarget && (
        <Theme appearance={theme} {...appTheme}>
          <ReviewAndPickSurface
            rpc={rpc}
            target={reviewTarget}
            appearance={theme}
            open
            onClose={() => setReviewTarget(null)}
          />
        </Theme>
      )}
    </>
  );
}
