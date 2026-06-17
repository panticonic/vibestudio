import type { EventName } from "./events.js";
import type { HostTarget, HostTargetLaunchSessionSnapshot } from "./hostTargets.js";

export const HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT =
  "host-target-launch:session-changed" as const;

export const HOST_TARGET_LAUNCH_SESSION_WAKE_EVENTS = [
  HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT,
] satisfies EventName[];

export type LaunchGateDecision = "once" | "deny";

export function normalizeLaunchEventName(raw: string): EventName | null {
  const name = raw.startsWith("event:") ? raw.slice("event:".length) : raw;
  return HOST_TARGET_LAUNCH_SESSION_WAKE_EVENTS.some((event) => event === name)
    ? (name as EventName)
    : null;
}

export function isLaunchSessionEventFor(
  sessionId: string,
  rawEventName: string,
  payload?: unknown
): payload is HostTargetLaunchSessionSnapshot {
  const eventName = normalizeLaunchEventName(rawEventName);
  return (
    eventName === HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT &&
    asLaunchSessionPayload(payload)?.sessionId === sessionId
  );
}

export function isLaunchSessionEventForTarget(
  target: HostTarget,
  rawEventName: string,
  payload?: unknown
): payload is HostTargetLaunchSessionSnapshot {
  const eventName = normalizeLaunchEventName(rawEventName);
  return (
    eventName === HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT &&
    asLaunchSessionPayload(payload)?.target === target
  );
}

function asLaunchSessionPayload(payload: unknown): HostTargetLaunchSessionSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const target = (payload as { target?: unknown }).target;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  if (target !== "electron" && target !== "react-native" && target !== "terminal") return null;
  if (typeof sessionId !== "string") return null;
  return payload as HostTargetLaunchSessionSnapshot;
}
