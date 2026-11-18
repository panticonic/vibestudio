import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { vcsStateNodeRefSchema, type VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import { z } from "zod";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceSourceProviderRef } from "../workspaceSourceProvider.js";

const headSchema = z.object({ head: z.string().min(1) }).strict();
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

/** The caller owns source quiescence and admission of the destination's hosted executable. */
export async function migrateWorkspaceHistory(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  source: WorkspaceSourceProviderRef;
  destination: WorkspaceSourceProviderRef;
}): Promise<{
  main: string;
  contexts: Array<{ id: string; committed: string; working: string }>;
}> {
  const { dispatch, source, destination } = input;
  const readPlan = async (): Promise<HistoryReplayPlan> =>
    planSchema.parse(await dispatch.dispatch(source, "exportHistoryReplayPlan"));
  const plan = await readPlan();
  if (plan.main?.kind !== "event")
    throw new Error("Workspace replay requires an initialized source");
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
  const contexts = plan.contexts.map(({ id, working, committed }) => ({
    id,
    working: resolve(working),
    committed: resolve(committed),
  }));
  if (canonicalJson(plan) !== canonicalJson(await readPlan())) {
    throw new Error("Workspace source advanced during replay");
  }
  const result = headSchema.parse(
    await dispatch.dispatch(destination, "finishHistoryReplay", {
      eventId: plan.main.eventId,
      head: main,
    })
  );
  if (result.head !== main) throw new Error("Workspace replay installed a different head");
  return { main, contexts };
}
