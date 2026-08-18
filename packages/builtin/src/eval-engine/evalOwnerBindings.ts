/**
 * Owner-scoped eval-engine bindings — `chat` (channel ops) + `agent` (self
 * introspect/configure) — that an EvalDO injects when it runs AS an agent.
 *
 * Extracted into a self-contained, import-light module so it is unit-testable
 * without loading the EvalDO's heavy engine/runtime deps. Both bindings forward
 * to the owning agent runtime over the gated `chatOp` channel (the runtime's
 * `assertOwnEvalCaller` restricts that to the agent's own EvalDO).
 */

/** Subset of the EvalDO run args needed to decide + build the owner bindings. */
export interface OwnerBindingArgs {
  channelId?: string;
  agentRef?: string;
  contextId?: string;
  /** Stable owning tool invocation, supplied by the host rather than guest code. */
  agentInvocationId?: string;
}

/** The `chat` surface forwarded to the owning agent DO (mirrors agentic-core's
 *  `ChatSandboxValue`; every method is a thin `chatOp` forward). */
export interface ChatBinding {
  publish: (
    eventType: string,
    payload: unknown,
    options?: { idempotencyKey?: string }
  ) => Promise<unknown>;
  send: (content: string, options?: { idempotencyKey?: string }) => Promise<unknown>;
  publishCustomMessage: (
    input: { typeId: string; initialState?: unknown; displayMode?: "inline" | "row" },
    options?: { idempotencyKey?: string }
  ) => Promise<{ messageId: string; pubsubId: number | undefined }>;
  updateCustomMessage: (
    messageId: string,
    update: unknown,
    options?: { idempotencyKey?: string }
  ) => Promise<number | undefined>;
  registerMessageType: (
    input: unknown,
    options?: { idempotencyKey?: string }
  ) => Promise<number | undefined>;
  clearMessageType: (
    typeId: string,
    options?: { idempotencyKey?: string }
  ) => Promise<number | undefined>;
  getMessageType: (typeId: string) => Promise<unknown>;
  getMessageTypes: () => Promise<unknown[]>;
  /** Look up one durable channel envelope by id; returns null if absent. */
  replayEnvelope: (envelopeId: string) => Promise<unknown | null>;
  getParticipants: () => Promise<
    Array<{
      id: string;
      ref: unknown;
      type: "user" | "panel" | "headless" | "agent";
      name: string;
      isPerson: boolean;
      isAgent: boolean;
      handle?: string;
      methods?: unknown[];
    }>
  >;
  callMethod: (
    participantId: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>;
  callMethodResult: (
    participantId: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>;
  participantByHandle: (handle: string) => Promise<unknown>;
  callMethodByHandle: (
    handle: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>;
  callMethodResultByHandle: (
    handle: string,
    method: string,
    args: unknown,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>;
  focusMessage: (messageId: string) => Promise<boolean>;
  contextId: string;
  channelId: string | null;
  rpc: { call: (target: string, method: string, args: unknown[]) => Promise<unknown> };
}

/** Agent-owned automation authoring. The owner runtime supplies channel
 * provenance and emits the durable institution event; guest code only
 * supplies the actual automation definition. */
export interface AgentAutomationProposal {
  name: string;
  summary: string;
  action:
    | { kind: "prompt"; text: string }
    | {
        kind: "eval";
        code: string;
        syntax?: "javascript" | "typescript" | "jsx" | "tsx";
        timeoutMs?: number;
        reset?: boolean;
      };
  trigger:
    | { kind: "manual" }
    | {
        kind: "schedule";
        everyMs: number;
        anchorAt?: number;
        jitterMs?: number;
        untilAt?: number;
        maxRuns?: number;
      }
    | {
        kind: "cron";
        expression: string;
        timezone: string;
        untilAt?: number;
        maxRuns?: number;
      };
  conversation?: { mode: "fresh" | "continue" };
  toolExposure?: {
    services: string[];
    userlandServices: Array<{
      name: string;
      provider: string;
      providerEv: string;
      upgradePolicy: "pinned" | "follow-head";
    }>;
    workspaceServiceDiscovery: "bound" | "live-declarations";
    evalNetwork: "none" | "declared-origins" | "unrestricted";
    declaredOrigins: string[];
  };
  declaredLineageClasses?: Array<
    "none" | "web" | "email" | "channel-external" | "external"
  >;
  permissions?: Array<{
    capability: string;
    resource: unknown;
    tier: "gated" | "critical";
  }>;
  standingRestrictions?: Array<{ capability: string; resourceKey: string }>;
}

export interface AutomationsBinding {
  propose(input: AgentAutomationProposal): Promise<unknown>;
}

type CallFn = (target: string, method: string, callArgs: unknown[]) => Promise<unknown>;

/**
 * Build the owner bindings. Returns `{}` when the eval has NO owning agent (a
 * CLI/panel eval supplies no `channelId`/`agentRef`) — `chat`/`agent` are then
 * ABSENT, so referencing them in eval code throws a `ReferenceError` (and
 * `typeof agent === "undefined"` lets eval feature-detect). Per-agent config:
 * `agent` setters funnel through the server-validated `configureAgent` and apply
 * across all the agent's channels. Pure (given `call`).
 */
export function buildOwnerBindings(args: OwnerBindingArgs, call: CallFn): Record<string, unknown> {
  if (!args.channelId || !args.agentRef) return {};
  const { channelId, agentRef } = args;
  const op =
    (name: string) =>
    (...a: unknown[]): Promise<unknown> =>
      call(agentRef, "chatOp", [channelId, name, a]);
  const chat: ChatBinding = {
    publish: op("publish") as ChatBinding["publish"],
    send: op("send") as ChatBinding["send"],
    publishCustomMessage: op("publishCustomMessage") as ChatBinding["publishCustomMessage"],
    updateCustomMessage: op("updateCustomMessage") as ChatBinding["updateCustomMessage"],
    registerMessageType: op("registerMessageType") as ChatBinding["registerMessageType"],
    clearMessageType: op("clearMessageType") as ChatBinding["clearMessageType"],
    getMessageType: op("getMessageType") as ChatBinding["getMessageType"],
    getMessageTypes: op("getMessageTypes") as ChatBinding["getMessageTypes"],
    getParticipants: op("getParticipants") as ChatBinding["getParticipants"],
    replayEnvelope: op("replayEnvelope") as ChatBinding["replayEnvelope"],
    callMethod: op("callMethod") as ChatBinding["callMethod"],
    callMethodResult: op("callMethodResult") as ChatBinding["callMethodResult"],
    participantByHandle: op("participantByHandle") as ChatBinding["participantByHandle"],
    callMethodByHandle: op("callMethodByHandle") as ChatBinding["callMethodByHandle"],
    callMethodResultByHandle: op(
      "callMethodResultByHandle"
    ) as ChatBinding["callMethodResultByHandle"],
    focusMessage: op("focusMessage") as ChatBinding["focusMessage"],
    contextId: args.contextId ?? "",
    channelId,
    rpc: { call },
  };
  const configure = op("configureAgent");
  let automationProposalOrdinal = 0;
  const automations: AutomationsBinding = {
    propose: (input) => {
      automationProposalOrdinal += 1;
      const provenance = args.agentInvocationId
        ? { invocationId: args.agentInvocationId, ordinal: automationProposalOrdinal }
        : undefined;
      return call(agentRef, "chatOp", [
        channelId,
        "proposeAutomation",
        provenance ? [input, provenance] : [input],
      ]);
    },
  };
  const agent = {
    // Observation has its own read-classified receiver method. Routing it
    // through chatOp would make a harmless snapshot inherit that method's
    // write sensitivity and fail every read-only eval.
    describe: () => call(agentRef, "describeEvalOwner", [channelId]),
    configure: (patch: Record<string, unknown>) => configure(patch),
    setModel: (model: string) => configure({ model }),
    setThinkingLevel: (thinkingLevel: string) => configure({ thinkingLevel }),
    setApprovalLevel: (approvalLevel: number) => configure({ approvalLevel }),
    setRespondPolicy: (respondPolicy: string, respondFrom?: string[]) =>
      configure(respondFrom !== undefined ? { respondPolicy, respondFrom } : { respondPolicy }),
    setRespondFrom: (respondFrom: string[]) => configure({ respondFrom }),
  };
  return { chat, agent, automations };
}
