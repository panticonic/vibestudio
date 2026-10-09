import { sha256HexSyncText } from "@vibestudio/content-addressing";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import {
  canonicalCronExpression,
  canonicalCronTimeZone,
  cronNextOccurrence,
} from "./cronSchedule.js";

export const MISSION_SCHEMA_VERSION = 3 as const;
export const MISSION_AUTHORITY_PLAN_SCHEMA_VERSION = 2 as const;
export const MISSION_COMPLETION_PROTOCOL = "automation-completion.v1" as const;

export type MissionState = "active" | "paused" | "completed" | "retired";
export type MissionCompletionReason = "until" | "max-runs" | "response";

export interface MissionCompletionResponse {
  protocol: typeof MISSION_COMPLETION_PROTOCOL;
  response: string;
}

export interface MissionExecutionImage {
  source: string;
  ref: `state:${string}`;
  effectiveVersion: string;
  className: string;
  objectKey: string;
}

export interface MissionOperationIntent {
  service: string;
  method: string;
  args?: readonly unknown[];
  use: "action" | "conditional";
}

export interface MissionAuthorityPlanReference {
  schemaVersion: typeof MISSION_AUTHORITY_PLAN_SCHEMA_VERSION;
  digest: string;
  artifactRef: `authority-plan:${string}`;
  compilerVersion: string;
  catalogDigest: string;
}

export type MissionAgentAction =
  | { kind: "prompt"; text: string }
  | { kind: "notify"; text: string; title?: string; alert?: "inbox" | "interrupt" }
  | {
      kind: "eval" | "watch";
      code: string;
      syntax?: "javascript" | "typescript" | "jsx" | "tsx";
      timeoutMs?: number;
      reset?: boolean;
    };

export type MissionExecution =
  | {
      kind: "method";
      image: MissionExecutionImage;
      method: string;
      args: readonly unknown[];
      operations: readonly MissionOperationIntent[];
    }
  | {
      kind: "agent";
      image: MissionExecutionImage;
      action: MissionAgentAction;
      conversation:
        | {
            mode: "continue";
            channelId: string;
            contextId: string;
            executorId: string;
          }
        | { mode: "fresh" };
      operations: readonly MissionOperationIntent[];
    };

interface MissionTerminationPolicy {
  untilAt?: number;
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
      kind: "cron";
      expression: string;
      timezone: string;
    } & MissionTerminationPolicy);

export interface MissionCharter {
  summary: string;
  execution: MissionExecution;
  trigger: MissionTrigger;
}

export interface MissionAuthorityProjection {
  requestIds: readonly string[];
  grantIds: readonly string[];
  denialIds: readonly string[];
}

export interface MissionRecord {
  schemaVersion: typeof MISSION_SCHEMA_VERSION;
  missionId: string;
  name: string;
  revision: number;
  charter: MissionCharter;
  authorityPlan: MissionAuthorityPlanReference;
  owner: { userId: string };
  state: MissionState;
  revisionDigest: string;
  authority: MissionAuthorityProjection;
  createdAt: number;
  updatedAt: number;
  activatedAt: number;
  runCount: number;
  completedAt?: number;
  completionReason?: MissionCompletionReason;
  completionResponse?: string;
  seeded?: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
}

export type MissionRunPhase =
  | "admitted"
  | "execution-admitting"
  | "context-preparing"
  | "executor-preparing"
  | "dispatching"
  | "executing"
  | "terminal";

export type MissionRunOutcome =
  | "succeeded"
  | "completed-with-errors"
  | "failed"
  | "skipped"
  | "interrupted"
  | "cancelled";

export interface MissionRunFailure {
  code: string;
  stage: string;
  message: string;
  retry: "automatic" | "manual" | "none";
  invocationId?: string;
  executorId?: string;
  causalEventRef?: string;
  detailsRef?: string;
}

/** A terminal child effect that failed during an otherwise completed run.
 * This is durable run evidence, not a second failure channel: the agent turn
 * may have recovered and produced a final response, while the ledger still
 * records that one of its requested effects did not succeed. */
export interface MissionRunEffectFailure {
  source:
    | { kind: "native-tool"; invocationId: string; nativeTaskId: number; nativeEntryId: number }
    | {
        kind: "provider-call";
        nativeTaskId: number;
        nativeEntryId: number;
        assistantEntryId: number;
        callId: string;
      };
  name: string;
  outcome: "tool_error" | "infrastructure_error" | "cancelled" | "stale_dispatch" | "abandoned";
  code: string;
  message: string;
}

export interface MissionRunRecord {
  runId: string;
  missionId: string;
  missionSubject: `mission:${string}@${string}`;
  revision: number;
  trigger: "manual" | "scheduled";
  phase: MissionRunPhase;
  outcome?: MissionRunOutcome;
  startedAt: number;
  runNumber?: number;
  finishedAt?: number;
  authoritySessionId?: string;
  acquisitionId?: string;
  channelId?: string;
  contextId?: string;
  executorId?: string;
  finalMessage?: string;
  completionResponse?: string;
  failure?: MissionRunFailure;
  effectFailures?: MissionRunEffectFailure[];
}

/** Durable executor evidence used by the mission coordinator after an
 * ambiguous dispatch or a lost terminal callback. The receiver owns this
 * fact; elapsed time is never evidence that a turn did or did not run. */
export type AutomationExecutorRunStatus =
  | { state: "not-found" }
  | { state: "queued"; channelId: string }
  | {
      state: "running";
      channelId: string;
      nativeTaskId: number;
      waiting: boolean;
    }
  | {
      state: "terminal";
      channelId: string;
      nativeTaskId: number;
      outcome: Exclude<MissionRunOutcome, "skipped">;
      finalMessage?: string;
      completionResponse?: string;
      failure?: MissionRunFailure;
      effectFailures?: MissionRunEffectFailure[];
    };

const HEX64 = /^[0-9a-f]{64}$/u;
const MIN_SCHEDULE_INTERVAL_MS = 60_000;
const MAX_CHARTER_BYTES = 128 * 1_024;

export function validateMissionCharter(charter: MissionCharter): void {
  if (new TextEncoder().encode(canonicalJson(charter)).byteLength > MAX_CHARTER_BYTES) {
    throw new Error(`Automation charter exceeds ${MAX_CHARTER_BYTES} bytes`);
  }
  if (!charter.summary.trim()) throw new Error("Automation charter requires a summary");
  validateExecution(charter.execution);
  validateTrigger(charter.trigger);
}

function validateExecution(execution: MissionExecution): void {
  validateExecutionImage(execution.image);
  if (execution.kind === "method") {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(execution.method)) {
      throw new Error("Automation method must be one canonical RPC method name");
    }
  } else {
    if (execution.action.kind === "prompt" && !execution.action.text.trim()) {
      throw new Error("Prompt automation requires prompt text");
    }
    if (execution.action.kind === "notify") {
      if (!execution.action.text.trim()) throw new Error("Notify automation requires text");
      const title: unknown = execution.action.title;
      if (title !== undefined && (typeof title !== "string" || !title.trim())) {
        throw new Error("Notify automation title must be non-empty text");
      }
      const alert: unknown = execution.action.alert;
      if (alert !== undefined && alert !== "inbox" && alert !== "interrupt") {
        throw new Error('Notify automation alert must be "inbox" or "interrupt"');
      }
      // A notification links back to the conversation it was scheduled from;
      // a fresh conversation would have nothing to link to.
      if (execution.conversation.mode !== "continue") {
        throw new Error("Notify automations run in the conversation that created them");
      }
    }
    if (execution.action.kind === "eval" || execution.action.kind === "watch") {
      if (!execution.action.code.trim()) throw new Error("Eval automation requires inline code");
      if (
        execution.action.timeoutMs !== undefined &&
        (!Number.isSafeInteger(execution.action.timeoutMs) || execution.action.timeoutMs <= 0)
      ) {
        throw new Error("Eval automation timeoutMs must be a positive integer");
      }
    }
    if (
      execution.conversation.mode === "continue" &&
      (!execution.conversation.channelId ||
        !execution.conversation.contextId ||
        !execution.conversation.executorId)
    ) {
      throw new Error("A continuing agent automation requires a channel, context, and executor");
    }
  }
  const seen = new Set<string>();
  for (const operation of execution.operations) {
    if (!operation.service || !operation.method || operation.service === "*") {
      throw new Error("Automation operations require exact service and method names");
    }
    const key = `${operation.service}\0${operation.method}\0${canonicalJson(operation.args ?? [])}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate automation operation ${operation.service}.${operation.method}`);
    }
    seen.add(key);
  }
}

function validateExecutionImage(image: MissionExecutionImage): void {
  if (
    !image.source ||
    !image.className ||
    !image.objectKey ||
    !HEX64.test(image.effectiveVersion) ||
    !/^state:[0-9a-f]{64}$/u.test(image.ref)
  ) {
    throw new Error("Automation execution requires an exact immutable execution image");
  }
  try {
    normalizeWorkspaceRepoPath(image.source);
  } catch {
    throw new Error(
      `Automation execution image must name one canonical workspace repo: ${JSON.stringify(image.source)}`
    );
  }
}

function validateTrigger(trigger: MissionTrigger): void {
  if (trigger.kind === "schedule") {
    if (!Number.isSafeInteger(trigger.everyMs) || trigger.everyMs < MIN_SCHEDULE_INTERVAL_MS) {
      throw new Error("Automation schedule everyMs must be an integer of at least one minute");
    }
    if (
      trigger.anchorAt !== undefined &&
      (!Number.isSafeInteger(trigger.anchorAt) || trigger.anchorAt < 0)
    ) {
      throw new Error("Automation schedule anchorAt must be a non-negative epoch millisecond");
    }
    if (
      trigger.jitterMs !== undefined &&
      (!Number.isSafeInteger(trigger.jitterMs) ||
        trigger.jitterMs < 0 ||
        trigger.jitterMs >= trigger.everyMs)
    ) {
      throw new Error("Automation schedule jitterMs must be smaller than everyMs");
    }
  }
  if (trigger.kind === "cron") {
    const expression = canonicalCronExpression(trigger.expression);
    if (expression !== trigger.expression) {
      throw new Error(`Automation cron expression must be canonical: ${expression}`);
    }
    const timezone = canonicalCronTimeZone(trigger.timezone);
    if (timezone !== trigger.timezone) {
      throw new Error(`Automation cron timezone must be canonical IANA timezone ${timezone}`);
    }
    cronNextOccurrence(expression, timezone, Date.UTC(2024, 0, 1));
  }
  if (trigger.kind !== "manual") {
    if (
      trigger.untilAt !== undefined &&
      (!Number.isSafeInteger(trigger.untilAt) || trigger.untilAt < 0)
    ) {
      throw new Error("Automation untilAt must be a non-negative epoch millisecond");
    }
    if (
      trigger.maxRuns !== undefined &&
      (!Number.isSafeInteger(trigger.maxRuns) || trigger.maxRuns < 1)
    ) {
      throw new Error("Automation maxRuns must be a positive integer");
    }
  }
}

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

export function missionRevisionDigest(
  charter: MissionCharter,
  authorityPlanDigest: string
): string {
  validateMissionCharter(charter);
  if (!HEX64.test(authorityPlanDigest)) {
    throw new Error("Automation revision requires an exact authority-plan digest");
  }
  return sha256HexSyncText(
    `automation-revision-v2\0${canonicalJson({ charter, authorityPlanDigest })}`
  );
}

export function missionExecutionImageDigest(image: MissionExecutionImage): string {
  validateExecutionImage(image);
  return sha256HexSyncText(
    `mission-execution-image-v1\0${canonicalJson({
      source: image.source,
      ref: image.ref,
      effectiveVersion: image.effectiveVersion,
      className: image.className,
    })}`
  );
}

/** Continuing schedules are ordinary input; isolated executions own mission authority. */
export function missionUsesAuthority(execution: MissionExecution): boolean {
  return !(execution.kind === "agent" && execution.conversation.mode === "continue");
}

/** Minimal RPC surface used by the author-side helpers below. */
export interface MissionRpc {
  call(
    target: string,
    method: string,
    args: unknown[],
    options?: { idempotencyKey?: string; signal?: AbortSignal }
  ): Promise<unknown>;
}

export const MISSIONS_SERVICE_PROTOCOL = "vibestudio.missions.v1" as const;

/** Compile one execution's authority plan as the authenticated caller. The
 * controller later verifies it against the same author; it never compiles. */
export async function compileMissionAuthorityPlan(
  rpc: MissionRpc,
  execution: MissionExecution,
  idempotencyKey?: string
): Promise<MissionAuthorityPlanReference> {
  return (await callWithKey(
    rpc,
    "main",
    "authority.compileAuthorityPlan",
    [{ execution }],
    idempotencyKey
  )) as MissionAuthorityPlanReference;
}

/** Pass call options only when a request identity exists. */
function callWithKey(
  rpc: MissionRpc,
  target: string,
  method: string,
  args: unknown[],
  idempotencyKey: string | undefined
): Promise<unknown> {
  return idempotencyKey
    ? rpc.call(target, method, args, { idempotencyKey })
    : rpc.call(target, method, args);
}

/** Schedule/name changes do not change the compiled invocation meaning. */
export function sameMissionExecution(left: MissionExecution, right: MissionExecution): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** A definition edit needs a new plan when its execution changes or when it
 * customizes a seeded default (a new author). */
function editNeedsAuthorityPlan(
  current: Pick<MissionRecord, "charter" | "authorityPlan" | "seeded">,
  execution: MissionExecution
): boolean {
  return current.seeded === true || !sameMissionExecution(current.charter.execution, execution);
}

export interface MissionDefinitionInput {
  name: string;
  charter: MissionCharter;
}

export interface MissionEditPatch {
  name?: string;
  charter?: MissionCharter;
}

export interface MissionCallOptions {
  /** Stable request identity. The authority-plan compilation and the
   * controller call derive their own keys from it. */
  idempotencyKey?: string;
}

/**
 * Author-side client for the missions controller. `launch`, `edit`, and
 * `provisionDefault` compile the authority plan as the authenticated caller
 * and then call the controller, which verifies that plan within its own
 * invocation: still two server calls, never controller-side compilation.
 */
export interface MissionsClient {
  observeChanges(options?: {
    afterVersion?: string;
    signal?: AbortSignal;
  }): Promise<{ version: string }>;
  overview(options?: Record<string, unknown>): Promise<unknown>;
  list(): Promise<MissionRecord[]>;
  get(missionId: string): Promise<MissionRecord | null>;
  getDefault(defaultId: string): Promise<MissionRecord | null>;
  listRuns(
    missionId: string,
    options?: { limit?: number; cursor?: { startedAt: number; runId: string } }
  ): Promise<{
    items: MissionRunRecord[];
    nextCursor?: { startedAt: number; runId: string };
  }>;
  getRun(runId: string): Promise<MissionRunRecord | null>;
  launch(input: MissionDefinitionInput, options?: MissionCallOptions): Promise<MissionRecord>;
  provisionDefault(
    defaultId: string,
    input: MissionDefinitionInput,
    options?: MissionCallOptions
  ): Promise<MissionRecord>;
  edit(
    missionId: string,
    patch: MissionEditPatch,
    options?: MissionCallOptions
  ): Promise<MissionRecord>;
  runNow(missionId: string): Promise<MissionRunRecord>;
  cancel(missionId: string): Promise<MissionRecord>;
  pause(missionId: string): Promise<MissionRecord>;
  resume(missionId: string): Promise<MissionRecord>;
  retire(missionId: string): Promise<MissionRecord>;
}

export function createMissionsClient(rpc: MissionRpc): MissionsClient {
  let target: Promise<string> | null = null;
  const resolveTarget = (): Promise<string> =>
    (target ??= (async () => {
      const service = (await rpc.call("main", "workers.resolveService", [
        MISSIONS_SERVICE_PROTOCOL,
        null,
      ])) as { kind?: unknown; targetId?: unknown };
      if (service.kind !== "durable-object" || typeof service.targetId !== "string")
        throw new Error("The Automations service is unavailable");
      return service.targetId;
    })().catch((error: unknown) => {
      target = null;
      throw error;
    }));
  const call = async <T>(method: string, args: unknown[], idempotencyKey?: string) =>
    (await callWithKey(rpc, await resolveTarget(), method, args, idempotencyKey)) as T;
  const planKey = (options?: MissionCallOptions) =>
    options?.idempotencyKey ? `${options.idempotencyKey}:authority-plan` : undefined;
  return {
    async observeChanges({ afterVersion, signal } = {}) {
      return (await rpc.call(
        await resolveTarget(),
        "observeChanges",
        [{ ...(afterVersion === undefined ? {} : { afterVersion }) }],
        { ...(signal ? { signal } : {}) }
      )) as { version: string };
    },
    overview: (options = {}) => call("overview", [options]),
    list: () => call("list", []),
    get: (missionId) => call("get", [missionId]),
    getDefault: (defaultId) => call("getDefault", [defaultId]),
    listRuns: (missionId, options = {}) => call("listRuns", [missionId, options]),
    getRun: (runId) => call("getRun", [runId]),
    async launch(input, options) {
      const authorityPlan = await compileMissionAuthorityPlan(
        rpc,
        input.charter.execution,
        planKey(options)
      );
      return call("launch", [{ ...input, authorityPlan }], options?.idempotencyKey);
    },
    async provisionDefault(defaultId, input, options) {
      const authorityPlan = await compileMissionAuthorityPlan(
        rpc,
        input.charter.execution,
        planKey(options)
      );
      return call(
        "provisionDefault",
        [defaultId, { ...input, authorityPlan }],
        options?.idempotencyKey
      );
    },
    async edit(missionId, patch, options) {
      const current = await call<MissionRecord | null>("get", [missionId]);
      if (!current) throw new Error(`Automation ${missionId} is unavailable`);
      const execution = patch.charter?.execution ?? current.charter.execution;
      const authorityPlan = editNeedsAuthorityPlan(current, execution)
        ? await compileMissionAuthorityPlan(rpc, execution, planKey(options))
        : undefined;
      return call(
        "edit",
        [missionId, { ...patch, ...(authorityPlan ? { authorityPlan } : {}) }],
        options?.idempotencyKey
      );
    },
    runNow: (missionId) => call("runNow", [missionId]),
    cancel: (missionId) => call("cancel", [missionId]),
    pause: (missionId) => call("pause", [missionId]),
    resume: (missionId) => call("resume", [missionId]),
    retire: (missionId) => call("retire", [missionId]),
  };
}

export function missionPrincipal(
  missionId: string,
  revisionDigest: string
): `mission:${string}@${string}` {
  if (!missionId || !HEX64.test(revisionDigest)) {
    throw new Error("Mission principal requires an id and exact revision digest");
  }
  return `mission:${missionId}@${revisionDigest}`;
}
