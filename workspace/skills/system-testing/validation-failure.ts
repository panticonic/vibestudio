import type { ChatMessage } from "@workspace/agentic-core";
import { serializeSystemTestStack, type SystemTestJsonValue } from "./structured-error.js";
import type { TestCase, TestExecutionResult, ValidationFailureProvenance } from "./types.js";

const MAX_INVOCATIONS = 40;
const MAX_SHAPE_DEPTH = 6;
const MAX_KEYS = 40;
const MAX_ARRAY_ITEMS = 5;

/** Capture protocol shape, not conversation content or scalar payload data. */
export function projectValidationInput(execution: TestExecutionResult): SystemTestJsonValue {
  const invocations = execution.messages
    .filter((message) => message.contentType === "invocation")
    .slice(-MAX_INVOCATIONS)
    .map(invocationProjection);
  return {
    messageCount: execution.messages.length,
    messageKinds: counts(
      execution.messages
        .map((message) => message.contentType ?? message.kind)
        .filter((kind): kind is string => typeof kind === "string")
    ),
    invocations,
    snapshot: execution.snapshot
      ? {
          present: true,
          invocationCount: execution.snapshot.invocations.length,
          debugEventCount: execution.snapshot.debugEvents.length,
          cleanupErrorCount: execution.snapshot.cleanupErrors.length,
        }
      : { present: false },
    toolFailureCount: execution.toolFailures?.length ?? 0,
  };
}

export function validationFailureProvenance(input: {
  test: TestCase;
  error: unknown;
  inputProjection: SystemTestJsonValue;
}): ValidationFailureProvenance {
  const stack = serializeSystemTestStack(input.error);
  return {
    testName: input.test.name,
    validator:
      input.test.validation === "harness"
        ? "harness"
        : input.test.validation === "agent-evidence"
          ? "agent-evidence"
          : "agent-completion-report",
    phase: "validation",
    ...(stack ? { stack } : {}),
    inputProjection: input.inputProjection,
  };
}

function invocationProjection(message: ChatMessage): SystemTestJsonValue {
  const payload = invocationPayload(message);
  const execution = record(payload?.["execution"]);
  return {
    name: typeof payload?.["name"] === "string" ? payload["name"] : "[missing]",
    status: typeof execution?.["status"] === "string" ? execution["status"] : "[missing]",
    isError: execution?.["isError"] === true,
    arguments: shape(payload?.["arguments"], 0),
    result: shape(execution?.["result"], 0),
  };
}

function invocationPayload(message: ChatMessage): Record<string, unknown> | null {
  const embedded = record((message as { invocation?: unknown }).invocation);
  if (embedded) return embedded;
  try {
    return record(JSON.parse(message.content ?? ""));
  } catch {
    return null;
  }
}

function shape(value: unknown, depth: number): SystemTestJsonValue {
  if (value === undefined) return "undefined";
  if (value === null) return null;
  if (Array.isArray(value)) {
    if (depth >= MAX_SHAPE_DEPTH) return "array";
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => shape(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push("[truncated]");
    return { type: "array", length: value.length, items };
  }
  if (typeof value === "object") {
    if (depth >= MAX_SHAPE_DEPTH) return "object";
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS);
    const fields: Record<string, SystemTestJsonValue> = {};
    for (const [key, child] of entries) fields[key] = shape(child, depth + 1);
    if (Object.keys(value).length > MAX_KEYS) fields["$truncated"] = true;
    return { type: "object", fields };
  }
  return typeof value;
}

function counts(values: string[]): Record<string, SystemTestJsonValue> {
  const result: Record<string, SystemTestJsonValue> = {};
  for (const value of values) result[value] = Number(result[value] ?? 0) + 1;
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
