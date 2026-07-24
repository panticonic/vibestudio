import { z } from "zod";

import type {
  ApprovalPrincipal,
  ExternalAgentApprovalRequest,
  ExternalAgentApprovalResult,
  ExternalAgentSettle,
  SecretInputRequest,
  SecretInputResult,
  UserlandApprovalChoice,
  UserlandApprovalGrantScope,
  UserlandApprovalGrant,
  UserlandApprovalIssuer,
  UserlandApprovalOption,
  UserlandApprovalRequest,
} from "@vibestudio/shared/approvals";
import {
  approvalPrincipalSchema,
  externalAgentApprovalRequestSchema,
  externalAgentSettleSchema,
  secretInputRequestSchema,
  userlandApprovalChoiceSchema,
  userlandApprovalGrantSchema,
  userlandApprovalRequestSchema,
  userlandApprovalSubjectIdSchema,
} from "@vibestudio/shared/approvals";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { EntityRecord, RuntimeAgentBinding } from "@vibestudio/shared/runtime/entitySpec";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { testPolicyUserlandDecision } from "./authorityRuntime.js";

const SERVICE_NAME = "userlandApproval";
/**
 * A relayed external-agent permission auto-denies at the workspace card after
 * this long with no user answer. Agent runtimes use the same horizon so
 * whichever side fires first wins, and the other settle path is a no-op.
 */
// A pushed approval must survive a realistic step-away from the desk. Ten
// minutes matches interactive sign-in horizons while still bounding callers.
export const EXTERNAL_APPROVAL_TIMEOUT_MS = 10 * 60_000;
const BINARY_OPTIONS: UserlandApprovalOption[] = [
  { value: "allow", label: "Allow", tone: "primary" },
  { value: "deny", label: "Deny", tone: "danger" },
];

function scopedAllowOptions(principal: ApprovalPrincipal): UserlandApprovalOption[] {
  const identityScoped =
    principal.effectiveVersion === "internal" ||
    principal.repoPath === "vibestudio/internal" ||
    principal.requesterCategory === "eval" ||
    principal.requesterCategory === "internal-service" ||
    principal.requester?.category === "eval" ||
    principal.requester?.category === "internal-service";
  const identityIsAgent =
    principal.requesterCategory === "agent" ||
    principal.requesterCategory === "eval" ||
    principal.requester?.category === "agent" ||
    principal.requester?.category === "eval" ||
    principal.requester?.category === "worker" ||
    principal.requester?.category === "durable-object";
  const identityLabel = identityIsAgent ? "this agent" : "this workspace service";
  return [
    {
      value: "once",
      label: "Allow once",
      description: "Allow this request only.",
      tone: "neutral",
    },
    {
      value: "session",
      label: "Allow this session",
      description: "Remember for this caller until Vibestudio restarts.",
      tone: "neutral",
    },
    {
      value: "version",
      label: identityScoped
        ? identityIsAgent
          ? "Trust this agent"
          : "Trust this workspace service"
        : "Trust this version",
      description: identityScoped
        ? `Remember for ${identityLabel}. Its executable capabilities remain limited by version review.`
        : "Remember for this exact code version.",
      tone: "primary",
    },
    { value: "deny", label: "Deny", description: "Do not allow this request.", tone: "danger" },
  ];
}

// Dangerous prompts (or those defaulting to deny) present Deny first so the
// safe choice leads; other prompts keep the allow-first ordering.
function scopedOptionsFor(
  principal: ApprovalPrincipal,
  req: UserlandApprovalRequest
): UserlandApprovalOption[] {
  const options = scopedAllowOptions(principal);
  if (req.severity === "dangerous" || req.defaultAction === "deny") {
    const deny = options.filter((option) => option.value === "deny");
    const rest = options.filter((option) => option.value !== "deny");
    return [...deny, ...rest];
  }
  return options;
}

export function createUserlandApprovalService(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: Pick<
    CapabilityGrantStore,
    "lookupUserland" | "recordUserland" | "revokeUserland" | "listUserland"
  >;
  resolveRuntimeEntity?: (id: string) => Promise<EntityRecord | null>;
  onExternalApprovalExpired?: (details: {
    channelId: string;
    operation: string;
    requestId: string;
  }) => void;
}): ServiceDefinition {
  function extensionIssuer(ctx: ServiceContext): UserlandApprovalIssuer | undefined {
    return ctx.caller.runtime.kind === "extension"
      ? { kind: "extension", id: ctx.caller.runtime.id }
      : undefined;
  }

  function decorateForIssuer(
    req: UserlandApprovalRequest,
    issuer: UserlandApprovalIssuer | undefined
  ): UserlandApprovalRequest {
    if (!issuer || issuer.kind !== "extension") return req;
    return {
      ...req,
      details: [{ label: "Extension", value: issuer.id }, ...(req.details ?? [])].slice(0, 8),
    };
  }

  function decorateSecretInputForIssuer(
    req: SecretInputRequest,
    issuer: UserlandApprovalIssuer | undefined
  ): SecretInputRequest {
    if (!issuer || issuer.kind !== "extension") return req;
    return {
      ...req,
      details: [{ label: "Extension", value: issuer.id }, ...(req.details ?? [])].slice(0, 8),
    };
  }

  async function resolvePrincipal(
    ctx: ServiceContext,
    method: string
  ): Promise<ApprovalPrincipal | null> {
    if (ctx.caller.runtime.kind === "extension") {
      return ctx.chainCaller ?? null;
    }
    if (
      ctx.caller.runtime.kind !== "panel" &&
      ctx.caller.runtime.kind !== "app" &&
      ctx.caller.runtime.kind !== "worker" &&
      ctx.caller.runtime.kind !== "do"
    ) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        "userlandApproval is only available to panels, workers, DOs, and attributed extensions",
        "EACCES"
      );
    }
    const identity = ctx.caller.code;
    if (!identity) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        `Unknown caller identity: ${ctx.caller.runtime.id}`,
        "ENOENT"
      );
    }
    if (identity.callerKind !== ctx.caller.runtime.kind) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        `Caller identity kind mismatch for ${ctx.caller.runtime.id}`,
        "EACCES"
      );
    }
    return {
      callerId: identity.callerId,
      callerKind: identity.callerKind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
    };
  }

  async function resolveExternalAgentBinding(
    ctx: ServiceContext,
    method: string,
    channelId: string
  ): Promise<RuntimeAgentBinding> {
    const kind = ctx.caller.runtime.kind;
    if (kind !== "do" && kind !== "worker") {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        "external-agent approvals require a bound runtime caller",
        "EACCES"
      );
    }
    if (!deps.resolveRuntimeEntity) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        "runtime entity resolver is unavailable",
        "ENOSYS"
      );
    }
    const record = await deps.resolveRuntimeEntity(ctx.caller.runtime.id);
    if (!record || record.status !== "active") {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        `Unknown active runtime entity: ${ctx.caller.runtime.id}`,
        "ENOENT"
      );
    }
    const binding = record.agentBinding;
    if (!binding) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        "runtime entity is not bound to an external agent session",
        "EACCES"
      );
    }
    if (record.contextId !== binding.contextId) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        "runtime entity binding does not match its context",
        "EACCES"
      );
    }
    if (binding.channelId !== channelId) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        "external-agent request channel does not match the runtime binding",
        "EACCES"
      );
    }
    return binding;
  }

  async function request(
    ctx: ServiceContext,
    rawReq: UserlandApprovalRequest
  ): Promise<UserlandApprovalChoice> {
    // Re-parse to apply the schema's transforms (zero-width strip). The
    // dispatcher validates against this schema but discards parsed.data and
    // forwards the un-transformed input — see serviceDispatcher.ts at the
    // `args = normalized` line. Without this parse, post-strip uniqueness and
    // reserved-prefix invariants would not hold here.
    const req = userlandApprovalRequestSchema.parse(rawReq);
    const principal = await resolvePrincipal(ctx, "request");
    if (!principal) return { kind: "uncallable", reason: "no-user-context" };
    return requestForPrincipal(ctx, principal, req);
  }

  async function requestAs(
    ctx: ServiceContext,
    rawPrincipal: ApprovalPrincipal,
    rawReq: UserlandApprovalRequest
  ): Promise<UserlandApprovalChoice> {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        SERVICE_NAME,
        "requestAs",
        "requestAs is only available to attributed extension callbacks",
        "EACCES"
      );
    }
    const principal = approvalPrincipalSchema.parse(rawPrincipal);
    const req = userlandApprovalRequestSchema.parse(rawReq);
    return requestForPrincipal(ctx, principal, req);
  }

  async function requestSecretInput(
    ctx: ServiceContext,
    rawReq: SecretInputRequest
  ): Promise<SecretInputResult> {
    const req = secretInputRequestSchema.parse(rawReq);
    const principal = await resolvePrincipal(ctx, "requestSecretInput");
    if (!principal) return { decision: "deny" };
    return requestSecretInputForPrincipal(ctx, principal, req);
  }

  async function requestSecretInputAs(
    ctx: ServiceContext,
    rawPrincipal: ApprovalPrincipal,
    rawReq: SecretInputRequest
  ): Promise<SecretInputResult> {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        SERVICE_NAME,
        "requestSecretInputAs",
        "requestSecretInputAs is only available to attributed extension callbacks",
        "EACCES"
      );
    }
    const principal = approvalPrincipalSchema.parse(rawPrincipal);
    const req = secretInputRequestSchema.parse(rawReq);
    return requestSecretInputForPrincipal(ctx, principal, req);
  }

  async function requestSecretInputForPrincipal(
    ctx: ServiceContext,
    principal: ApprovalPrincipal,
    req: SecretInputRequest
  ): Promise<SecretInputResult> {
    const issuer = extensionIssuer(ctx);
    const decoratedReq = decorateSecretInputForIssuer(req, issuer);
    return deps.approvalQueue.requestSecretInput({
      kind: "secret-input",
      callerId: principal.callerId,
      callerKind: principal.callerKind,
      ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
      repoPath: principal.repoPath,
      effectiveVersion: principal.effectiveVersion,
      title: decoratedReq.title,
      description: decoratedReq.description,
      warning: decoratedReq.warning,
      details: decoratedReq.details,
      fields: decoratedReq.fields.map((field) => ({
        ...field,
        required: field.required ?? false,
      })),
      signal: undefined,
    });
  }

  async function requestForPrincipal(
    ctx: ServiceContext,
    principal: ApprovalPrincipal,
    req: UserlandApprovalRequest
  ): Promise<UserlandApprovalChoice> {
    const issuer = extensionIssuer(ctx);
    const decoratedReq = decorateForIssuer(req, issuer);
    const promptOptions = decoratedReq.promptOptions ?? "scoped";
    const options =
      promptOptions === "scoped"
        ? scopedOptionsFor(principal, decoratedReq)
        : (decoratedReq.options ?? BINARY_OPTIONS);
    const hit = deps.grantStore.lookupUserland(principal, decoratedReq.subject.id, issuer);
    if (hit) {
      if (isCachedChoiceValid(promptOptions, options, hit.choice)) {
        return { kind: "choice", choice: hit.choice };
      }
      await deps.grantStore.revokeUserland(principal, decoratedReq.subject.id, issuer);
    }

    const testDecision = testPolicyUserlandDecision(
      ctx.caller,
      ctx.authorization,
      decoratedReq.subject.id
    );
    if (testDecision) {
      const resolved = resolveTestPromptChoice(
        promptOptions,
        options,
        testDecision.decision,
        testDecision.remember
      );
      if (!resolved.record) return { kind: "choice", choice: resolved.choice };
      await deps.grantStore.recordUserland(
        principal,
        decoratedReq.subject,
        resolved.choice,
        Date.now(),
        issuer,
        resolved.scope,
        {
          provenance: "preauthorization",
          decidedBy: `host:${testDecision.policyId}:${testDecision.ruleId}`,
        }
      );
      return { kind: "choice", choice: resolved.choice };
    }
    const testPolicy =
      ctx.authorization?.testPolicy ??
      ctx.caller.testPolicy ??
      ctx.caller.executionSession?.testPolicy;
    if (testPolicy?.kind === "case" && testPolicy.case.unexpectedPrompts === "fail") {
      throw new ServiceError(
        SERVICE_NAME,
        "request",
        `Unexpected userland approval prompt in system test ${testPolicy.case.testId}: ${decoratedReq.subject.id}`,
        "EUNEXPECTEDTESTPROMPT"
      );
    }

    const result = await deps.approvalQueue.requestUserland({
      principal,
      issuer,
      ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
      ...decoratedReq,
      promptOptions,
      options,
    });
    if (result.kind === "choice") {
      const resolved = resolvePromptChoice(promptOptions, options, result.choice);
      if (!resolved.record) return { kind: "choice", choice: resolved.choice };
      await deps.grantStore.recordUserland(
        principal,
        decoratedReq.subject,
        resolved.choice,
        Date.now(),
        issuer,
        resolved.scope
      );
      if (typeof deps.approvalQueue.resolveMatchingUserland === "function") {
        deps.approvalQueue.resolveMatchingUserland((approval) => {
          if (approval.kind !== "userland") return false;
          // Userland approvals always have a panel/app/worker/do principal; the
          // "system" principal is only used for host-initiated prompts.
          if (approval.callerKind === "system") return false;
          if (approval.promptOptions !== "scoped") return false;
          if (!approval.options.some((option) => option.value === result.choice)) return false;
          const hit = deps.grantStore.lookupUserland(
            {
              callerId: approval.callerId,
              callerKind: approval.callerKind,
              repoPath: approval.repoPath,
              effectiveVersion: approval.effectiveVersion,
            },
            approval.subject.id,
            approval.issuer
          );
          return !!hit && isCachedChoiceValid(approval.promptOptions, approval.options, hit.choice);
        }, result.choice);
      }
      return { kind: "choice", choice: resolved.choice };
    }
    return result;
  }

  /**
   * File a relayed external-agent tool-use permission (plan §7.3) as a
   * first-class workspace approval and long-poll for the verdict. Resolves
   * `{ behavior: "allow" | "deny" }` when the user answers, or `deny` on the
   * ten-minute expiry / no-user-context. Per-request; no durable grant.
   */
  async function requestExternal(
    ctx: ServiceContext,
    rawReq: ExternalAgentApprovalRequest
  ): Promise<ExternalAgentApprovalResult> {
    // Re-parse to apply the schema transforms (preview control-char strip) — see
    // the comment in `request`: the dispatcher forwards un-transformed input.
    const req = externalAgentApprovalRequestSchema.parse(rawReq);
    const principal = await resolvePrincipal(ctx, "requestExternal");
    if (!principal) return { behavior: "deny" };
    const binding = await resolveExternalAgentBinding(ctx, "requestExternal", req.channelId);
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, EXTERNAL_APPROVAL_TIMEOUT_MS);
    try {
      const result = await deps.approvalQueue.requestExternalAgent({
        kind: "external-agent",
        callerId: principal.callerId,
        callerKind: principal.callerKind,
        ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
        repoPath: principal.repoPath,
        effectiveVersion: principal.effectiveVersion,
        ...(principal.requesterCategory ? { requesterCategory: principal.requesterCategory } : {}),
        entityId: binding.entityId,
        channelId: binding.channelId,
        capability: req.capability,
        operationName: req.operation,
        ...(req.description !== undefined ? { description: req.description } : {}),
        ...(req.preview !== undefined ? { preview: req.preview } : {}),
        requestId: req.requestId,
        resolveToken: req.resolveToken,
        signal: controller.signal,
      });
      if (expired) {
        deps.onExternalApprovalExpired?.({
          channelId: binding.channelId,
          operation: req.operation,
          requestId: req.requestId,
        });
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Quiet-settle a pending external-agent approval whose permission was answered
   * at the terminal (or whose bridge detached): the card disappears without a
   * recorded deny (plan §7.5). Scoped to the caller's runtime binding and
   * (channelId, requestId).
   */
  async function settleExternal(
    ctx: ServiceContext,
    rawArg: ExternalAgentSettle
  ): Promise<{ settled: boolean }> {
    const principal = await resolvePrincipal(ctx, "settleExternal");
    if (!principal) return { settled: false };
    const arg = externalAgentSettleSchema.parse(rawArg);
    const binding = await resolveExternalAgentBinding(ctx, "settleExternal", arg.channelId);
    const count = deps.approvalQueue.settleExternalAgent(
      (approval) =>
        approval.entityId === binding.entityId &&
        approval.channelId === binding.channelId &&
        approval.requestId === arg.requestId
    );
    return { settled: count > 0 };
  }

  const methods = {
    request: {
      description:
        "Ask for consent to one provider-defined custom resource. Returns only the user's choice. " +
        'To forget the saved choice later, call userlandApproval.revoke("the-subject-id") with request.subject.id as a plain string, not the subject object.',
      args: z.tuple([userlandApprovalRequestSchema]),
      returns: userlandApprovalChoiceSchema,
      access: { sensitivity: "write" as const },
    },
    requestSecretInput: {
      args: z.tuple([secretInputRequestSchema]),
      access: { sensitivity: "write" as const },
    },
    requestAs: {
      description:
        "Ask for custom-resource consent as an already verified durable code principal. " +
        "Workers and Durable Objects use this attributed form; eval/session code must use userlandApproval.request and cannot supply its own identity. " +
        'Returns only the user\'s choice; revoke later with userlandApproval.revoke("the-subject-id"), passing request.subject.id as a plain string.',
      args: z.tuple([approvalPrincipalSchema, userlandApprovalRequestSchema]),
      returns: userlandApprovalChoiceSchema,
      authority: { principals: ["code"] },
      access: { sensitivity: "write" as const },
    },
    requestSecretInputAs: {
      args: z.tuple([approvalPrincipalSchema, secretInputRequestSchema]),
      authority: { principals: ["code"] },
      access: { sensitivity: "write" as const },
    },
    // External-agent relay: bound agent runtimes may be either DOs or workers.
    requestExternal: {
      args: z.tuple([externalAgentApprovalRequestSchema]),
      authority: { principals: ["code"] },
      access: { sensitivity: "write" as const },
    },
    settleExternal: {
      args: z.tuple([externalAgentSettleSchema]),
      authority: { principals: ["code"] },
      access: { sensitivity: "write" as const },
    },
    revoke: {
      description:
        "Forget this caller's saved custom-resource choice by the original subject.id. This does not revoke built-in workspace permissions.",
      args: z.tuple([userlandApprovalSubjectIdSchema]),
      returns: z.boolean(),
      access: { sensitivity: "destructive" as const },
    },
    list: {
      description:
        "List only this caller's saved provider-defined custom-resource choices. For the workspace's complete capability, credential, browser-site, and custom-choice permission inventory, call permissions.list instead.",
      args: z.tuple([]),
      returns: z.array(userlandApprovalGrantSchema),
      access: { sensitivity: "read" as const },
    },
  } satisfies ServiceDefinition["methods"];

  return {
    name: SERVICE_NAME,
    description:
      "Provider-defined custom-resource consent choices; not the workspace permission inventory",
    authority: { principals: ["code", "session"] },
    methods,
    handler: defineServiceHandler(SERVICE_NAME, methods, {
      request: (ctx, [requestArg]) => request(ctx, requestArg),
      requestSecretInput: (ctx, [requestArg]) => requestSecretInput(ctx, requestArg),
      requestAs: (ctx, [principal, requestArg]) => requestAs(ctx, principal, requestArg),
      requestSecretInputAs: (ctx, [principal, requestArg]) =>
        requestSecretInputAs(ctx, principal, requestArg),
      requestExternal: (ctx, [requestArg]) => requestExternal(ctx, requestArg),
      settleExternal: (ctx, [settleArg]) => settleExternal(ctx, settleArg),
      revoke: async (ctx, [rawSubjectId]) => {
        const principal = await resolvePrincipal(ctx, "revoke");
        if (!principal) return { kind: "uncallable", reason: "no-user-context" };
        // Re-parse for transform application — see comment in `request`.
        const subjectId = userlandApprovalSubjectIdSchema.parse(rawSubjectId);
        return deps.grantStore.revokeUserland(principal, subjectId, extensionIssuer(ctx));
      },
      list: async (ctx) => {
        const principal = await resolvePrincipal(ctx, "list");
        if (!principal) return [];
        return deps.grantStore.listUserland(
          principal,
          extensionIssuer(ctx)
        ) as UserlandApprovalGrant[];
      },
    }),
  };
}

function isCachedChoiceValid(
  promptOptions: UserlandApprovalRequest["promptOptions"] | undefined,
  options: UserlandApprovalOption[],
  choice: string
): boolean {
  if ((promptOptions ?? "scoped") === "scoped") return choice === "allow";
  return options.some((option) => option.value === choice);
}

function resolvePromptChoice(
  promptOptions: UserlandApprovalRequest["promptOptions"] | undefined,
  options: UserlandApprovalOption[],
  choice: string
):
  | { choice: string; record: false }
  | { choice: string; record: true; scope: UserlandApprovalGrantScope } {
  if ((promptOptions ?? "scoped") !== "scoped") {
    // Preserve exact declared options before interpreting the UI's one-shot
    // envelope, and only unwrap an envelope that targets a real option.
    if (options.some((option) => option.value === choice)) {
      return { choice, record: true, scope: "caller" };
    }
    if (choice.startsWith("once:")) {
      const oneTimeChoice = choice.slice("once:".length);
      if (options.some((option) => option.value === oneTimeChoice)) {
        return { choice: oneTimeChoice, record: false };
      }
    }
    throw new ServiceError(SERVICE_NAME, "request", `Invalid approval choice: ${choice}`, "EINVAL");
  }
  if (choice === "once") return { choice: "allow", record: false };
  if (choice === "session") return { choice: "allow", record: true, scope: "session" };
  if (choice === "version") return { choice: "allow", record: true, scope: "version" };
  return { choice: "deny", record: false };
}

function resolveTestPromptChoice(
  promptOptions: UserlandApprovalRequest["promptOptions"] | undefined,
  options: UserlandApprovalOption[],
  choice: string,
  remember: boolean
):
  | { choice: string; record: false }
  | { choice: string; record: true; scope: UserlandApprovalGrantScope } {
  const scoped = (promptOptions ?? "scoped") === "scoped";
  const valid = scoped
    ? choice === "allow" || choice === "deny"
    : options.some((option) => option.value === choice);
  if (!valid) {
    throw new ServiceError(
      SERVICE_NAME,
      "request",
      `Invalid test approval choice: ${choice}`,
      "EINVAL"
    );
  }
  if (!remember || choice === "deny") return { choice, record: false };
  return { choice, record: true, scope: scoped ? "version" : "caller" };
}
