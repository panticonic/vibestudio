import { tsImport } from "tsx/esm/api";
const { nativeInvocationId, nativeInvocationSourceSchema } = await tsImport(
  "@vibestudio/service-schemas/nativeInvocation",
  import.meta.url
);
import {
  chromePage,
  nativeRpc,
  until,
  waitForApprovalSettlement,
} from "./desktop-shared-revocation.mjs";
import { inspectPresentedDesktopDocuments } from "./presented-desktop-documents.mjs";

function endpointIdentity(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Onboarding model has no exact remote credential audience");
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

/** Compare host-presented consent with the one actual, original native model request. */
export function inspectOwnedOnboardingCredentialReview(entry, owned) {
  const source = nativeInvocationSourceSchema.parse(owned.source);
  const task = owned.task;
  const checkpoint = task?.state?.checkpoint;
  if (
    nativeInvocationId(source) !== owned.invocationId ||
    source.operation.kind !== "model" ||
    source.operation.purpose !== "generation" ||
    source.owner.channelId !== owned.channelId ||
    source.owner.runtimeId !== owned.agentId ||
    source.task.taskId !== task?.id ||
    source.task.conversationId !== task?.conversationId ||
    source.task.kind !== task?.kind ||
    source.task.version !== task?.version ||
    task.state.status !== "running" ||
    task.abortRequested ||
    checkpoint?.phase !== "request" ||
    checkpoint.attempt !== source.operation.attempt ||
    checkpoint.cutoff !== source.operation.cutoff
  )
    throw new Error("Onboarding review has no exact active native model invocation");
  const endpoint = endpointIdentity(checkpoint.model.baseUrl);
  // The host's authority principal producers construct `user:${accountUserId}`
  // (acquisitionCoordinator/authorityRuntime). The canonical channel actor is
  // that participant identity; requestedByUserId is the raw account identity.
  // The actual retained-desktop run66832 exposed this distinction.
  const reviewAccountUserId = entry?.requestedByUserId;
  const reviewUserParticipantId =
    typeof reviewAccountUserId === "string" &&
    reviewAccountUserId.length > 0 &&
    !reviewAccountUserId.startsWith("user:")
      ? `user:${reviewAccountUserId}`
      : null;
  const audience = Array.isArray(entry?.audience) ? entry.audience : [];
  const checks = {
    kind: entry?.kind === "credential",
    lifecycle: entry?.lifecycle?.state === "ready",
    callerKind: entry?.callerKind === "do",
    callerId: entry?.callerId === source.owner.runtimeId,
    repoPath: entry?.repoPath === source.owner.source,
    effectiveVersion: entry?.effectiveVersion === source.owner.effectiveVersion,
    requestedByUserId: reviewUserParticipantId === owned.originalUserParticipantId,
    requesterContextId: entry?.requester?.contextId === source.owner.contextId,
    requesterRepoPath: entry?.requester?.repoPath === source.owner.source,
    requesterEffectiveVersion: entry?.requester?.effectiveVersion === source.owner.effectiveVersion,
    credentialUse: entry?.credentialUse === "fetch",
    credentialId: typeof entry?.credentialId === "string" && Boolean(entry.credentialId),
    onceDecision: entry?.allowedDecisions?.includes("once") === true,
    operation: entry?.operation?.kind === "credential" && entry.operation.verb === "use credential",
    audience:
      audience.length === 1 &&
      audience[0].match === "path-prefix" &&
      endpointIdentity(audience[0].url) === endpoint,
    grantResource:
      entry?.grantResource?.bindingId === "fetch" &&
      entry.grantResource.action === "use" &&
      endpointIdentity(entry.grantResource.resource) === endpoint,
  };
  const mismatchFields = Object.entries(checks)
    .filter(([, matches]) => !matches)
    .map(([field]) => field);
  return {
    match: mismatchFields.length
      ? null
      : {
          approvalId: entry.approvalId,
          invocationId: owned.invocationId,
          credentialId: entry.credentialId,
          callerId: source.owner.runtimeId,
          endpoint,
          taskId: source.task.taskId,
        },
    mismatchFields,
    owned: {
      invocationId: owned.invocationId,
      taskId: source.task.taskId,
      conversationId: source.task.conversationId,
      channelId: source.owner.channelId,
      callerId: source.owner.runtimeId,
      repoPath: source.owner.source,
      effectiveVersion: source.owner.effectiveVersion,
      contextId: source.owner.contextId,
      originalUserParticipantId: owned.originalUserParticipantId,
      endpoint,
    },
    review: {
      approvalId: entry?.approvalId,
      kind: entry?.kind,
      lifecycleState: entry?.lifecycle?.state,
      callerKind: entry?.callerKind,
      callerId: entry?.callerId,
      repoPath: entry?.repoPath,
      effectiveVersion: entry?.effectiveVersion,
      requestedByUserId: entry?.requestedByUserId,
      reviewAccountUserId,
      reviewUserParticipantId,
      requesterContextId: entry?.requester?.contextId,
      requesterRepoPath: entry?.requester?.repoPath,
      requesterEffectiveVersion: entry?.requester?.effectiveVersion,
      credentialUse: entry?.credentialUse,
      hasCredentialId: typeof entry?.credentialId === "string" && Boolean(entry.credentialId),
      onceDecision: checks.onceDecision,
      operationKind: entry?.operation?.kind,
      operationVerb: entry?.operation?.verb,
      audience: audience.map(({ match, url }) => ({ match, endpoint: endpointIdentity(url) })),
      grantResource: entry?.grantResource
        ? {
            bindingId: entry.grantResource.bindingId,
            action: entry.grantResource.action,
            endpoint: endpointIdentity(entry.grantResource.resource),
          }
        : null,
    },
  };
}

export function ownedOnboardingCredentialReview(entry, owned) {
  return inspectOwnedOnboardingCredentialReview(entry, owned).match;
}

/** Expanded cards and minimized pills are two states of the same native presentation. */
export async function openOwnedOnboardingReview(app, page, approvalId, deadline) {
  const visibleCard = async () => {
    const documents = await app.evaluate(inspectPresentedDesktopDocuments, { kind: "documents" });
    const presentedUrls = new Set(documents.map((document) => document.url));
    let card;
    for (const candidate of app.context().pages()) {
      if (candidate.isClosed() || !presentedUrls.has(candidate.url())) continue;
      const exactCard = candidate.locator(`[data-approval-id="${approvalId}"]`);
      if ((await exactCard.count()) && (await exactCard.isVisible())) {
        if (card) throw new Error("Onboarding review has multiple visible owner cards");
        card = exactCard;
      }
    }
    return card;
  };
  const expanded = await visibleCard();
  if (expanded) return expanded;
  // ConsentApprovalBar renders this opener only while its card is minimized.
  const pill = page.locator("[data-approval-pill]:visible");
  if ((await pill.count()) !== 1)
    throw new Error("Onboarding review has no unique visible native presentation");
  await pill.click();
  return until(visibleCard, `displaying the original onboarding review ${approvalId}`, deadline);
}

export async function approveOwnedOnboardingCredential(app, workspaceId, readOwned, deadline) {
  const page = await chromePage(app, deadline);
  const pending = await nativeRpc(
    page,
    { kind: "workspace", workspaceId },
    "shellApproval.listPending",
    []
  );
  if (pending.length === 0) return null;
  const owned = await readOwned();
  const inspected = pending.map((entry) => inspectOwnedOnboardingCredentialReview(entry, owned));
  const matches = inspected.map((result) => result.match).filter(Boolean);
  if (matches.length !== 1 || pending.length !== 1)
    throw new Error(
      `Onboarding exposed an unclassified or ambiguous review: ${JSON.stringify(
        inspected.map(({ mismatchFields, owned, review }) => ({ mismatchFields, owned, review }))
      )}`
    );
  const exact = matches[0];
  const card = await openOwnedOnboardingReview(app, page, exact.approvalId, deadline);
  const once = card.locator('[data-approval-decision="once"]');
  if ((await once.count()) !== 1 || !(await once.isEnabled()))
    throw new Error("Exact onboarding credential review has no enabled Use once decision");
  await once.click();
  await waitForApprovalSettlement(
    () => nativeRpc(page, { kind: "workspace", workspaceId }, "shellApproval.listPending", []),
    exact.approvalId,
    deadline
  );
  return exact;
}

/** Public canonical input, task and source projection from the original Personal panel. */
export async function readOwnedOnboardingFromPanel() {
  const { rpc, workers } = await globalThis.__vibestudioRequireAsync__("@workspace/runtime");
  const args = window.__vibestudioStateArgs;
  const channelId = args.channelName;
  const route = await workers.resolveService("vibestudio.channel.v1", channelId);
  const [participants, replay] = await Promise.all([
    rpc.call(route.targetId, "getParticipants", []),
    rpc.call(route.targetId, "getReplayAfter", [{ after: 0 }]),
  ]);
  const agents = participants.filter((entry) =>
    entry.participantId.startsWith("do:workers/agent-worker:AiChatWorker:")
  );
  if (agents.length !== 1) throw new Error("Onboarding has no unique owned agent");
  const agentId = agents[0].participantId;
  const events = replay.logEvents.map((event) => event.payload);
  const userInputs = events.filter(
    (event) => event?.kind === "message.completed" && event.actor?.kind === "user"
  );
  const prompt = (event) =>
    event.payload.blocks
      ?.filter((block) => block.type === "text")
      .map((block) => block.content)
      .join(String.fromCharCode(10)) ?? "";
  if (userInputs.length !== 1 || prompt(userInputs[0]) !== args.initialPrompt)
    throw new Error("Onboarding review is not bound to its original user input");
  const debug = await rpc.call(agentId, "getDebugState", [channelId]);
  const inspection = debug.conversations[channelId];
  const run = inspection.live?.run;
  if (
    !inspection.loaded ||
    !run ||
    run.inputs.length !== 1 ||
    inspection.submissions.filter(
      (input) => input.id === run.inputs[0] && input.type === "input" && input.status === "placed"
    ).length !== 1
  )
    throw new Error("Onboarding has no unique original native input run");
  const tasks = inspection.tasks
    .map((entry) => entry.record)
    .filter((task) => task.id === run.taskId);
  if (tasks.length !== 1) throw new Error("Onboarding lost its actual generation task");
  const task = tasks[0];
  const starts = events.filter(
    (event) =>
      event?.kind === "invocation.started" &&
      event.actor?.id === agentId &&
      event.payload.nativeSource?.task.taskId === task.id &&
      event.payload.nativeSource?.operation.kind === "model" &&
      event.payload.nativeSource.operation.attempt === task.state.checkpoint.attempt &&
      event.payload.nativeSource.operation.cutoff === task.state.checkpoint.cutoff
  );
  if (starts.length !== 1) throw new Error("Onboarding has no unique canonical model invocation");
  return {
    channelId,
    agentId,
    originalUserParticipantId: userInputs[0].actor.id,
    invocationId: starts[0].causality.invocationId,
    source: starts[0].payload.nativeSource,
    task: {
      id: task.id,
      conversationId: task.conversationId,
      kind: task.kind,
      version: task.version,
      abortRequested: task.abortRequested,
      state: {
        status: task.state.status,
        checkpoint: {
          phase: task.state.checkpoint.phase,
          attempt: task.state.checkpoint.attempt,
          cutoff: task.state.checkpoint.cutoff,
          model: { baseUrl: task.state.checkpoint.model?.baseUrl },
        },
      },
    },
  };
}
