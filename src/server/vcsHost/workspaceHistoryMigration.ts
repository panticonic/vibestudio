import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { compareUtf16CodeUnits, sha256HexSyncText } from "@vibestudio/content-addressing";
import { vcsStateNodeRefSchema, type VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import { z } from "zod";
import {
  finishWorkspaceReplayBlobScopes,
  markPrivateWorkspaceBlobs,
  workspaceReplayBlobScopesReady,
} from "../storage/blobUploads.js";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceSourceProviderRef } from "../workspaceSourceProvider.js";

export const WORKSPACE_PARTICIPANT_HISTORY_MIGRATION = "workspace-participant-history-v1";

const headSchema = z.object({ head: z.string().min(1) }).strict();
const replayReceiptSchema = headSchema
  .extend({
    eventId: z.string().min(1),
    frozenPlanDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    contexts: z.array(
      z
        .object({
          id: z.string().min(1),
          committed: z.string().min(1),
          working: z.string().min(1),
        })
        .strict()
    ),
  })
  .strict();
const freezeSchema = z.object({
  operationId: z.string().min(1),
  expectedMainEventId: z.string().min(1),
}).strict();

export async function readWorkspaceHistoryReplayFreeze(
  dispatch: Pick<DODispatch, "dispatch">,
  source: WorkspaceSourceProviderRef
) {
  return freezeSchema.nullable().parse(await dispatch.dispatch(source, "readHistoryReplayFreeze"));
}

const planSchema = z
  .object({
    main: vcsStateNodeRefSchema.nullable(),
    contexts: z.array(
      z
        .object({
          id: z.string().min(1),
          committed: vcsStateNodeRefSchema,
          working: vcsStateNodeRefSchema,
        })
        .strict()
    ),
    steps: z.array(vcsStateNodeRefSchema),
  })
  .strict();

type HistoryReplayPlan = z.infer<typeof planSchema>;

const replayStepIdentity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), record: z.object({ eventId: z.string().min(1) }) }),
  z.object({
    kind: z.literal("application"),
    record: z.object({ applicationId: z.string().min(1) }),
  }),
]);

function stateId(ref: VcsStateNodeRef): string {
  return ref.kind === "event" ? `event:${ref.eventId}` : `application:${ref.applicationId}`;
}

export async function readWorkspaceHistoryReplayReceipt(
  dispatch: Pick<DODispatch, "dispatch">,
  destination: WorkspaceSourceProviderRef
) {
  return replayReceiptSchema
    .nullable()
    .parse(await dispatch.dispatch(destination, "readHistoryReplayReceipt"));
}

const replayContentPageSize = 1_024;
const replayContentPage = z.array(z.string().regex(/^[0-9a-f]{64}$/u)).max(replayContentPageSize);

/** Mark private bytes before the first admission. Each completed page is safe to repeat. */
export async function installWorkspaceReplayBlobScopes(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  destination: WorkspaceSourceProviderRef;
  blobsDir: string;
  planDigest: string;
}): Promise<void> {
  const { dispatch, destination, blobsDir, planDigest } = input;
  if (workspaceReplayBlobScopesReady(blobsDir, planDigest)) return;
  let after: string | null = null;
  for (;;) {
    const hashes = replayContentPage.parse(
      await dispatch.dispatch(destination, "readHistoryReplayPrivateContent", { planDigest, after })
    );
    let previous: string = after ?? "";
    for (const hash of hashes) {
      if (hash <= previous) throw new Error("Workspace replay content returned an inconsistent page");
      previous = hash;
    }
    markPrivateWorkspaceBlobs(blobsDir, hashes);
    if (hashes.length < replayContentPageSize) break;
    after = previous;
  }
  finishWorkspaceReplayBlobScopes(blobsDir, planDigest);
}

const replayOwnersSchema = z.array(z.object({
  contextId: z.string().min(1),
  participantId: z.string().min(1),
}).strict());

export async function registerWorkspaceHistoryReplayOwners(
  dispatch: Pick<DODispatch, "dispatch">,
  destination: WorkspaceSourceProviderRef,
  owners: z.infer<typeof replayOwnersSchema>
) {
  return replayOwnersSchema.parse(
    await dispatch.dispatch(destination, "registerHistoryReplayOwners", { owners })
  );
}

/** The caller owns source quiescence and admission of the destination's hosted executable. */
export async function migrateWorkspaceHistory(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  source: WorkspaceSourceProviderRef;
  destination: WorkspaceSourceProviderRef;
  freeze?: { operationId: string; expectedMainEventId: string };
}): Promise<{
  main: string;
  contexts: Array<{ id: string; committed: string; working: string }>;
}> {
  const { dispatch, source, destination, freeze } = input;
  const readPlan = async (): Promise<HistoryReplayPlan> =>
    planSchema.parse(await dispatch.dispatch(source, "exportHistoryReplayPlan"));
  const { generation, ...plan } = freeze
    ? planSchema.extend({ generation: z.string().uuid() }).parse(
        await dispatch.dispatch(source, "beginHistoryReplayFreeze", freeze)
      )
    : { ...(await readPlan()), generation: undefined };
  if (plan.main?.kind !== "event")
    throw new Error("Workspace replay requires an initialized source");
  if (freeze && plan.main.eventId !== freeze.expectedMainEventId)
    throw new Error("Workspace history froze a different source event");
  const frozenPlanDigest = generation
    ? sha256HexSyncText(canonicalJson({ source, freeze, plan, generation }))
    : undefined;
  if (frozenPlanDigest) {
    const existing = await readWorkspaceHistoryReplayReceipt(dispatch, destination);
    if (existing?.frozenPlanDigest) {
      if (existing.frozenPlanDigest !== frozenPlanDigest || existing.eventId !== plan.main.eventId)
        throw new Error("Workspace replay already installed a different frozen source");
      return { main: existing.head, contexts: existing.contexts };
    }
  }
  const installed = new Map<string, string>();
  for (const ref of plan.steps) {
    const step = await dispatch.dispatch(source, "exportHistoryReplayStep", ref);
    const identity = replayStepIdentity.parse(z.object({ step: z.unknown() }).parse(step).step);
    const exported =
      identity.kind === "event"
        ? `event:${identity.record.eventId}`
        : `application:${identity.record.applicationId}`;
    if (exported !== stateId(ref))
      throw new Error("Workspace replay returned a different source revision");
    const { head } = headSchema.parse(
      await dispatch.dispatch(destination, "stageHistoryReplayStep", step)
    );
    installed.set(stateId(ref), head);
  }
  const resolve = (ref: VcsStateNodeRef): string => {
    const head = installed.get(stateId(ref));
    if (!head) throw new Error(`Workspace replay omitted ${stateId(ref)}`);
    return head;
  };
  const main = resolve(plan.main);
  const contexts = plan.contexts
    .map(({ id, working, committed }) => ({
      id,
      working: resolve(working),
      committed: resolve(committed),
    }))
    .sort((left, right) => compareUtf16CodeUnits(left.id, right.id));
  if (canonicalJson(plan) !== canonicalJson(await readPlan())) {
    throw new Error("Workspace source advanced during replay");
  }
  const receipt = {
    eventId: plan.main.eventId, head: main, contexts,
    ...(frozenPlanDigest ? { frozenPlanDigest } : {}),
  };
  const result = headSchema.parse(
    await dispatch.dispatch(destination, "finishHistoryReplay", receipt)
  );
  if (result.head !== main) throw new Error("Workspace replay installed a different head");
  const recorded = await readWorkspaceHistoryReplayReceipt(dispatch, destination);
  if (!recorded ||
      canonicalJson({
        eventId: recorded.eventId, head: recorded.head, contexts: recorded.contexts,
        ...(frozenPlanDigest ? { frozenPlanDigest: recorded.frozenPlanDigest } : {}),
      }) !== canonicalJson(receipt)) {
    throw new Error("Workspace replay recorded different context revisions");
  }
  return { main, contexts };
}
