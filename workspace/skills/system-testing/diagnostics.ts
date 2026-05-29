import type { ChatMessage } from "@workspace/agentic-core";
import type { TestSuiteResult, TestSuiteResultEntry } from "./types.js";

export interface FailureDiagnostic {
  name: string;
  category: string;
  prompt: string;
  validationReason: string | null;
  sessionError: string | null;
  durationMs: number;
  finalAgentMessage: string | null;
  conversation: Array<{
    who: "user" | "agent";
    type: string;
    complete?: boolean;
    pending?: boolean;
    error?: string;
    text: string;
  }>;
  invocations: Array<{
    name: string;
    status: string;
    error?: string;
    isError?: boolean;
    argumentSummary?: string;
    resultSummary?: string;
  }>;
  debugEvents: string[];
  cleanupErrors: string[];
  participants: Array<{
    id: string;
    name?: string;
    type?: string;
    handle?: string;
    connected?: boolean;
  }>;
  likelyIssue: string;
}

export interface FailureReport {
  failureCount: number;
  failures: FailureDiagnostic[];
}

const DEFAULT_LIMITS = {
  failures: 12,
  messages: 12,
  invocations: 20,
  debugEvents: 20,
  text: 900,
};

export function summarizeFailures(
  suite: TestSuiteResult,
  opts?: Partial<typeof DEFAULT_LIMITS>,
): FailureReport {
  const limits = { ...DEFAULT_LIMITS, ...opts };
  const failed = suite.results.filter((entry) => !entry.result.passed);
  return {
    failureCount: failed.length,
    failures: failed.slice(0, limits.failures).map((entry) => summarizeFailure(entry, limits)),
  };
}

function summarizeFailure(
  entry: TestSuiteResultEntry,
  limits: typeof DEFAULT_LIMITS,
): FailureDiagnostic {
  const entryExecution = entry["execution"];
  const selfSenderId = entryExecution["messages"][0]?.senderId;
  const conversation = entryExecution["messages"].slice(-limits.messages).map((message) => ({
    who: message.senderId === selfSenderId ? "user" as const : "agent" as const,
    type: message.contentType ?? message.kind ?? "message",
    complete: message.complete,
    pending: message.pending,
    error: asString((message as { error?: unknown }).error),
    text: clip(message.content ?? "", limits.text),
  }));
  const finalAgentMessage = findFinalAgentMessage(entryExecution["messages"]);
  const snapshot = entryExecution["snapshot"];
  const invocations = (snapshot?.invocations ?? []).slice(-limits.invocations).map((invocation) => {
    const inv = invocation as Record<string, unknown>;
    const execution = isRecord(inv["execution"]) ? inv["execution"] : {};
    return {
      name: asString(inv["name"]) ?? asString(inv["method"]) ?? "(unknown)",
      status: asString(inv["status"]) ?? asString(execution["status"]) ?? "(unknown)",
      error: asString(inv["error"]) ?? asString(execution["error"]),
      isError: typeof execution["isError"] === "boolean" ? execution["isError"] : undefined,
      argumentSummary: summarizeValue(inv["arguments"] ?? inv["args"], limits.text),
      resultSummary: summarizeValue(inv["result"] ?? execution["result"], limits.text),
    };
  });
  const debugEvents = (snapshot?.debugEvents ?? [])
    .slice(-limits.debugEvents)
    .map((event) => clip(safeJson(event), limits.text));
  const cleanupErrors = [
    ...(entryExecution["cleanupErrors"] ?? []),
    ...((snapshot?.cleanupErrors ?? []).map((error) => `${error.phase}: ${error.message}`)),
  ];
  const participants = Object.entries(snapshot?.participants ?? {}).map(([id, participant]) => ({
    id,
    name: participant.name,
    type: participant.type,
    handle: participant.handle,
    connected: participant.connected,
  }));

  return {
    name: entry.test.name,
    category: entry.test.category,
    prompt: entry.test.prompt,
    validationReason: entry.result.reason ?? null,
    sessionError: entryExecution["error"] ?? null,
    durationMs: entryExecution["duration"],
    finalAgentMessage,
    conversation,
    invocations,
    debugEvents,
    cleanupErrors,
    participants,
    likelyIssue: classifyFailure(entry, finalAgentMessage, invocations, cleanupErrors),
  };
}

function findFinalAgentMessage(messages: ChatMessage[]): string | null {
  const selfSenderId = messages[0]?.senderId;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (
      message.senderId !== selfSenderId &&
      message.kind === "message" &&
      message.complete &&
      message.contentType !== "thinking" &&
      message.contentType !== "invocation" &&
      !message.pending
    ) {
      return clip(message.content ?? "", DEFAULT_LIMITS.text);
    }
  }
  return null;
}

function classifyFailure(
  entry: TestSuiteResultEntry,
  finalAgentMessage: string | null,
  invocations: FailureDiagnostic["invocations"],
  cleanupErrors: string[],
): string {
  if (entry["execution"]["error"]) return "session-error";
  if (cleanupErrors.length > 0) return "cleanup-error";
  const incomplete = invocations.filter((invocation) => invocation.status !== "complete");
  if (incomplete.length > 0) return `incomplete-invocation:${incomplete.map((i) => i.name).join(",")}`;
  const errored = invocations.filter((invocation) => invocation.error || invocation.isError);
  if (errored.length > 0) return `tool-error:${errored.map((i) => i.name).join(",")}`;
  if (!finalAgentMessage) return "no-final-agent-message";
  return "validation-mismatch";
}

function summarizeValue(value: unknown, limit: number): string | undefined {
  if (value === undefined) return undefined;
  return clip(typeof value === "string" ? value : safeJson(value), limit);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}... [truncated ${value.length - limit} chars]`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
