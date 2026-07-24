/**
 * AgentVesselBase (WS1 §2.7) — the thin, event-sourced agent vessel.
 *
 * Replaces TrajectoryVesselBase (8,662 lines). Composition only:
 *
 *   DOIdentity + SubscriptionManager + ChannelClient   — transport plumbing
 *   FeedbackIngest + CardManager                       — UX surfaces (unchanged)
 *   AgentLoopDriver (+ pure @workspace/agent-loop)     — ALL turn semantics
 *
 * Every durable decision lives in the trajectory log; this class only wires
 * ports (blobstore, credentials, local tools, channel calls) and translates
 * the DO surface (subscribe/envelope/methodCall/fork/alarm) into commands.
 */

import {
  DurableObjectBase,
  rpc,
  type DurableObjectContext,
  type LifecyclePrepareInput,
  type LifecyclePrepareResult,
  type LifecycleResumeInput,
} from "@workspace/runtime/worker";
import { withCausalParent, type RpcClient } from "@vibestudio/rpc";
import {
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@workspace/runtime/workerd-client";
import type {
  ChannelReplayEnvelope,
  RegisterMessageTypeInput,
  RpcChannelMessage,
} from "@workspace/pubsub";
import { iterateChannelReplayAfterPages } from "@workspace/pubsub";
import {
  composeSystemPrompt,
  formatEvalResult,
  normalizeEvalToolSource,
  type ChannelEvent,
  type EvalRunResult,
  type ParticipantDescriptor,
  type SystemPromptMode,
} from "@workspace/harness";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  agentToolFailureFromUnknown,
  hydrateStoredValueRefs,
  isRespondPolicy,
  participantRefFromActor,
  renderAgentToolFailure,
  resolveShouldRespond,
  type ActorRef,
  type AgenticEvent,
  type CustomMessageDisplayMode,
  type ParticipantRef,
  type SubagentProgressUpdate,
} from "@workspace/agentic-protocol";
import { sha256HexSyncText, stableSha256Hex } from "@vibestudio/content-addressing";
import {
  channelTrajectoryFor,
  commandIdForTrajectoryInvocation,
  logIdForChannel,
} from "@vibestudio/trajectory-identity";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import {
  createAgentEntity,
  createSubagentContext,
  initAgentFromTrajectoryFork,
  publishAgentTaskSeed,
  subagentRuntimePrompt,
  subscribeAgentToChannel,
  type SubagentIdentity,
} from "@workspace/agentic-core";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import type { DoAlarmSchedule } from "@vibestudio/shared/doDispatcher";
import {
  AGENT_INSPECTION_METHODS,
  isAgentInspectionMethod,
  type AgentInspectionMethod,
} from "@vibestudio/shared/agentInspection";
import type {
  VcsCompareResult,
  VcsIntegrateResult,
  VcsInspectResult,
  VcsListFilesResult,
  VcsNeighborsResult,
  VcsReadFileResult,
  VcsStateNodeRef,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import { toCredentialConnectRequest } from "@workspace/model-catalog/providerConnect";
import {
  defaultPolicies,
  derivedTurnStatus,
  ids,
  type AgentLoopConfig,
  type AgentState,
  type AgentTurnMetadata,
  type EffectOutcome,
  type RespondPolicy,
  type RosterEntry,
  type StepPolicy,
  type ThinkingLevel,
} from "@workspace/agent-loop";
import {
  createModelCredentialSentinel,
  installUrlBoundModelFetchProxy,
} from "./model-fetch-proxy.js";
import { modelTransportRuntimeEvidence } from "./effect-executors/index.js";
import { prepareAgentToolArguments } from "./tool-arguments.js";

export interface AgentToolExecutionContext {
  readonly invocationId: string;
  /** Stable semantic command id derived from the exact causal invocation. */
  readonly commandId: string;
  /** Immutable caller bound to the exact trajectory invocation that caused the tool call. */
  readonly rpc: RpcClient;
}
import type {
  ConnectCredentialRequest,
  StoredCredentialSummary as ModelCredentialSummary,
} from "@workspace/runtime/credentials";
import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import {
  SubagentRunStore,
  type SubagentAgentKind,
  type SubagentRunIntegration,
  type SubagentRunRow,
} from "./subagent-runs.js";
import { ChannelClient } from "./channel-client.js";
import { FeedbackIngest } from "./feedback-ingest.js";
import { CardManager } from "./custom-cards.js";
import { AgentLoopDriver, type DriverDeps } from "./agent-loop-driver.js";
import { inspectEffectOutbox } from "./effect-outbox.js";
import {
  CredentialApprovalDeferredError,
  CredentialPendingError,
  type EphemeralEmit,
  type ExecutorDeps,
} from "./effect-executors/index.js";
import {
  LOCAL_FALLBACK_MODEL_REF,
  LOCAL_MODELS_EXTENSION_ID,
  LOCAL_PROVIDER_ID,
  materializeModel,
  type LocalModelDescriptor,
  type MaterializedModel,
} from "./model-spec.js";

const DELTA_BATCH_MS = 100;
const CHANNEL_STATE_CACHE_MS = 5_000;
const BLOB_TEXT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** ~256KB of serialized session entries before compaction — comfortably
 *  under modern model context windows while keeping plenty of recent
 *  history. Subclasses override getCompactionTriggerBytes for a tighter or
 *  model-sized budget. */
const DEFAULT_COMPACTION_TRIGGER_BYTES = 256 * 1024;
/** Subagent guardrails (overridable per-agent via config). Depth bounds the
 *  spawn chain; concurrency bounds live children per supervisor. */
const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 10;
const PARTICIPANT_HANDLE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const SUBAGENT_INTEGRATION_PROTOCOL = "vibestudio.subagent-integration.v2";

function subagentVcsCommandId(
  phase: "integrate",
  run: Pick<SubagentRunRow, "runId" | "parentContextId" | "childContextId">,
  basis: Record<string, string>
): string {
  return `subagent-${phase}:${stableSha256Hex({
    protocol: SUBAGENT_INTEGRATION_PROTOCOL,
    runId: run.runId,
    parentContextId: run.parentContextId,
    childContextId: run.childContextId,
    basis,
  })}`;
}

function sameState(left: VcsStateNodeRef, right: VcsStateNodeRef): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "event"
      ? right.kind === "event" && left.eventId === right.eventId
      : right.kind === "application" && left.applicationId === right.applicationId)
  );
}

/** The subset of an external subagent launch result the spawn path consumes.
 *  Typed inline to avoid a vessel→extension source dependency; the call goes
 *  through a configured provider namespace when one exists. */
interface ExternalSubagentLaunchResult {
  entityId: string;
  contextId: string;
  channelId: string;
  vesselRef: string;
  vesselEntityId: string;
  vesselParticipantId: string | null;
  launchId: string;
  pid?: number | null;
}

const EXTERNAL_SUBAGENT_KIND_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

function normalizeSubagentAgentKind(value: unknown): SubagentAgentKind | null {
  if (value === undefined || value === null || value === "") return "pi";
  if (typeof value !== "string") return null;
  const kind = value.trim();
  if (kind === "pi") return "pi";
  return EXTERNAL_SUBAGENT_KIND_PATTERN.test(kind) ? kind : null;
}

function externalSubagentExtensionId(agentKind: SubagentAgentKind): string {
  return `@workspace-extensions/${agentKind}`;
}

function externalSubagentProviderSlot(agentKind: SubagentAgentKind): string | null {
  return agentKind === "claude-code" ? "claudeCode" : null;
}

export type ApprovalLevel = 0 | 1 | 2;

export type CustomMessageReducer = (state: unknown, update: unknown) => unknown;

export interface AgentSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
  fallbackModel?: string;
  fallbackThinkingLevel?: ThinkingLevel;
  fallbackOn?: string[];
  fallbackScope?: "unattended" | "all-turns";
  approvalLevel: ApprovalLevel;
  respondPolicy: RespondPolicy;
  respondFrom: string[];
}

/** Per-channel settings — a Ref-kind KV value; every model call journals the
 *  values it actually used in its request descriptor, so the audit trail is
 *  the log, not this pointer. */
interface StoredSettings extends Partial<AgentSettings> {}

const CONFIGURABLE_FALLBACK_FAILURE_CODES = new Set([
  "usage_limit_terminal",
  "quota_exhausted_terminal",
  "rate_limited_retryable",
  "provider_overloaded_retryable",
  "auth_or_credentials",
  "circuit_breaker_open_terminal",
  "unknown_retryable",
]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function isFallbackOn(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((code) => typeof code === "string" && CONFIGURABLE_FALLBACK_FAILURE_CODES.has(code))
  );
}

/**
 * The agent's settings record is PER-AGENT (channel-independent): one model,
 * thinking level, approval posture, respond policy, etc. for the agent across
 * every channel it joins. Membership is per-channel (the subscriptions table);
 * behavior config is not.
 */
const AGENT_SETTINGS_KEY = "agent:settings";

/**
 * Resolve a per-agent `respondFrom` allowlist (handles and/or participant ids) to
 * THIS channel's participant ids, so "who I respond to" travels with the agent
 * across channels. An entry matching a participant's handle maps to that
 * participant's id; an entry that matches nothing is kept as-is (already an id).
 * Pure + exported for direct testing.
 */
export function resolveRespondFromHandles(
  respondFrom: readonly string[],
  participants: ReadonlyArray<{ participantId: string; metadata?: Record<string, unknown> | null }>
): string[] {
  const handleToId = new Map<string, string>();
  for (const p of participants) {
    const handle = p.metadata?.["handle"];
    if (typeof handle === "string" && handle.length > 0) handleToId.set(handle, p.participantId);
  }
  return respondFrom.map((entry) => handleToId.get(entry) ?? entry);
}

function participantIdFromRef(ref: ParticipantRef): string {
  return ref.participantId ?? ref.id;
}

function configuredParticipantHandle(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const handle = (config as Record<string, unknown>)["handle"];
  return typeof handle === "string" && handle.length > 0 ? handle : null;
}

function configuredWakePolicy(config: unknown): "every-envelope" | "turn-final" | "manual" {
  if (!config || typeof config !== "object") return "every-envelope";
  const wakePolicy = (config as Record<string, unknown>)["wakePolicy"];
  return wakePolicy === "turn-final" || wakePolicy === "manual" ? wakePolicy : "every-envelope";
}

function sanitizeParticipantHandlePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function deriveSubagentParticipantHandle(
  baseHandle: string,
  runId: string,
  objectKey?: string
): string {
  if (objectKey && PARTICIPANT_HANDLE_PATTERN.test(objectKey)) return objectKey;

  const base = sanitizeParticipantHandlePart(baseHandle) || "agent";
  const suffixSource = sanitizeParticipantHandlePart(objectKey ?? runId) || "subagent";
  const suffix = suffixSource.slice(-16);
  const maxBaseLength = Math.max(1, 63 - suffix.length);
  const trimmedBase = base.slice(0, maxBaseLength).replace(/[-_]+$/g, "") || "agent";
  const candidate = `${trimmedBase}-${suffix}`;
  const handle = /^[a-zA-Z]/.test(candidate) ? candidate : `a-${candidate}`;
  return handle.slice(0, 64);
}

/**
 * Summarize a loop's folded turn state for `agent.describe()` — derived status +
 * the live pending-effect counts. Pure (given the folded `AgentState`) + exported
 * so it can be verified against a REAL folded loop state in the loop-driver tests.
 */
export function summarizeTurn(state: Parameters<typeof derivedTurnStatus>[0]): {
  status: ReturnType<typeof derivedTurnStatus>;
  lastSeq: number;
  pendingInvocations: number;
  pendingApprovals: number;
  pendingCredentialWaits: number;
} {
  return {
    status: derivedTurnStatus(state),
    lastSeq: state.lastSeq,
    pendingInvocations: Object.keys(state.pendingInvocations).length,
    pendingApprovals: Object.keys(state.pendingApprovals).length,
    pendingCredentialWaits: Object.keys(state.pendingCredentialWaits).length,
  };
}

export interface AgentPromptResources {
  workspacePrompt?: string;
  skillIndex?: string;
}

export interface AgentPromptOverride {
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
}

// Moved to @workspace/agentic-core so external launcher extensions render the
// same contract; re-exported here for existing import sites.
export { subagentRuntimePrompt } from "@workspace/agentic-core";
export type { SubagentIdentity } from "@workspace/agentic-core";

type BrowserOpenMode = "internal" | "external";
type BrowserHandoffCallerKind = "app" | "panel" | "shell";
type ConnectCredentialEnvelope = {
  spec: ConnectCredentialRequest;
  handoffTarget: {
    callerId: string;
    callerKind: BrowserHandoffCallerKind;
  };
};

function isSystemPromptMode(value: unknown): value is SystemPromptMode {
  return value === "append" || value === "replace" || value === "replace-vibestudio";
}

function normalizeBrowserOpenMode(value: unknown): BrowserOpenMode {
  return value === "internal" ? "internal" : "external";
}

function normalizeBrowserHandoffTarget(input: {
  browserHandoffCallerId?: unknown;
  browserHandoffCallerKind?: unknown;
}): ConnectCredentialEnvelope["handoffTarget"] | null {
  const callerId = input.browserHandoffCallerId;
  const callerKind = input.browserHandoffCallerKind;
  if (typeof callerId !== "string" || callerId.length === 0) return null;
  if (callerKind !== "app" && callerKind !== "panel" && callerKind !== "shell") return null;
  return { callerId, callerKind };
}

/** Context handed to {@link AgentVesselBase.onChannelForked} after a clone. */
export interface ClonedChannelContext {
  /** Channel id the parent was subscribed to (the clone is NOT subscribed to it). */
  oldChannelId: string;
  /** Channel id the clone is about to be subscribed to. */
  newChannelId: string;
  forkPointPubsubId: number;
}

export interface AgentAlarmSource {
  id: string;
  nextWakeAt(): number | null;
  fire(now: number): Promise<void>;
}

export interface AgentInitiatedTurnOptions extends AgentTurnMetadata {
  steeringId?: string;
  mode?: "auto" | "sequential";
}

export abstract class AgentVesselBase extends DurableObjectBase {
  protected readonly identity: DOIdentity;
  protected readonly subscriptions: SubscriptionManager;
  protected readonly feedback: FeedbackIngest;
  protected readonly cards: CardManager;
  protected readonly subagentRuns: SubagentRunStore;
  private _driver: AgentLoopDriver | null = null;
  private readonly localTools = new Map<string, Map<string, AgentTool>>();
  private readonly deltaBuffers = new Map<string, { events: AgenticEvent[]; timer: unknown }>();
  private readonly channelClients = new Map<string, ChannelClient>();
  private readonly channelConfigCache = new Map<
    string,
    { expiresAt: number; value: Record<string, unknown> | null }
  >();
  private readonly participantCache = new Map<
    string,
    {
      expiresAt: number;
      value: Array<{ participantId: string; metadata: Record<string, unknown> }>;
    }
  >();
  private readonly blobTextCache = new Map<string, { value: string; bytes: number }>();
  private blobTextCacheBytes = 0;
  private readonly alarmSources = new Map<string, AgentAlarmSource>();
  private readonly alarmDeadlines = new Map<string, number>();
  /**
   * In-flight `chat.callMethod` relays initiated on behalf of an EvalDO sandbox
   * (keyed by transportCallId). The agent issues the call via ChannelClient,
   * then the channel's durable invocation terminal — broadcast back to us, the
   * caller — settles the awaiting promise in settleChatOpCall. This is a
   * loop-independent pending-call mechanism (parallel to the loop's
   * effect-outbox channel_call path) so the eval relay can return the delivered
   * result synchronously to the RPC caller. */
  private readonly chatOpPendingCalls = new Map<
    string,
    {
      resolve: (value: { content: unknown }) => void;
      reject: (error: Error) => void;
      responderSessionId: string;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
    // Module tables are owned by the composed managers (constructed below);
    // driver tables (effect_outbox, fold_cache) are created lazily on first
    // driver use. createTables() itself is therefore a no-op hook.
    this.identity = new DOIdentity(this.sql);
    this.identity.createTables();
    this.subscriptions = new SubscriptionManager(
      this.sql,
      (channelId) => this.createChannelClient(channelId),
      this.identity,
      async ({ channelId, config, envelope }) => {
        await this.ingestSubscriptionReplay(
          channelId,
          envelope,
          configuredWakePolicy(config) === "every-envelope"
        );
      }
    );
    this.subscriptions.createTables();
    this.subagentRuns = new SubagentRunStore(this.sql);
    this.subagentRuns.createTables();
    this.feedback = new FeedbackIngest(this.sql);
    this.cards = new CardManager({
      sql: this.sql,
      createChannelClient: (channelId) => this.createChannelClient(channelId),
      getParticipantId: (channelId) => this.subscriptions.getParticipantId(channelId),
      getActor: () => ({ kind: "agent", id: this.participantId() }),
      getAgentId: () => this.objectKey,
    });
    this.registerAgentAlarmSource({
      id: "agent-loop-driver",
      nextWakeAt: () => this._driver?.nextWakeAt() ?? this.driverNextWakeAtFromSql(),
      fire: async () => {
        const { completion } = await this.driver.beginAlarmDispatch();
        // Durable Objects remain active while I/O is pending; ctx.waitUntil is
        // explicitly a no-op for DO lifetime. The alarm RPC returns after the
        // rows are durably leased, while this activation-owned continuation
        // either settles them or leaves them for lease-expiry recovery.
        void completion
          .finally(() => this.persistAlarmSchedule(this.nextAgentAlarmSchedule()))
          .catch((error) => {
            console.error("[AgentVessel] alarm effect dispatch failed:", error);
          });
      },
    });
    this.registerAgentAlarmSource({
      id: "subagent-progress-outbox",
      nextWakeAt: () => this.subagentRuns.nextProgressWakeAt(),
      fire: async (now) => {
        await this.drainSubagentProgress(now);
      },
    });
  }

  protected createTables(): void {
    // Composed managers create their own tables; nothing to do here.
  }

  override async releaseForLifecycle(
    input: LifecyclePrepareInput
  ): Promise<LifecyclePrepareResult> {
    const releasedEffects = this._driver ? await this._driver.releaseActivation() : 0;
    if (input.mode === "retire") {
      const channelIds = this.subscriptions.listChannelIds();
      for (const channelId of channelIds) await this.unsubscribeChannel(channelId);
      return {
        status: "ready",
        detail: {
          mode: input.mode,
          releasedEffects,
          retiredSubscriptions: channelIds.length,
        },
      };
    }
    const releasedSubscriptions = await this.subscriptions.releaseActivation();
    return {
      status: "ready",
      detail: { mode: input.mode, releasedEffects, releasedSubscriptions },
    };
  }

  override async resumeAfterRestart(input: LifecycleResumeInput): Promise<void> {
    await super.resumeAfterRestart(input);
    // Durable rows remember which channels this vessel belongs to; live
    // membership itself is the routed response resource and must be recreated
    // after the old workerd activation has disappeared.
    for (const subscription of this.subscriptions.listStored()) {
      await this.subscribeChannel({
        channelId: subscription.channelId,
        contextId: subscription.contextId,
        ...(subscription.config !== undefined ? { config: subscription.config } : {}),
        replay: true,
      });
    }
  }

  // ── Subclass surface (WS1 §3.2 — names preserved where semantics survive) ─

  protected getDefaultModel(): string {
    return "anthropic:claude-sonnet-4-6";
  }
  protected getDefaultThinkingLevel(): ThinkingLevel {
    return "medium";
  }
  protected getDefaultApprovalLevel(): ApprovalLevel {
    return 2;
  }
  protected getDefaultRespondPolicy(): RespondPolicy {
    return "mentioned-or-followup";
  }
  protected getDefaultRespondFrom(): string[] {
    return [];
  }
  /** Idle-history byte budget that triggers compaction. Subclasses with a
   *  known model context window should override this to ~0.7× the window
   *  (in serialized-entry bytes). */
  protected getCompactionTriggerBytes(): number {
    return DEFAULT_COMPACTION_TRIGGER_BYTES;
  }

  /** Channel publication discipline (WS-4 `publishPolicy` StepPolicy). Default
   *  agents publish everything (`undefined` ⇒ "all"); the silent agent overrides
   *  this to "say-only" (the old `silentPolicy` behavior). */
  protected getPublishPolicy(_channelId: string): "all" | "turn-final" | "say-only" | undefined {
    return undefined;
  }

  /** Max subagent nesting depth enforced at spawn. */
  protected getMaxSubagentDepth(): number {
    return DEFAULT_MAX_SUBAGENT_DEPTH;
  }

  /** Max concurrent live subagents enforced at spawn. */
  protected getMaxConcurrentSubagents(): number {
    return DEFAULT_MAX_CONCURRENT_SUBAGENTS;
  }

  protected abstract getParticipantInfo(channelId: string, config?: unknown): ParticipantDescriptor;

  protected getEffectiveParticipantInfo(
    channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const descriptor = this.getParticipantInfo(channelId, config);
    const subagent = this.subagentIdentity();
    if (!subagent) return descriptor;

    const configuredHandle = configuredParticipantHandle(config);
    if (configuredHandle) return { ...descriptor, handle: configuredHandle };

    let objectKey: string | undefined;
    try {
      objectKey = this.objectKey;
    } catch {
      objectKey = undefined;
    }
    return {
      ...descriptor,
      handle: deriveSubagentParticipantHandle(descriptor.handle, subagent.runId, objectKey),
    };
  }

  private subscriptionContextOrNull(channelId: string): string | null {
    try {
      return this.subscriptions.getContextId(channelId);
    } catch {
      return null;
    }
  }

  /** Workspace-level prompt resources. Workspace agents load AGENTS.md and the
   *  skill index here; non-workspace agents may return nothing. */
  protected loadPromptResources(
    _channelId: string
  ): AgentPromptResources | Promise<AgentPromptResources> {
    return {};
  }

  /** Clears any prompt resource cache owned by a subclass. */
  protected invalidatePromptResources(_channelId?: string): void {}

  /** Agent-class behavior prompt, such as a Gmail-specific role. */
  protected getAgentPrompt(_channelId: string): string | undefined {
    return undefined;
  }

  /** Per-subscription user/workspace override. */
  protected getPromptOverride(channelId: string): AgentPromptOverride {
    const config = this.subscriptions.getConfig(channelId);
    const override: AgentPromptOverride = {};
    if (typeof config?.systemPrompt === "string") {
      override.systemPrompt = config.systemPrompt;
    }
    if (isSystemPromptMode(config?.systemPromptMode)) {
      override.systemPromptMode = config.systemPromptMode;
    }
    return override;
  }

  /** Final system prompt text for a channel (blob-spilled; its hash rides every
   *  model request descriptor). Keep run-specific volatile instructions out of
   *  this path so provider prompt-cache keys stay stable. */
  protected async composePrompt(channelId: string): Promise<string> {
    const resources = await this.loadPromptResources(channelId);
    const agentPrompt = this.getAgentPrompt(channelId);
    const override = this.getPromptOverride(channelId);
    return composeSystemPrompt({
      ...(resources.workspacePrompt !== undefined
        ? { workspacePrompt: resources.workspacePrompt }
        : {}),
      ...(resources.skillIndex !== undefined ? { skillIndex: resources.skillIndex } : {}),
      ...(agentPrompt !== undefined ? { agentPrompt } : {}),
      ...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
      ...(override.systemPromptMode !== undefined
        ? { systemPromptMode: override.systemPromptMode }
        : {}),
    });
  }

  /** Per-request prompt appended at the end of the model message context. */
  protected immediatePrompt(_channelId: string): string | undefined {
    const subagent = this.subagentIdentity();
    return subagent ? subagentRuntimePrompt(subagent) : undefined;
  }

  /**
   * Impure per-model-call context. Unlike the stable system prompt, this is
   * prepared by the durable prompt-artifact effect immediately before the
   * model request and may read fresh runtime projections.
   */
  protected prepareImmediatePrompt(
    channelId: string,
    _signal?: AbortSignal
  ): string | undefined | Promise<string | undefined> {
    return this.immediatePrompt(channelId);
  }

  /** Local tools registered with the local-tool executor. */
  protected getLoopTools(_channelId: string, _execution?: AgentToolExecutionContext): AgentTool[] {
    return [];
  }

  /**
   * Provider-side enforcement for channel participant methods. Descriptors are
   * discovery/UI metadata; subclasses with a reduced control surface must also
   * close the method at the receiver.
   */
  protected isParticipantMethodEnabled(_methodName: string): boolean {
    return true;
  }

  /** Whether this vessel exposes workspace-history search to the model. */
  protected includeMemoryRecallTool(): boolean {
    return true;
  }

  /** Step policies composed onto the pure loop (silent agents, card flows…). */
  protected getStepPolicies(_channelId: string): StepPolicy[] {
    return defaultPolicies();
  }

  /** Test seam: replace effect executors (e.g. inject a scripted model so a
   *  full turn can be driven without a live model). Production returns
   *  undefined — the real executors run. */
  protected getDriverExecutorOverride(): DriverDeps["executorOverride"] {
    return undefined;
  }

  /** Roster method names this agent expects (warning surface only). */
  protected getExpectedChannelToolNames(_channelId: string): readonly string[] {
    return [];
  }

  /** Hook before addressing — return true to swallow the event. */
  protected async onChannelEvent(_channelId: string, _event: ChannelEvent): Promise<boolean> {
    return false;
  }

  protected getModelCredentialSetupProps(_providerId: string): Record<string, unknown> | null {
    return null;
  }

  /** Provider claims baked into the JWT-shaped sentinel apiKey (e.g.
   *  openai-codex's chatgpt_account_id). Subclass hook; default none. */
  protected getModelCredentialTokenClaims(
    _providerId: string,
    _credential: ModelCredentialSummary
  ): Record<string, unknown> {
    return {};
  }

  /** Fork hook. The clone has been re-identified and its subscription renamed
   *  old→new, but the new channel is not yet (re)subscribed. Subclasses purge
   *  or migrate the per-channel state the clone copied wholesale from the
   *  parent here — and may set flags that the subsequent subscribeChannel
   *  reads. Without this, any agent that keys SQLite by channelId or runs a
   *  per-channel scheduler would have the clone act on a channel it no longer
   *  holds a subscription on. */
  protected async onChannelForked(_ctx: ClonedChannelContext): Promise<void> {}

  // ── Wiring ────────────────────────────────────────────────────────────────

  protected createChannelClient(channelId: string): ChannelClient {
    let client = this.channelClients.get(channelId);
    if (!client) {
      client = new ChannelClient(this.rpc, channelId);
      this.channelClients.set(channelId, client);
    }
    return client;
  }

  private _identityBootstrapped = false;

  /** Bootstrap identity from the canonical workerd environment. */
  protected ensureIdentity(): void {
    if (this._identityBootstrapped) return;
    const env = this.env as Record<string, string>;
    const source = env["WORKER_SOURCE"];
    const className = env["WORKER_CLASS_NAME"];
    const sessionId = env["WORKERD_SESSION_ID"];
    if (!source || !className || !sessionId) {
      throw new Error(
        "Agent vessel identity requires WORKER_SOURCE, WORKER_CLASS_NAME, and WORKERD_SESSION_ID"
      );
    }
    const generationRaw = env["WORKERD_BOOT_GENERATION"];
    const generation =
      typeof generationRaw === "string" && generationRaw.length > 0
        ? Number.parseInt(generationRaw, 10)
        : null;
    this.identity.bootstrap(
      { source, className, objectKey: this.objectKey },
      sessionId,
      Number.isFinite(generation) ? generation : null
    );
    this._identityBootstrapped = true;
  }

  protected participantId(): string {
    this.ensureIdentity();
    const ref = this.identity.ref;
    return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
  }

  protected selfRef(channelId: string): ParticipantRef {
    const descriptor = this.getEffectiveParticipantInfo(
      channelId,
      this.subscriptions.getConfig(channelId)
    );
    return {
      kind: "agent",
      id: this.participantId(),
      participantId: this.participantId(),
      displayName: descriptor.name,
      metadata: { type: descriptor.type, name: descriptor.name, handle: descriptor.handle },
    };
  }

  protected get driver(): AgentLoopDriver {
    this._driver ??= new AgentLoopDriver({
      sql: this.sql,
      gad: {
        call: <T>(method: string, args: Record<string, unknown>) => this.callGad<T>(method, args),
      },
      executorDeps: this.executorDeps(),
      selfRefFor: (channelId) => this.selfRef(channelId),
      configFor: (channelId) => this.loopConfig(channelId),
      policiesFor: (channelId) => this.getStepPolicies(channelId),
      onEphemeral: (emit) => this.emitEphemeral(emit),
      broadcastStoredEnvelopes: async (channelId, envelopeIds) => {
        await this.createChannelClient(channelId).broadcastStoredEnvelopes(envelopeIds);
      },
      onHeartbeatOutcome: (input) => this.onHeartbeatOutcome(input),
      now: () => Date.now(),
      // Idle-history budget before a fold-shrinking compaction. Kept well
      // below typical model context windows so context never grows to the
      // model's hard limit (the deleted CompactionTrigger used ~0.8× the
      // window); a subclass can tune via getCompactionTriggerBytes.
      compaction: { triggerBytes: this.getCompactionTriggerBytes() },
      scheduleAlarm: (at) => {
        this.scheduleAgentAlarm("agent-loop-driver", Math.max(at, Date.now() + 50));
      },
      executorOverride: this.getDriverExecutorOverride(),
    });
    this._driver.connectSpecProvider = async (providerId) =>
      this.getModelCredentialSetupProps(providerId) ?? { providerId };
    return this._driver;
  }

  protected onHeartbeatOutcome(_input: {
    channelId: string;
    descriptor: import("@workspace/agent-loop").EffectDescriptor;
    outcome: EffectOutcome;
  }): void | Promise<void> {}

  protected registerAgentAlarmSource(source: AgentAlarmSource): void {
    this.alarmSources.set(source.id, source);
    const next = source.nextWakeAt();
    if (next === null) {
      this.alarmDeadlines.delete(source.id);
    } else {
      this.alarmDeadlines.set(source.id, next);
    }
  }

  protected unregisterAgentAlarmSource(sourceId: string): void {
    this.alarmSources.delete(sourceId);
    this.alarmDeadlines.delete(sourceId);
  }

  protected scheduleAgentAlarm(sourceId: string, timeMs: number): void {
    if (!Number.isFinite(timeMs)) return;
    this.alarmDeadlines.set(sourceId, Math.max(Math.round(timeMs), Date.now() + 1));
  }

  protected clearAgentAlarm(sourceId: string): void {
    this.alarmDeadlines.delete(sourceId);
  }

  protected nextAgentAlarmSchedule(): DoAlarmSchedule | null {
    for (const source of this.alarmSources.values()) {
      const next = source.nextWakeAt();
      if (next === null) this.alarmDeadlines.delete(source.id);
      else this.alarmDeadlines.set(source.id, next);
    }
    const deadlines = [...this.alarmDeadlines.values()].filter(
      (value) => Number.isFinite(value) && value >= 0
    );
    return deadlines.length === 0 ? null : { wakeAt: Math.min(...deadlines) };
  }

  protected override nextAlarmAfterRequest(): DoAlarmSchedule | null {
    return this.nextAgentAlarmSchedule();
  }

  private async fireAgentAlarms(now: number): Promise<void> {
    const due = [...this.alarmSources.values()]
      .map((source) => ({ source, wakeAt: source.nextWakeAt() }))
      .filter(
        (entry): entry is { source: AgentAlarmSource; wakeAt: number } =>
          typeof entry.wakeAt === "number" && entry.wakeAt <= now
      )
      .sort((a, b) => a.wakeAt - b.wakeAt);
    for (const { source } of due) {
      this.alarmDeadlines.delete(source.id);
      await source.fire(now);
    }
  }

  private driverNextWakeAtFromSql(): number | null {
    const due: number[] = [];
    try {
      const row = this.sql
        .exec(
          `SELECT MIN(
             CASE WHEN lease_expires_at IS NOT NULL
                  THEN lease_expires_at
                  ELSE COALESCE(next_attempt_at, 0)
             END
           ) AS due FROM effect_outbox`
        )
        .toArray()[0];
      const value = row?.["due"];
      if (typeof value === "number") due.push(value);
    } catch {
      // Driver tables are created lazily.
    }
    try {
      const row = this.sql
        .exec(`SELECT MIN(reset_at_ms) AS due FROM scheduled_model_resumes`)
        .toArray()[0];
      const value = row?.["due"];
      if (typeof value === "number") due.push(value);
    } catch {
      // Driver tables are created lazily.
    }
    return due.length ? Math.min(...due) : null;
  }

  private _gadClient: DurableObjectServiceClient | null = null;

  protected async callGad<T>(method: string, ...args: unknown[]): Promise<T> {
    this._gadClient ??= createGadServiceClient({
      call: <R>(targetId: string, m: string, a: unknown[]) => this.rpc.call<R>(targetId, m, a),
    });
    return this._gadClient.call<T>(method, ...args);
  }

  private executorDeps(): ExecutorDeps {
    this.ensureIdentity();
    const ref = this.identity.ref;
    return {
      selfRef: { kind: "agent", id: this.participantId(), participantId: this.participantId() },
      blobstore: {
        getText: (digest) => this.getCachedBlobText(digest),
        putText: async (value) => {
          const stored = await this.rpc.call<{ digest: string; size: number }>(
            "main",
            "blobstore.putText",
            [value]
          );
          this.rememberBlobText(stored.digest, value);
          return stored;
        },
      },
      channel: {
        callMethod: async (input) => {
          await this.createChannelClient(input.channelId).callMethod(
            this.participantId(),
            input.targetParticipantId,
            input.transportCallId,
            input.method,
            input.args,
            {
              invocationId: input.invocationId,
              transportCallId: input.transportCallId,
              ...(input.turnId ? { turnId: input.turnId } : {}),
              ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
            }
          );
        },
        cancelMethodCall: async (channelId, transportCallId) => {
          await this.createChannelClient(channelId).cancelCall(
            this.participantId(),
            transportCallId
          );
        },
        publish: async (input) => {
          await this.rpc.call(await this.channelTarget(input.channelId), "publish", [
            this.participantId(),
            input.payloadKind,
            input.payload,
            input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
          ]);
        },
        sendSignalEvent: async (channelId, event) => {
          await this.createChannelClient(channelId).sendSignalEvent(
            this.participantId(),
            AGENTIC_EVENT_PAYLOAD_KIND,
            event
          );
        },
      },
      localModels: {
        // Loopback model runtime (design §6.3). The key crosses this boundary
        // per call and is never persisted vessel-side; the extension enforces
        // do-kind + vessel-allowlist caller gating on getLoopbackAuth.
        ensureLoaded: async (modelId, signal) =>
          await this.rpc.call<{ baseUrl: string }>(
            "main",
            "extensions.invoke",
            [LOCAL_MODELS_EXTENSION_ID, "ensureLoaded", [modelId]],
            { signal }
          ),
        getLoopbackAuth: async (signal) =>
          await this.rpc.call<{ apiKey: string }>(
            "main",
            "extensions.invoke",
            [LOCAL_MODELS_EXTENSION_ID, "getLoopbackAuth", []],
            { signal }
          ),
      },
      promptArtifacts: {
        prepare: (channelId, signal) => this.preparePromptArtifacts(channelId, signal),
      },
      credentials: {
        getApiKey: async ({ providerId, modelBaseUrl, requestId, idempotencyKey }) => {
          // Prefer URL-bound credentials when the model exposes a concrete
          // endpoint; fall back to provider-scoped credentials for providers
          // whose registry entries do not carry a base URL.
          let summary: ModelCredentialSummary | null;
          const resolveRequest = modelBaseUrl ? { url: modelBaseUrl } : { providerId };
          try {
            if (requestId) {
              const ack = await this.rpc.callDeferred(
                "main",
                "credentials.resolveCredential",
                [resolveRequest],
                { requestId, idempotencyKey: idempotencyKey ?? requestId }
              );
              if (ack.status === "deferred") {
                throw new CredentialApprovalDeferredError(providerId, modelBaseUrl);
              }
              summary = ack.result as ModelCredentialSummary | null;
            } else {
              summary = await this.rpc.call<ModelCredentialSummary | null>(
                "main",
                "credentials.resolveCredential",
                [resolveRequest]
              );
            }
            if (!summary) throw new CredentialPendingError(providerId, modelBaseUrl);
          } catch (err) {
            if (
              !(
                err instanceof CredentialPendingError ||
                err instanceof CredentialApprovalDeferredError
              )
            ) {
              console.warn(
                `[AgentVessel] resolveCredential(${modelBaseUrl ?? providerId}) failed:`,
                err instanceof Error ? err.message : err
              );
            }
            if (
              err instanceof CredentialPendingError ||
              err instanceof CredentialApprovalDeferredError
            ) {
              throw err;
            }
            throw new CredentialPendingError(providerId, modelBaseUrl);
          }
          installUrlBoundModelFetchProxy(modelBaseUrl ?? "*", (url, init) =>
            this.credentials.fetch(url, init)
          );
          return {
            apiKey: createModelCredentialSentinel(
              this.getModelCredentialTokenClaims(providerId, summary)
            ),
          };
        },
        registerCredentialInterest: async () => {
          // Resolution arrives via the `credentialConnected` agent method —
          // panel-driven, no server-side interest registry required.
        },
      },
      localTools: {
        run: async ({ channelId, tool, invocationId, args, signal, onProgress }) => {
          const trajectory = channelTrajectoryFor(channelId);
          const execution = Object.freeze({
            invocationId,
            commandId: commandIdForTrajectoryInvocation({
              logId: trajectory.logId,
              head: trajectory.head,
              invocationId,
            }),
            rpc: withCausalParent(this.rpc, {
              kind: "trajectory-invocation",
              logId: trajectory.logId,
              head: trajectory.head,
              invocationId,
            }),
          }) satisfies AgentToolExecutionContext;
          try {
            // The `eval` tool DEFERS: the agent can't hold a connection for a multi-minute run.
            // eval.startRun receives this verified parent scope and delegates it to the EvalDO.
            if (tool === "eval") {
              return await this.runDeferredEval(channelId, invocationId, args, execution.rpc);
            }
            // `spawn_subagent` is an agentic lifecycle operation, not workspace authorship.
            if (tool === "spawn_subagent") {
              return await this.runDeferredSpawn(channelId, invocationId, args);
            }
            const registry = await this.toolRegistry(channelId, execution);
            const agentTool = registry.get(tool);
            if (!agentTool) {
              const failure = agentToolFailureFromUnknown(
                Object.assign(new Error(`unknown tool: ${tool}`), { code: "tool_not_found" }),
                {
                  operation: `tool.${tool}`,
                  stage: "resolve",
                  causal: { invocationId, commandId: execution.commandId },
                }
              );
              return {
                result: {
                  protocolContent: [{ type: "text", text: renderAgentToolFailure(failure) }],
                  details: { failure },
                },
                isError: true,
                terminalReasonCode: failure.code,
                failure,
              };
            }
            const params = prepareAgentToolArguments(agentTool, args);
            const result = await agentTool.execute(
              invocationId,
              params as never,
              signal,
              (update) => onProgress?.(update)
            );
            return {
              result: { protocolContent: result.content, details: result.details },
              isError: false,
            };
          } catch (err) {
            const failure = agentToolFailureFromUnknown(err, {
              operation: `tool.${tool}`,
              stage: signal.aborted ? "cancel" : "execute",
              causal: { invocationId, commandId: execution.commandId },
              ...(signal.aborted ? { kind: "cancelled" as const } : {}),
            });
            return {
              result: {
                protocolContent: [
                  {
                    type: "text",
                    text: renderAgentToolFailure(failure),
                  },
                ],
                details: { failure },
              },
              isError: true,
              terminalReasonCode: failure.code,
              failure,
            };
          }
        },
        alreadyApplied: () => false,
      },
      http: {
        post: async (input) => {
          if (!input.target) throw new Error("http_call requires a target service/method");
          // Deferral opt-in (CAP-5): capability-gated server methods (egress
          // domain approval, permission prompts) PARK server-side instead of
          // holding this RPC open across a human approval — the outbox row is
          // the durable continuation, keyed by branch-scoped outbox id, and the result
          // arrives via onDeferredResult → deliverEffectOutcome. Non-gated
          // methods complete inline exactly as before (deferIfNeeded only
          // parks when an approval is actually pending).
          const ack = await this.rpc.callDeferred(
            "main",
            `${input.target.service}.${input.target.method}`,
            [input.request],
            { requestId: input.effectId, idempotencyKey: input.idempotencyKey }
          );
          if (ack.status === "deferred") return { deferred: true };
          return { deferred: false, result: ack.result, isError: false };
        },
      },
      callbackAddress: {
        source: ref.source,
        className: ref.className,
        objectKey: ref.objectKey,
      },
      env: this.env,
    };
  }

  private async getCachedBlobText(digest: string): Promise<string | null> {
    const cached = this.blobTextCache.get(digest);
    if (cached) {
      this.blobTextCache.delete(digest);
      this.blobTextCache.set(digest, cached);
      return cached.value;
    }
    const value = await this.rpc.call<string | null>("main", "blobstore.getText", [digest]);
    if (value != null) this.rememberBlobText(digest, value);
    return value;
  }

  private rememberBlobText(digest: string, value: string): void {
    const bytes = new TextEncoder().encode(value).byteLength;
    const existing = this.blobTextCache.get(digest);
    if (existing) this.blobTextCacheBytes -= existing.bytes;
    this.blobTextCache.delete(digest);
    this.blobTextCache.set(digest, { value, bytes });
    this.blobTextCacheBytes += bytes;
    while (this.blobTextCacheBytes > BLOB_TEXT_CACHE_MAX_BYTES) {
      const first = this.blobTextCache.entries().next().value as
        | [string, { value: string; bytes: number }]
        | undefined;
      if (!first) break;
      this.blobTextCache.delete(first[0]);
      this.blobTextCacheBytes -= first[1].bytes;
    }
  }

  private async channelTarget(channelId: string): Promise<string> {
    const service = await this.rpc.call<{ targetId?: string }>("main", "workers.resolveService", [
      "vibestudio.channel.v1",
      channelId,
    ]);
    if (!service.targetId) throw new Error("channel service did not resolve");
    return service.targetId;
  }

  /** Batched delta signals (~100ms) — never durable (WS1 §2.4.1). */
  /** Per-channel ordered signal sender — concurrent fire-and-forget posts
   *  arrive out of order and scramble streamed token text; the chain keeps
   *  delta order end to end (across flush batches too). */
  private readonly signalChains = new Map<string, Promise<unknown>>();

  private sendOrderedSignal(channelId: string, events: AgenticEvent[]): void {
    void serializeByKey(this.signalChains, channelId, () =>
      this.createChannelClient(channelId)
        .sendSignalEvent(
          this.participantId(),
          AGENTIC_EVENT_PAYLOAD_KIND,
          events.length === 1 ? events[0] : events
        )
        .catch(() => {})
    );
  }

  private sendOrderedSignalMessage(channelId: string, content: string, contentType?: string): void {
    void serializeByKey(this.signalChains, channelId, () =>
      this.createChannelClient(channelId)
        .sendSignal(this.participantId(), content, contentType)
        .catch(() => {})
    );
  }

  private emitEphemeral(emit: EphemeralEmit): void {
    if (emit.kind === "signal-message") {
      this.sendOrderedSignalMessage(emit.channelId, emit.content, emit.contentType);
      return;
    }
    const buffer = this.deltaBuffers.get(emit.channelId) ?? { events: [], timer: null };
    buffer.events.push(emit.event);
    if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        const drained = this.deltaBuffers.get(emit.channelId);
        this.deltaBuffers.delete(emit.channelId);
        const events = drained?.events ?? [];
        if (events.length > 0) this.sendOrderedSignal(emit.channelId, events);
      }, DELTA_BATCH_MS);
    }
    this.deltaBuffers.set(emit.channelId, buffer);
  }

  // ── Settings (Ref-kind KV; the log journals what each call actually used) ─

  protected updateSettings(patch: StoredSettings): AgentSettings {
    const next = { ...this.storedSettings(), ...patch };
    this.setStateValue(AGENT_SETTINGS_KEY, JSON.stringify(next));
    // Config is PER-AGENT: a change applies to EVERY channel the agent is in,
    // so drop each channel's cached loop + fold so the next wake refolds with it.
    for (const channelId of this.subscriptions.listChannelIds()) {
      this.driver.dropLoop(channelId);
      const { logId, head } = channelTrajectoryFor(channelId);
      this.driver.foldCache.delete(logId, head);
    }
    return this.getAgentSettings();
  }

  /**
   * The agent's settings record (channel-INDEPENDENT). On first read it is
   * seeded from the agent's creation params (`STATE_ARGS.agentConfig`) so an
   * invited agent starts with the config it was created with, then persisted so
   * later reads are stable and edits (updateSettings) win over the seed.
   */
  private storedSettings(persistSeed = true): StoredSettings {
    const raw = this.getStateValue(AGENT_SETTINGS_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as StoredSettings;
      } catch {
        /* corrupt record — fall through to a fresh seed */
      }
    }
    const seed = this.seedSettingsFromStateArgs();
    if (persistSeed && Object.keys(seed).length > 0) {
      this.setStateValue(AGENT_SETTINGS_KEY, JSON.stringify(seed));
    }
    return seed;
  }

  /**
   * Initial settings from the agent's creation stateArgs (`STATE_ARGS.agentConfig`).
   * Picks ONLY the known settings (lenient — skips invalid/unknown keys) so the
   * persisted record stays clean even if the creation config carries presentation
   * fields (handle/systemPrompt) or junk.
   */
  private seedSettingsFromStateArgs(): StoredSettings {
    const stateArgs = this.env["STATE_ARGS"];
    const raw =
      stateArgs && typeof stateArgs === "object"
        ? (stateArgs as Record<string, unknown>)["agentConfig"]
        : undefined;
    if (!raw || typeof raw !== "object") return {};
    const c = raw as Record<string, unknown>;
    const seed: StoredSettings = {};
    if (typeof c["model"] === "string" && c["model"]) seed.model = c["model"];
    const tl = c["thinkingLevel"];
    if (isThinkingLevel(tl)) seed.thinkingLevel = tl;
    if (typeof c["fallbackModel"] === "string" && c["fallbackModel"]) {
      seed.fallbackModel = c["fallbackModel"];
    }
    if (isThinkingLevel(c["fallbackThinkingLevel"])) {
      seed.fallbackThinkingLevel = c["fallbackThinkingLevel"];
    }
    if (isFallbackOn(c["fallbackOn"])) seed.fallbackOn = [...c["fallbackOn"]];
    if (c["fallbackScope"] === "unattended" || c["fallbackScope"] === "all-turns") {
      seed.fallbackScope = c["fallbackScope"];
    }
    const al = c["approvalLevel"];
    if (al === 0 || al === 1 || al === 2) seed.approvalLevel = al;
    if (isRespondPolicy(c["respondPolicy"])) seed.respondPolicy = c["respondPolicy"];
    const rf = c["respondFrom"];
    if (Array.isArray(rf) && rf.every((x) => typeof x === "string"))
      seed.respondFrom = rf as string[];
    return seed;
  }

  private resolveAgentSettings(persistSeed: boolean): AgentSettings {
    const stored = this.storedSettings(persistSeed);
    const approval = stored.approvalLevel;
    return {
      model: stored.model ?? this.getDefaultModel(),
      thinkingLevel: stored.thinkingLevel ?? this.getDefaultThinkingLevel(),
      ...(stored.fallbackModel ? { fallbackModel: stored.fallbackModel } : {}),
      ...(stored.fallbackThinkingLevel
        ? { fallbackThinkingLevel: stored.fallbackThinkingLevel }
        : {}),
      ...(stored.fallbackOn ? { fallbackOn: [...stored.fallbackOn] } : {}),
      ...(stored.fallbackScope ? { fallbackScope: stored.fallbackScope } : {}),
      approvalLevel:
        approval === 0 || approval === 1 || approval === 2
          ? approval
          : this.getDefaultApprovalLevel(),
      respondPolicy: isRespondPolicy(stored.respondPolicy)
        ? stored.respondPolicy
        : this.getRespondPolicy(),
      respondFrom: stored.respondFrom ?? this.getDefaultRespondFrom(),
    };
  }

  getAgentSettings(): AgentSettings {
    return this.resolveAgentSettings(true);
  }

  /** Settings projection for operational inspection; never seeds local state. */
  private inspectAgentSettings(): AgentSettings {
    return this.resolveAgentSettings(false);
  }

  protected getRespondPolicy(): RespondPolicy {
    return this.getDefaultRespondPolicy();
  }

  private loopConfig(channelId: string): AgentLoopConfig {
    const settings = this.getAgentSettings();
    // Tool approval is a channel-wide consent control. The chat header writes
    // this value to channel config, so it must override the legacy per-agent
    // setting used as the fallback for channels that have not selected a level.
    const channelConfig =
      (this.subscriptions.getConfig(channelId) as Record<string, unknown> | null) ??
      this.channelConfigCache.get(channelId)?.value;
    const channelApprovalLevel = channelConfig?.["approvalLevel"];
    const approvalLevel =
      channelApprovalLevel === 0 || channelApprovalLevel === 1 || channelApprovalLevel === 2
        ? channelApprovalLevel
        : settings.approvalLevel;
    const publishPolicy = this.getPublishPolicy(channelId);
    const immediatePrompt = this.immediatePrompt(channelId);
    const materialized = this.materializedModel(channelId, settings.model);
    if (!materialized) {
      throw new Error(
        `Agent model ${JSON.stringify(settings.model)} could not be materialized; ` +
          "select a model present in the current catalog before starting the agent"
      );
    }
    const fallbackModelRef = settings.fallbackModel ?? LOCAL_FALLBACK_MODEL_REF;
    const fallbackMaterialized = this.materializedModel(channelId, fallbackModelRef);
    if (settings.fallbackModel && !fallbackMaterialized) {
      throw new Error(
        `Agent fallback model ${JSON.stringify(settings.fallbackModel)} could not be materialized; ` +
          "select a fallback model present in the current catalog before starting the agent"
      );
    }
    const toolSchemasHash =
      // Tool-capability gate (design §6.4): omit tool schemas at the source
      // for models whose chat template can't parse them.
      !materialized.toolsCapable
        ? undefined
        : (this.getStateValue(`agent:toolsHash:${channelId}`) ?? undefined);
    return {
      model: settings.model,
      modelSpec: materialized.spec,
      modelAuth: materialized.auth,
      ...(fallbackMaterialized
        ? {
            fallbackModelRef,
            fallbackModelSpec: fallbackMaterialized.spec,
            fallbackModelAuth: fallbackMaterialized.auth,
            ...(settings.fallbackThinkingLevel
              ? { fallbackThinkingLevel: settings.fallbackThinkingLevel }
              : {}),
            ...(settings.fallbackOn ? { fallbackFailureCodes: settings.fallbackOn } : {}),
            ...(settings.fallbackScope ? { fallbackScope: settings.fallbackScope } : {}),
          }
        : {}),
      thinkingLevel: settings.thinkingLevel,
      approvalLevel,
      respondPolicy: settings.respondPolicy,
      systemPromptHash: this.getStateValue(`agent:promptHash:${channelId}`) ?? "",
      ...(immediatePrompt ? { immediatePrompt } : {}),
      toolSchemasHash,
      activeToolNames: JSON.parse(
        this.getStateValue(`agent:toolNames:${channelId}`) ?? "[]"
      ) as string[],
      localToolExecutionModes: JSON.parse(
        this.getStateValue(`agent:toolExecutionModes:${channelId}`) ?? "{}"
      ) as Record<string, "sequential" | "parallel">,
      roster: { participants: [] }, // roster snapshots fold from system.event
      maxSubagentDepth: this.getMaxSubagentDepth(),
      maxConcurrentSubagents: this.getMaxConcurrentSubagents(),
      ...(publishPolicy ? { publishPolicy } : {}),
    };
  }

  /** Materialize the journaled model spec (design §6.2): local refs from the
   *  cached extension entry (refreshed in ensurePromptArtifacts), cloud refs
   *  from the pi-ai registry — an INPUT to materialization here at the impure
   *  edge, never a resolution path in the executor. */
  private materializedModel(channelId: string, ref: string): MaterializedModel | null {
    const idx = ref.indexOf(":");
    const providerId = idx === -1 ? "anthropic" : ref.slice(0, idx);
    const modelId = idx === -1 ? ref : ref.slice(idx + 1);
    let localEntry: LocalModelDescriptor | null = null;
    if (providerId === LOCAL_PROVIDER_ID) {
      const raw = this.getStateValue(`agent:localModelEntry:${channelId}`);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as LocalModelDescriptor;
          if (parsed && parsed.slug === modelId) localEntry = parsed;
        } catch {
          // Corrupt cache — placeholder materialization covers this call;
          // the next artifact refresh rewrites it.
        }
      }
    }
    return materializeModel(providerId, modelId, localEntry);
  }

  /** Cache the local-models extension entry for a `local:*` agent model so
   *  the synchronous loopConfig() can materialize its journaled spec. Failure
   *  is non-fatal: the placeholder spec keeps the call path alive and the
   *  executor's ensureLoaded() supplies the live endpoint regardless. */
  private async refreshLocalModelEntry(channelId: string): Promise<void> {
    const model = this.getAgentSettings().model;
    if (!model.startsWith(`${LOCAL_PROVIDER_ID}:`)) return;
    const slug = model.slice(LOCAL_PROVIDER_ID.length + 1);
    try {
      const entries = await this.rpc.call<LocalModelDescriptor[]>("main", "extensions.invoke", [
        LOCAL_MODELS_EXTENSION_ID,
        "listModels",
        [],
      ]);
      const entry = Array.isArray(entries)
        ? (entries.find((candidate) => candidate?.slug === slug) ?? null)
        : null;
      if (!entry) return;
      this.setStateValue(
        `agent:localModelEntry:${channelId}`,
        JSON.stringify({
          slug: entry.slug,
          displayName: entry.displayName,
          baseUrl: entry.baseUrl,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          toolsCapable: entry.toolsCapable,
        } satisfies LocalModelDescriptor)
      );
    } catch (err) {
      console.warn("[agent-vessel] local model entry refresh failed:", err);
    }
  }

  /** Compose + blob-spill the exact prompt/tool/model snapshot that will be
   * journaled before a model call. This is the impure executor for the
   * loop-owned `prompt_artifacts` effect; channel delivery only journals the
   * prerequisite and never awaits this method. */
  private async preparePromptArtifacts(
    channelId: string,
    signal?: AbortSignal
  ): Promise<Partial<AgentLoopConfig>> {
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("prompt artifact preparation aborted");
    };
    throwIfAborted();
    await this.refreshLocalModelEntry(channelId);
    throwIfAborted();
    const immediatePrompt = await this.prepareImmediatePrompt(channelId, signal);
    throwIfAborted();
    const systemPrompt = await this.composePrompt(channelId);
    throwIfAborted();
    const registry = await this.toolRegistry(channelId);
    const schemas: Array<{ name: string; description?: string; parameters?: unknown }> = [
      ...registry.values(),
    ].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const executionModes = Object.fromEntries(
      [...registry.values()].map((tool) => [
        tool.name,
        tool.executionMode === "parallel" ? "parallel" : "sequential",
      ])
    ) satisfies Record<string, "sequential" | "parallel">;
    // Channel tools: roster participants' advertised methods become model
    // tools dispatched as channel_call effects (the panel's UI surface —
    // inline_ui/feedback/action_bar). eval is a LOCAL tool now, not a channel method.
    const seenTools = new Set(registry.keys());
    for (const participant of this.rosterSnapshot(channelId)) {
      if (participant.methods.length > 0) {
        await this.recordDerivedSessionIngestion(
          participant.participantId,
          "participant-tool-advertisement"
        );
        throwIfAborted();
      }
      for (const method of participant.methods) {
        if (seenTools.has(method.name)) continue;
        seenTools.add(method.name);
        schemas.push({
          name: method.name,
          description:
            method.description ??
            `Channel method on @${participant.handle ?? participant.participantId}`,
          parameters: method.parameters ?? {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
        });
      }
    }
    const schemasJson = JSON.stringify(schemas);
    const names = JSON.stringify([...registry.keys()]);
    const executionModesJson = JSON.stringify(executionModes);
    const signature = stableSha256Hex({ systemPrompt, schemas, executionModes });
    const promptHashKey = `agent:promptHash:${channelId}`;
    const toolsHashKey = `agent:toolsHash:${channelId}`;
    const toolNamesKey = `agent:toolNames:${channelId}`;
    const toolExecutionModesKey = `agent:toolExecutionModes:${channelId}`;
    const artifactSigKey = `agent:artifactSig:${channelId}`;
    const existingPromptHash = this.getStateValue(promptHashKey) ?? "";
    const existingToolsHash = this.getStateValue(toolsHashKey) ?? "";
    if (
      !existingPromptHash ||
      !existingToolsHash ||
      this.getStateValue(artifactSigKey) !== signature ||
      this.getStateValue(toolNamesKey) !== names ||
      this.getStateValue(toolExecutionModesKey) !== executionModesJson
    ) {
      const prompt = await this.rpc.call<{ digest?: string }>("main", "blobstore.putText", [
        systemPrompt,
      ]);
      throwIfAborted();
      const tools = await this.rpc.call<{ digest?: string }>("main", "blobstore.putText", [
        schemasJson,
      ]);
      throwIfAborted();
      const promptHash = typeof prompt?.digest === "string" ? prompt.digest : "";
      const toolsHash = typeof tools?.digest === "string" ? tools.digest : "";
      this.setStateValue(promptHashKey, promptHash);
      this.setStateValue(toolsHashKey, toolsHash);
      this.setStateValue(toolNamesKey, names);
      this.setStateValue(toolExecutionModesKey, executionModesJson);
      this.setStateValue(artifactSigKey, signature);
    }
    throwIfAborted();
    const {
      roster: _foldOwnedRoster,
      immediatePrompt: _synchronousImmediatePrompt,
      ...patch
    } = this.loopConfig(channelId);
    return { ...patch, immediatePrompt: immediatePrompt ?? "" };
  }

  /** Explicit refresh API: materialize, then journal the same config patch the
   * durable prompt prerequisite would have produced. */
  protected async ensurePromptArtifacts(channelId: string): Promise<void> {
    const patch = await this.preparePromptArtifacts(channelId);
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: { kind: "setConfig", patch },
    });
  }

  /** Last roster snapshot for a channel (set by maybeRefreshRoster). */
  private rosterSnapshot(channelId: string): RosterEntry[] {
    try {
      const raw = this.getStateValue(`agent:roster:${channelId}`);
      return raw ? (JSON.parse(raw) as RosterEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async toolRegistry(
    channelId: string,
    execution?: AgentToolExecutionContext
  ): Promise<Map<string, AgentTool>> {
    if (execution) {
      const registry = new Map<string, AgentTool>();
      if (this.includeMemoryRecallTool()) {
        registry.set("memory_recall", this.createMemoryRecallTool());
      }
      for (const tool of this.getLoopTools(channelId, execution)) {
        registry.set(tool.name, tool);
      }
      return registry;
    }
    let registry = this.localTools.get(channelId);
    if (!registry) {
      registry = new Map();
      if (this.includeMemoryRecallTool()) {
        registry.set("memory_recall", this.createMemoryRecallTool());
      }
      for (const tool of this.getLoopTools(channelId)) {
        registry.set(tool.name, tool);
      }
      this.localTools.set(channelId, registry);
    }
    return registry;
  }

  /**
   * Workspace memory search (WS4): chat messages and committed file content,
   * with provenance. The recall result is journaled via the invocation terminal
   * like any tool output — replays and audits see exactly what was recalled.
   */
  private createMemoryRecallTool(): AgentTool<never> {
    return {
      name: "memory_recall",
      label: "memory_recall",
      executionMode: "parallel",
      description:
        "Search workspace memory: past conversation messages and committed file content. " +
        "Returns snippets with provenance (who/when/where). Use before re-deriving facts that may already be known.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms." },
          kinds: {
            type: "array",
            items: { type: "string", enum: ["message", "file"] },
            description: "Optional filter by memory kind.",
          },
          limit: { type: "number", description: "Max results (default 10, max 50)." },
        },
        required: ["query"],
      } as never,
      execute: async (_toolCallId, params) => {
        const input = params as { query?: unknown; kinds?: unknown; limit?: unknown };
        if (typeof input.query !== "string" || !input.query.trim()) {
          throw new Error("memory_recall requires a non-empty query");
        }
        const recall = await this.callGad<{
          results: Array<{
            kind: string;
            snippet: string;
            path: string | null;
            eventId: string | null;
            actor: unknown;
            appendedAt: string | null;
          }>;
        }>("recallMemory", {
          query: input.query,
          kinds: Array.isArray(input.kinds)
            ? input.kinds.filter((kind): kind is string => typeof kind === "string")
            : null,
          limit: typeof input.limit === "number" ? input.limit : null,
        });
        for (const result of recall.results) {
          const origin =
            result.actor && typeof result.actor === "object" && "id" in result.actor
              ? String((result.actor as { id: unknown }).id)
              : (result.eventId ?? "memory-unknown");
          await this.recordDerivedSessionIngestion(origin, "memory-recall");
        }
        const lines = recall.results.map((result) => {
          const where =
            result.path ??
            (result.actor && typeof result.actor === "object" && "id" in result.actor
              ? String((result.actor as { id: unknown }).id)
              : (result.eventId ?? "unknown"));
          const when = result.appendedAt ? ` @ ${result.appendedAt}` : "";
          return `[${result.kind}] ${where}${when}\n${result.snippet}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: lines.length > 0 ? lines.join("\n\n") : "No memory matched the query.",
            },
          ],
          details: { resultCount: recall.results.length } as never,
        };
      },
    };
  }

  // ── Channel membership ───────────────────────────────────────────────────

  @rpc({
    principals: ["code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
    this.ensureIdentity();
    const firstSubscription = this.subscriptions.count() === 0;
    if (firstSubscription) {
      await this.registerLifecycleRelease({ kind: "channel-subscriptions" });
    }
    const descriptor = this.getEffectiveParticipantInfo(opts.channelId, opts.config);
    // Subscription is MEMBERSHIP + presentation only. Behavior config (model,
    // approvalLevel, respondPolicy, …) is per-agent and seeded at creation from
    // STATE_ARGS.agentConfig — it does NOT ride the subscription. `config` here
    // carries only channel-presentation (handle, systemPrompt) consumed via the
    // participant descriptor / getPromptOverride.
    let result: Awaited<ReturnType<SubscriptionManager["subscribe"]>>;
    try {
      result = await this.subscriptions.subscribe({
        channelId: opts.channelId,
        contextId: opts.contextId,
        config: opts.config,
        descriptor,
        replay: opts.replay,
      });
    } catch (error) {
      if (firstSubscription && this.subscriptions.count() === 0) {
        await this.clearLifecycleRelease();
      }
      throw error;
    }
    await this.ingestSubscriptionReplay(
      opts.channelId,
      result.envelope,
      configuredWakePolicy(opts.config) === "every-envelope"
    );
    return { ok: result.ok, participantId: result.participantId };
  }

  /**
   * Host lifecycle counterpart to the code-owned subscription API. Product
   * orchestration may attach an already-created vessel without impersonating a
   * code caller; channel.subscribe still authenticates this exact DO identity.
   */
  @rpc({
    principals: ["host"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async attachChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
    return this.subscribeChannel(opts);
  }

  private async ingestSubscriptionReplay(
    channelId: string,
    envelope: ChannelReplayEnvelope | undefined,
    wakeAfterReplay: boolean
  ): Promise<void> {
    let page = envelope;
    for (;;) {
      if (page?.logEvents?.length) {
        for (const event of page.logEvents) {
          await this.processSubscriptionReplayEvent(channelId, event);
        }
      }
      if (page?.mode !== "after" || !page.ready.hasMoreAfter) break;
      const after = page.ready.replayToId;
      const throughSeq = page.ready.snapshotLastSeq;
      if (after === undefined || throughSeq === undefined) {
        throw new Error("subscription replay claims more history without a stable cursor");
      }
      page = await this.createChannelClient(channelId).getReplayAfter({ after, throughSeq });
    }
    if (wakeAfterReplay) await this.driver.wake(channelId);
  }

  private async processSubscriptionReplayEvent(
    channelId: string,
    event: ChannelReplayEnvelope["logEvents"][number]
  ): Promise<void> {
    await this.processChannelEvent(channelId, {
      id: event.id,
      messageId: event.messageId,
      type: event.type,
      payload: event.payload,
      senderId: event.senderId,
      ts: event.ts,
      ...(event.senderMetadata ? { senderMetadata: event.senderMetadata } : {}),
      ...(event.contentType ? { contentType: event.contentType } : {}),
      ...(event.attachments ? { attachments: event.attachments } : {}),
      ...((event as unknown as { annotations?: Record<string, unknown> }).annotations
        ? {
            annotations: (event as unknown as { annotations: Record<string, unknown> }).annotations,
          }
        : {}),
    });
  }

  @rpc({
    principals: ["user", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async unsubscribeChannel(channelId: string): Promise<{ ok: boolean }> {
    try {
      await this.driver.handleIncoming(channelId, {
        type: "command",
        command: { kind: "abort", reason: "channel_unsubscribe" },
      });
      await this.subscriptions.unsubscribeFromChannel(channelId);
    } finally {
      this.subscriptions.deleteSubscription(channelId);
      this.driver.dropLoop(channelId);
      if (this.subscriptions.count() === 0) await this.clearLifecycleRelease();
    }
    return { ok: true };
  }

  // ── Channel intake ───────────────────────────────────────────────────────

  @rpc({
    principals: ["code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async onChannelEnvelope(channelId: string, envelope: RpcChannelMessage): Promise<void> {
    this.assertChannelDeliveryCaller("onChannelEnvelope");
    if (envelope.kind === "control") {
      if (envelope.type === "ready") {
        const wakePolicy = this.subscriptions.getConfig(channelId)?.wakePolicy ?? "every-envelope";
        if (wakePolicy === "every-envelope") await this.driver.wake(channelId);
      }
      return;
    }
    if (envelope.kind === "log" && envelope.event) {
      await this.processChannelEvent(channelId, envelope.event);
      return;
    }
    // signals are advisory — subclasses may hook them via onChannelEvent
    if (envelope.kind === "signal" && envelope.type) {
      await this.onChannelEvent(channelId, {
        id: 0,
        messageId: "",
        type: envelope.type,
        payload: envelope.payload,
        senderId: envelope.senderId ?? "system",
        ts: envelope.ts ?? Date.now(),
      });
    }
  }

  async processChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    // Invalidate the cached participant roster on any presence change, in the one sink both the
    // live stream and subscription-replay paths funnel through — so neither path serves a stale
    // roster to shouldRespond / maybeRefreshRoster.
    if (event.type === "presence") {
      this.participantCache.delete(channelId);
      // A participant joined/left/updated mid-session: refresh the durable
      // roster snapshot. Prompt/tool artifacts are materialized at the actual
      // reasoning boundary, where their signature includes this snapshot.
      // Idle membership must not start host RPC/build work that outlives the
      // subscription or competes with lifecycle release.
      await this.maybeRefreshRoster(channelId);
    }
    // A supervisor's task-channel progress mirror observes the raw agentic
    // stream before specialized routing consumes invocation traffic. In
    // particular, routeInvocationTerminal intentionally swallows
    // invocation.started/output events so they never become prompts; observing
    // only after that gate made child tools permanently invisible on the
    // parent card.
    const observedAgentic =
      event.type === AGENTIC_EVENT_PAYLOAD_KIND ? (event.payload as AgenticEvent | null) : null;
    this.publishSubagentProgress(channelId, event, observedAgentic);
    if (await this.onChannelEvent(channelId, event)) return;
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return;
    const maybeFeedback = event.payload as AgenticEvent | null;
    if (maybeFeedback && (maybeFeedback as { kind?: string }).kind === "ui.feedback") {
      const payload = (maybeFeedback as AgenticEvent<"ui.feedback">).payload;
      if ((payload.target as { participantId?: string })?.participantId === this.participantId()) {
        this.feedback.ingest(channelId, payload);
      }
      return;
    }
    // chatOp callMethod relay settles first: a terminal for a call WE initiated
    // on behalf of the EvalDO's `chat.callMethod` resolves its awaiting promise.
    // Like routeInvocationTerminal this must run before the message.completed
    // gate and self-sender skip (the channel journals terminals with us, the
    // caller, as sender).
    if (await this.settleChatOpCall(channelId, event)) return;
    // Outcome routing first: a channel invocation terminal for one of our
    // pending channel_call effects settles that effect. This must run BEFORE
    // the message.completed gate and the self-sender skip — the channel
    // journals call terminals with the CALLER (us) as sender.
    if (await this.routeInvocationTerminal(channelId, event)) return;

    // Edit/retract mutations target an existing message and may arrive outside
    // an open turn — route them BEFORE the message.completed-only gate, and skip
    // our own (the fold still enforces the author guard).
    if (await this.routeMessageMutation(channelId, event)) return;

    // Wake discipline (WS-5). A channel subscribed with a non-default wakePolicy
    // (task channels the supervisor watches, subscribed "turn-final") buffers
    // envelopes in the durable log and wakes only on a trigger — never opening a
    // turn per intermediate envelope. Resolved BEFORE the message.completed gate
    // because a turn.closed trigger is not itself a message.completed. Returns
    // true when the event was handled (buffered or drove a turn-final wake);
    // false falls through to the default every-envelope path (say / mention).
    const wakePolicy = this.subscriptions.getConfig(channelId)?.wakePolicy ?? "every-envelope";
    if (wakePolicy !== "every-envelope") {
      if (await this.resolveWake(channelId, event, wakePolicy)) return;
    }

    const agentic = event.payload as AgenticEvent | null;
    if (!agentic || (agentic as { kind?: string }).kind !== "message.completed") return;
    if (event.senderId === this.participantId()) return;

    const respond = await this.shouldRespond(channelId, event);
    if (!respond) return;

    // Sender's canonical message identity — the read-ack / edit / retract
    // correlation key. NOT derived from the recv envelope id.
    const sourceMessageId =
      ((agentic as AgenticEvent).causality?.messageId as string | undefined) ?? undefined;

    // Validate identity before recording ingestion or allowing a subclass to
    // consume content. A transport envelope is not a durable source identity.
    if (!sourceMessageId) {
      throw new Error(
        `channel input ${event.messageId} has no canonical source message identity; refusing an unwalkable turn`
      );
    }

    // The host resolves this exact durable message's persisted class. Do not
    // read a class from the delivered payload: a participant controls payload
    // bytes, while the GAD provenance row is product-sealed.
    await this.recordMessageIngestion(channelId, event, "channel-message");

    // Only an actual recipient (shouldRespond === true) emits a received ack.
    await this.publishReceivedAck(channelId, sourceMessageId);

    await this.maybeRefreshRoster(channelId);
    await this.dispatchApprovedInput(channelId, event, sourceMessageId);
  }

  /**
   * Deliver an addressing-approved inbound message to this vessel's reasoning
   * loop. The default drives the in-process AgentLoopDriver; a vessel whose
   * reasoning loop lives OUTSIDE the system (linked agents — an attached
   * external process) overrides this to enqueue/forward instead. Runs AFTER
   * shouldRespond and the received ack, so overrides only ever see input the
   * agent should react to.
   */
  protected async dispatchApprovedInput(
    channelId: string,
    event: ChannelEvent,
    sourceMessageId: string | undefined
  ): Promise<void> {
    const agentic = event.payload as AgenticEvent | null;
    const metadata = this.turnMetadata(event);
    const command = {
      channelId,
      source: { envelopeId: event.messageId },
      ...(sourceMessageId ? { sourceMessageId } : {}),
      content: this.turnContent(channelId, event),
      senderRef: participantRefFromActor((agentic as AgenticEvent).actor),
      agentHops: event.annotations?.["agentHops"] as number | undefined,
      ...(metadata ? { metadata } : {}),
    };
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: {
        // Replayed history is deduped downstream by envelope id
        // (alreadyIngested) — only messages the loop never saw open a turn,
        // so backlog that arrived while the agent was down still gets a
        // response after replay.
        kind: "prompt",
        ...command,
      },
    });
  }

  /** Publish a `message.received` ack for a message this agent will consume.
   *  Deterministic idempotency key dedupes redeliveries. */
  private async publishReceivedAck(
    channelId: string,
    sourceMessageId: string | undefined
  ): Promise<void> {
    if (!sourceMessageId) return;
    const participantId = this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const event: AgenticEvent<"message.received"> = {
      kind: "message.received",
      actor: this.selfRef(channelId),
      causality: { messageId: sourceMessageId as never },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(channelId)
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: `received:${channelId}:${sourceMessageId}:${participantId}`,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((err) => {
        console.error(`[AgentVessel] received ack emit failed for ${channelId}:`, err);
      });
  }

  /** Route a `message.edited` / `message.retracted` channel event to the loop
   *  as an edit/retract command. The fold enforces the author guard and the
   *  read-wins cutoff; here we only skip our own events and require a target. */
  private async routeMessageMutation(channelId: string, event: ChannelEvent): Promise<boolean> {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    const agentic = event.payload as AgenticEvent | null;
    const kind = (agentic as { kind?: string } | null)?.kind;
    if (kind !== "message.edited" && kind !== "message.retracted") return false;
    if (event.senderId === this.participantId()) return true; // our own; nothing to do
    const sourceMessageId = (agentic as AgenticEvent).causality?.messageId as string | undefined;
    const by = participantRefFromActor((agentic as AgenticEvent).actor);
    if (!sourceMessageId || !by) return true;
    if (kind === "message.edited") {
      const payload = (agentic as AgenticEvent<"message.edited">).payload;
      await this.recordMessageIngestion(channelId, event, "channel-message-edit");
      await this.driver.handleIncoming(channelId, {
        type: "command",
        command: { kind: "edit", sourceMessageId, blocks: payload.blocks, by },
      });
    } else {
      await this.driver.handleIncoming(channelId, {
        type: "command",
        command: { kind: "retract", sourceMessageId, by },
      });
    }
    return true;
  }

  /** Channel terminals for our pending channel_call/approval-form effects. */
  private static readonly INVOCATION_TERMINAL_KINDS = new Set([
    "invocation.completed",
    "invocation.failed",
    "invocation.cancelled",
    "invocation.abandoned",
  ]);

  /** Settle our pending channel_call effects from the channel's durable
   *  invocation terminals (the channel broadcasts them to all subscribers,
   *  including us, the caller). This IS the outcome-delivery leg of the
   *  channel_call at-least-once protocol — without it a turn that invokes a
   *  panel method (eval, set_title, …) never advances. Duplicate delivery is
   *  a no-op: the outbox row is gone after the first settle. */
  private async routeInvocationTerminal(channelId: string, event: ChannelEvent): Promise<boolean> {
    const agentic = event.payload as AgenticEvent;
    const kind = (agentic as { kind?: string }).kind ?? "";
    if (!kind.startsWith("invocation.")) return false;
    if (!AgentVesselBase.INVOCATION_TERMINAL_KINDS.has(kind)) {
      return true; // started/output traffic is never a prompt
    }
    const causality = ((agentic as { causality?: Record<string, unknown> }).causality ??
      {}) as Record<string, unknown>;
    const invocationId =
      typeof causality["invocationId"] === "string" ? (causality["invocationId"] as string) : null;
    if (!invocationId) return true;
    const effectId = ids.invocationEffect(invocationId);
    const row = this.driver.outbox.getForChannel(channelId, effectId);
    if (!row || row.kind !== "channel_call") return true; // not ours or already settled
    const descriptor = row.descriptor as import("@workspace/agent-loop").ChannelCallEffect;
    const payload = ((agentic as { payload?: Record<string, unknown> }).payload ?? {}) as Record<
      string,
      unknown
    >;
    const isError = kind !== "invocation.completed";
    const responderSessionId = participantIdFromRef(descriptor.target);
    await this.recordMessageIngestion(channelId, event, "channel-tool-result");
    const hydratedResult = await this.hydrateTransportValue(
      payload["result"],
      responderSessionId,
      "channel-tool-result"
    );
    let outcome: EffectOutcome;
    if (descriptor.purpose === "approval-form") {
      const raw = hydratedResult;
      const granted =
        !isError &&
        !!raw &&
        typeof raw === "object" &&
        (raw as { granted?: unknown }).granted === true;
      outcome = {
        kind: "approval",
        granted,
        resolvedBy: descriptor.target,
        ...(typeof payload["reason"] === "string" ? { reason: payload["reason"] as string } : {}),
      };
      if (isError) {
        await this.publishApprovalDeliveryDiagnostic(channelId, descriptor, payload["reason"]);
      }
    } else {
      outcome = {
        kind: "tool",
        result: hydratedResult ?? payload["error"] ?? payload["reason"] ?? null,
        isError,
        ...(typeof payload["reason"] === "string" ? { reason: payload["reason"] as string } : {}),
      };
    }
    await this.driver.deliverEffectOutcome(effectId, outcome, { channelId });
    return true;
  }

  private async publishApprovalDeliveryDiagnostic(
    channelId: string,
    descriptor: import("@workspace/agent-loop").ChannelCallEffect,
    reason: unknown
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const messageId = `approval-delivery-failed:${descriptor.transportCallId}`;
    const reasonText =
      typeof reason === "string" && reason.trim() ? reason : "approval prompt unavailable";
    const event: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: {
        kind: "agent",
        id: participantId,
        displayName: this.getEffectiveParticipantInfo(
          channelId,
          this.subscriptions.getConfig(channelId)
        ).name,
      },
      turnId: descriptor.turnId as never,
      causality: { messageId: messageId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: `${messageId}:diagnostic` as never,
            type: "diagnostic",
            content: "Approval prompt could not be delivered. The requested action was denied.",
            metadata: {
              code: "approval_prompt_unavailable",
              severity: "error",
              reason: reasonText,
              invocationId: descriptor.invocationId,
            },
          },
        ],
        outcome: "completed",
      },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(channelId)
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: messageId,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((err) => {
        console.error(`[AgentVessel] approval diagnostic emit failed for ${channelId}:`, err);
      });
  }

  protected turnContent(channelId: string, event: ChannelEvent): unknown {
    const agentic = event.payload as { payload?: { blocks?: unknown[] } };
    const blocks = agentic.payload?.blocks ?? [];
    const text = blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : ""
      )
      .filter(Boolean)
      .join("\n");
    const notes = this.feedback.consume(channelId);
    return notes.length > 0 ? [...notes, text].filter(Boolean).join("\n\n") : text;
  }

  protected turnMetadata(event: ChannelEvent): AgentTurnMetadata | undefined {
    const agentic = event.payload as { payload?: { metadata?: unknown } };
    const metadata = agentic.payload?.metadata;
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as AgentTurnMetadata)
      : undefined;
  }

  protected async shouldRespond(channelId: string, event: ChannelEvent): Promise<boolean> {
    const agentic = event.payload as AgenticEvent;
    const payload = (agentic.payload ?? {}) as {
      mentions?: string[];
      replyTo?: string;
      to?: never[];
    };
    const channel = this.createChannelClient(channelId);
    let lastCompletedSender: string | null = null;
    let lastCompletedMessageId: string | null = null;
    let replyToSenderId: string | undefined;
    let conversationPolicy: "open" | "directed" | "moderated" | undefined;
    let agentHopLimit: number | undefined;
    let participantIds: string[] = [];
    // Captured for per-agent respondFrom handle→id resolution (resolveRespondFromHandles).
    let respondParticipants: ReadonlyArray<{
      participantId: string;
      metadata?: Record<string, unknown> | null;
    }> = [];
    let agentStreakHops: number | undefined;
    try {
      const [policyState, config, participants] = await Promise.all([
        channel.getPolicyState(),
        this.getCachedChannelConfig(channelId),
        this.getCachedParticipants(channelId),
      ]);
      const conversation = policyState.state as {
        lastCompletedSender: string | null;
        lastCompletedMessageId?: string | null;
        lastCompletedSeq: number | null;
        previousCompletedSender: string | null;
        previousCompletedMessageId?: string | null;
        agentStreak?: number;
      };
      // The GAD trajectory fan-out path doesn't run the channel policy annotate,
      // so agent-published rows lack the per-event `agentHops` annotation. The
      // policy's `agentStreak` (folded over every channel row, incl. fan-out) is
      // the equivalent hop count — use it as the fallback so the loop breaker
      // still fires for agent→agent chains.
      if (typeof conversation.agentStreak === "number") {
        agentStreakHops = conversation.agentStreak;
      }
      lastCompletedSender =
        conversation.lastCompletedSeq != null && conversation.lastCompletedSeq === event.id
          ? conversation.previousCompletedSender
          : conversation.lastCompletedSender;
      lastCompletedMessageId =
        conversation.lastCompletedSeq != null && conversation.lastCompletedSeq === event.id
          ? (conversation.previousCompletedMessageId ?? null)
          : (conversation.lastCompletedMessageId ?? null);
      if (
        config?.["conversationPolicy"] === "open" ||
        config?.["conversationPolicy"] === "directed" ||
        config?.["conversationPolicy"] === "moderated"
      ) {
        conversationPolicy = config["conversationPolicy"];
      }
      if (typeof config?.["agentHopLimit"] === "number") {
        agentHopLimit = config["agentHopLimit"];
      }
      participantIds = participants.map((participant) => participant.participantId);
      respondParticipants = participants;
      if (payload.replyTo) {
        replyToSenderId =
          (await channel.getMessageSender(this.participantId(), payload.replyTo)) ??
          (payload.replyTo === lastCompletedMessageId
            ? (lastCompletedSender ?? undefined)
            : undefined);
      }
    } catch {
      /* addressing degrades gracefully without channel state */
    }
    const settings = this.getAgentSettings();
    // respondFrom is per-agent: resolve handle entries to this channel's ids.
    const respondFrom = resolveRespondFromHandles(settings.respondFrom, respondParticipants);
    const decision = resolveShouldRespond({
      event: {
        senderParticipantId: event.senderId,
        senderKind: agentic.actor?.kind ?? "user",
        mentions: payload.mentions,
        replyTo: payload.replyTo,
        replyToSenderId,
        to: payload.to,
        agentHops: (event.annotations?.["agentHops"] as number | undefined) ?? agentStreakHops,
      },
      self: { participantId: this.participantId() },
      policy: settings.respondPolicy,
      respondFrom,
      participantIds,
      lastCompletedSender,
      conversationPolicy,
      agentHopLimit,
    });
    return decision.respond;
  }

  /** roster.snapshot details are class-INLINE (the fold reads them; there is
   *  no implicit spill, oversize is a hard encode error) — so this emitter
   *  bounds what panels advertise: descriptions are truncated, oversized
   *  parameter JSON-Schemas are dropped (the method stays callable; the
   *  model just loses its schema). */
  private static readonly MAX_ROSTER_DESCRIPTION_CHARS = 2_000;
  private static readonly MAX_ROSTER_PARAMETERS_BYTES = 16 * 1024;

  private boundedRosterMethod(method: {
    name: string;
    description?: string;
    parameters?: unknown;
  }): { name: string; description?: string; parameters?: unknown } {
    const description =
      typeof method.description === "string"
        ? method.description.slice(0, AgentVesselBase.MAX_ROSTER_DESCRIPTION_CHARS)
        : undefined;
    let parameters = method.parameters;
    if (parameters !== undefined) {
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(parameters)).byteLength;
        if (bytes > AgentVesselBase.MAX_ROSTER_PARAMETERS_BYTES) {
          console.warn(
            `[Vessel] dropping oversized parameter schema for roster method ` +
              `${method.name} (${bytes} bytes > ${AgentVesselBase.MAX_ROSTER_PARAMETERS_BYTES})`
          );
          parameters = undefined;
        }
      } catch {
        parameters = undefined;
      }
    }
    return {
      name: method.name,
      ...(description !== undefined ? { description } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
    };
  }

  /** Roster changes enter the log as events (nondeterministic I/O → journal).
   *  Returns true when a fresh snapshot was appended (roster actually changed). */
  private async maybeRefreshRoster(channelId: string): Promise<boolean> {
    try {
      const participants = await this.getCachedParticipants(channelId);
      const roster: RosterEntry[] = participants
        .filter((participant) => participant.participantId !== this.participantId())
        .map((participant) => ({
          participantId: participant.participantId,
          ref: {
            kind: "panel",
            id: participant.participantId,
            participantId: participant.participantId,
          } as ParticipantRef,
          handle:
            typeof participant.metadata?.["handle"] === "string"
              ? (participant.metadata["handle"] as string)
              : undefined,
          type:
            typeof participant.metadata?.["type"] === "string"
              ? (participant.metadata["type"] as string)
              : undefined,
          methods: Array.isArray(participant.metadata?.["methods"])
            ? (
                participant.metadata["methods"] as Array<{
                  name?: string;
                  description?: string;
                  parameters?: unknown;
                }>
              )
                .filter((method) => typeof method?.name === "string")
                .map((method) =>
                  this.boundedRosterMethod(method as { name: string } & typeof method)
                )
            : [],
        }));
      const fingerprint = JSON.stringify(roster);
      if (this.getStateValue(`agent:roster:${channelId}`) === fingerprint) return false;
      const loop = await this.driver.loop(channelId);
      const envelope = await this.appendRosterSnapshot(loop.state, channelId, roster);
      await this.driver.handleIncoming(channelId, {
        type: "event-appended",
        envelope: envelope as never,
      });
      this.setStateValue(`agent:roster:${channelId}`, fingerprint);
      return true;
    } catch {
      /* roster refresh is best-effort */
      return false;
    }
  }

  private async getCachedChannelConfig(channelId: string): Promise<Record<string, unknown> | null> {
    const now = Date.now();
    const cached = this.channelConfigCache.get(channelId);
    if (cached && cached.expiresAt > now) return cached.value;
    const value =
      (await this.createChannelClient(channelId).getConfig()) ??
      (this.subscriptions.getConfig(channelId) as Record<string, unknown> | null) ??
      null;
    this.channelConfigCache.set(channelId, { value, expiresAt: now + CHANNEL_STATE_CACHE_MS });
    return value;
  }

  private async getCachedParticipants(
    channelId: string
  ): Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>> {
    const now = Date.now();
    const cached = this.participantCache.get(channelId);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await this.createChannelClient(channelId).getParticipants();
    this.participantCache.set(channelId, { value, expiresAt: now + CHANNEL_STATE_CACHE_MS });
    return value;
  }

  private async appendRosterSnapshot(
    state: AgentState,
    channelId: string,
    roster: RosterEntry[]
  ): Promise<unknown> {
    const result = await this.callGad<{ envelopes: unknown[] }>("appendLogEvent", {
      logId: state.logId,
      head: state.head,
      logKind: "trajectory",
      events: [
        {
          envelopeId: ids.systemEvent(channelId, "roster", state.lastSeq),
          actor: { kind: "agent", id: this.participantId() },
          payloadKind: "system.event",
          payload: {
            protocol: "agentic.trajectory.v1",
            kind: "roster.snapshot",
            details: { kind: "roster.snapshot", roster: { participants: roster } },
          },
        },
      ],
    });
    return result.envelopes[result.envelopes.length - 1];
  }

  // ── Method calls (agent as PROVIDER) ─────────────────────────────────────

  @rpc({
    principals: ["code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async onMethodCall(
    channelId: string,
    _transportCallId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean }> {
    this.assertChannelDeliveryCaller("onMethodCall");
    return (
      (await this.handleStandardAgentMethodCall(channelId, methodName, args)) ?? {
        result: { error: `unknown method: ${methodName}` },
        isError: true,
      }
    );
  }

  /**
   * Operational, activation-local inspection for a channel or the host.
   *
   * This is deliberately separate from `onMethodCall`: inspection is not an
   * agent action and must not enter participant invocation routing. Every read
   * below is in-memory or local SQLite; missing folded state remains explicitly
   * missing instead of being hydrated through GAD.
   */
  @rpc({
    principals: ["host"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  async readAgentInspection(
    channelId: string,
    methodName: string
  ): Promise<{ result: unknown; isError?: boolean }> {
    this.assertChannelDeliveryCaller("readAgentInspection");
    if (!isAgentInspectionMethod(methodName)) {
      throw new Error(
        `readAgentInspection: unsupported method ${methodName}; expected one of ` +
          AGENT_INSPECTION_METHODS.join(", ")
      );
    }
    return this.readStandardAgentInspection(channelId, methodName);
  }

  private readStandardAgentInspection(
    channelId: string,
    methodName: AgentInspectionMethod
  ): { result: unknown; isError?: boolean } {
    switch (methodName) {
      case "getDebugState":
        return { result: this.activationDebugState(channelId) };
      case "getAgentSettings":
        return { result: this.inspectAgentSettings() };
      case "inspectMethodSuspensions":
        return { result: { outbox: inspectEffectOutbox(this.sql) } };
    }
  }

  /**
   * Journal-derived model route/usage evidence for headless orchestration.
   * This direct RPC remains available when channel presence has already gone
   * stale, which is precisely when timeout/cancellation diagnostics need it.
   * The response contains no prompt, tool argument, credential, or secret.
   */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  async getModelExecutionEvidence(channelId: string): Promise<unknown> {
    const evidence = await this.driver.modelExecutionEvidence(channelId);
    return { ...evidence, transportRuntime: modelTransportRuntimeEvidence() };
  }

  /** Direct lifecycle barrier for non-interactive owners. Unlike the chat
   * `pause` method this does not require the controller to remain a channel
   * member while cancellation is already unwinding that membership. */
  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async interruptChannel(channelId: string): Promise<{ interrupted: true }> {
    await this.driver.interruptChannel(channelId, false);
    return { interrupted: true };
  }

  protected async handleStandardAgentMethodCall(
    channelId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean } | null> {
    if (!this.isParticipantMethodEnabled(methodName)) return null;
    if (isAgentInspectionMethod(methodName)) {
      return this.readStandardAgentInspection(channelId, methodName);
    }
    switch (methodName) {
      case "pause": {
        const flushDeferred = (args as { flushDeferred?: unknown } | null)?.flushDeferred === true;
        await this.driver.interruptChannel(channelId, flushDeferred);
        return { result: { paused: true } };
      }
      case "cancelEval": {
        // The chat-panel pill cancels a SERVER-SIDE eval run by asking THIS agent
        // (the eval's owner, subKey = channelId) to cancel it. The agent calls
        // eval.cancel for itself — the eval service resolves the owner from the
        // caller, so the panel cannot address another owner's EvalDO. The UI
        // supplies the journaled invocation coordinate; this trusted owner
        // derives the distinct eval-effect coordinate used as the run id.
        const invocationId = (args as { invocationId?: unknown } | null)?.invocationId;
        if (typeof invocationId !== "string" || invocationId.length === 0) {
          return { result: { error: "cancelEval requires an invocationId" }, isError: true };
        }
        const runId = ids.invocationEffect(invocationId);
        try {
          const result = await this.rpc.call<{ ok: boolean }>("main", "eval.cancel", [
            { subKey: channelId, runId },
          ]);
          return { result };
        } catch (err) {
          return {
            result: { error: err instanceof Error ? err.message : String(err) },
            isError: true,
          };
        }
      }
      case "resume": {
        await this.driver.wake(channelId);
        return { result: { resumed: true } };
      }
      case "scheduleResumeAtReset": {
        const result = await this.driver.scheduleResumeAtReset(
          channelId,
          (args ?? {}) as { messageId?: unknown; resetAt?: unknown }
        );
        return { result, isError: result.scheduled !== true };
      }
      case "connectModelCredential": {
        const input = (args ?? {}) as {
          providerId?: string;
          modelRef?: string;
          browserOpenMode?: string;
          modelBaseUrl?: string;
          browserHandoffCallerId?: string;
          browserHandoffCallerKind?: string;
        };
        if (!input.providerId) {
          return { result: { error: "connectModelCredential requires providerId" }, isError: true };
        }
        const setup = this.getModelCredentialSetupProps(input.providerId);
        if (!setup) {
          return {
            result: { error: `no credential setup for provider ${input.providerId}` },
            isError: true,
          };
        }
        const browser = normalizeBrowserOpenMode(input.browserOpenMode);
        const request = toCredentialConnectRequest(input.providerId, { browser });
        if (!request) {
          return {
            result: { error: `no credential connect request for provider ${input.providerId}` },
            isError: true,
          };
        }
        const handoffTarget = normalizeBrowserHandoffTarget(input);
        const connectParams: ConnectCredentialRequest | ConnectCredentialEnvelope = handoffTarget
          ? { spec: request, handoffTarget }
          : request;
        const credential = await this.rpc.call<Record<string, unknown>>(
          "main",
          "credentials.connect",
          [connectParams]
        );
        return { result: credential };
      }
      case "credentialConnected": {
        const input = (args ?? {}) as { providerId?: string };
        const providerId = input.providerId ?? "";
        const effectId = ids.credentialWaitEffect(ids.credKey(channelId, providerId));
        // This is the only reconnect success path that resumes the waiting loop.
        const resumed = await this.driver.deliverEffectOutcome(
          effectId,
          {
            kind: "credential",
            resolved: true,
          } satisfies EffectOutcome,
          { channelId }
        );
        if (resumed) await this.driver.wake(channelId);
        return { result: { resumed } };
      }
      case "setModel": {
        const model = (args as { model?: unknown } | null)?.model;
        if (typeof model !== "string" || model.length === 0) {
          return {
            result: { error: "setModel requires model in provider:model format" },
            isError: true,
          };
        }
        return { result: this.updateSettings({ model }) };
      }
      case "setThinkingLevel": {
        const level = (args as { level?: unknown } | null)?.level;
        if (
          level !== "minimal" &&
          level !== "low" &&
          level !== "medium" &&
          level !== "high" &&
          level !== "xhigh" &&
          level !== "max"
        ) {
          return {
            result: {
              error: "setThinkingLevel requires level: minimal, low, medium, high, xhigh, or max",
            },
            isError: true,
          };
        }
        return { result: this.updateSettings({ thinkingLevel: level }) };
      }
      case "setApprovalLevel": {
        const level = (args as { level?: unknown } | null)?.level;
        if (level !== 0 && level !== 1 && level !== 2) {
          return {
            result: { error: "setApprovalLevel requires level: 0, 1, or 2" },
            isError: true,
          };
        }
        return { result: this.updateSettings({ approvalLevel: level }) };
      }
      case "setRespondPolicy": {
        const input = args as { policy?: unknown; from?: unknown } | null;
        if (!isRespondPolicy(input?.policy)) {
          return {
            result: {
              error:
                "setRespondPolicy requires policy: all, mentioned, mentioned-strict, mentioned-or-followup, or from-participants",
            },
            isError: true,
          };
        }
        const from = Array.isArray(input?.from)
          ? input.from.filter((id): id is string => typeof id === "string")
          : undefined;
        return {
          result: this.updateSettings({
            respondPolicy: input.policy,
            ...(from !== undefined ? { respondFrom: from } : {}),
          }),
        };
      }
      case "refreshPromptArtifacts": {
        this.invalidatePromptResources(channelId);
        await this.ensurePromptArtifacts(channelId);
        return {
          result: {
            refreshed: true,
            systemPromptHash: this.getStateValue(`agent:promptHash:${channelId}`),
            toolSchemasHash: this.getStateValue(`agent:toolsHash:${channelId}`),
          },
        };
      }
      case "getModelExecutionEvidence":
        return { result: await this.driver.modelExecutionEvidence(channelId) };
      default:
        return null;
    }
  }

  // ── chat proxy for server-side eval (chatOp) ─────────────────────────────

  /**
   * Forwarded channel operation from THIS agent's own EvalDO sandbox `chat`
   * binding. The EvalDO can only publish as its own non-agent identity and
   * cannot receive a delivered method result, so it relays every
   * `ChatSandboxValue` op here and we perform it AS the agent (correct @agent
   * attribution) using our existing channel machinery. Return values mirror
   * `ChatSandboxValue`'s.
   *
   * Auth: the caller MUST be this agent's own EvalDO. We re-derive that DO's
   * objectKey the SAME way evalService does — sha256(ownerId + "\\0" + subKey),
   * hex, first 40 chars — and require the verified caller id to be
   * `do:vibestudio/internal:EvalDO:<key>`. Any other caller is rejected; the
   * generic DO relay is open, so a sensitive receiver gates on receipt.
   */
  @rpc({
    principals: ["code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async chatOp(channelId: string, op: string, args: unknown[]): Promise<unknown> {
    await this.assertOwnEvalCaller(channelId);
    const channel = this.createChannelClient(channelId);
    const participantId = this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const a = args ?? [];

    switch (op) {
      case "publish": {
        const [eventType, payload, options] = a as [
          string,
          unknown,
          { idempotencyKey?: string } | undefined,
        ];
        const target = await this.channelTarget(channelId);
        return this.rpc.call(target, "publish", [
          participantId,
          eventType,
          payload,
          options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
        ]);
      }
      case "send": {
        const [content, options] = a as [string, { idempotencyKey?: string } | undefined];
        const messageId = options?.idempotencyKey ?? crypto.randomUUID();
        const descriptor = this.getEffectiveParticipantInfo(
          channelId,
          this.subscriptions.getConfig(channelId)
        );
        await channel.send(participantId, messageId, content, {
          senderMetadata: { type: "agent", name: descriptor.name, handle: descriptor.handle },
          ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        });
        return undefined;
      }
      case "publishCustomMessage": {
        const [input, options] = a as [
          { typeId: string; initialState?: unknown; displayMode?: CustomMessageDisplayMode },
          { idempotencyKey?: string } | undefined,
        ];
        // create() mints a fresh card identity (random natural key), publishing
        // custom.started as the agent. The handle carries the pubsubId of that
        // started event — matching the panel client's { messageId, pubsubId }.
        const handle = await this.cards.create(channelId, input.typeId, input.initialState, {
          ...(input.displayMode ? { displayMode: input.displayMode } : {}),
          ...(options?.idempotencyKey ? { key: options.idempotencyKey } : {}),
        });
        return { messageId: handle.messageId, pubsubId: handle.pubsubId };
      }
      case "updateCustomMessage": {
        const [messageId, update] = a as [string, unknown];
        const handle = this.cards.get(channelId, messageId);
        if (!handle) {
          throw new Error(`updateCustomMessage: no card ${messageId} on channel ${channelId}`);
        }
        // Resolves to the pubsubId of the custom.updated event (number | undefined).
        return handle.update(update);
      }
      case "registerMessageType": {
        const [input] = a as [RegisterMessageTypeInput, { idempotencyKey?: string } | undefined];
        const idempotencyKey = (a[1] as { idempotencyKey?: string } | undefined)?.idempotencyKey;
        return this.publishMessageTypeRegistered(channelId, participantId, input, idempotencyKey);
      }
      case "clearMessageType": {
        const [typeId] = a as [string, { idempotencyKey?: string } | undefined];
        const idempotencyKey = (a[1] as { idempotencyKey?: string } | undefined)?.idempotencyKey;
        return this.publishMessageTypeCleared(channelId, participantId, typeId, idempotencyKey);
      }
      case "getMessageType": {
        const [typeId] = a as [string];
        return channel.getMessageType(typeId);
      }
      case "getMessageTypes":
        return channel.getMessageTypes();
      case "replayEnvelope": {
        const [envelopeId] = a as [string];
        if (typeof envelopeId !== "string" || envelopeId.length === 0) return null;
        return channel.getEnvelope(envelopeId);
      }
      case "callMethod": {
        const [targetPid, method, callArgs, options] = a as [
          string,
          string,
          unknown,
          { timeoutMs?: number } | undefined,
        ];
        const result = await this.relayChannelCall(channelId, targetPid, method, callArgs, options);
        return result.content;
      }
      case "callMethodResult": {
        const [targetPid, method, callArgs, options] = a as [
          string,
          string,
          unknown,
          { timeoutMs?: number } | undefined,
        ];
        return this.relayChannelCall(channelId, targetPid, method, callArgs, options);
      }
      case "participantByHandle": {
        const [handle] = a as [string];
        return this.resolveParticipantByHandle(channelId, handle);
      }
      case "callMethodByHandle": {
        const [handle, method, callArgs, options] = a as [
          string,
          string,
          unknown,
          { timeoutMs?: number } | undefined,
        ];
        const target = await this.requireParticipantByHandle(channelId, handle);
        const result = await this.relayChannelCall(channelId, target.id, method, callArgs, options);
        return result.content;
      }
      case "callMethodResultByHandle": {
        const [handle, method, callArgs, options] = a as [
          string,
          string,
          unknown,
          { timeoutMs?: number } | undefined,
        ];
        const target = await this.requireParticipantByHandle(channelId, handle);
        return this.relayChannelCall(channelId, target.id, method, callArgs, options);
      }
      case "focusMessage":
        // Panel-only DOM scroll; no server-side equivalent.
        return false;
      // ── agent self-management (the eval `agent` binding) ──────────────────
      case "describeSelf":
        return this.describeSelf(channelId);
      case "configureAgent":
        return this.configureAgent((a[0] ?? {}) as Record<string, unknown>);
      default:
        throw new Error(`chatOp: unknown op ${op}`);
    }
  }

  /** Re-derive this agent's own EvalDO objectKey (matching evalService's
   *  formula EXACTLY: sha256(`${ownerId}\0${subKey}`) hex, first 40 chars; owner
   *  = this agent's runtime id, subKey = channelId) and require the verified
   *  caller to be that EvalDO. */
  private async assertOwnEvalCaller(channelId: string): Promise<void> {
    const callerId = this.rpcCallerId;
    const expectedKey = sha256HexSyncText(`${this.participantId()}\0${channelId}`);
    const expectedCaller = `do:vibestudio/internal:EvalDO:${expectedKey.slice(0, 40)}`;
    if (callerId !== expectedCaller) {
      throw new Error(
        `chatOp: refusing caller ${callerId ?? "unknown"} — only this agent's own EvalDO may forward chat ops`
      );
    }
  }

  /** Server-stamped settlement (`onEvalComplete`, `onDeferredResult`): the
   *  server dispatches these via doDispatch / callTarget as callerKind
   *  "server". The DO relay is open, so without this any authenticated caller
   *  could forge an eval/deferred completion and drive the agent loop. */
  private assertServerCaller(method: string): void {
    if (this.rpcCallerKind !== "server") {
      throw new Error(
        `${method}: refusing caller ${this.rpcCallerId ?? "unknown"} (kind ${this.rpcCallerKind ?? "unknown"}) — server-only`
      );
    }
  }

  /** The channel→agent delivery boundary. Effect terminals (`deliverEffectOutcome`),
   *  structured channel envelopes (`onChannelEnvelope`), and method dispatch
   *  (`onMethodCall`) arrive from exactly two legitimate sources: the server
   *  (http_call / credential callbacks, kind "server") and the agent's PubSubChannel
   *  DO (a "do" caller whose id names PubSubChannel). Refuse anything else — the open
   *  relay otherwise lets a panel, a worker, or ANOTHER agent forge channel traffic /
   *  tool outcomes into the loop. callerId is server-authenticated, so the className
   *  segment cannot be spoofed. */
  private assertChannelDeliveryCaller(method: string): void {
    const kind = this.rpcCallerKind;
    if (kind === "server") return;
    const callerId = this.rpcCallerId ?? "";
    if (kind === "do" && callerId.includes(":PubSubChannel:")) return;
    throw new Error(
      `${method}: refusing caller ${callerId || "unknown"} (kind ${kind ?? "unknown"})`
    );
  }

  /** Publish a messageType.registered event AS the agent (mirrors the ui-install
   *  publisher + the panel client) and invalidate the CardManager type cache. */
  private async publishMessageTypeRegistered(
    channelId: string,
    participantId: string,
    input: RegisterMessageTypeInput,
    idempotencyKey?: string
  ): Promise<number | undefined> {
    // Self-gate: this helper is independently RPC-exposed (collectExposableMethods
    // reflects every method) over the open DO relay, so chatOp's assertOwnEvalCaller
    // is bypassable by addressing it directly. Only this agent's own EvalDO may act
    // as the agent.
    await this.assertOwnEvalCaller(channelId);
    const actor = this.cardActor(channelId, participantId);
    const event: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: input.typeId,
        displayMode: input.displayMode,
        source: input.source,
        ...(input.imports !== undefined ? { imports: input.imports } : {}),
        ...(input.stateSchema !== undefined ? { stateSchema: input.stateSchema } : {}),
        ...(input.updateSchema !== undefined ? { updateSchema: input.updateSchema } : {}),
        registeredBy: actor,
      },
      createdAt: new Date().toISOString(),
    };
    const res = await this.createChannelClient(channelId).publishAgenticEvent(
      participantId,
      event,
      {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        senderMetadata: actor.metadata,
      }
    );
    this.cards.invalidateType(channelId, input.typeId);
    return res.id;
  }

  /** Publish a messageType.cleared tombstone AS the agent + invalidate cache. */
  private async publishMessageTypeCleared(
    channelId: string,
    participantId: string,
    typeId: string,
    idempotencyKey?: string
  ): Promise<number | undefined> {
    await this.assertOwnEvalCaller(channelId); // direct-call gate — see publishMessageTypeRegistered
    const actor = this.cardActor(channelId, participantId);
    const event: AgenticEvent<"messageType.cleared"> = {
      kind: "messageType.cleared",
      actor,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, typeId },
      createdAt: new Date().toISOString(),
    };
    const res = await this.createChannelClient(channelId).publishAgenticEvent(
      participantId,
      event,
      {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        senderMetadata: actor.metadata,
      }
    );
    this.cards.invalidateType(channelId, typeId);
    return res.id;
  }

  private cardActor(
    channelId: string,
    participantId: string
  ): ActorRef & { participantId?: string; metadata?: Record<string, unknown> } {
    const descriptor = this.getEffectiveParticipantInfo(
      channelId,
      this.subscriptions.getConfig(channelId)
    );
    return {
      kind: "agent",
      id: participantId,
      displayName: descriptor.name,
      participantId,
      metadata: { type: "agent", name: descriptor.name, handle: descriptor.handle },
    };
  }

  /** Resolve a participant by handle ("handle" or "@handle") from the channel
   *  roster. Returns the raw participant record (id + metadata) or null. */
  private async resolveParticipantByHandle(
    channelId: string,
    rawHandle: string
  ): Promise<{ id: string; metadata: Record<string, unknown> } | null> {
    const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
    const participants = await this.getCachedParticipants(channelId);
    const match = participants.find((p) => p.metadata?.["handle"] === handle);
    return match ? { id: match.participantId, metadata: match.metadata } : null;
  }

  private async requireParticipantByHandle(
    channelId: string,
    rawHandle: string
  ): Promise<{ id: string; metadata: Record<string, unknown> }> {
    const participant = await this.resolveParticipantByHandle(channelId, rawHandle);
    if (!participant) {
      const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
      throw new Error(`No participant with handle @${handle}`);
    }
    return participant;
  }

  /**
   * Initiate a channel method call AS the agent and resolve to the DELIVERED
   * result. The channel broadcasts the durable invocation terminal back to us
   * (the caller); settleChatOpCall matches it by transportCallId and resolves
   * the promise registered here. Loop-independent (does not touch the
   * effect-outbox) so the eval relay returns the result inline.
   */
  private async relayChannelCall(
    channelId: string,
    targetPid: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number }
  ): Promise<{ content: unknown }> {
    await this.assertOwnEvalCaller(channelId); // direct-call gate — see publishMessageTypeRegistered
    const callId = crypto.randomUUID();
    const timeoutMs = options?.timeoutMs;
    const settled = new Promise<{ content: unknown }>((resolve, reject) => {
      const entry: {
        resolve: (value: { content: unknown }) => void;
        reject: (error: Error) => void;
        responderSessionId: string;
        timer?: ReturnType<typeof setTimeout>;
      } = { resolve, reject, responderSessionId: targetPid };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.chatOpPendingCalls.delete(callId)) {
            reject(new Error(`chat.callMethod(${method}) timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      this.chatOpPendingCalls.set(callId, entry);
    });
    try {
      await this.createChannelClient(channelId).callMethod(
        this.participantId(),
        targetPid,
        callId,
        method,
        args,
        {
          invocationId: callId,
          transportCallId: callId,
          ...(timeoutMs && timeoutMs > 0 ? { timeoutMs } : {}),
        }
      );
    } catch (err) {
      const entry = this.chatOpPendingCalls.get(callId);
      if (entry?.timer) clearTimeout(entry.timer);
      this.chatOpPendingCalls.delete(callId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return settled;
  }

  /** Settle a pending chatOp relay call from a channel invocation terminal.
   *  Returns true when the event settled (or was a non-terminal phase of) one
   *  of our relay calls — so processChannelEvent stops routing it further. */
  private async settleChatOpCall(channelId: string, event: ChannelEvent): Promise<boolean> {
    if (this.chatOpPendingCalls.size === 0) return false;
    const agentic = event.payload as AgenticEvent | null;
    const kind = (agentic as { kind?: string } | null)?.kind ?? "";
    if (!kind.startsWith("invocation.")) return false;
    const causality = ((agentic as { causality?: Record<string, unknown> })?.causality ??
      {}) as Record<string, unknown>;
    const transportCallId =
      typeof causality["transportCallId"] === "string"
        ? (causality["transportCallId"] as string)
        : typeof causality["invocationId"] === "string"
          ? (causality["invocationId"] as string)
          : null;
    if (!transportCallId) return false;
    const entry = this.chatOpPendingCalls.get(transportCallId);
    if (!entry) return false;
    if (!AgentVesselBase.INVOCATION_TERMINAL_KINDS.has(kind)) {
      // started/output for our own relay call — consume but keep waiting.
      return true;
    }
    this.chatOpPendingCalls.delete(transportCallId);
    if (entry.timer) clearTimeout(entry.timer);
    const payload = ((agentic as { payload?: Record<string, unknown> })?.payload ?? {}) as Record<
      string,
      unknown
    >;
    if (kind === "invocation.completed") {
      // Hydrate any stored-value refs the provider spilled, then resolve with
      // the delivered content (ChatMethodResult shape). hydrate is async; the
      // settle hook stays sync by resolving inside the promise chain.
      void this.recordMessageIngestion(channelId, event, "chat-method-result")
        .then(() =>
          this.hydrateTransportValue(
            payload["result"],
            entry.responderSessionId,
            "chat-method-result"
          )
        )
        .then(
          (content) => entry.resolve({ content }),
          (err) => entry.reject(err instanceof Error ? err : new Error(String(err)))
        );
    } else {
      const reason = payload["error"] ?? payload["reason"] ?? payload["result"] ?? null;
      const message =
        typeof reason === "string" && reason.length > 0
          ? reason
          : reason &&
              typeof reason === "object" &&
              typeof (reason as { error?: unknown }).error === "string"
            ? (reason as { error: string }).error
            : `chat.callMethod failed (${kind})`;
      entry.reject(new Error(message));
    }
    return true;
  }

  /** Channel DO settle path: terminals for our channel_call effects POST back
   *  here. Duplicate delivery is a no-op (deterministic terminal ids). */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async deliverEffectOutcome(
    effectId: string,
    outcome: EffectOutcome,
    address?: { branchId?: string; channelId?: string }
  ): Promise<void> {
    this.assertChannelDeliveryCaller("deliverEffectOutcome");
    await this.driver.deliverEffectOutcome(effectId, outcome, address);
  }

  /** Inbound completion of a server-deferred RPC (CAP-5). The requestId is the
   *  branch-scoped outbox id set by the http port's callDeferred, so duplicate
   *  delivery no-ops once the row is gone. Eviction between defer and delivery
   *  is healed by lease-expiry redrive: the retried call re-attaches via its
   *  idempotencyKey / already-granted capability. */
  @rpc({
    principals: ["host"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async onDeferredResult(payload: {
    requestId: string;
    result?: unknown;
    isError?: boolean;
  }): Promise<void> {
    this.assertServerCaller("onDeferredResult");
    await this.driver.deliverDeferredResult(
      payload.requestId,
      payload.result ?? null,
      payload.isError === true
    );
  }

  /**
   * The deferral half of the agent's `eval` tool. Kicks off a durable background run (`eval.startRun`,
   * idempotent on a deterministic effect id derived from `invocationId`, while keeping that run id
   * distinct from authorship. Crash-replay / deferRedrive therefore never duplicates the eval. It
   * returns `{deferred:true}` while in flight. The result normally
   * arrives directly from this agent's own EvalDO; if that was lost, a ~60s deferRedrive re-runs this and the
   * `getRun` poll completes the invocation INLINE (`done` → result, `cancelled` → error).
   */
  protected async runDeferredEval(
    channelId: string,
    invocationId: string,
    args: unknown,
    scopedRpc: RpcClient
  ): Promise<{ deferred: true } | { result: unknown; isError: boolean }> {
    const runId = ids.invocationEffect(invocationId);
    const p = (args ?? {}) as {
      code?: string;
      path?: string;
      sourcePath?: string;
      reset?: boolean;
      syntax?: "javascript" | "typescript" | "jsx" | "tsx";
      imports?: Record<string, string>;
      timeoutMs?: number;
    };
    let source;
    try {
      source = normalizeEvalToolSource(p);
    } catch (error) {
      return {
        result: `[eval] ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    await scopedRpc.call("main", "eval.startRun", [
      {
        subKey: channelId, // the agent's eval subKey IS its channelId
        reset: p.reset === true,
        ...source,
        syntax: p.syntax,
        imports: p.imports,
        timeoutMs: p.timeoutMs,
        runId,
      },
    ]);
    // `getRun` is a poll BACKSTOP, not the primary settle path — the run is already
    // in flight in its EvalDO (startRun succeeded). If the poll THROWS (a transient
    // RPC/store hiccup), do NOT surface it as the tool result: that would settle the
    // invocation with a spurious error AND drop the real eval result when the background
    // run later completes (the parked row would be gone). Instead PARK: return
    // `{deferred:true}` so the row stays leased for the `onEvalComplete` push (or the
    // ~60s deferRedrive, which re-polls) to settle. This keeps the run parked — it
    // never bounds the (legitimately long-running) eval.
    let status: { status: string; result?: EvalRunResult };
    try {
      status = await scopedRpc.call<{ status: string; result?: EvalRunResult }>(
        "main",
        "eval.getRun",
        [{ subKey: channelId, runId }]
      );
    } catch (err) {
      console.warn(
        `[AgentVessel] eval.getRun poll for ${runId} failed (run parked; push/redrive backstop covers it):`,
        err instanceof Error ? err.message : err
      );
      return { deferred: true };
    }
    if (status.status === "done" && status.result) {
      const formatted = formatEvalResult(status.result);
      const failure =
        status.result.success === true
          ? undefined
          : agentToolFailureFromUnknown(
              {
                message: status.result.error ?? "eval failed",
                code: status.result.failureCode,
                errorData: status.result.errorData,
              },
              {
                operation: "tool.eval",
                stage: "execute",
                causal: { invocationId },
                ...(status.result.failureKind === "infrastructure"
                  ? { kind: "infrastructure" as const }
                  : {}),
              }
            );
      return {
        result: { protocolContent: formatted.content, details: formatted.details },
        // Preserve the structured diagnostic, but do not lie about its
        // terminal outcome. A user-code exception is still a failed eval tool
        // invocation; callers (and the system-test harness) must be able to
        // distinguish it from a successful execution and explicitly classify
        // deliberate failures when appropriate.
        isError: status.result.success !== true,
        ...(status.result.failureKind === "infrastructure"
          ? { terminalOutcome: "infrastructure_error" as const }
          : {}),
        ...(failure ? { terminalReasonCode: failure.code, failure } : {}),
      };
    }
    if (status.status === "cancelled") {
      return { result: "[eval] run cancelled", isError: true };
    }
    return { deferred: true };
  }

  /**
   * Streamed eval console — the rolling-output sibling of `onEvalComplete`. The agent's eval runs in
   * a server-side EvalDO; during the run the EvalDO forwards buffered console chunks here (gated
   * by `assertOwnEvalCaller`, exactly like the `chat` binding's `chatOp` — only this agent's own
   * EvalDO may act as it). Each chunk is published as an `invocation.output` event keyed to the eval
   * parent tool invocation (`agentInvocationId`), independently of the eval effect's `runId`, so the
   * chat panel renders the console live AND persists it for the card's details view. Best-effort: a
   * dropped chunk is just a gap in the live console — the
   * final result still carries the full console text. Ordering: the EvalDO awaits its final flush
   * before completing, so every output precedes the `invocation.completed` terminal (the reducer drops
   * output after terminal).
   */
  @rpc({
    principals: ["code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async onEvalProgress(payload: {
    runId: string;
    agentInvocationId: string;
    channelId: string;
    output: string;
  }): Promise<void> {
    await this.assertOwnEvalCaller(payload.channelId);
    if (!payload.output) return;
    const participantId =
      this.subscriptions.getParticipantId(payload.channelId) ?? this.participantId();
    const actor = this.cardActor(payload.channelId, participantId);
    const event: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor,
      causality: { invocationId: payload.agentInvocationId as never },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, output: payload.output, channel: "stdout" },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(payload.channelId).publishAgenticEvent(participantId, event, {
      senderMetadata: actor.metadata,
    });
  }

  /**
   * Settle the exact eval effect addressed by `runId`. Parent invocation
   * identity is carried separately for causality and never reconstructed from
   * the effect id. Duplicate settlement is an idempotent driver no-op.
   */
  @rpc({
    principals: ["code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async onEvalComplete(payload: {
    runId: string;
    agentInvocationId?: string;
    result?: EvalRunResult;
    channelId?: string;
  }): Promise<void> {
    if (!payload.channelId || !payload.result) return;
    await this.assertOwnEvalCaller(payload.channelId);
    const formatted = formatEvalResult(payload.result);
    const failure =
      payload.result.success === true
        ? undefined
        : agentToolFailureFromUnknown(
            {
              message: payload.result.error ?? "eval failed",
              code: payload.result.failureCode,
              errorData: payload.result.errorData,
            },
            {
              operation: "tool.eval",
              stage: "execute",
              causal: { invocationId: payload.agentInvocationId ?? payload.runId },
              ...(payload.result.failureKind === "infrastructure"
                ? { kind: "infrastructure" as const }
                : {}),
            }
          );
    await this.driver.deliverEffectOutcome(
      payload.runId,
      {
        kind: "tool",
        result: { protocolContent: formatted.content, details: formatted.details },
        isError: payload.result.success !== true,
        ...(payload.result.failureKind === "infrastructure"
          ? { terminalOutcome: "infrastructure_error" as const }
          : {}),
        ...(failure ? { terminalReasonCode: failure.code, failure } : {}),
      },
      { channelId: payload.channelId }
    );
  }

  // ── Custom message recovery (CardManager read path) ─────────────────────

  /** Fold this agent's own custom messages from the channel log:
   *  Map<typeId, Map<messageId, state>> with card reducers applied. Used by
   *  card-owning agents to recover live card state after hibernation/fork. */
  protected async indexOwnCustomMessages(
    channelId: string,
    reducerLookup?: (typeId: string) => CustomMessageReducer | undefined | null
  ): Promise<Map<string, Map<string, unknown>>> {
    const selfParticipantId = this.subscriptions.getParticipantId(channelId);
    if (!selfParticipantId) return new Map();

    const byMessageId = new Map<string, { typeId: string; state: unknown }>();
    const channel = this.createChannelClient(channelId);
    for await (const envelope of iterateChannelReplayAfterPages(
      (request) => channel.getReplayAfter(request),
      { after: 0 }
    )) {
      const events = envelope.logEvents;
      for (const event of events) {
        if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
        const agentic = event.payload as {
          kind?: string;
          actor?: { id?: string; participantId?: string };
          payload?: Record<string, unknown>;
        } | null;
        const actor = agentic?.actor;
        if (actor?.participantId !== selfParticipantId && actor?.id !== selfParticipantId) {
          continue;
        }
        const payload = agentic?.payload ?? {};
        if (agentic?.kind === "custom.started") {
          const messageId = typeof payload["messageId"] === "string" ? payload["messageId"] : null;
          const typeId = typeof payload["typeId"] === "string" ? payload["typeId"] : null;
          if (!messageId || !typeId) continue;
          byMessageId.set(messageId, {
            typeId,
            state: await this.hydrateTransportValue(payload["initialState"]),
          });
          continue;
        }
        if (agentic?.kind === "custom.updated") {
          const messageId = typeof payload["messageId"] === "string" ? payload["messageId"] : null;
          if (!messageId) continue;
          const existing = byMessageId.get(messageId);
          if (!existing) continue;
          const reducer = reducerLookup?.(existing.typeId) ?? null;
          const update = await this.hydrateTransportValue(payload["update"]);
          byMessageId.set(messageId, {
            typeId: existing.typeId,
            state: reducer ? reducer(existing.state, update) : update,
          });
        }
      }
    }

    const byType = new Map<string, Map<string, unknown>>();
    for (const [messageId, { typeId, state }] of byMessageId.entries()) {
      let messages = byType.get(typeId);
      if (!messages) {
        messages = new Map();
        byType.set(typeId, messages);
      }
      messages.set(messageId, state);
    }
    return byType;
  }

  private async hydrateTransportValue(
    value: unknown,
    originSessionId?: string | null,
    via = "channel-value-hydration"
  ): Promise<unknown> {
    if (originSessionId) await this.recordDerivedSessionIngestion(originSessionId, via);
    return hydrateStoredValueRefs(value, {
      getText: (digest) => this.rpc.call<string | null>("main", "blobstore.getText", [digest]),
    });
  }

  /** Advance the monotone latch before indirect userland content is exposed to
   * prompt composition or a tool result. The server resolves the origin
   * session's persisted class; unknown origins conservatively become external. */
  private async recordDerivedSessionIngestion(originSessionId: string, via: string): Promise<void> {
    if (!originSessionId || originSessionId === this.participantId()) return;
    await this.rpc.call("main", "contextIntegrity.ingest", [
      { key: `session:${originSessionId}`, via, classification: "derived" },
    ]);
  }

  private async recordMessageIngestion(
    channelId: string,
    event: ChannelEvent,
    via: string
  ): Promise<void> {
    if (!channelId || !event.messageId) {
      throw new Error(`${via}: durable channel identity is required before content ingestion`);
    }
    await this.rpc.call("main", "contextIntegrity.ingest", [
      { key: `msg:${channelId}/${event.messageId}`, via, classification: "derived" },
    ]);
  }

  // ── Subclass conveniences ────────────────────────────────────────────────

  /** Whether a channel event is a client-authored completed message. */
  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    if (event.senderId === this.participantId()) return false;
    const agentic = event.payload as { kind?: string } | null;
    return agentic?.kind === "message.completed";
  }

  /** Plain-text turn input extracted from a channel event. */
  protected buildTurnInput(event: ChannelEvent): { content: string } {
    const agentic = event.payload as { payload?: { blocks?: unknown[] } } | null;
    const blocks = agentic?.payload?.blocks ?? [];
    const content = blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : ""
      )
      .filter(Boolean)
      .join("\n");
    return { content };
  }

  /** Journal an agent-initiated prompt (digest turns, onboarding nudges).
   *  `steeringId` keys the deterministic turn identity — re-submission with
   *  the same id is a replay no-op all the way down. */
  protected async submitAgentInitiatedTurn(
    channelId: string,
    input: { content: string },
    opts?: AgentInitiatedTurnOptions
  ): Promise<void> {
    const metadata: AgentTurnMetadata = {
      origin: opts?.origin ?? "agent-initiated",
      ...(opts?.contextPolicy ? { contextPolicy: opts.contextPolicy } : {}),
      ...(opts?.delivery ? { delivery: opts.delivery } : {}),
      ...(opts?.ackToken ? { ackToken: opts.ackToken } : {}),
      ...(opts?.silentOk !== undefined ? { silentOk: opts.silentOk } : {}),
    };
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: {
        kind: "prompt",
        channelId,
        source: { envelopeId: opts?.steeringId ?? `agent-init:${Date.now()}` },
        content: input.content,
        senderRef: { kind: "system", id: metadata.origin ?? "agent-initiated" },
        metadata,
      },
    });
  }

  /** Resolve the current model's API key (out-of-loop helpers like draft
   *  writers). When no credential is configured, publishes a connect-only
   *  credential card (resumeAfterConnect: false — one-shot flows have no
   *  parked turn to resume) and throws with the canonical message. */
  protected async resolveModelApiKey(
    channelId: string,
    opts?: { connectCard?: boolean }
  ): Promise<string> {
    const model = this.getAgentSettings().model;
    const providerId = model.includes(":") ? model.slice(0, model.indexOf(":")) : "anthropic";
    const modelId = model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
    try {
      const { getBuiltinModel: getModel } = await import("@earendil-works/pi-ai/providers/all");
      const registryModel = getModel(providerId as never, modelId as never) as
        | { baseUrl?: string }
        | undefined;
      const modelBaseUrl =
        typeof registryModel?.baseUrl === "string" ? registryModel.baseUrl : undefined;
      const resolved = await this.executorDeps().credentials.getApiKey({
        providerId,
        ...(modelBaseUrl ? { modelBaseUrl } : {}),
      });
      return resolved.apiKey;
    } catch (err) {
      if (err instanceof CredentialPendingError && opts?.connectCard !== false) {
        await this.publishCredentialConnectCard(channelId, providerId, {
          resumeAfterConnect: false,
        });
      }
      throw new Error(
        `No URL-bound model credential is configured for model provider: ${providerId}`
      );
    }
  }

  /** The credential-connect inline card (same renderer the chat panel ships). */
  protected async publishCredentialConnectCard(
    channelId: string,
    providerId: string,
    opts: { resumeAfterConnect: boolean; reason?: string }
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const cardId = `model-credential-${providerId}:${channelId}`;
    const event: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: { kind: "agent", id: participantId, displayName: participantId },
      payload: {
        protocol: "agentic.trajectory.v1",
        uiType: "inline",
        id: cardId,
        source: {
          type: "file",
          path: "workspace/packages/agentic-chat/components/ModelCredentialRequiredCard.tsx",
        },
        props: {
          providerId,
          modelRef: this.getAgentSettings().model,
          agentParticipantId: participantId,
          resumeAfterConnect: opts.resumeAfterConnect,
          ...(opts.reason ? { reason: opts.reason } : {}),
          ...(this.getModelCredentialSetupProps(providerId) ?? {}),
        },
      },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(channelId)
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: cardId,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((err) => {
        console.error(`[AgentVessel] credential card emit failed for ${providerId}:`, err);
      });
  }

  // ── Fork ─────────────────────────────────────────────────────────────────

  /** Per-channel fork preflight. Vets ONLY the named subscription (it must
   *  exist); a multi-channel agent forks the one channel and drops the rest in
   *  the clone (see {@link postClone}), so the old ≤1-subscription gate is gone. */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  async canFork(channelId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.subscriptions.getParticipantId(channelId)) {
      return { ok: false, reason: `no subscription for channel ${channelId}` };
    }
    return { ok: true };
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async postClone(
    _parentObjectKey: string,
    newChannelId: string,
    oldChannelId: string,
    forkPointPubsubId: number,
    // The clone's new context. A true context fork (`runtime.cloneContext`) lands
    // the clone in a fresh, isolated context; thread it so the agent's subscription
    // re-homes to it (the entity record is already in the new context).
    newContextId: string
  ): Promise<void> {
    if (!newContextId) throw new Error("postClone requires newContextId");
    // fix identity (cloneDO copied the parent's)
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey
    );
    const from = channelTrajectoryFor(oldChannelId);
    const to = channelTrajectoryFor(newChannelId);
    const atSeq = await this.resolveTrajectorySeqForChannelSeq(
      from.logId,
      oldChannelId,
      forkPointPubsubId
    );
    await this.callGad("forkLog", {
      fromLogId: from.logId,
      fromHead: from.head,
      toLogId: to.logId,
      toHead: to.head,
      atSeq,
    });
    const driver = this.driver;
    // caches: wiped, reconverge (P3)
    this.sql.exec(`DELETE FROM effect_outbox`);
    this.sql.exec(`DELETE FROM fold_cache`);
    this.subscriptions.rename(oldChannelId, newChannelId, newContextId);
    // Per-channel fork: the clone is a NEW entity and must NOT ghost-join the
    // parent's OTHER channels (cloneDO copied the whole subscriptions table).
    // Drop every subscription except the forked one — delete the local row and
    // the driver loop, but DO NOT call the channel DO to unsubscribe: the copied
    // rows still carry the PARENT's participantId, so an unsubscribe would evict
    // the parent from its own channels. This runs BEFORE driver.wake so the
    // driver never wakes a loop for a channel the clone no longer holds.
    for (const otherChannelId of this.subscriptions.listChannelIds()) {
      if (otherChannelId === newChannelId) continue;
      this.subscriptions.deleteSubscription(otherChannelId);
      driver.dropLoop(otherChannelId);
    }
    // Subclass fork cleanup/setup runs with the rename applied but BEFORE the
    // new channel is (re)subscribed, so subclasses can purge per-channel state
    // the clone copied and influence the upcoming subscribe.
    await this.onChannelForked({ oldChannelId, newChannelId, forkPointPubsubId });
    await this.subscribeChannel({
      channelId: newChannelId,
      // After rename, getContextId(newChannelId) reflects newContextId.
      contextId: this.subscriptions.getContextId(newChannelId),
      config: this.subscriptions.getConfig(newChannelId) ?? undefined,
      replay: false,
    });
    await driver.wake(newChannelId); // fork policy settles pre-cut pendings
  }

  private async resolveTrajectorySeqForChannelSeq(
    trajectoryLogId: string,
    channelId: string,
    channelSeq: number
  ): Promise<number> {
    const fork = await this.callGad<{ rows: Array<Record<string, unknown>> }>(
      "rawSql",
      `SELECT MAX(o.seq) AS seq
       FROM log_events ch
       JOIN log_events o
         ON o.log_id = ch.origin_log_id
        AND o.head = ch.origin_head
        AND o.envelope_id = ch.origin_envelope_id
       WHERE ch.log_id = ?
         AND ch.seq <= ?
         AND ch.origin_log_id = ?
         AND ch.origin_head = ?`,
      [channelId, channelSeq, trajectoryLogId, trajectoryLogId]
    );
    const seq = fork?.rows?.[0]?.["seq"];
    if (seq == null) return 0;
    const parsed = Number(seq);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid trajectory fork sequence for ${trajectoryLogId}: ${String(seq)}`);
    }
    return parsed;
  }

  /**
   * Re-root a FRESH child vessel's identity + trajectory from a parent agent's
   * trajectory at `seq` — the sibling of {@link postClone} for the
   * `spawn_subagent(mode:"fork")` path. No DO storage was cloned (the entity was
   * just created), so there is nothing to wipe: outbox/fold caches start empty.
   * The child boots knowing everything the parent knew at the fork point.
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async initFromTrajectoryFork(opts: {
    parentLogId: string;
    seq: number;
    taskChannelId: string;
    contextId: string;
    config?: unknown;
  }): Promise<{ ok: boolean; participantId: string }> {
    this.ensureIdentity();
    // Fix identity for parity with postClone (a fresh DO already has it correct).
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey
    );
    // `seq` is already a TRAJECTORY seq (the parent's folded head), not a channel
    // seq — no resolveTrajectorySeqForChannelSeq indirection needed.
    await this.ensureSubagentTaskTrajectoryFork({
      parentLogId: opts.parentLogId,
      parentSeq: opts.seq,
      taskChannelId: opts.taskChannelId,
    });
    // Subscribe to the task channel; the first task message drives the first turn
    // via the normal intake path (no explicit driver.wake here).
    return this.subscribeChannel({
      channelId: opts.taskChannelId,
      contextId: opts.contextId,
      config: opts.config,
      replay: false,
    });
  }

  // ── Subagents ──────────────────────────────────────────────────────────────

  /** This agent's own subagent identity (set in `STATE_ARGS.subagent` at spawn),
   *  or null for a top-level agent. Drives depth accounting + the child `complete`
   *  tool gate. */
  protected subagentIdentity(): SubagentIdentity | null {
    const stateArgs = this.env["STATE_ARGS"];
    const raw =
      stateArgs && typeof stateArgs === "object"
        ? (stateArgs as Record<string, unknown>)["subagent"]
        : undefined;
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Record<string, unknown>;
    if (
      typeof s["runId"] !== "string" ||
      typeof s["parentRef"] !== "string" ||
      typeof s["parentChannelId"] !== "string"
    ) {
      return null;
    }
    return {
      runId: s["runId"],
      parentRef: s["parentRef"],
      parentChannelId: s["parentChannelId"],
      parentContextId: typeof s["parentContextId"] === "string" ? s["parentContextId"] : "",
      depth: typeof s["depth"] === "number" ? s["depth"] : 0,
      mode: s["mode"] === "fork" || s["mode"] === "fresh" ? s["mode"] : undefined,
    };
  }

  /** True when this agent was spawned as a subagent (advertises `complete`). */
  protected isSubagent(): boolean {
    return this.subagentIdentity() !== null;
  }

  private currentSubagentDepth(): number {
    return this.subagentIdentity()?.depth ?? 0;
  }

  private toolText(
    text: string,
    details?: Record<string, unknown>
  ): AgentToolResult<Record<string, unknown>> {
    return { content: [{ type: "text", text }], details: details ?? {} };
  }

  private async trajectoryHeadSeq(channelId: string): Promise<number> {
    try {
      const loop = await this.driver.loop(channelId);
      return loop.state.lastSeq;
    } catch {
      return 0;
    }
  }

  private async ensureSubagentTaskTrajectoryFork(input: {
    parentLogId: string;
    parentSeq: number;
    taskChannelId: string;
  }): Promise<number> {
    const to = channelTrajectoryFor(input.taskChannelId);
    const existing = await this.callGad<{
      parentLogId: string | null;
      parentHead: string | null;
      forkSeq: number | null;
    } | null>("getLogHead", { logId: to.logId, head: to.head });
    const parentHead = input.parentLogId;
    const equivalentExisting =
      existing?.parentLogId === input.parentLogId &&
      existing.parentHead === parentHead &&
      existing.forkSeq != null;
    if (existing && !equivalentExisting) {
      throw new Error(
        `subagent task trajectory already exists with different fork lineage: ${to.logId}:${to.head}`
      );
    }
    const atSeq = equivalentExisting ? existing.forkSeq! : input.parentSeq;
    await this.callGad("forkLog", {
      fromLogId: input.parentLogId,
      fromHead: parentHead,
      toLogId: to.logId,
      toHead: to.head,
      atSeq,
    });
    return atSeq;
  }

  /**
   * Launch `spawn_subagent`. Mints the child context (deterministic under
   * `targetKey`) + child agent entity, explicitly creates the task trajectory
   * fork, wires the task channel (child subscribes, parent watches turn-final),
   * seeds the task, records the run + the parent-trajectory invocation card,
   * then returns a run handle.
   * Guarded by depth/fan-out. Any failure settles inline as a tool error.
   */
  protected async runDeferredSpawn(
    channelId: string,
    invocationId: string,
    args: unknown
  ): Promise<{ result: unknown; isError: boolean }> {
    try {
      const p = (args ?? {}) as {
        mode?: unknown;
        task?: unknown;
        source?: unknown;
        config?: unknown;
        label?: unknown;
        agentKind?: unknown;
      };
      const mode: "fresh" | "fork" = p.mode === "fork" ? "fork" : "fresh";
      const agentKind = normalizeSubagentAgentKind(p.agentKind);
      if (!agentKind) {
        return {
          result: "spawn_subagent agentKind must be 'pi' or a valid extension launcher id",
          isError: true,
        };
      }
      const task = typeof p.task === "string" ? p.task : "";
      if (mode === "fresh" && !task.trim()) {
        return { result: "spawn_subagent(mode:'fresh') requires a non-empty task", isError: true };
      }
      // External launchers receive their task out-of-process, so it must be
      // non-empty regardless of mode.
      if (agentKind !== "pi" && !task.trim()) {
        return {
          result: `spawn_subagent(agentKind:'${agentKind}') requires a non-empty task`,
          isError: true,
        };
      }
      // Idempotency: a re-driven spawn returns the SAME run handle.
      const existingRun = this.subagentRuns.get(invocationId);
      if (existingRun) {
        if (existingRun.status === "starting") {
          console.warn(`[AgentVessel] resetting stale starting subagent run ${existingRun.runId}`);
          await this.teardownRun(existingRun);
        } else {
          if (existingRun.status === "running" && task.trim()) {
            console.info(
              `[AgentVessel] retrying subagent seed for existing run ${existingRun.runId}`
            );
            await this.publishSubagentSeed(existingRun, task);
          }
          return {
            result: {
              protocolContent: [
                { type: "text", text: `subagent already exists: ${existingRun.runId}` },
              ],
              details: this.subagentRunDetails(existingRun),
            },
            isError: false,
          };
        }
      }

      const loopConfig = this.loopConfig(channelId);
      const maxDepth = loopConfig.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
      const maxConcurrent = loopConfig.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS;
      const childDepth = this.currentSubagentDepth() + 1;
      if (childDepth > maxDepth) {
        return { result: `subagent depth limit reached (max ${maxDepth})`, isError: true };
      }
      if (this.subagentRuns.countRunning() >= maxConcurrent) {
        return {
          result: `concurrent subagent limit reached (max ${maxConcurrent})`,
          isError: true,
        };
      }

      const runId = invocationId;
      const targetKey = `subagent:${runId}`;
      const taskChannelId = `task-${runId}`;
      const label =
        typeof p.label === "string" && p.label.trim()
          ? p.label
          : mode === "fork"
            ? "forked subagent"
            : "subagent";
      const requestedChildConfig =
        p.config && typeof p.config === "object"
          ? (p.config as Record<string, unknown>)
          : undefined;
      // A Pi subagent is a child of THIS agent, so its behavioral defaults
      // should be the parent's effective settings rather than whichever model
      // happens to be the worker-wide default. Besides being the unsurprising
      // product behavior, this keeps unattended/headless trees uniform: a
      // parent pinned to a model, approval posture, or stream watchdog cannot
      // silently spawn a differently configured child. Explicit child config
      // remains an override. External launcher config is provider-specific CLI
      // input, so it intentionally does not receive Pi settings.
      const parentChannelConfig =
        (this.subscriptions.getConfig(channelId) as Record<string, unknown> | null) ?? {};
      const inheritedPromptConfig = Object.fromEntries(
        ["systemPrompt", "systemPromptMode"].flatMap((key) =>
          parentChannelConfig[key] === undefined ? [] : [[key, parentChannelConfig[key]]]
        )
      );
      const childConfig =
        agentKind === "pi"
          ? {
              model: loopConfig.model,
              thinkingLevel: loopConfig.thinkingLevel,
              ...(loopConfig.fallbackModelRef
                ? { fallbackModel: loopConfig.fallbackModelRef }
                : {}),
              ...(loopConfig.fallbackThinkingLevel
                ? { fallbackThinkingLevel: loopConfig.fallbackThinkingLevel }
                : {}),
              ...(loopConfig.fallbackFailureCodes
                ? { fallbackOn: [...loopConfig.fallbackFailureCodes] }
                : {}),
              ...(loopConfig.fallbackScope ? { fallbackScope: loopConfig.fallbackScope } : {}),
              approvalLevel: loopConfig.approvalLevel,
              respondPolicy: loopConfig.respondPolicy,
              ...inheritedPromptConfig,
              ...(requestedChildConfig ?? {}),
            }
          : requestedChildConfig;
      const source =
        typeof p.source === "string" && p.source
          ? p.source
          : String(this.env["WORKER_SOURCE"] ?? "");
      const className =
        childConfig && typeof childConfig["className"] === "string"
          ? String(childConfig["className"])
          : String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name);
      if (!source) {
        return { result: "spawn_subagent could not resolve a child source", isError: true };
      }

      const parentContextId = this.subscriptions.getContextId(channelId);
      const ownerEntityId = this.participantId();
      const ownerRuntimeContextId = await this.rpc.call<string | null>(
        "main",
        "runtime.resolveContext",
        [ownerEntityId]
      );
      if (ownerRuntimeContextId && ownerRuntimeContextId !== parentContextId) {
        console.warn("[AgentVessel] spawn_subagent context mismatch", {
          channelId,
          invocationId,
          ownerEntityId,
          ownerRuntimeContextId,
          subscriptionContextId: parentContextId,
        });
        throw new Error(
          `spawn_subagent context mismatch: owner ${ownerEntityId} is registered in ` +
            `${ownerRuntimeContextId}, but channel ${channelId} is subscribed as ${parentContextId}`
        );
      }

      // External subagent target: the child is a linked external session driven
      // by an extension-owned headless process, not an in-process Pi child.
      if (agentKind !== "pi") {
        return await this.runExternalSubagentSpawn(agentKind, channelId, {
          runId,
          taskChannelId,
          label,
          task,
          mode,
          childDepth,
          parentContextId,
          ownerEntityId,
          // For external kinds `config` is launcher options (the extension
          // whitelists what its CLI supports — e.g. model/effort for claude-code).
          ...(childConfig ? { launcherOptions: childConfig } : {}),
        });
      }

      // 1) Child context (deterministic; runtime records the lifecycle edge).
      const { contextId } = await createSubagentContext(this.rpc, {
        parentContextId,
        ownerEntityId,
        targetKey,
      });

      // 2) Child agent entity in that context. createEntity derives parentId from
      //    the verified caller (this vessel) → the entity→entity edge lands.
      const childHandle = await createAgentEntity(this.rpc, {
        source,
        className,
        key: targetKey,
        contextId,
        agentChannelId: taskChannelId,
        config: childConfig,
        stateArgs: {
          subagent: {
            runId,
            mode,
            parentRef: ownerEntityId,
            parentChannelId: channelId,
            parentContextId,
            depth: childDepth,
          },
        },
      });

      // 3) Record the run BEFORE any wake so replay + teardown can find it.
      const now = Date.now();
      const run: SubagentRunRow = {
        runId,
        taskChannelId,
        parentContextId: parentContextId ?? null,
        childContextId: contextId,
        childEntityId: childHandle.id ?? childHandle.targetId,
        childParticipantId: null,
        parentChannelId: channelId,
        mode,
        label,
        depth: childDepth,
        status: "starting",
        integration: null,
        startedAt: now,
        lastActivityAt: now,
        agentKind: "pi",
        externalSessionEntityId: null,
      };
      this.subagentRuns.insert(run);

      // 4) For forked subagents, the spawn orchestrator creates the task
      // trajectory fork before ANY task-channel participant subscribes. That
      // keeps observer-side roster/presence bookkeeping from claiming the task
      // trajectory as a root log.
      const parentLogId = logIdForChannel(channelId);
      const parentSeq = mode === "fork" ? await this.trajectoryHeadSeq(channelId) : 0;
      if (mode === "fork") {
        await this.ensureSubagentTaskTrajectoryFork({
          parentLogId,
          parentSeq,
          taskChannelId,
        });
      }

      // 5) Bring the child online on the task channel.
      let childParticipantId: string | null = null;
      if (mode === "fork") {
        const childSubscription = await initAgentFromTrajectoryFork(this.rpc, childHandle, {
          parentLogId,
          seq: parentSeq,
          taskChannelId,
          contextId,
          config: childConfig,
        });
        childParticipantId = childSubscription.participantId ?? null;
      } else {
        const childSubscription = await subscribeAgentToChannel(this.rpc, childHandle, {
          channelId: taskChannelId,
          contextId,
          config: childConfig,
          replay: false,
        });
        childParticipantId = childSubscription.participantId ?? null;
      }
      this.subagentRuns.setChildParticipantId(runId, childParticipantId);

      // 6) Parent watches the task channel turn-final (buffered, log-derived).
      // The seed is published only after this, so the supervisor cannot miss
      // child activity that follows the task prompt.
      await this.subscribeChannel({
        channelId: taskChannelId,
        contextId,
        config: { wakePolicy: "turn-final" },
        replay: false,
      });

      // 6b) Stamp task provenance on the task channel so its getProvenance
      //     reports kind:"task" (B1) — parent home channel + context + runId.
      await this.createChannelClient(taskChannelId).recordTaskProvenance({
        parentChannelId: channelId,
        parentContextId: parentContextId ?? "",
        runId,
      });

      // 6) Durable run record on the parent's home channel (the subagent card),
      // then transition from setup to live before the child sees a task prompt.
      await this.publishSubagentStarted(run);
      this.subagentRuns.setStatus(runId, "running");
      const runningRun = this.subagentRuns.get(runId) ?? { ...run, status: "running" as const };

      // 7) Seed the task prompt (both modes, when provided).
      await this.publishSubagentSeed(runningRun, task);

      return {
        result: {
          protocolContent: [{ type: "text", text: `spawned subagent ${runId}` }],
          details: this.subagentRunDetails(runningRun),
        },
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[AgentVessel] spawn_subagent failed", {
        channelId,
        invocationId,
        message,
      });
      const run = this.subagentRuns.get(invocationId);
      if (run && (run.status === "starting" || run.status === "running")) {
        let canTeardown = run.status === "starting";
        if (run.status === "running") {
          try {
            await this.settleSubagentTerminal(run, "failed", message, run.integration ?? undefined);
            canTeardown = true;
          } catch (terminalErr) {
            console.error(
              `[AgentVessel] subagent setup failure terminal emit failed for ${run.runId}:`,
              terminalErr
            );
          }
        }
        if (canTeardown) {
          await this.teardownRun(run).catch((teardownErr) => {
            console.error(
              `[AgentVessel] subagent setup teardown failed for ${run.runId}:`,
              teardownErr
            );
          });
        }
      }
      return { result: message, isError: true };
    }
  }

  /**
   * External subagent bring-up. Mirrors the Pi path but delegates the child
   * process to an extension launcher named by agentKind. Completion still flows
   * through the same linked-vessel `completeFromBridge` → `onSubagentComplete`
   * path, so cards, progress, merge-back, and cancellation stay shared.
   */
  private async runExternalSubagentSpawn(
    agentKind: SubagentAgentKind,
    channelId: string,
    opts: {
      runId: string;
      taskChannelId: string;
      label: string;
      task: string;
      mode: "fresh" | "fork";
      childDepth: number;
      parentContextId: string;
      ownerEntityId: string;
      /** Launcher-specific options, forwarded verbatim; the extension owns the
       *  whitelist of what its CLI supports. */
      launcherOptions?: Record<string, unknown>;
    }
  ): Promise<{ result: unknown; isError: boolean }> {
    const { runId, taskChannelId, label, task, mode, childDepth, parentContextId, ownerEntityId } =
      opts;
    const targetKey = `subagent:${runId}`;

    // 1) Child context (deterministic; runtime records the lifecycle edge).
    const { contextId } = await createSubagentContext(this.rpc, {
      parentContextId,
      ownerEntityId,
      targetKey,
    });

    // 2) Record the run BEFORE any external side effect so a setup failure
    //    (prepare/spawn) is reclaimable by the tool's catch → teardownRun (which
    //    keys teardown off childContextId). childEntityId/participant are filled
    //    once `prepare` returns; the complete-gate can't fire during setup.
    const now = Date.now();
    const run: SubagentRunRow = {
      runId,
      taskChannelId,
      parentContextId: parentContextId ?? null,
      childContextId: contextId,
      childEntityId: "",
      childParticipantId: null,
      parentChannelId: channelId,
      mode,
      label,
      depth: childDepth,
      status: "starting",
      integration: null,
      startedAt: now,
      lastActivityAt: now,
      agentKind,
      externalSessionEntityId: null,
    };
    this.subagentRuns.insert(run);

    // 3) Parent watches the task channel turn-final + stamps task provenance —
    //    this also materializes the channel bound to the child context, which the
    //    extension's `prepare` resolves the session context from.
    await this.subscribeChannel({
      channelId: taskChannelId,
      contextId,
      config: { wakePolicy: "turn-final" },
      replay: false,
    });
    await this.createChannelClient(taskChannelId).recordTaskProvenance({
      parentChannelId: channelId,
      parentContextId: parentContextId ?? "",
      runId,
    });

    // 4) Launch the linked external subagent via its extension. The extension
    //    owns the Node-only work: prepare the linked vessel, write the profile,
    //    and spawn the headless process in the child context.
    const providerSlot = externalSubagentProviderSlot(agentKind);
    const launched = await this.rpc.call<ExternalSubagentLaunchResult>(
      "main",
      providerSlot ? "extensions.invokeProvider" : "extensions.invoke",
      [
        providerSlot ?? externalSubagentExtensionId(agentKind),
        "launchSubagent",
        [
          {
            channelId: taskChannelId,
            title: label,
            task,
            ...(opts.launcherOptions ? { options: opts.launcherOptions } : {}),
            subagent: {
              runId,
              parentRef: ownerEntityId,
              parentChannelId: channelId,
              parentContextId,
              depth: childDepth,
              mode,
            },
          },
        ],
      ]
    );

    // childEntityId = the linked vessel's canonical id — its RPC caller identity
    // when it calls back `onSubagentComplete` (the ownership gate).
    this.subagentRuns.setChildEntityId(runId, launched.vesselEntityId);
    this.subagentRuns.setChildParticipantId(runId, launched.vesselParticipantId);
    this.subagentRuns.setExternalSessionEntityId(runId, launched.entityId);

    // 6) Durable run card, then transition to live.
    const startedRun = this.subagentRuns.get(runId) ?? {
      ...run,
      externalSessionEntityId: launched.entityId,
    };
    await this.publishSubagentStarted(startedRun);
    this.subagentRuns.setStatus(runId, "running");
    const runningRun = this.subagentRuns.get(runId) ?? {
      ...startedRun,
      status: "running" as const,
    };

    // 7) Seed the task on the channel (trajectory visibility; the headless copy
    //    is the -p prompt).
    await this.publishSubagentSeed(runningRun, task);

    return {
      result: {
        protocolContent: [{ type: "text", text: `spawned ${agentKind} subagent ${runId}` }],
        details: this.subagentRunDetails(runningRun),
      },
      isError: false,
    };
  }

  private subagentRunDetails(run: SubagentRunRow): Record<string, unknown> {
    return {
      runId: run.runId,
      mode: run.mode,
      label: run.label,
      taskChannelId: run.taskChannelId,
      contextId: run.childContextId,
      parentContextId: run.parentContextId,
      childEntityId: run.childEntityId,
      status: run.status,
      integration: run.integration,
      // W6b: the SubagentRunCard badges the reasoning engine from this field.
      agentKind: run.agentKind,
      ...(run.externalSessionEntityId
        ? { externalSessionEntityId: run.externalSessionEntityId }
        : {}),
    };
  }

  private async resolveSubagentRun(
    runId: string,
    parentChannelId?: string
  ): Promise<SubagentRunRow | null> {
    const existing = this.subagentRuns.resolveReference(runId, parentChannelId);
    if (existing?.kind === "ambiguous") {
      throw new Error(
        `ambiguous subagent run reference ${runId}; use a longer abbreviation or the exact runId`
      );
    }
    if (existing) return this.hydrateSubagentParentContext(existing.run);
    // Recovery scans durable lifecycle cards by their exact causality id. An
    // abbreviated reference can only identify an already indexed run.
    if (!parentChannelId || runId.trim().endsWith("...") || runId.trim().endsWith("…")) {
      return null;
    }
    return this.recoverSubagentRunFromParentChannel(runId, parentChannelId);
  }

  private async hydrateSubagentParentContext(run: SubagentRunRow): Promise<SubagentRunRow> {
    if (run.parentContextId) return run;
    let parentContextId: string | null = null;
    try {
      const provenance = await this.createChannelClient(run.taskChannelId).getProvenance();
      if (provenance && typeof provenance === "object") {
        const record = provenance as Record<string, unknown>;
        if (record["kind"] === "task" && typeof record["parentContextId"] === "string") {
          parentContextId = record["parentContextId"];
        }
      }
    } catch {
      // Older task channels may not expose provenance; fall back below.
    }
    parentContextId = parentContextId ?? this.subscriptionContextOrNull(run.parentChannelId);
    if (!parentContextId) return run;
    this.subagentRuns.setParentContextId(run.runId, parentContextId);
    return { ...run, parentContextId };
  }

  private async recoverSubagentRunFromParentChannel(
    runId: string,
    parentChannelId: string
  ): Promise<SubagentRunRow | null> {
    // The subagent lifecycle card is durably published on the parent channel.
    // Rebuild this local index from that stream after hibernation or teardown.
    let recovered: SubagentRunRow | null = null;
    const channel = this.createChannelClient(parentChannelId);
    for await (const page of iterateChannelReplayAfterPages(
      (request) => channel.getReplayAfter(request),
      { after: 0 }
    )) {
      for (const event of page.logEvents) {
        if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
        const agentic =
          event.payload && typeof event.payload === "object"
            ? (event.payload as AgenticEvent & { payload?: unknown })
            : null;
        if (!agentic) continue;
        const eventKind = typeof agentic.kind === "string" ? agentic.kind : null;
        if (!eventKind) continue;
        const invocationId = (agentic.causality as { invocationId?: unknown } | undefined)
          ?.invocationId;
        if (invocationId !== runId) continue;
        const payload =
          agentic.payload && typeof agentic.payload === "object"
            ? (agentic.payload as Record<string, unknown>)
            : {};
        const subagent =
          payload["subagent"] && typeof payload["subagent"] === "object"
            ? (payload["subagent"] as Record<string, unknown>)
            : null;
        if (eventKind === "invocation.started" && subagent) {
          const taskChannelId = subagent["taskChannelId"];
          const contextId = subagent["contextId"];
          const parentContextId = subagent["parentContextId"];
          const childEntityId = subagent["childEntityId"];
          if (
            typeof taskChannelId !== "string" ||
            typeof contextId !== "string" ||
            typeof childEntityId !== "string"
          ) {
            continue;
          }
          const mode = subagent["mode"] === "fork" ? "fork" : "fresh";
          const startedAt =
            Date.parse(typeof agentic.createdAt === "string" ? agentic.createdAt : "") ||
            event.ts ||
            Date.now();
          recovered = {
            runId,
            taskChannelId,
            parentContextId:
              typeof parentContextId === "string"
                ? parentContextId
                : this.subscriptionContextOrNull(parentChannelId),
            childContextId: contextId,
            childEntityId,
            childParticipantId: null,
            parentChannelId,
            mode,
            label: typeof subagent["label"] === "string" ? subagent["label"] : "subagent",
            depth: this.currentSubagentDepth() + 1,
            status: "running",
            integration: null,
            startedAt,
            lastActivityAt: startedAt,
            agentKind:
              typeof subagent["agentKind"] === "string" && subagent["agentKind"]
                ? subagent["agentKind"]
                : "pi",
            externalSessionEntityId:
              typeof subagent["externalSessionEntityId"] === "string"
                ? subagent["externalSessionEntityId"]
                : null,
          };
          continue;
        }
        if (recovered && subagent) {
          const integration = subagent["integration"];
          if (
            integration === "integrated" ||
            integration === "conflicted" ||
            integration === "discarded"
          ) {
            recovered = { ...recovered, integration };
          }
        }
        if (!recovered) continue;
        if (eventKind === "invocation.completed") {
          recovered = { ...recovered, status: "completed" };
        } else if (eventKind === "invocation.failed") {
          recovered = { ...recovered, status: "failed" };
        } else if (eventKind === "invocation.cancelled") {
          recovered = { ...recovered, status: "cancelled" };
        } else if (eventKind === "invocation.abandoned") {
          recovered = { ...recovered, status: "abandoned" };
        }
      }
    }
    if (!recovered) return null;
    this.subagentRuns.insert(recovered);
    if (recovered.integration) {
      this.subagentRuns.setIntegration(recovered.runId, recovered.integration);
    }
    return this.subagentRuns.get(runId) ?? recovered;
  }

  private async publishSubagentSeed(run: SubagentRunRow, task: string): Promise<void> {
    if (!task.trim()) return;
    const participantId =
      this.subscriptions.getParticipantId(run.taskChannelId) ?? this.participantId();
    const messageId = `subagent-seed:${run.runId}`;
    const senderMetadata = {
      type: "headless",
      name: "Subagent task",
      handle: "subagent-task",
      parentParticipantId: participantId,
      subagentRunId: run.runId,
    };
    await publishAgentTaskSeed(this.createChannelClient(run.taskChannelId), {
      senderParticipantId: participantId,
      task,
      messageId,
      childParticipantId: run.childParticipantId,
      senderMetadata,
    });
  }

  /** Post a message into a subagent's task channel (parent → child). */
  protected async sendToSubagent(
    toolCallId: string,
    runId: string,
    message: string,
    parentChannelId?: string
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    if (!run) throw new Error(`unknown subagent run ${runId}`);
    if (typeof message !== "string" || !message.trim()) {
      throw new Error("send_to_subagent requires a non-empty message");
    }
    const participantId =
      this.subscriptions.getParticipantId(run.taskChannelId) ?? this.participantId();
    const messageId = `subagent-msg:${toolCallId}`;
    await this.createChannelClient(run.taskChannelId).send(participantId, messageId, message, {
      senderMetadata: { type: "agent", name: participantId },
    });
    this.subagentRuns.touch(run.runId, Date.now());
    return this.toolText(`sent to subagent ${run.runId}`, { runId: run.runId, messageId });
  }

  /** Inspect a subagent through the sole canonical semantic VCS service.
   *  `query` is `status` | `diff` | `log` | an exact file path. */
  protected async inspectSubagent(
    runId: string,
    query: string,
    parentChannelId?: string
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    if (!run) throw new Error(`unknown subagent run ${runId}`);
    const q = (query ?? "status").trim() || "status";
    const callVcs = <T>(method: string, input: unknown): Promise<T> =>
      this.rpc.call<T>("main", `vcs.${method}`, [input]);
    const status = await callVcs<VcsStatusResult>("status", { contextId: run.childContextId });
    let result: unknown;
    if (q === "status") {
      result = status;
    } else if (q === "diff") {
      result = await callVcs<VcsInspectResult>("inspect", {
        node: status.workingHead,
        edgeLimit: 500,
      });
    } else if (q === "log") {
      result = await callVcs("history", {
        root: status.workingHead,
        direction: "past",
        limit: 100,
      });
    } else {
      const repositoryRefs = new Map<
        string,
        Extract<VcsNeighborsResult["edges"][number]["to"], { kind: "repository" }>
      >();
      let neighborCursor: string | undefined;
      do {
        const page = await callVcs<VcsNeighborsResult>("neighbors", {
          root: status.workingHead,
          limit: 500,
          ...(neighborCursor ? { cursor: neighborCursor } : {}),
        });
        for (const edge of page.edges) {
          for (const node of [edge.from, edge.to]) {
            if (node.kind === "repository" && sameState(node.state, status.workingHead)) {
              repositoryRefs.set(node.repositoryId, node);
            }
          }
        }
        neighborCursor = page.nextCursor ?? undefined;
      } while (neighborCursor);

      const requestedPath = q.replace(/^\/+/, "");
      const matches: Array<{
        repositoryId: string;
        repoPath: string;
        fileId: string;
        path: string;
      }> = [];
      for (const repository of repositoryRefs.values()) {
        const inspected = await callVcs<VcsInspectResult>("inspect", {
          node: repository,
          edgeLimit: 1,
        });
        if (inspected.node.kind !== "repository" || inspected.node.value.kind !== "present") {
          continue;
        }
        const repoPath = inspected.node.value.repoPath;
        let fileCursor: string | undefined;
        do {
          const listed = await callVcs<VcsListFilesResult>("listFiles", {
            state: status.workingHead,
            repositoryId: repository.repositoryId,
            limit: 500,
            ...(fileCursor ? { cursor: fileCursor } : {}),
          });
          for (const file of listed.files) {
            if (file.path === requestedPath || `${repoPath}/${file.path}` === requestedPath) {
              matches.push({
                repositoryId: repository.repositoryId,
                repoPath,
                fileId: file.fileId,
                path: file.path,
              });
            }
          }
          fileCursor = listed.nextCursor ?? undefined;
        } while (fileCursor);
      }
      if (matches.length > 1) {
        throw new Error(
          `ambiguous subagent file path ${q}; matches repositories ${matches
            .map((candidate) => candidate.repoPath)
            .join(", ")}`
        );
      }
      const file = matches[0];
      result = file
        ? await callVcs<VcsReadFileResult>("readFile", {
            state: status.workingHead,
            repositoryId: file.repositoryId,
            file: { kind: "id", fileId: file.fileId },
          })
        : null;
    }
    return this.toolText(typeof result === "string" ? result : JSON.stringify(result, null, 2), {
      runId: run.runId,
      query: q,
      integration: run.integration,
    });
  }

  /**
   * Adopt a child context's committed changes into the parent's local working
   * chain. Each call is an ordinary `vcs.integrate` application. It does not
   * create a parallel merge session or commit unrelated parent work. The
   * parent can inspect or reconcile remaining changes and
   * later commit the whole local chain with the normal VCS tool.
   */
  protected async integrateSubagent(
    runId: string,
    parentChannelId?: string,
    toolRpc: RpcClient = this.rpc
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    if (!run) throw new Error(`unknown subagent run ${runId}`);
    if (!run.parentContextId) {
      throw new Error(`subagent ${run.runId} has no recoverable parent context`);
    }

    const callVcs = <T>(method: string, input: unknown): Promise<T> =>
      toolRpc.call<T>("main", `vcs.${method}`, [input]);
    const [targetStatus, sourceStatus] = await Promise.all([
      callVcs<VcsStatusResult>("status", { contextId: run.parentContextId }),
      callVcs<VcsStatusResult>("status", { contextId: run.childContextId }),
    ]);
    if (!sourceStatus.clean) {
      this.subagentRuns.setIntegration(run.runId, "conflicted");
      this.subagentRuns.touch(run.runId, Date.now());
      return this.toolText(
        `subagent ${run.runId} has uncommitted semantic work; commit the child context before integration`,
        {
          protocol: SUBAGENT_INTEGRATION_PROTOCOL,
          runId: run.runId,
          status: "source-uncommitted",
          source: sourceStatus,
        }
      );
    }
    if (sourceStatus.committed.kind !== "event") {
      throw new Error(`subagent ${run.runId} has no committed source event`);
    }

    const sourceEventId = sourceStatus.committed.eventId;
    const initialWorkingHead = targetStatus.workingHead;
    let workingHead = initialWorkingHead;
    const integrations: VcsIntegrateResult[] = [];
    let remaining: VcsCompareResult["changes"] = [];
    let counts: VcsCompareResult["counts"] | null = null;

    for (;;) {
      const changes: VcsCompareResult["changes"] = [];
      let cursor: string | undefined;
      do {
        const page = await callVcs<VcsCompareResult>("compare", {
          target: workingHead,
          sourceEventId,
          view: "changes",
          disposition: "actionable",
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        counts = page.counts;
        changes.push(...page.changes);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      const applicable = changes.filter(
        (change) =>
          change.disposition.status === "actionable" &&
          change.disposition.applicability === "applicable"
      );
      if (applicable.length === 0) {
        remaining = changes;
        break;
      }

      const sourceChangeIds = applicable.slice(0, 200).map((change) => change.changeId);
      const previousHead = workingHead;
      const integration = await callVcs<VcsIntegrateResult>("integrate", {
        commandId: subagentVcsCommandId("integrate", run, {
          expectedWorkingHead:
            previousHead.kind === "event" ? previousHead.eventId : previousHead.applicationId,
          sourceEventId,
          sourceChangeIds: sourceChangeIds.join(","),
        }),
        contextId: run.parentContextId,
        expectedWorkingHead: previousHead,
        intentSummary: `Adopt changes from subagent ${run.label || run.runId}`,
        sourceEventId,
        decision: { kind: "adopted", sourceChangeIds },
      });
      if (sameState(integration.workingHead, previousHead)) {
        throw new Error("vcs.integrate returned success without advancing the working head");
      }
      integrations.push(integration);
      workingHead = integration.workingHead;
    }

    const unresolved = remaining.filter(
      (change) =>
        change.disposition.status === "actionable" &&
        change.disposition.applicability !== "applicable"
    );
    const needsDecision =
      unresolved.length > 0 || (counts?.conflicting ?? 0) > 0 || (counts?.blocked ?? 0) > 0;
    this.subagentRuns.setIntegration(run.runId, needsDecision ? "conflicted" : "integrated");
    this.subagentRuns.touch(run.runId, Date.now());

    if (needsDecision) {
      return this.toolText(
        `adopted ${integrations.reduce((total, step) => total + step.incorporatedChangeIds.length, 0)} ` +
          `subagent changes locally; remaining changes require explicit decisions`,
        {
          protocol: SUBAGENT_INTEGRATION_PROTOCOL,
          runId: run.runId,
          status: "needs-decision",
          sourceEventId,
          initialWorkingHead,
          workingHead,
          integrations,
          counts,
          unresolved,
        }
      );
    }

    const adopted = integrations.reduce(
      (total, step) => total + step.incorporatedChangeIds.length,
      0
    );
    return this.toolText(
      adopted > 0
        ? `integrated ${adopted} subagent changes into the local working chain`
        : `subagent ${run.runId} has no unaccounted changes`,
      {
        protocol: SUBAGENT_INTEGRATION_PROTOCOL,
        runId: run.runId,
        status: adopted > 0 ? "working" : "unchanged",
        sourceEventId,
        initialWorkingHead,
        workingHead,
        integrations,
        counts,
      }
    );
  }

  /** Read a subagent's task-channel envelopes since a cursor (the `manual`-wake
   *  read path). Returns the child's messages + the next cursor. */
  protected async readSubagent(
    runId: string,
    afterSeq: number,
    parentChannelId?: string
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    if (!run) throw new Error(`unknown subagent run ${runId}`);
    const envelope = await this.createChannelClient(run.taskChannelId).getReplayAfter({
      after: Number.isFinite(afterSeq) ? afterSeq : 0,
    });
    let nextSeq = Number.isFinite(afterSeq) ? afterSeq : 0;
    const messages: Array<{ seq: number; author: string; text: string }> = [];
    for (const event of envelope.logEvents) {
      nextSeq = Math.max(nextSeq, event.id ?? 0);
      if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
      const agentic = event.payload as AgenticEvent | null;
      if ((agentic as { kind?: string } | null)?.kind !== "message.completed") continue;
      const text = this.extractMessageText(agentic);
      if (!text) continue;
      messages.push({ seq: event.id ?? 0, author: event.senderId ?? "unknown", text });
    }
    if (messages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No new subagent messages. Stop polling now: the parent is already subscribed to pushed subagent progress. Use suspend_turn when no foreground work remains.",
          },
        ],
        details: {
          runId: run.runId,
          nextSeq,
          messages,
          empty: true,
          waitForPush: true,
          hasMore: envelope.ready.hasMoreAfter === true,
          tokenWaste: "polling_without_new_subagent_messages",
        },
      };
    }
    const rendered = messages.map((m) => `[#${m.seq} ${m.author}]\n${m.text}`).join("\n\n");
    return this.toolText(rendered, {
      runId: run.runId,
      nextSeq,
      messages,
      empty: false,
      hasMore: envelope.ready.hasMoreAfter === true,
    });
  }

  /** Close a subagent run: cancel it if still open, tear down its context
   *  (recursive lifecycle subtree), and drop the parent's task subscription. */
  protected async closeSubagent(
    runId: string,
    discard: boolean,
    parentChannelId?: string
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const run = await this.resolveSubagentRun(runId, parentChannelId);
    if (!run) return this.toolText(`subagent ${runId} already closed`, { runId });
    if (discard && run.integration === null) {
      this.subagentRuns.setIntegration(run.runId, "discarded");
    }
    const refreshed = this.subagentRuns.get(run.runId)!;
    if (refreshed.status === "starting" || refreshed.status === "running") {
      await this.settleSubagentTerminal(
        refreshed,
        "cancelled",
        "closed by parent",
        refreshed.integration ?? undefined
      );
    }
    await this.teardownRun(refreshed);
    return this.toolText(`closed subagent ${run.runId}`, {
      runId: run.runId,
      discarded: discard,
    });
  }

  /** CHILD side of the terminal trigger: notify the owning parent that this run
   *  is done. Routes to the parent's {@link onSubagentComplete}. */
  protected async completeAsSubagent(
    report: string,
    outcome: "success" | "failed"
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const sub = this.subagentIdentity();
    if (!sub) throw new Error("complete is only available to subagents");
    await this.rpc.call(sub.parentRef, "onSubagentComplete", [
      { runId: sub.runId, channelId: sub.parentChannelId, report, outcome },
    ]);
    return this.toolText("subagent run completed", { runId: sub.runId, outcome });
  }

  /**
   * Parent-side terminal delivery, driven by the child's `complete` tool. Gated to
   * the OWNING subagent (caller id must equal the recorded child entity) — an open
   * relay otherwise lets any DO forge a completion and drive the parent loop.
   * Idempotent: a duplicate / post-terminal call no-ops.
   */
  @rpc({
    principals: ["code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "write",
  })
  async onSubagentComplete(payload: {
    runId: string;
    channelId?: string;
    report?: unknown;
    outcome?: "success" | "failed";
  }): Promise<void> {
    const run = await this.resolveSubagentRun(payload.runId, payload.channelId);
    if (!run) return; // unknown / already torn down — idempotent
    if (this.rpcCallerId !== run.childEntityId) {
      throw new Error(
        `onSubagentComplete: refusing caller ${this.rpcCallerId ?? "unknown"} — not the owning subagent for ${payload.runId}`
      );
    }
    if (run.status !== "starting" && run.status !== "running") return; // already terminal
    const outcome: "completed" | "failed" = payload.outcome === "failed" ? "failed" : "completed";
    const reportText =
      typeof payload.report === "string" ? payload.report : JSON.stringify(payload.report ?? null);
    this.subagentRuns.touch(payload.runId, Date.now());
    await this.settleSubagentTerminal(run, outcome, reportText, run.integration ?? undefined, {
      wakeParent: true,
    });
  }

  /** Publish the terminal subagent card and wake the parent, then mark the run
   *  terminal to keep delivery retryable if either terminal side effect fails.
   *  `spawn_subagent`
   *  returns when the child is launched; child completion is a later event, not
   *  the terminal for the original tool.
   */
  private async settleSubagentTerminal(
    run: SubagentRunRow,
    outcome: "completed" | "failed" | "cancelled" | "abandoned",
    text: string,
    integration?: SubagentRunIntegration,
    opts: { wakeParent?: boolean } = {}
  ): Promise<void> {
    await this.publishSubagentTerminal(run, outcome, text, integration);
    if (opts.wakeParent) {
      await this.wakeParentForSubagentTerminal(run, outcome, text);
    }
    this.subagentRuns.setStatus(run.runId, outcome === "completed" ? "completed" : outcome);
  }

  private async wakeParentForSubagentTerminal(
    run: SubagentRunRow,
    outcome: "completed" | "failed" | "cancelled" | "abandoned",
    text: string
  ): Promise<void> {
    const outcomeLabel = outcome === "completed" ? "completed" : outcome;
    const label = run.label ? `"${run.label}"` : run.runId;
    const report = text.trim();
    const content = [`Subagent ${label} ${outcomeLabel}.`, report ? `Report:\n${report}` : ""]
      .filter(Boolean)
      .join("\n\n");
    const senderRef: ParticipantRef = {
      kind: "agent",
      id: run.childEntityId,
      displayName: run.label || "Subagent",
      metadata: {
        type: "agent",
        subagentRunId: run.runId,
        taskChannelId: run.taskChannelId,
      },
    };
    await this.driver.handleIncoming(run.parentChannelId, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: run.parentChannelId,
        source: { envelopeId: `subagent-terminal:${run.runId}:${outcomeLabel}` },
        sourceMessageId: `subagent-terminal:${run.runId}`,
        content,
        senderRef,
      },
    });
  }

  private async publishSubagentStarted(run: SubagentRunRow): Promise<void> {
    const participantId =
      this.subscriptions.getParticipantId(run.parentChannelId) ?? this.participantId();
    const actor = this.cardActor(run.parentChannelId, participantId);
    const event = {
      kind: "invocation.started",
      actor,
      causality: { invocationId: run.runId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "spawn_subagent",
        invocationType: "agent",
        userVisible: true,
        summary: run.label,
        subagent: {
          runId: run.runId,
          mode: run.mode,
          taskChannelId: run.taskChannelId,
          contextId: run.childContextId,
          parentContextId: run.parentContextId,
          childEntityId: run.childEntityId,
          label: run.label,
          agentKind: run.agentKind,
        },
      },
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    await this.createChannelClient(run.parentChannelId).publishAgenticEvent(participantId, event, {
      idempotencyKey: `subagent-started:${run.runId}`,
      senderMetadata: actor.metadata,
    });
  }

  private async publishSubagentTerminal(
    run: SubagentRunRow,
    outcome: "completed" | "failed" | "cancelled" | "abandoned",
    text: string,
    integration?: SubagentRunIntegration
  ): Promise<void> {
    const kindByOutcome = {
      completed: "invocation.completed",
      failed: "invocation.failed",
      cancelled: "invocation.cancelled",
      abandoned: "invocation.abandoned",
    } as const;
    const terminalOutcomeByOutcome = {
      completed: "success",
      failed: "tool_error",
      cancelled: "cancelled",
      abandoned: "abandoned",
    } as const;
    const participantId =
      this.subscriptions.getParticipantId(run.parentChannelId) ?? this.participantId();
    const actor = this.cardActor(run.parentChannelId, participantId);
    const subagent = integration ? { integration } : {};
    const payload: Record<string, unknown> =
      outcome === "completed"
        ? {
            protocol: AGENTIC_PROTOCOL_VERSION,
            terminalOutcome: "success",
            summary: text,
            subagent,
          }
        : {
            protocol: AGENTIC_PROTOCOL_VERSION,
            reason: text,
            terminalOutcome: terminalOutcomeByOutcome[outcome],
            subagent,
          };
    const event = {
      kind: kindByOutcome[outcome],
      actor,
      causality: { invocationId: run.runId as never },
      payload,
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    await this.createChannelClient(run.parentChannelId).publishAgenticEvent(participantId, event, {
      idempotencyKey: `subagent-terminal:${run.runId}`,
      senderMetadata: actor.metadata,
    });
  }

  /** Tear down a run: drop the parent's task subscription + wake cursor and
   *  recursively destroy the child's lifecycle context subtree. */
  private async teardownRun(run: SubagentRunRow): Promise<void> {
    try {
      await this.unsubscribeChannel(run.taskChannelId);
    } catch {
      /* already gone */
    }
    this.subagentRuns.deleteWakeCursor(run.taskChannelId);
    // Release an extension-owned headless launch directly. Close/cancel/abandon
    // all route here. Idempotent — releasing an already-exited launch is a no-op.
    if (run.externalSessionEntityId) {
      const agentKind = normalizeSubagentAgentKind(run.agentKind);
      if (agentKind && agentKind !== "pi") {
        const providerSlot = externalSubagentProviderSlot(agentKind);
        await this.rpc
          .call("main", providerSlot ? "extensions.invokeProvider" : "extensions.invoke", [
            providerSlot ?? externalSubagentExtensionId(agentKind),
            "release",
            [{ entityId: run.externalSessionEntityId }],
          ])
          .catch((err) => {
            console.error(
              `[AgentVessel] ${run.agentKind} release for subagent ${run.runId} failed:`,
              err
            );
          });
      } else {
        console.error(
          `[AgentVessel] cannot release external subagent ${run.runId}: invalid agentKind ${run.agentKind}`
        );
      }
    }
    try {
      await this.rpc.call("main", "runtime.destroyContext", [
        { contextId: run.childContextId, recursive: true },
      ]);
    } catch (err) {
      console.error(`[AgentVessel] destroyContext for subagent ${run.runId} failed:`, err);
    }
    this.subagentRuns.delete(run.runId);
  }

  // ── Wake discipline (turn-final buffering / manual) ─────────────────────────

  private extractMessageText(agentic: AgenticEvent | null): string {
    const blocks = (agentic as { payload?: { blocks?: unknown[] } } | null)?.payload?.blocks ?? [];
    return blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }

  private trimSubagentProgress(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > 360 ? `${compact.slice(0, 357)}...` : compact;
  }

  /** Fold a child task-channel event into a structured, bounded progress
   *  update for the parent card. Returns null for kinds we don't surface. */
  private subagentProgressUpdate(
    agentic: AgenticEvent | null,
    messageSeq: number
  ): SubagentProgressUpdate | null {
    const kind = (agentic as { kind?: string } | null)?.kind ?? "";
    const payload = ((agentic as { payload?: Record<string, unknown> } | null)?.payload ??
      {}) as Record<string, unknown>;
    const tool = typeof payload["name"] === "string" ? payload["name"] : undefined;
    if (kind === "turn.opened") return { kind: "turn-started", messageSeq };
    if (kind === "turn.closed") return { kind: "turn-finished", messageSeq };
    if (kind === "invocation.started") return { kind: "tool-started", tool, messageSeq };
    if (kind === "invocation.progress") {
      const message = typeof payload["message"] === "string" ? payload["message"] : undefined;
      return {
        kind: "tool-progress",
        tool,
        ...(message ? { text: this.trimSubagentProgress(message) } : {}),
        messageSeq,
      };
    }
    if (kind === "invocation.completed") return { kind: "tool-completed", tool, messageSeq };
    if (
      kind === "invocation.failed" ||
      kind === "invocation.cancelled" ||
      kind === "invocation.abandoned"
    ) {
      const reason = typeof payload["reason"] === "string" ? payload["reason"] : undefined;
      return {
        kind: kind.replace("invocation.", "tool-") as SubagentProgressUpdate["kind"],
        tool,
        ...(reason ? { text: this.trimSubagentProgress(reason) } : {}),
        messageSeq,
      };
    }
    if (kind === "message.completed") {
      const text = this.extractMessageText(agentic);
      if (!text) return null;
      return {
        kind: "said",
        text: this.trimSubagentProgress(text),
        messageSeq,
        ...(payload["saliency"] === "say" ? { say: true } : {}),
      };
    }
    return null;
  }

  private publishSubagentProgress(
    channelId: string,
    event: ChannelEvent,
    agentic: AgenticEvent | null
  ): void {
    const run = this.subagentRuns.getByTaskChannel(channelId);
    if (!run || event.senderId === this.participantId()) return;
    const messageSeq = Number.isFinite(event.id) ? (event.id as number) : 0;
    const update = this.subagentProgressUpdate(agentic, messageSeq);
    if (!update) return;
    const participantId =
      this.subscriptions.getParticipantId(run.parentChannelId) ?? this.participantId();
    const actor = this.cardActor(run.parentChannelId, participantId);
    const progressEvent: AgenticEvent<"invocation.progress"> = {
      kind: "invocation.progress",
      actor,
      causality: { invocationId: run.runId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        subagent: update,
      },
      createdAt: new Date().toISOString(),
    };
    const idempotencyKey = `subagent-progress:${run.runId}:${messageSeq}:${(agentic as { kind?: string } | null)?.kind ?? "event"}`;
    this.subagentRuns.enqueueProgress({
      idempotencyKey,
      runId: run.runId,
      messageSeq,
      parentChannelId: run.parentChannelId,
      participantId,
      event: progressEvent,
      now: Date.now(),
    });
    // The alarm is the authoritative delivery mechanism. No asynchronous
    // publication escapes this source event, so hibernation cannot drop it.
    this.scheduleAgentAlarm("subagent-progress-outbox", Date.now() + 1);
  }

  private async drainSubagentProgress(now: number): Promise<void> {
    const entries = this.subagentRuns.dueProgress(now, 50);
    for (const entry of entries) {
      try {
        await this.createChannelClient(entry.parentChannelId).publishAgenticEvent(
          entry.participantId,
          entry.event,
          {
            idempotencyKey: entry.idempotencyKey,
            senderMetadata: entry.event.actor.metadata,
          }
        );
        this.subagentRuns.completeProgress(entry.sequence);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Retry forever with bounded exponential backoff. The persisted error
        // is intentionally exposed by getDebugState rather than silently lost.
        const retryDelay = Math.min(30_000, 250 * 2 ** Math.min(entry.attempts, 7));
        this.subagentRuns.failProgress(entry.sequence, message, Date.now() + retryDelay);
        console.error(`[AgentVessel] subagent progress publish failed for ${entry.runId}:`, error);
      }
    }
  }

  private eventAddressesSelf(
    channelId: string,
    payload: {
      mentions?: string[];
      to?: Array<{ kind?: string; participantId?: string }>;
    }
  ): boolean {
    const selfPid = this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    if (Array.isArray(payload.mentions) && payload.mentions.includes(selfPid)) return true;
    if (Array.isArray(payload.to)) {
      for (const target of payload.to) {
        if (target?.kind === "all") return true;
        if (target?.participantId === selfPid) return true;
      }
    }
    return false;
  }

  /**
   * Resolve whether an inbound envelope wakes the loop NOW, per the channel's
   * wakePolicy. Returns true when the event was HANDLED here (buffered, or drove a
   * turn-final wake) so the caller returns; false to fall through to the default
   * every-envelope path (used for say-flagged / addressed messages). Buffering is
   * log-derived (a durable wake cursor in SQLite), never an in-memory queue — so
   * it survives DO hibernation.
   */
  private async resolveWake(
    channelId: string,
    event: ChannelEvent,
    wakePolicy: "turn-final" | "manual"
  ): Promise<boolean> {
    if (wakePolicy === "manual") {
      // Never auto-wake; the supervisor reads via the read_subagent tool.
      return true;
    }
    // turn-final
    if (event.senderId === this.participantId()) return true; // our own traffic never wakes us
    const agentic = event.payload as AgenticEvent | null;
    const kind = (agentic as { kind?: string } | null)?.kind ?? "";
    if (kind === "message.completed") {
      const payload =
        ((agentic as AgenticEvent).payload as {
          saliency?: string;
          mentions?: string[];
          to?: Array<{ kind?: string; participantId?: string }>;
        }) ?? {};
      if (payload.saliency === "say" || this.eventAddressesSelf(channelId, payload)) {
        // Explicit surface: advance the cursor past it (so a subsequent
        // turn.closed fold doesn't double-count it) and take the normal path.
        const run = this.subagentRuns.getByTaskChannel(channelId);
        console.warn("[AgentVessel] turn-final subscription falling through to normal wake", {
          taskChannelId: channelId,
          taskContextId: this.subscriptionContextOrNull(channelId),
          parentChannelId: run?.parentChannelId ?? null,
          runId: run?.runId ?? null,
          eventId: event.id ?? null,
          eventMessageId: event.messageId,
          saliency: payload.saliency ?? null,
          addressedSelf: this.eventAddressesSelf(channelId, payload),
        });
        this.subagentRuns.setWakeCursor(
          channelId,
          Math.max(this.subagentRuns.getWakeCursor(channelId), event.id ?? 0)
        );
        return false;
      }
      return true; // ordinary child turn output → buffer (the log is the buffer)
    }
    if (kind === "turn.closed") {
      await this.wakeTurnFinal(channelId);
      return true;
    }
    return true; // invocation.* / presence / … buffer
  }

  /** Fold the child's buffered task-channel messages (since the wake cursor) into
   *  a single prompt and drive one parent turn. Log-derived + replay-safe. */
  private async wakeTurnFinal(channelId: string): Promise<void> {
    const cursor = this.subagentRuns.getWakeCursor(channelId);
    let maxId = cursor;
    const parts: string[] = [];
    let senderRef: ParticipantRef | undefined;
    let lastMessageId: string | undefined;
    try {
      const channel = this.createChannelClient(channelId);
      const pages = iterateChannelReplayAfterPages((request) => channel.getReplayAfter(request), {
        after: cursor,
      });
      for await (const envelope of pages) {
        for (const event of envelope.logEvents) {
          maxId = Math.max(maxId, event.id ?? 0);
          if (event.senderId === this.participantId()) continue;
          if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
          const agentic = event.payload as AgenticEvent | null;
          if ((agentic as { kind?: string } | null)?.kind !== "message.completed") continue;
          const text = this.extractMessageText(agentic);
          if (text) parts.push(text);
          senderRef = participantRefFromActor((agentic as AgenticEvent).actor);
          lastMessageId =
            ((agentic as AgenticEvent).causality?.messageId as string | undefined) ??
            event.messageId;
        }
      }
    } catch (error) {
      console.error("[AgentVessel] failed to replay task-channel output for parent wake", {
        channelId,
        cursor,
        error,
      });
      return;
    }
    this.subagentRuns.setWakeCursor(channelId, maxId);
    if (parts.length === 0 || !senderRef) return;
    const run = this.subagentRuns.getByTaskChannel(channelId);
    console.warn("[AgentVessel] turn-final subscription waking loop from task channel", {
      taskChannelId: channelId,
      taskContextId: this.subscriptionContextOrNull(channelId),
      parentChannelId: run?.parentChannelId ?? null,
      parentContextId: run?.parentChannelId
        ? this.subscriptionContextOrNull(run.parentChannelId)
        : null,
      runId: run?.runId ?? null,
      wakeCursorBefore: cursor,
      wakeCursorAfter: maxId,
      foldedMessageCount: parts.length,
    });
    if (run) this.subagentRuns.touch(run.runId, Date.now());
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: {
        kind: "prompt",
        channelId,
        source: { envelopeId: `turn-final:${channelId}:${maxId}` },
        ...(lastMessageId ? { sourceMessageId: lastMessageId } : {}),
        content: parts.join("\n\n"),
        senderRef,
      },
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  override async alarm(): Promise<DoAlarmSchedule | null> {
    await super.alarm();
    await this.fireAgentAlarms(Date.now());
    return this.nextAgentAlarmSchedule();
  }

  private activationDebugState(channelId?: string): Record<string, unknown> {
    const channels = channelId ? [channelId] : this.subscriptions.listChannelIds();
    const loops: Record<string, unknown> = {};
    for (const id of channels) {
      const loop = this._driver?.peekLoadedLoop(id) ?? null;
      if (loop) {
        loops[id] = {
          loaded: true,
          turnStatus: derivedTurnStatus(loop.state),
          lastSeq: loop.state.lastSeq,
          pendingInvocations: Object.keys(loop.state.pendingInvocations),
          pendingApprovals: Object.keys(loop.state.pendingApprovals),
          pendingCredentialWaits: Object.keys(loop.state.pendingCredentialWaits),
          settings: this.inspectAgentSettings(),
        };
      } else {
        loops[id] = {
          loaded: false,
          note: "No folded loop is loaded in this activation; inspect GAD for durable trajectory state.",
        };
      }
    }
    return {
      participantId: this.participantId(),
      loops,
      outbox: inspectEffectOutbox(this.sql),
      activeDispatches: this._driver?.activeDispatchDiagnostics?.(channelId) ?? [],
      subagentProgressOutbox: this.subagentRuns.progressDiagnostics(),
    };
  }

  @rpc({
    principals: ["host", "user", "code"],
    effect: { kind: "runtime-intrinsic" },
    tier: "open",
    sensitivity: "read",
  })
  async getDebugState(channelId?: string): Promise<Record<string, unknown>> {
    return this.activationDebugState(channelId);
  }

  /**
   * Comprehensive self-snapshot for an agent introspecting itself from eval (the
   * `agent` binding): identity + resolved per-agent config + channel memberships
   * + active tools + this channel's turn state + an effect summary.
   */
  async describeSelf(channelId: string): Promise<Record<string, unknown>> {
    let turn: Record<string, unknown> = { status: "idle" };
    try {
      const loop = await this.driver.loop(channelId);
      turn = summarizeTurn(loop.state);
    } catch {
      /* loop not loadable yet — report idle */
    }
    let activeTools: string[] = [];
    try {
      activeTools = [...(await this.toolRegistry(channelId)).keys()];
    } catch {
      /* tools unavailable */
    }
    return {
      identity: {
        id: this.participantId(),
        objectKey: this.objectKey,
        source: String(this.env["WORKER_SOURCE"] ?? ""),
        className: String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name),
      },
      config: this.getAgentSettings(),
      channels: this.subscriptions.listAll(),
      tools: { active: activeTools },
      turn,
      effects: { outbox: { total: this.driver.outbox.all().length } },
    };
  }

  /**
   * Validate + apply a per-agent config patch (the `agent.configure`/setter write
   * path from eval). Every field is freely settable — including `approvalLevel`,
   * which is a UX convenience; all sensitive operations are gated by out-of-band
   * app approvals. Writes the per-agent record (applies to all the agent's channels).
   */
  configureAgent(patch: Record<string, unknown>): AgentSettings {
    const next: StoredSettings = {};
    if ("model" in patch) {
      if (typeof patch["model"] !== "string" || !patch["model"]) {
        throw new Error("model must be a non-empty 'provider:model' string");
      }
      next.model = patch["model"];
    }
    if ("thinkingLevel" in patch) {
      const l = patch["thinkingLevel"];
      if (!isThinkingLevel(l)) {
        throw new Error("thinkingLevel must be minimal|low|medium|high|xhigh|max");
      }
      next.thinkingLevel = l;
    }
    if ("fallbackModel" in patch) {
      if (typeof patch["fallbackModel"] !== "string" || !patch["fallbackModel"]) {
        throw new Error("fallbackModel must be a non-empty 'provider:model' string");
      }
      next.fallbackModel = patch["fallbackModel"];
    }
    if ("fallbackThinkingLevel" in patch) {
      const level = patch["fallbackThinkingLevel"];
      if (!isThinkingLevel(level)) {
        throw new Error("fallbackThinkingLevel must be minimal|low|medium|high|xhigh|max");
      }
      next.fallbackThinkingLevel = level;
    }
    if ("fallbackOn" in patch) {
      if (!isFallbackOn(patch["fallbackOn"])) {
        throw new Error(
          `fallbackOn must be a non-empty array containing only ${[
            ...CONFIGURABLE_FALLBACK_FAILURE_CODES,
          ].join("|")}`
        );
      }
      next.fallbackOn = [...patch["fallbackOn"]];
    }
    if ("fallbackScope" in patch) {
      const scope = patch["fallbackScope"];
      if (scope !== "unattended" && scope !== "all-turns") {
        throw new Error("fallbackScope must be unattended|all-turns");
      }
      next.fallbackScope = scope;
    }
    if ("approvalLevel" in patch) {
      const l = patch["approvalLevel"];
      if (l !== 0 && l !== 1 && l !== 2) throw new Error("approvalLevel must be 0, 1, or 2");
      next.approvalLevel = l;
    }
    if ("respondPolicy" in patch) {
      if (!isRespondPolicy(patch["respondPolicy"])) throw new Error("invalid respondPolicy");
      next.respondPolicy = patch["respondPolicy"];
    }
    if ("respondFrom" in patch) {
      const from = patch["respondFrom"];
      if (!Array.isArray(from) || !from.every((x) => typeof x === "string")) {
        throw new Error("respondFrom must be an array of handle/participant strings");
      }
      next.respondFrom = from as string[];
    }
    return this.updateSettings(next);
  }
}
