import type { ChatMessage } from "@workspace/agentic-core";
import type { TestSuiteResult, TestSuiteResultEntry, ToolFailureSummary } from "./types.js";

export interface DiagnosticInvocation {
  id?: string;
  transportCallId?: string;
  name: string;
  status: string;
  terminalOutcome?: string;
  terminalReasonCode?: string;
  description?: string;
  error?: string;
  isError?: boolean;
  arguments?: Record<string, unknown>;
  result?: unknown;
  consoleOutput?: string;
  argumentSummary?: string;
  resultSummary?: string;
}

interface InvocationPayloadLike {
  id: string;
  transportCallId?: string;
  name: string;
  arguments: Record<string, unknown>;
  execution: {
    status: string;
    terminalOutcome?: string;
    terminalReasonCode?: string;
    description?: string;
    result?: unknown;
    isError?: boolean;
    consoleOutput?: string;
  };
}

export interface DiagnosticConversationItem {
  id?: string;
  who: "user" | "agent";
  type: string;
  kind?: string;
  contentType?: string;
  uiType: string;
  senderId?: string;
  senderName?: string;
  senderType?: string;
  complete?: boolean;
  pending?: boolean;
  error?: string;
  text: string;
  rawContent?: string;
  invocation?: DiagnosticInvocation;
  diagnostic?: {
    severity?: string;
    code?: string;
    title?: string;
    detail?: string;
    reason?: string;
  };
  lifecycle?: {
    status?: string;
    title?: string;
    detail?: string;
    reason?: string;
  };
  approval?: {
    id?: string;
    status?: string;
    question?: string;
    reason?: string;
  };
  custom?: {
    messageId?: string;
    typeId?: string;
    displayMode?: string;
    updateCount?: number;
    failed?: boolean;
    error?: string;
  };
  inlineUi?: {
    id?: string;
    sourceType?: string;
    path?: string;
  };
}

export interface FailureDiagnostic {
  name: string;
  category: string;
  passed: boolean;
  prompt: string;
  validationReason: string | null;
  sessionError: string | null;
  durationMs: number;
  modelExecution: {
    totalCalls: number;
    truncated: boolean;
    calls: Array<{
      ref: string;
      provider?: string;
      model?: string;
      api?: string;
      baseUrl?: string;
      auth?: string;
      outcome?: string;
      usage?: Record<string, unknown>;
    }>;
  } | null;
  finalAgentMessage: string | null;
  conversation: DiagnosticConversationItem[];
  invocations: DiagnosticInvocation[];
  toolFailures: ToolFailureSummary[];
  debugEvents: string[];
  cleanupErrors: string[];
  workspaceRepoFixture: {
    testName: string | null;
    projectName: string | null;
    repoNamePrefix: string | null;
    staleReposRemoved: string[];
    reposRemoved: string[];
    escapedRepos: string[];
    reposAfter: string[];
  } | null;
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
  shownFailureCount: number;
  truncatedFailureCount: number;
  failures: FailureDiagnostic[];
}

const DEFAULT_LIMITS = {
  failures: 3,
  messages: 6,
  invocations: 8,
  debugEvents: 8,
  text: 500,
};

export type DiagnosticLimits = typeof DEFAULT_LIMITS;

export function summarizeFailures(
  suite: TestSuiteResult,
  opts?: Partial<DiagnosticLimits>
): FailureReport {
  const limits = { ...DEFAULT_LIMITS, ...opts };
  const failed = suite.results.filter(
    (entry) =>
      !entry.result.passed ||
      (entry.execution.toolFailures ?? []).some((failure) => failure.expected !== true)
  );
  const failures = failed.slice(0, limits.failures).map((entry) => summarizeEntry(entry, limits));
  return {
    failureCount: failed.length,
    shownFailureCount: failures.length,
    truncatedFailureCount: Math.max(0, failed.length - failures.length),
    failures,
  };
}

/**
 * Bounded diagnostic for a single test entry — works for passing tests too, so
 * the stage report card can show transcript/tool detail for every test that ran.
 */
export function summarizeEntry(
  entry: TestSuiteResultEntry,
  opts?: Partial<DiagnosticLimits>
): FailureDiagnostic {
  return summarizeFailure(entry, { ...DEFAULT_LIMITS, ...opts });
}

function summarizeFailure(
  entry: TestSuiteResultEntry,
  limits: typeof DEFAULT_LIMITS
): FailureDiagnostic {
  const entryExecution = entry["execution"];
  const selfSenderId = entryExecution["messages"][0]?.senderId;
  const conversation = entryExecution["messages"]
    .slice(-limits.messages)
    .map((message) => summarizeMessage(message, selfSenderId, limits));
  const finalAgentMessage =
    clipOptional(findFinalAgentMessage(entryExecution["messages"]) ?? undefined, limits.text) ??
    null;
  const snapshot = entryExecution["snapshot"];
  const invocations = summarizeInvocations(
    entryExecution["messages"],
    snapshot?.invocations,
    limits
  );
  const debugEvents = (snapshot?.debugEvents ?? [])
    .slice(-limits.debugEvents)
    .map((event) => clip(safeJson(event), limits.text));
  const cleanupErrors = [
    ...(entryExecution["cleanupErrors"] ?? []),
    ...(snapshot?.cleanupErrors ?? []).map((error) => `${error.phase}: ${error.message}`),
  ].map((error) => clip(String(error), limits.text));
  const participants = Object.entries(snapshot?.participants ?? {}).map(([id, participant]) => ({
    id,
    name: participant.name,
    type: participant.type,
    handle: participant.handle,
    connected: participant.connected,
  }));
  const unexpectedToolFailures = (entryExecution["toolFailures"] ?? []).filter(
    (failure) => failure.expected !== true
  );

  return {
    name: entry.test.name,
    category: entry.test.category,
    passed: entry.result.passed,
    prompt: clip(entry.test.prompt, limits.text),
    validationReason: clipOptional(entry.result.reason, limits.text) ?? null,
    sessionError: clipOptional(entryExecution["error"], limits.text) ?? null,
    durationMs: entryExecution["duration"],
    modelExecution: summarizeModelExecution(
      entryExecution["modelExecutionEvidence"] ?? snapshot?.modelExecutionEvidence
    ),
    finalAgentMessage,
    conversation,
    invocations,
    toolFailures: (entryExecution["toolFailures"] ?? [])
      .slice(-limits.invocations)
      .map((failure) => ({
        ...failure,
        ...(failure.error ? { error: clip(failure.error, limits.text) } : {}),
      })),
    debugEvents,
    cleanupErrors,
    workspaceRepoFixture: summarizeWorkspaceRepoFixture(entryExecution["diagnostics"]),
    participants,
    likelyIssue: entry.result.passed
      ? unexpectedToolFailures.length > 0
        ? `tool-failure-observed:${unexpectedToolFailures.map((failure) => failure.name).join(",")}`
        : "passed"
      : classifyFailure(entry, finalAgentMessage, invocations, cleanupErrors),
  };
}

function summarizeWorkspaceRepoFixture(
  diagnostics: TestSuiteResultEntry["execution"]["diagnostics"]
): FailureDiagnostic["workspaceRepoFixture"] {
  const fixture = diagnostics?.["workspaceRepoFixture"];
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) return null;
  const record = fixture as Record<string, unknown>;
  const stringOrNull = (key: string): string | null =>
    typeof record[key] === "string" ? clip(record[key] as string, 240) : null;
  const strings = (key: string): string[] =>
    Array.isArray(record[key])
      ? (record[key] as unknown[])
          .filter((value): value is string => typeof value === "string")
          .slice(0, 20)
          .map((value) => clip(value, 240))
      : [];
  return {
    testName: stringOrNull("testName"),
    projectName: stringOrNull("projectName"),
    repoNamePrefix: stringOrNull("repoNamePrefix"),
    staleReposRemoved: strings("staleReposRemoved"),
    reposRemoved: strings("reposRemoved"),
    escapedRepos: strings("escapedRepos"),
    reposAfter: strings("reposAfter"),
  };
}

function summarizeModelExecution(value: unknown): FailureDiagnostic["modelExecution"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawCalls = Array.isArray(record["calls"]) ? record["calls"] : [];
  const calls = rawCalls
    .slice(-10)
    .filter((call): call is Record<string, unknown> => Boolean(call) && typeof call === "object")
    .map((call) => ({
      ref: String(call["ref"] ?? ""),
      ...(typeof call["provider"] === "string" ? { provider: call["provider"] } : {}),
      ...(typeof call["model"] === "string" ? { model: call["model"] } : {}),
      ...(typeof call["api"] === "string" ? { api: call["api"] } : {}),
      ...(typeof call["baseUrl"] === "string" ? { baseUrl: call["baseUrl"] } : {}),
      ...(typeof call["auth"] === "string" ? { auth: call["auth"] } : {}),
      ...(typeof call["outcome"] === "string" ? { outcome: call["outcome"] } : {}),
      ...(call["usage"] && typeof call["usage"] === "object" && !Array.isArray(call["usage"])
        ? { usage: call["usage"] as Record<string, unknown> }
        : {}),
    }));
  return {
    totalCalls: typeof record["totalCalls"] === "number" ? record["totalCalls"] : rawCalls.length,
    truncated: record["truncated"] === true || rawCalls.length > calls.length,
    calls,
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
  cleanupErrors: string[]
): string {
  if (entry["execution"]["error"]) return "session-error";
  if (cleanupErrors.length > 0) return "cleanup-error";
  const incomplete = invocations.filter((invocation) => invocation.status !== "complete");
  if (incomplete.length > 0)
    return `incomplete-invocation:${incomplete.map((i) => i.name).join(",")}`;
  const toolFailures = (entry.execution.toolFailures ?? []).filter(
    (failure) => failure.expected !== true
  );
  if (toolFailures.length > 0) return `tool-error:${toolFailures.map((i) => i.name).join(",")}`;
  const errored = invocations.filter((invocation) => invocation.error || invocation.isError);
  if (errored.length > 0) return `tool-error:${errored.map((i) => i.name).join(",")}`;
  if (!finalAgentMessage) return "no-final-agent-message";
  return "validation-mismatch";
}

function summarizeMessage(
  message: ChatMessage,
  selfSenderId: string | undefined,
  limits: typeof DEFAULT_LIMITS
): DiagnosticConversationItem {
  const invocation = invocationFromChatMessage(message, limits);
  const rawContent = clip(message.content ?? "", limits.text);
  const text = messageText(message, invocation, rawContent, limits.text);
  const diagnostic = message.diagnostic
    ? {
        severity: message.diagnostic.severity,
        code: message.diagnostic.code,
        title: message.diagnostic.title,
        detail: clipOptional(message.diagnostic.detail, limits.text),
        reason: clipOptional(message.diagnostic.reason, limits.text),
      }
    : undefined;
  const lifecycle = message.lifecycle
    ? {
        status: message.lifecycle.status,
        title: message.lifecycle.title,
        detail: clipOptional(message.lifecycle.detail, limits.text),
        reason: message.lifecycle.reason,
      }
    : undefined;
  const approval = message.approval
    ? {
        id: message.approval.id,
        status: message.approval.status,
        question: clipOptional(message.approval.question, limits.text),
        reason: clipOptional(message.approval.reason, limits.text),
      }
    : undefined;
  const custom = message.custom
    ? {
        messageId: message.custom.messageId,
        typeId: message.custom.typeId,
        displayMode: message.custom.displayMode,
        updateCount: message.custom.updates.length,
        failed: message.custom.failed,
        error: clipOptional(message.custom.error?.message, limits.text),
      }
    : undefined;
  const inlineUi = message.inlineUi
    ? {
        id: message.inlineUi.id,
        sourceType: message.inlineUi.source.type,
        path: message.inlineUi.source.type === "file" ? message.inlineUi.source.path : undefined,
      }
    : undefined;

  return {
    id: message.id,
    who: message.senderId === selfSenderId ? ("user" as const) : ("agent" as const),
    type: message.contentType ?? message.kind ?? "message",
    kind: message.kind,
    contentType: message.contentType,
    uiType: classifyMessageUiType(message),
    senderId: message.senderId,
    senderName: message.senderMetadata?.name,
    senderType: message.senderMetadata?.type,
    complete: message.complete,
    pending: message.pending,
    error: asString((message as { error?: unknown }).error),
    text,
    rawContent: rawContent && rawContent !== text ? rawContent : undefined,
    invocation,
    diagnostic,
    lifecycle,
    approval,
    custom,
    inlineUi,
  };
}

function summarizeInvocations(
  messages: ChatMessage[],
  snapshotInvocations: ReadonlyArray<unknown> | undefined,
  limits: typeof DEFAULT_LIMITS
): DiagnosticInvocation[] {
  const fromSnapshot = (snapshotInvocations ?? [])
    .slice(-limits.invocations)
    .map((invocation) => invocationFromSnapshot(invocation, limits));
  if (fromSnapshot.length > 0) return fromSnapshot;

  const fromMessages: DiagnosticInvocation[] = [];
  for (const message of messages) {
    if (message.contentType !== "invocation") continue;
    const invocation = invocationFromChatMessage(message, limits);
    if (invocation) fromMessages.push(invocation);
  }
  return fromMessages.slice(-limits.invocations);
}

function invocationFromSnapshot(
  invocation: unknown,
  limits: typeof DEFAULT_LIMITS
): DiagnosticInvocation {
  const inv = invocation as Record<string, unknown>;
  const execution = isRecord(inv["execution"]) ? inv["execution"] : {};
  const args = inv["arguments"] ?? inv["args"];
  const result = inv["result"] ?? execution["result"];
  return {
    id: asString(inv["id"]),
    name: asString(inv["name"]) ?? asString(inv["method"]) ?? "(unknown)",
    status: asString(inv["status"]) ?? asString(execution["status"]) ?? "(unknown)",
    error: asString(inv["error"]) ?? asString(execution["error"]),
    isError: typeof execution["isError"] === "boolean" ? execution["isError"] : undefined,
    arguments: isRecord(args) ? boundRecord(args, limits.text) : undefined,
    result: result === undefined ? undefined : boundValue(result, limits.text),
    consoleOutput: clipOptional(
      asString(inv["consoleOutput"]) ?? asString(execution["consoleOutput"]),
      limits.text
    ),
    argumentSummary: summarizeValue(args, limits.text),
    resultSummary: summarizeValue(result, limits.text),
  };
}

function invocationFromChatMessage(
  message: ChatMessage,
  limits: typeof DEFAULT_LIMITS
): DiagnosticInvocation | undefined {
  const payload =
    (message.invocation as InvocationPayloadLike | undefined) ??
    parseInvocationPayload(message.content);
  if (!payload) return undefined;
  const exec = payload.execution;
  return {
    id: payload.id,
    transportCallId: payload.transportCallId,
    name: payload.name,
    status: exec.status,
    terminalOutcome: exec.terminalOutcome,
    terminalReasonCode: exec.terminalReasonCode,
    description: clipOptional(exec.description, limits.text),
    error: exec.isError
      ? summarizeValue(exec.result ?? exec.description ?? message.error, limits.text)
      : clipOptional(message.error, limits.text),
    isError: exec.isError,
    arguments: boundRecord(payload.arguments ?? {}, limits.text),
    result: exec.result === undefined ? undefined : boundValue(exec.result, limits.text),
    consoleOutput: clipOptional(exec.consoleOutput, limits.text),
    argumentSummary: summarizeValue(payload.arguments, limits.text),
    resultSummary: summarizeValue(exec.result, limits.text),
  };
}

function parseInvocationPayload(content: string | undefined): InvocationPayloadLike | null {
  if (!content) return null;
  const parsed = parseJson(content);
  if (!isRecord(parsed)) return null;
  if (typeof parsed["id"] !== "string" || typeof parsed["name"] !== "string") return null;
  const execution = parsed["execution"];
  if (!isRecord(execution) || typeof execution["status"] !== "string") return null;
  return {
    id: parsed["id"],
    transportCallId: asString(parsed["transportCallId"]),
    name: parsed["name"],
    arguments: isRecord(parsed["arguments"]) ? parsed["arguments"] : {},
    execution: {
      status: execution["status"],
      terminalOutcome: asString(execution["terminalOutcome"]),
      terminalReasonCode: asString(execution["terminalReasonCode"]),
      description: asString(execution["description"]) ?? "",
      result: execution["result"],
      isError: typeof execution["isError"] === "boolean" ? execution["isError"] : undefined,
      consoleOutput: asString(execution["consoleOutput"]),
    },
  };
}

function classifyMessageUiType(message: ChatMessage): string {
  if (message.contentType === "invocation") return "invocation";
  if (message.contentType === "thinking") return "thinking";
  if (message.contentType === "typing") return "typing";
  if (message.custom) return "custom";
  if (message.approval) return "approval";
  if (message.inlineUi) return "inline-ui";
  if (message.credentialRequest) return "credential-request";
  if (message.lifecycle) return "lifecycle";
  if (message.diagnostic) return "diagnostic";
  if (message.kind === "system") return "system";
  return "message";
}

function messageText(
  message: ChatMessage,
  invocation: DiagnosticInvocation | undefined,
  rawContent: string,
  limit: number
): string {
  if (invocation) {
    return clip(
      invocation.description ||
        invocation.argumentSummary ||
        invocation.resultSummary ||
        `${invocation.name} ${invocation.status}`,
      limit
    );
  }
  if (message.diagnostic) {
    return clip(
      [message.diagnostic.title, message.diagnostic.detail].filter(Boolean).join("\n"),
      limit
    );
  }
  if (message.lifecycle) {
    return clip(
      [message.lifecycle.title, message.lifecycle.detail].filter(Boolean).join("\n"),
      limit
    );
  }
  if (message.approval) return clip(message.approval.question ?? message.approval.status, limit);
  if (message.custom) return clip(`${message.custom.typeId} custom message`, limit);
  if (message.inlineUi) return clip(`Inline UI ${message.inlineUi.id}`, limit);
  return rawContent;
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

function clipOptional(value: string | undefined, limit: number): string | undefined {
  return value === undefined ? undefined : clip(value, limit);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function boundRecord(value: Record<string, unknown>, stringLimit: number): Record<string, unknown> {
  return boundValue(value, stringLimit) as Record<string, unknown>;
}

function boundValue(
  value: unknown,
  stringLimit: number,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === "string") return clip(value, stringLimit);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    if (depth >= 2) return `[Array(${value.length})]`;
    const items = value.slice(0, 10).map((item) => boundValue(item, stringLimit, depth + 1, seen));
    if (value.length > items.length) items.push(`[... ${value.length - items.length} more]`);
    return items;
  }

  const entries = Object.entries(value);
  if (depth >= 2) return `{Object(${entries.length})}`;
  const out: Record<string, unknown> = {};
  for (const [key, child] of entries.slice(0, 12)) {
    out[key] = boundValue(child, stringLimit, depth + 1, seen);
  }
  if (entries.length > 12) out["..."] = `${entries.length - 12} more keys`;
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
