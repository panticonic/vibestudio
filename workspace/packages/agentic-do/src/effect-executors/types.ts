/**
 * Executor interfaces (WS1 §2.4). Executors are the impure edge: they take a
 * pure EffectDescriptor + read-only AgentState and produce an EffectOutcome
 * that `outcomeEvents` (pure) maps to terminal append items. Ephemeral
 * emissions (stream deltas, typing) bypass the log entirely.
 */

import type {
  AgentState,
  EffectDescriptor,
  EffectKind,
  EffectOutcome,
} from "@workspace/agent-loop";
import type { AgenticEvent, ParticipantRef } from "@workspace/agentic-protocol";

export interface EphemeralEmit {
  /** AgenticEvent shape broadcast as a channel `signal` (never durable). */
  kind: "signal-event";
  channelId: string;
  event: AgenticEvent;
}

export interface BlobReaderWriter {
  getText(digest: string): Promise<string | null>;
  putText(value: string): Promise<{ digest: string; size: number }>;
}

export interface ChannelCallPort {
  callMethod(input: {
    channelId: string;
    targetParticipantId: string;
    transportCallId: string;
    method: string;
    args: unknown;
    invocationId: string;
    turnId?: string;
    timeoutMs?: number;
  }): Promise<void>;
  publish(input: {
    channelId: string;
    payloadKind: string;
    payload: unknown;
    idempotencyKey?: string;
  }): Promise<void>;
  sendSignalEvent(channelId: string, event: AgenticEvent): Promise<void>;
}

export interface CredentialPort {
  /** Resolve the API key for a provider; throws CredentialPendingError when a
   *  connect flow is required. */
  getApiKey(input: {
    providerId: string;
    modelBaseUrl?: string;
    requestId?: string;
    idempotencyKey?: string;
  }): Promise<{ apiKey: string; headers?: Record<string, string> }>;
  /** Register interest in a credential with the server-side service;
   *  resolution is delivered back via deliverEffectOutcome (http callback). */
  registerCredentialInterest(input: {
    credKey: string;
    providerId: string;
    effectId: string;
    expiresAt: string;
  }): Promise<void>;
}

export class CredentialPendingError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly modelBaseUrl?: string
  ) {
    super(`credential pending for ${providerId}`);
    this.name = "CredentialPendingError";
  }
}

export class CredentialApprovalDeferredError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly modelBaseUrl?: string
  ) {
    super(`credential approval deferred for ${providerId}`);
    this.name = "CredentialApprovalDeferredError";
  }
}

export interface LocalToolPort {
  /** Execute a registered local tool. */
  run(input: {
    channelId: string;
    tool: string;
    invocationId: string;
    args: unknown;
    signal: AbortSignal;
    onProgress?(chunk: unknown): void;
  }): Promise<{ result: unknown; summary?: string; isError: boolean }>;
  /** Mutation-replay guard (§1.4.2): true when the fold already recorded a
   *  state.file_mutation_applied for this invocation. */
  alreadyApplied(state: AgentState, invocationId: string): boolean;
}

export interface HttpCallPort {
  post(input: {
    targetUrl?: string;
    target?: { service: string; method: string };
    idempotencyKey: string;
    request: unknown;
    /** Branch-scoped outbox row id — the durable continuation key. Ports that support
     *  server-side deferral (capability-gated calls parking across a human
     *  approval) use it as the deferred requestId so onDeferredResult can
     *  route back to deliverEffectOutcome. */
    effectId: string;
    callback: { source: string; className: string; objectKey: string; method: string };
  }): Promise<{ deferred: true } | { deferred: false; result: unknown; isError: boolean }>;
}

export interface ExecutorDeps {
  selfRef: ParticipantRef;
  blobstore: BlobReaderWriter;
  channel: ChannelCallPort;
  credentials: CredentialPort;
  localTools: LocalToolPort;
  http: HttpCallPort;
  callbackAddress: { source: string; className: string; objectKey: string };
  env?: Record<string, unknown>;
}

export interface EffectExecutor<D extends EffectDescriptor = EffectDescriptor> {
  kind: EffectKind;
  execute(args: {
    descriptor: D;
    state: AgentState;
    signal: AbortSignal;
    deps: ExecutorDeps;
    onEphemeral(emit: EphemeralEmit): void;
  }): Promise<EffectOutcome | { deferred: true }>;
}
