/**
 * AgentState (WS1 §1.1) — derived by fold, never stored authoritatively
 * (the driver's fold_cache is a P1 cache). All fields JSON-serializable;
 * large payloads remain `vibestudio.blob-ref.v1` refs inside entries
 * (hydration happens in executors, never in the fold).
 */

import type { InvocationTransport, ParticipantRef } from "@workspace/agentic-protocol";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** How the executor authenticates a model call (design §6.3):
 *  "url-bound" — resolve a stored URL-bound credential (suspends on absence);
 *  "loopback"  — local llama.cpp server; key injected executor-side at call
 *                time, never journaled. */
export type ModelAuthMode = "url-bound" | "loopback";

/**
 * Serializable model descriptor — a pi-ai `Model` literal, journaled with
 * every model request so replay never depends on the installed registry
 * version (design docs/local-models-extension-design.md §6.2). Kept
 * structural so agent-loop stays free of a pi-ai dependency; the vessel
 * materializes it at the impure edge (settings write / artifact refresh).
 * MUST stay secret-free: it rides catalog snapshots and the journal.
 */
export interface AgentModelSpec {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export type RespondPolicy =
  | "all"
  | "mentioned"
  | "mentioned-strict"
  | "mentioned-or-followup"
  | "from-participants";

export interface RosterMethod {
  name: string;
  description?: string;
  /** JSON Schema for the method's arguments (from the participant's
   *  method advertisement) — exposed to the model as the tool schema. */
  parameters?: unknown;
}

export interface RosterEntry {
  participantId: string;
  ref: ParticipantRef;
  handle?: string;
  type?: string;
  methods: RosterMethod[];
}

export interface RosterSnapshot {
  participants: RosterEntry[];
}

export interface AgentLoopConfig {
  model: string;
  /** Materialized descriptor + auth for `model` (design §6.2/§6.3). The
   *  vessel resolves these at the impure edge; the pure planner copies them
   *  onto every request. Absent only in pre-refactor logs/fixtures — the
   *  executor rejects requests without a spec (no registry fallback). */
  modelSpec?: AgentModelSpec;
  modelAuth?: ModelAuthMode;
  /** Unattended provider-failure fallback (design §8). When present, the pure
   *  loop can journal exactly one local retry without consulting a registry. */
  fallbackModelRef?: string;
  fallbackModelSpec?: AgentModelSpec;
  thinkingLevel: ThinkingLevel;
  approvalLevel: 0 | 1 | 2;
  respondPolicy: RespondPolicy;
  systemPromptHash: string;
  /** Per-call instruction appended to the model message context, not the
   *  provider system prompt. Use for run-specific guidance that should not
   *  churn the system prompt/cache key. */
  immediatePrompt?: string;
  skillIndexHash?: string;
  toolSchemasHash?: string;
  activeToolNames: string[];
  roster: RosterSnapshot;
  agentHopLimit?: number;
  /** Optional cap for model rounds in one turn. Null/undefined means unlimited. */
  maxModelCallsPerTurn?: number | null;
  /** Idle watchdog for model streams. `null` intentionally disables it. */
  modelStreamIdleTimeoutMs?: number | null;
  /** Channel publication discipline (gated by `publishPolicyPolicy`, appended
   *  last in `defaultPolicies`). "all" = today's behavior (every model outcome
   *  publishes). "turn-final" = only the end-of-turn (tier "primary") message
   *  publishes; intermediate tool-step text stays trajectory-only (streamed as
   *  ephemeral deltas). "say-only" = NO model message publishes; the agent speaks
   *  only through its explicit `say` tool + turn boundaries. Absent ⇒ "all". */
  publishPolicy?: "all" | "turn-final" | "say-only";
  /** Max subagent nesting depth (enforced at spawn by the vessel). Absent ⇒
   *  the vessel's implementation default. */
  maxSubagentDepth?: number;
  /** Max concurrent live subagents (enforced at spawn by the vessel). Absent ⇒
   *  the vessel's implementation default. */
  maxConcurrentSubagents?: number;
}

export interface AgentTurnContextPolicy {
  mode?: "full" | "heartbeat" | "isolated";
  includeWorkspacePrompt?: boolean;
  includeSkillIndex?: boolean;
  promptFile?: string;
  promptFileContent?: string;
  tokenBudget?: number;
}

export interface AgentTurnMetadata {
  origin?: "agent-initiated" | "heartbeat" | "scheduled";
  contextPolicy?: AgentTurnContextPolicy;
  loopConfigPatch?: {
    maxModelCallsPerTurn?: number | null;
    modelStreamIdleTimeoutMs?: number | null;
  };
  delivery?: "none" | "channel" | "last-contact";
  ackToken?: string;
  silentOk?: boolean;
  /** Send-after-turn intent: while a turn is open this message is held in the
   *  deferred post-turn queue and promoted (one per turn) after close, instead
   *  of steering the open turn. */
  deliverAfterTurn?: boolean;
}

/** Config fields that are FOLD-OWNED: the reducer derives them from the log
 *  (roster from `roster.snapshot` events), so a reload must keep the folded
 *  value, NOT the vessel's injected input config (which carries an empty
 *  sentinel roster). Everything else in AgentLoopConfig is INPUT-OWNED
 *  (settings the vessel injects: model/prompt/tool hashes/active tools) and
 *  must overlay so updated settings reach the model. */
const FOLD_OWNED_CONFIG_KEYS = ["roster"] as const;

/** Overlay input-owned config onto a folded state's config while preserving
 *  fold-owned fields (see FOLD_OWNED_CONFIG_KEYS). Used by the fold cache on
 *  every reload: input settings win, but the folded roster survives so
 *  channel tools don't vanish after an eviction/reload. */
export function overlayInputConfig(
  folded: AgentLoopConfig,
  input: AgentLoopConfig
): AgentLoopConfig {
  const merged = { ...input };
  for (const key of FOLD_OWNED_CONFIG_KEYS) {
    (merged as Record<string, unknown>)[key] = folded[key];
  }
  return merged;
}

export interface ModelRequestDescriptor {
  provider: string;
  model: string;
  /** Journaled pi-ai Model literal — the ONLY resolution path in the
   *  executor (design §6.2); requests without it fail with a clear error.
   *  For local models the journaled baseUrl documents what ran; the live
   *  endpoint from ensureLoaded() wins at execution time (§6.3). */
  modelSpec?: AgentModelSpec;
  /** Auth mode copied from the catalog entry (design §6.3). Absent ⇒ "url-bound". */
  auth?: ModelAuthMode;
  modelBaseUrl?: string;
  thinkingLevel: ThinkingLevel;
  systemPromptHash: string;
  /** Per-call instruction appended after the hydrated transcript. */
  immediatePrompt?: string;
  skillIndexHash?: string;
  toolSchemasHash?: string;
  activeToolNames: string[];
  /** entries snapshot boundary; executor rebuilds context through this seq. */
  contextThroughSeq: number;
  attemptId: string;
  streamOptions?: { deltaBatchMs?: number; idleTimeoutMs?: number | null };
  turnMetadata?: AgentTurnMetadata;
}

export interface OpenTurn {
  turnId: string;
  openedAtSeq: number;
  reason?: string;
  /** count of message.started in this turn — drives messageId derivation. */
  modelCallCount: number;
  /** Consecutive model failures since the last successful assistant message. */
  consecutiveModelFailureCount: number;
  /** system.event {interrupt} seen since the turn opened (gates new model calls). */
  interrupted: boolean;
  /** count of turn.waiting events (drives waiting envelope id suffix). */
  waitingCount: number;
  metadata?: AgentTurnMetadata;
  /** A soft "flush queued steers" interrupt is in flight: the in-flight model
   *  call is being aborted, but the turn must CONTINUE (re-run the model with
   *  the queued steers) rather than close. Distinct from `interrupted` (a hard
   *  interrupt that closes the turn). Cleared when the next model call starts. */
  pendingFlush?: "steers";
  /** True once this turn has auto-switched to the local fallback. */
  failedOverToFallback?: boolean;
  /** Captured by the fold when a model failure clears inFlightModelCall, so the
   *  post-fold step can still apply provider/local guards. */
  lastFailedModelRequest?: ModelRequestDescriptor;
}

export interface InFlightModelCall {
  messageId: string;
  attemptId: string;
  contextThroughSeq: number;
  request: ModelRequestDescriptor;
}

export interface PendingInvocation {
  invocationId: string;
  turnId: string;
  startedAtSeq: number;
  /** originating model attempt (causality.attemptId). */
  attemptId?: string;
  name: string;
  transport: InvocationTransport;
  request: unknown;
  requiresApproval: boolean;
  approvalId?: string;
  approvalState: "none" | "pending" | "granted";
}

export interface PendingApproval {
  approvalId: string;
  invocationId: string;
  turnId: string;
  startedAtSeq: number;
  question: string;
  details: { toolName: string; input: unknown };
}

export interface PendingCredentialWait {
  credKey: string;
  providerId: string;
  turnId: string;
  startedAtSeq: number;
  connectSpec: Record<string, unknown>;
  modelBaseUrl?: string;
  waitReason?: "model_credential_required" | "model_credential_reconnect_required";
  reason?: string;
  failureCode?: string;
  /** ISO; from the logged event, never wall clock. */
  expiresAt: string;
}

export interface SteeringEntry {
  envelopeId: string;
  seq: number;
  /** Sender's canonical message id; the read-ack/edit/retract correlation key. */
  sourceMessageId?: string;
  senderRef: ParticipantRef;
  content: unknown;
  metadata?: AgentTurnMetadata;
}

export interface PendingPrompt {
  envelopeId: string;
  seq: number;
  sourceMessageId?: string;
  senderRef: ParticipantRef;
  content: unknown;
  agentHops?: number;
  metadata?: AgentTurnMetadata;
}

/** A "send after turn" message held until the current turn closes, then
 *  promoted (one per turn) into a fresh turn of its own. */
export interface DeferredPrompt {
  sourceMessageId: string;
  envelopeId: string;
  seq: number;
  senderRef: ParticipantRef;
  content: unknown;
  metadata?: AgentTurnMetadata;
  agentHops?: number;
}

/** Linear session entry — the materialized model-context path. */
export type SessionEntry =
  | {
      kind: "user";
      seq: number;
      envelopeId: string;
      sourceMessageId?: string;
      senderRef?: ParticipantRef;
      content: unknown;
      metadata?: AgentTurnMetadata;
    }
  | {
      kind: "assistant";
      seq: number;
      messageId: string;
      /** Author. When it differs from the loop's `selfId` (another agent in the channel),
       *  the context builder presents this as an attributed `user` message, NOT as this
       *  agent's own `assistant` turn — so the model doesn't read it as its own voice. */
      senderRef?: ParticipantRef;
      blocks: unknown[];
      outcome?: string;
    }
  | {
      kind: "tool-result";
      seq: number;
      invocationId: string;
      name: string;
      result: unknown;
      isError: boolean;
    }
  | { kind: "note"; seq: number; text: string };

export interface AgentState {
  logId: string;
  head: string;
  channelId: string;
  /** seq of last folded envelope. */
  lastSeq: number;
  /** hash of last folded envelope (== expectedHeadHash for the next append). */
  lastHash: string;
  /** fork boundary of this head (0 for root logs); pendings with
   *  startedAtSeq ≤ forkSeq are pre-cut (fork policy). */
  forkSeq: number;
  /** This agent's own participant/actor id for this channel's loop. Turn/message
   *  lifecycle events authored by ANOTHER participant are NOT folded into loop state
   *  (the fold filters by this), so the agent never adopts another agent's open turn
   *  from the shared channel replay. Undefined ⇒ no filtering (legacy/test folds). */
  selfId?: string;

  config: AgentLoopConfig;
  entries: SessionEntry[];

  openTurn: OpenTurn | null;
  inFlightModelCall: InFlightModelCall | null;
  pendingInvocations: Record<string, PendingInvocation>;
  pendingApprovals: Record<string, PendingApproval>;
  pendingCredentialWaits: Record<string, PendingCredentialWait>;
  steeringQueue: SteeringEntry[];
  pendingPrompt: PendingPrompt | null;
  /** "Send after turn" messages, drained one per turn after each turn closes. */
  deferredPostTurnQueue: DeferredPrompt[];
}

export const GENESIS_LAST_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

export interface InitialStateInput {
  channelId: string;
  logId?: string;
  head?: string;
  config: AgentLoopConfig;
  forkSeq?: number;
  lastSeq?: number;
  lastHash?: string;
  /** The agent's own participant/actor id (see AgentState.selfId). */
  selfId?: string;
}

export function initialAgentState(input: InitialStateInput): AgentState {
  const logId = input.logId ?? `branch:channel:${input.channelId}`;
  return {
    logId,
    head: input.head ?? logId,
    channelId: input.channelId,
    lastSeq: input.lastSeq ?? input.forkSeq ?? 0,
    lastHash: input.lastHash ?? GENESIS_LAST_HASH,
    forkSeq: input.forkSeq ?? 0,
    config: input.config,
    entries: [],
    openTurn: null,
    inFlightModelCall: null,
    pendingInvocations: {},
    pendingApprovals: {},
    pendingCredentialWaits: {},
    steeringQueue: [],
    pendingPrompt: null,
    deferredPostTurnQueue: [],
    ...(input.selfId ? { selfId: input.selfId } : {}),
  };
}

/** Derived turn status — replaces the old 8-state agent_turn_runs FSM. */
export function derivedTurnStatus(
  state: AgentState
): "idle" | "starting" | "running_model" | "waiting_external" | "continuing" {
  if (!state.openTurn) return "idle";
  if (state.inFlightModelCall) return "running_model";
  if (state.openTurn.modelCallCount === 0) return "starting";
  const pendings = Object.values(state.pendingInvocations);
  const hasExternal =
    pendings.some((inv) => inv.transport.kind !== "local") ||
    Object.keys(state.pendingApprovals).length > 0 ||
    Object.keys(state.pendingCredentialWaits).length > 0;
  if (pendings.length > 0 || hasExternal) return "waiting_external";
  return "continuing";
}
