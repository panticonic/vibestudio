import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import { vcsStateNodeRefSchema, type VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import { z } from "zod";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceSourceProviderRef } from "../workspaceSourceProvider.js";

const headSchema = z.object({ head: z.string().min(1) }).strict();
const replayReceiptSchema = headSchema
  .extend({
    eventId: z.string().min(1),
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
  const plan = freeze
    ? planSchema.parse(await dispatch.dispatch(source, "beginHistoryReplayFreeze", freeze))
    : await readPlan();
  if (plan.main?.kind !== "event")
    throw new Error("Workspace replay requires an initialized source");
  if (freeze && plan.main.eventId !== freeze.expectedMainEventId)
    throw new Error("Workspace history froze a different source event");
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
  const receipt = { eventId: plan.main.eventId, head: main, contexts };
  const result = headSchema.parse(
    await dispatch.dispatch(destination, "finishHistoryReplay", receipt)
  );
  if (result.head !== main) throw new Error("Workspace replay installed a different head");
  const recorded = await readWorkspaceHistoryReplayReceipt(dispatch, destination);
  if (canonicalJson(recorded) !== canonicalJson(receipt)) {
    throw new Error("Workspace replay recorded different context revisions");
  }
  return { main, contexts };
}
