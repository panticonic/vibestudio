export const AGENTIC_PROTOCOL_VERSION = "agentic.trajectory.v1" as const;

export const AGENTIC_EVENT_PAYLOAD_KIND = "agentic.trajectory.v1/event" as const;

export const GENESIS_EVENT_HASH = "0".repeat(64);

export const TERMINAL_MESSAGE_KINDS = ["message.completed", "message.failed"] as const;

export const TERMINAL_INVOCATION_KINDS = [
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
] as const;

export const INVOCATION_OUTCOMES = [
  "success",
  "tool_error",
  "infrastructure_error",
  "cancelled",
  "stale_dispatch",
  "abandoned",
] as const;

export type InvocationOutcome = (typeof INVOCATION_OUTCOMES)[number];

export type TerminalInvocationKind = (typeof TERMINAL_INVOCATION_KINDS)[number];

export const TURN_REASON_CODES = [
  "user_interrupted",
  "channel_unsubscribe",
  "runner_restarted",
  "work_failed",
  "model_credential_required",
  "model_credential_reconnect_required",
] as const;

export type TurnReasonCode = (typeof TURN_REASON_CODES)[number];

export const LIFECYCLE_MESSAGE_REASON_CODES = [
  "runner_restarted_before_model",
  "runner_restarted_mid_model",
  "recovery_continue_failed",
  "model_credential_required",
] as const;

export type LifecycleMessageReasonCode = (typeof LIFECYCLE_MESSAGE_REASON_CODES)[number];

export function isInvocationOutcome(value: unknown): value is InvocationOutcome {
  return INVOCATION_OUTCOMES.includes(value as InvocationOutcome);
}

export function isTurnReasonCode(value: unknown): value is TurnReasonCode {
  return TURN_REASON_CODES.includes(value as TurnReasonCode);
}

export function isLifecycleMessageReasonCode(value: unknown): value is LifecycleMessageReasonCode {
  return LIFECYCLE_MESSAGE_REASON_CODES.includes(value as LifecycleMessageReasonCode);
}

export function isTerminalInvocationKind(value: unknown): value is TerminalInvocationKind {
  return TERMINAL_INVOCATION_KINDS.includes(value as TerminalInvocationKind);
}

export function invocationTerminalKindForOutcome(
  outcome: InvocationOutcome
): TerminalInvocationKind {
  switch (outcome) {
    case "success":
      return "invocation.completed";
    case "tool_error":
    case "infrastructure_error":
      return "invocation.failed";
    case "cancelled":
    case "stale_dispatch":
      return "invocation.cancelled";
    case "abandoned":
      return "invocation.abandoned";
  }
}

export function validateInvocationTerminalOutcomeForKind(
  kind: unknown,
  outcome: unknown
): { valid: true } | { valid: false; message: string } {
  if (!isTerminalInvocationKind(kind)) return { valid: true };
  if (!isInvocationOutcome(outcome)) {
    return { valid: false, message: `${kind} requires payload.terminalOutcome` };
  }
  const expectedKind = invocationTerminalKindForOutcome(outcome);
  if (expectedKind !== kind) {
    return {
      valid: false,
      message: `terminalOutcome ${outcome} is inconsistent with ${kind}`,
    };
  }
  return { valid: true };
}

export const TERMINAL_APPROVAL_KINDS = ["approval.resolved"] as const;

export const TURN_SCOPED_OWNER_KINDS = [
  "message.started",
  "message.delta",
  "message.completed",
  "message.failed",
  "invocation.started",
  "invocation.progress",
  "invocation.output",
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
  "approval.requested",
  "approval.resolved",
  "turn.opened",
  "turn.waiting",
  "turn.closed",
] as const;
