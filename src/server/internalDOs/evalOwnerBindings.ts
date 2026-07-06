/**
 * Owner-scoped eval bindings — `chat` (channel ops) + `agent` (self
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
  const agent = {
    describe: op("describeSelf"),
    configure: (patch: Record<string, unknown>) => configure(patch),
    setModel: (model: string) => configure({ model }),
    setThinkingLevel: (thinkingLevel: string) => configure({ thinkingLevel }),
    setApprovalLevel: (approvalLevel: number) => configure({ approvalLevel }),
    setRespondPolicy: (respondPolicy: string, respondFrom?: string[]) =>
      configure(respondFrom !== undefined ? { respondPolicy, respondFrom } : { respondPolicy }),
    setRespondFrom: (respondFrom: string[]) => configure({ respondFrom }),
    setMaxModelCallsPerTurn: (maxModelCallsPerTurn: number | null) =>
      configure({ maxModelCallsPerTurn }),
    setModelStreamIdleTimeoutMs: (modelStreamIdleTimeoutMs: number | null) =>
      configure({ modelStreamIdleTimeoutMs }),
  };
  return { chat, agent };
}
