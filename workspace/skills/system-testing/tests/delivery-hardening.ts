import { z } from "zod";
import type { HeadlessSession } from "@workspace/agentic-session";
import type { TestCase, TestExecutionResult, TestOrchestrationContext } from "../types.js";
import { getToolCalls, hasAgentResponse, noIncompleteInvocations } from "./_helpers.js";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeSession(
  session: HeadlessSession,
  execution: TestExecutionResult
): Promise<void> {
  try {
    await session.close();
  } catch (error) {
    execution.cleanupErrors = [`close: ${formatError(error)}`];
  }
}

function successfulExecution(result: TestExecutionResult) {
  if (result.error) return { passed: false, reason: result.error };
  if ((result.cleanupErrors?.length ?? 0) > 0) {
    return { passed: false, reason: `Session cleanup failed: ${result.cleanupErrors!.join("; ")}` };
  }
  if (!hasAgentResponse(result))
    return { passed: false, reason: "No agent response was delivered" };
  return noIncompleteInvocations(result);
}

function injectedFault(result: TestExecutionResult, key: string, method: string) {
  const value = result.diagnostics?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const faults = (value as Record<string, unknown>)["faults"];
  if (!Array.isArray(faults)) return null;
  return faults.find(
    (fault) =>
      fault &&
      typeof fault === "object" &&
      (fault as Record<string, unknown>)["method"] === method &&
      (fault as Record<string, unknown>)["injected"] === true
  );
}

async function firstConnectRecovery(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  let session: HeadlessSession | null = null;
  let error: string | undefined;
  let connectedAfterRecovery = false;
  try {
    session = await context.runner.spawn({
      recoverSubscriptions: true,
      rpcFaults: [
        {
          transport: "call",
          method: "join",
          occurrence: 1,
          message: "injected first-subscription transport rejection",
          code: "ECONNRESET",
        },
      ],
    });
    connectedAfterRecovery = session.connected;
    await context.sendAndWait(
      session,
      "Confirm in one short sentence that this conversation is ready.",
      "post-recovery ready turn"
    );
  } catch (cause) {
    error = formatError(cause);
  }
  const execution: TestExecutionResult = {
    messages: session ? [...session.messages] : [],
    duration: Date.now() - startedAt,
    ...(session ? { snapshot: session.snapshot() } : {}),
    diagnostics: {
      firstConnectRecovery: {
        connectedAfterRecovery,
        faults: session ? context.runner.rpcFaultEvidence(session) : [],
      },
    },
    ...(error ? { error } : {}),
  };
  if (session) await closeSession(session, execution);
  return execution;
}

function validateFirstConnectRecovery(result: TestExecutionResult) {
  const base = successfulExecution(result);
  if (!base.passed) return base;
  const probe = result.diagnostics?.["firstConnectRecovery"] as
    | { connectedAfterRecovery?: unknown }
    | undefined;
  if (probe?.connectedAfterRecovery !== true) {
    return { passed: false, reason: "The recovered first connection never reached ready" };
  }
  return injectedFault(result, "firstConnectRecovery", "join")
    ? { passed: true }
    : { passed: false, reason: "The first subscribe attempt was not faulted" };
}

async function transientClaimRecovery(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  let executionCount = 0;
  const session = await context.runner.spawn({
    recoverSubscriptions: true,
    rpcFaults: [
      {
        transport: "call",
        method: "claimMethodCall",
        occurrence: 1,
        message: "injected transient provider claim failure",
        code: "EAGAIN",
      },
    ],
    methods: {
      delivery_probe: {
        description: "Return a harmless delivery probe marker from the connected client.",
        parameters: z.object({}).strict(),
        execute: async () => {
          executionCount += 1;
          return { marker: "CLAIM_RECOVERY_OK", executionCount };
        },
      },
    },
  });
  let error: string | undefined;
  try {
    await context.sendAndWait(
      session,
      "Ask the connected client to run its harmless delivery probe and report the result.",
      "claim recovery turn"
    );
  } catch (cause) {
    error = formatError(cause);
  }
  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - startedAt,
    snapshot: session.snapshot(),
    diagnostics: {
      transientClaimRecovery: {
        executionCount,
        faults: context.runner.rpcFaultEvidence(session),
      },
    },
    ...(error ? { error } : {}),
  };
  await closeSession(session, execution);
  return execution;
}

function validateTransientClaimRecovery(result: TestExecutionResult) {
  const base = successfulExecution(result);
  if (!base.passed) return base;
  const probe = result.diagnostics?.["transientClaimRecovery"] as
    | { executionCount?: unknown }
    | undefined;
  if (probe?.executionCount !== 1) {
    return {
      passed: false,
      reason: `Expected exactly one provider execution after claim recovery; observed ${String(probe?.executionCount)}`,
    };
  }
  if (!injectedFault(result, "transientClaimRecovery", "claimMethodCall")) {
    return { passed: false, reason: "The provider claim RPC was not faulted" };
  }
  const calls = getToolCalls(result).filter((call) => call.name === "delivery_probe");
  const unique = new Set(calls.map((call) => call.id));
  return calls.length >= 1 && unique.size === 1 && calls.at(-1)?.execution?.status === "complete"
    ? { passed: true }
    : {
        passed: false,
        reason: "The recovered provider invocation did not settle once on its original identity",
      };
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not occur within ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminalAfterVesselRestart(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  let executionCount = 0;
  let releaseResult!: () => void;
  let markStarted!: () => void;
  const resultGate = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  const executionStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const session = await context.runner.spawn({
    methods: {
      delayed_delivery_probe: {
        description:
          "Return a delivery marker after the client finishes a short pending operation.",
        parameters: z.object({}).strict(),
        execute: async () => {
          executionCount += 1;
          markStarted();
          await resultGate;
          return { marker: "TERMINAL_AFTER_RESTART_OK", executionCount };
        },
      },
    },
  });
  let error: string | undefined;
  let aborted = false;
  try {
    const turn = context.sendAndWait(
      session,
      "Ask the connected client to run its delayed delivery probe and report the returned result.",
      "pending provider result turn"
    );
    await waitFor(executionStarted, 30_000, "provider execution");
    const targetId = session.agentTargetId;
    if (!targetId) throw new Error("Spawned test agent has no runtime target");
    const fault = await context.runner.faultAbortAgentVesselForReplayProbe(targetId);
    aborted = fault.aborted;
    releaseResult();
    await turn;
  } catch (cause) {
    releaseResult();
    error = formatError(cause);
  }
  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - startedAt,
    snapshot: session.snapshot(),
    diagnostics: {
      terminalAfterVesselRestart: { aborted, executionCount },
    },
    ...(error ? { error } : {}),
  };
  await closeSession(session, execution);
  return execution;
}

function validateTerminalAfterVesselRestart(result: TestExecutionResult) {
  const base = successfulExecution(result);
  if (!base.passed) return base;
  const probe = result.diagnostics?.["terminalAfterVesselRestart"] as
    | { aborted?: unknown; executionCount?: unknown }
    | undefined;
  if (probe?.aborted !== true || probe.executionCount !== 1) {
    return {
      passed: false,
      reason: `Expected one execution across an acknowledged vessel abort; observed ${JSON.stringify(probe)}`,
    };
  }
  const calls = getToolCalls(result).filter((call) => call.name === "delayed_delivery_probe");
  const unique = new Set(calls.map((call) => call.id));
  return calls.length >= 1 && unique.size === 1 && calls.at(-1)?.execution?.status === "complete"
    ? { passed: true }
    : {
        passed: false,
        reason: "The pending terminal was duplicated or did not settle after vessel recovery",
      };
}

interface ContextStorageSnapshot {
  envelopeCount: number;
  eventRows: number;
  mailboxRows: number;
  mailboxContextCopies: number;
}

function contextStorageFromDiagnostics(value: Record<string, unknown>): ContextStorageSnapshot {
  const channel = value["channelDelivery"] as Record<string, unknown> | undefined;
  const delivery = channel?.["delivery"] as Record<string, unknown> | undefined;
  const storage = delivery?.["contextStorage"] as Record<string, unknown> | undefined;
  const number = (input: unknown, label: string) => {
    if (typeof input !== "number" || !Number.isFinite(input)) {
      throw new Error(`Missing channel diagnostic ${label}`);
    }
    return input;
  };
  return {
    envelopeCount: number(channel?.["envelopeCount"], "envelopeCount"),
    eventRows: number(storage?.["eventRows"], "eventRows"),
    mailboxRows: number(storage?.["mailboxRows"], "mailboxRows"),
    mailboxContextCopies: number(storage?.["mailboxContextCopies"], "mailboxContextCopies"),
  };
}

async function contextStorageAfterWake(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const session = await context.runner.spawn();
  let before: ContextStorageSnapshot | undefined;
  let after: ContextStorageSnapshot | undefined;
  let aborted = false;
  let error: string | undefined;
  try {
    await context.sendAndWait(
      session,
      "Reply with one concise sentence confirming the first delivery.",
      "context storage baseline turn"
    );
    const channelId = session.channelId;
    const targetId = session.agentTargetId;
    if (!channelId || !targetId) throw new Error("Session lacks channel or agent identity");
    before = contextStorageFromDiagnostics(await context.runner.collectDiagnostics({ channelId }));
    const fault = await context.runner.faultAbortAgentVesselForReplayProbe(targetId);
    aborted = fault.aborted;
    await context.sendAndWait(
      session,
      "Reply with one different concise sentence confirming delivery after wake.",
      "context storage post-wake turn"
    );
    after = contextStorageFromDiagnostics(await context.runner.collectDiagnostics({ channelId }));
  } catch (cause) {
    error = formatError(cause);
  }
  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - startedAt,
    snapshot: session.snapshot(),
    diagnostics: {
      contextStorageAfterWake: { aborted, before, after },
    },
    ...(error ? { error } : {}),
  };
  await closeSession(session, execution);
  return execution;
}

function validateContextStorageAfterWake(result: TestExecutionResult) {
  const base = successfulExecution(result);
  if (!base.passed) return base;
  const probe = result.diagnostics?.["contextStorageAfterWake"] as
    | { aborted?: unknown; before?: ContextStorageSnapshot; after?: ContextStorageSnapshot }
    | undefined;
  const before = probe?.before;
  const after = probe?.after;
  if (probe?.aborted !== true || !before || !after) {
    return { passed: false, reason: "The context-storage wake probe did not complete" };
  }
  const envelopeDelta = after.envelopeCount - before.envelopeCount;
  const contextDelta = after.eventRows - before.eventRows;
  if (
    before.mailboxContextCopies !== 0 ||
    after.mailboxContextCopies !== 0 ||
    before.eventRows > before.envelopeCount ||
    after.eventRows > after.envelopeCount ||
    envelopeDelta <= 0 ||
    contextDelta <= 0 ||
    contextDelta > envelopeDelta ||
    after.mailboxRows <= 0
  ) {
    return {
      passed: false,
      reason: `Context storage was duplicated or copied per mailbox row: ${JSON.stringify(probe)}`,
    };
  }
  return { passed: true };
}

export const deliveryHardeningTests: TestCase[] = [
  {
    name: "delivery-first-connect-recovery",
    description: "A first subscription rejection recovers onto one ready conversation surface",
    category: "delivery-hardening",
    prompt: "Confirm that a conversation remains usable after its first connection attempt fails.",
    validation: "harness",
    orchestrate: firstConnectRecovery,
    validate: validateFirstConnectRecovery,
  },
  {
    name: "delivery-transient-claim-recovery",
    description: "A transient provider claim failure does not terminate the live subscription",
    category: "delivery-hardening",
    prompt: "Run a harmless connected-client operation despite a transient delivery claim failure.",
    validation: "harness",
    orchestrate: transientClaimRecovery,
    validate: validateTransientClaimRecovery,
  },
  {
    name: "delivery-terminal-after-vessel-restart",
    description: "An outstanding method terminal is delivered exactly once after vessel restart",
    category: "delivery-hardening",
    prompt: "Complete a connected-client operation across an agent restart without duplication.",
    validation: "harness",
    orchestrate: terminalAfterVesselRestart,
    validate: validateTerminalAfterVesselRestart,
  },
  {
    name: "delivery-context-storage-after-wake",
    description:
      "Wake recovery preserves one normalized context row per event without mailbox copies",
    category: "delivery-hardening",
    prompt: "Exchange messages across an agent wake and verify bounded durable context storage.",
    validation: "harness",
    orchestrate: contextStorageAfterWake,
    validate: validateContextStorageAfterWake,
  },
];
