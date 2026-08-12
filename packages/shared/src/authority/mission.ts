import { createHash } from "node:crypto";
import type { ResourceScope } from "@vibestudio/rpc";
import { canonicalJson } from "../canonicalJson.js";
import { normalizeWorkspaceRepoPath } from "../runtime/entitySpec.js";
import {
  canonicalCronExpression,
  canonicalCronTimeZone,
  cronNextOccurrence,
} from "./cronSchedule.js";

export type MissionState =
  | "draft"
  | "active"
  | "needs-reapproval"
  | "paused"
  | "completed"
  | "retired";

export type MissionCompletionReason = "until" | "max-runs" | "response";

export const MISSION_COMPLETION_PROTOCOL = "automation-completion.v1" as const;

export interface MissionCompletionResponse {
  protocol: typeof MISSION_COMPLETION_PROTOCOL;
  response: string;
}

export interface MissionTarget {
  source: string;
  className: string;
  objectKey: string;
}

export interface MissionToolExposure {
  services: readonly string[];
  userlandServices: readonly {
    name: string;
    provider: string;
    providerEv: string;
    upgradePolicy: "pinned" | "follow-head";
  }[];
  workspaceServiceDiscovery: "bound" | "live-declarations";
  evalNetwork: "none" | "declared-origins" | "unrestricted";
  declaredOrigins: readonly string[];
}

export type MissionAgentAction =
  | { kind: "prompt"; text: string }
  | {
      kind: "eval";
      code: string;
      syntax?: "javascript" | "typescript" | "jsx" | "tsx";
      timeoutMs?: number;
      reset?: boolean;
    };

export type MissionExecution =
  | {
      kind: "method";
      target: MissionTarget;
      method: string;
      args: readonly unknown[];
    }
  | {
      kind: "agent";
      target: MissionTarget;
      action: MissionAgentAction;
      conversation: { mode: "continue"; channelId: string; contextId: string } | { mode: "fresh" };
      toolExposure: MissionToolExposure;
      declaredLineageClasses: readonly (
        | "none"
        | "web"
        | "email"
        | "channel-external"
        | "external"
      )[];
    };

/** Shared termination rules for interval and timezone-aware calendar schedules. */
interface MissionTerminationPolicy {
  /** No new run starts at or after this epoch-millisecond boundary. */
  untilAt?: number;
  /** Maximum admitted executions. Failed runs count; overlap skips do not. */
  maxRuns?: number;
}

export type MissionTrigger =
  | { kind: "manual" }
  | ({
      kind: "schedule";
      everyMs: number;
      anchorAt?: number;
      jitterMs?: number;
    } & MissionTerminationPolicy)
  | ({
      /** Five-field Vixie cron expression evaluated in one IANA timezone. */
      kind: "cron";
      expression: string;
      timezone: string;
    } & MissionTerminationPolicy);

export interface MissionCharter {
  summary: string;
  harness: { unit: string; ev: string };
  execution: MissionExecution;
  trigger: MissionTrigger;
}

export interface MissionRecord {
  missionId: string;
  name: string;
  revision: number;
  charter: MissionCharter;
  owner: { userId: string; deviceId: string };
  state: MissionState;
  revisionDigest: string;
  createdAt: number;
  updatedAt: number;
  /** First time a human activated this automation. Draft creation is not activation. */
  activatedAt?: number;
  runCount: number;
  completedAt?: number;
  completionReason?: MissionCompletionReason;
  completionResponse?: string;
  seeded?: boolean;
  permissions: readonly MissionPermission[];
  standingRestrictions: readonly MissionStandingRestriction[];
  nextRunAt?: number;
  lastRunAt?: number;
}

export interface MissionPermission {
  capability: string;
  resource: ResourceScope;
  tier: "gated" | "critical";
}

export interface MissionStandingRestriction {
  capability: string;
  resourceKey: string;
}

export type MissionRunStatus = "starting" | "running" | "succeeded" | "failed" | "skipped";

export interface MissionRunRecord {
  runId: string;
  missionId: string;
  closureDigest: string;
  revision: number;
  trigger: "manual" | "scheduled";
  status: MissionRunStatus;
  startedAt: number;
  runNumber?: number;
  finishedAt?: number;
  sessionId?: string;
  channelId?: string;
  contextId?: string;
  executorId?: string;
  finalMessage?: string;
  completionResponse?: string;
  error?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MIN_SCHEDULE_INTERVAL_MS = 60_000;
const MAX_CHARTER_BYTES = 128 * 1_024;

export function validateMissionCharter(charter: MissionCharter): void {
  if (new TextEncoder().encode(canonicalJson(charter)).byteLength > MAX_CHARTER_BYTES) {
    throw new Error(`Automation charter exceeds ${MAX_CHARTER_BYTES} bytes`);
  }
  if (!charter.summary.trim() || !charter.harness.unit || !HEX64.test(charter.harness.ev)) {
    throw new Error("Automation charter requires a summary and an exact harness EV");
  }
  try {
    normalizeWorkspaceRepoPath(charter.harness.unit);
  } catch {
    throw new Error(
      `Automation harness must name one canonical workspace repo: ${JSON.stringify(charter.harness.unit)}`
    );
  }
  validateTarget(charter.execution.target);
  if (charter.execution.target.source !== charter.harness.unit) {
    throw new Error("Automation harness unit must equal the execution target source");
  }
  if (charter.execution.kind === "method") {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(charter.execution.method)) {
      throw new Error("Automation method must be one canonical RPC method name");
    }
  } else {
    validateAgentExecution(charter.execution);
  }
  if (charter.trigger.kind === "schedule") {
    if (
      !Number.isSafeInteger(charter.trigger.everyMs) ||
      charter.trigger.everyMs < MIN_SCHEDULE_INTERVAL_MS
    ) {
      throw new Error("Automation schedule everyMs must be an integer of at least one minute");
    }
    if (
      charter.trigger.anchorAt !== undefined &&
      (!Number.isSafeInteger(charter.trigger.anchorAt) || charter.trigger.anchorAt < 0)
    ) {
      throw new Error("Automation schedule anchorAt must be a non-negative epoch millisecond");
    }
    if (
      charter.trigger.jitterMs !== undefined &&
      (!Number.isSafeInteger(charter.trigger.jitterMs) ||
        charter.trigger.jitterMs < 0 ||
        charter.trigger.jitterMs >= charter.trigger.everyMs)
    ) {
      throw new Error("Automation schedule jitterMs must be smaller than everyMs");
    }
  }
  if (charter.trigger.kind === "cron") {
    const expression = canonicalCronExpression(charter.trigger.expression);
    if (expression !== charter.trigger.expression) {
      throw new Error(`Automation cron expression must be canonical: ${expression}`);
    }
    const timezone = canonicalCronTimeZone(charter.trigger.timezone);
    if (timezone !== charter.trigger.timezone) {
      throw new Error(`Automation cron timezone must be canonical IANA timezone ${timezone}`);
    }
    cronNextOccurrence(expression, timezone, Date.UTC(2024, 0, 1));
  }
  if (charter.trigger.kind !== "manual") {
    if (
      charter.trigger.untilAt !== undefined &&
      (!Number.isSafeInteger(charter.trigger.untilAt) || charter.trigger.untilAt < 0)
    ) {
      throw new Error("Automation untilAt must be a non-negative epoch millisecond");
    }
    if (
      charter.trigger.maxRuns !== undefined &&
      (!Number.isSafeInteger(charter.trigger.maxRuns) || charter.trigger.maxRuns < 1)
    ) {
      throw new Error("Automation maxRuns must be a positive integer");
    }
  }
}

function validateTarget(target: MissionTarget): void {
  if (!target.source || !target.className || !target.objectKey) {
    throw new Error("Automation execution target requires source, className, and objectKey");
  }
  try {
    normalizeWorkspaceRepoPath(target.source);
  } catch {
    throw new Error(
      `Automation target must name one canonical workspace repo: ${JSON.stringify(target.source)}`
    );
  }
}

function validateAgentExecution(execution: Extract<MissionExecution, { kind: "agent" }>): void {
  if (execution.action.kind === "prompt" && !execution.action.text.trim()) {
    throw new Error("Prompt automation requires prompt text");
  }
  if (execution.action.kind === "eval") {
    if (!execution.action.code.trim()) {
      throw new Error("Eval automation requires inline code");
    }
    if (
      execution.action.timeoutMs !== undefined &&
      (!Number.isSafeInteger(execution.action.timeoutMs) || execution.action.timeoutMs <= 0)
    ) {
      throw new Error("Eval automation timeoutMs must be a positive integer");
    }
  }
  if (
    execution.conversation.mode === "continue" &&
    (!execution.conversation.channelId || !execution.conversation.contextId)
  ) {
    throw new Error("A continuing agent automation requires a channel and context");
  }
  const serviceSet = new Set<string>();
  for (const service of execution.toolExposure.services) {
    if (!service || service === "*" || service.includes("\0") || serviceSet.has(service)) {
      throw new Error(
        `Invalid or duplicate automation service exposure ${JSON.stringify(service)}`
      );
    }
    serviceSet.add(service);
  }
  for (const binding of execution.toolExposure.userlandServices) {
    if (!binding.name || !binding.provider) {
      throw new Error("Automation userland bindings must be resolved");
    }
    if (binding.upgradePolicy === "pinned" && !HEX64.test(binding.providerEv)) {
      throw new Error(`Pinned automation provider ${binding.provider} requires an exact EV`);
    }
    if (binding.upgradePolicy === "follow-head" && binding.providerEv !== "@follow-head") {
      throw new Error(`Follow-head automation provider ${binding.provider} must use @follow-head`);
    }
  }
  if (
    execution.toolExposure.workspaceServiceDiscovery === "live-declarations" &&
    execution.toolExposure.userlandServices.length > 0
  ) {
    throw new Error(
      "Live workspace-service discovery cannot be combined with pinned automation bindings"
    );
  }
  if (
    execution.toolExposure.evalNetwork === "declared-origins" &&
    execution.toolExposure.declaredOrigins.length === 0
  ) {
    throw new Error("Declared-origins automation network exposure requires at least one origin");
  }
  for (const origin of execution.toolExposure.declaredOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) {
      throw new Error(`Automation network origin is not canonical: ${origin}`);
    }
  }
  if (
    execution.declaredLineageClasses.length === 0 ||
    new Set(execution.declaredLineageClasses).size !== execution.declaredLineageClasses.length
  ) {
    throw new Error("Agent automation requires distinct declared data-flow classes");
  }
}

/** First scheduled occurrence strictly after `now`. */
export function missionNextRunAt(
  trigger: Exclude<MissionTrigger, { kind: "manual" }>,
  now: number,
  cadenceOrigin = now
): number {
  if (trigger.kind === "cron") {
    return cronNextOccurrence(trigger.expression, trigger.timezone, now);
  }
  const anchorAt = trigger.anchorAt ?? cadenceOrigin;
  if (anchorAt > now) return anchorAt;
  const elapsed = now - anchorAt;
  return anchorAt + (Math.floor(elapsed / trigger.everyMs) + 1) * trigger.everyMs;
}

export function missionCompletionResponse(value: unknown): MissionCompletionResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { protocol?: unknown; response?: unknown };
  if (
    candidate.protocol !== MISSION_COMPLETION_PROTOCOL ||
    typeof candidate.response !== "string" ||
    !candidate.response.trim()
  ) {
    return null;
  }
  return { protocol: MISSION_COMPLETION_PROTOCOL, response: candidate.response.trim() };
}

/**
 * Content address of the complete approved authority closure. Identity, owner,
 * display, lifecycle state, and time are deliberately excluded.
 */
export function missionClosureDigest(
  charter: MissionCharter,
  permissions: readonly MissionPermission[],
  standingRestrictions: readonly MissionStandingRestriction[]
): string {
  validateMissionCharter(charter);
  return createHash("sha256")
    .update("automation-closure-v3\0", "utf8")
    .update(canonicalJson({ charter, permissions, standingRestrictions }), "utf8")
    .digest("hex");
}

export function missionAllowsService(charter: MissionCharter, qualifiedMethod: string): boolean {
  if (charter.execution.kind !== "agent") return false;
  return charter.execution.toolExposure.services.some(
    (entry) =>
      entry === qualifiedMethod ||
      (entry.endsWith(".*") && qualifiedMethod.startsWith(entry.slice(0, -1)))
  );
}
