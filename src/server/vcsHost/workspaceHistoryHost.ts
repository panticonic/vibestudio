import { sha256HexSyncText } from "@vibestudio/content-addressing";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { z } from "zod";
import type { DODispatch } from "../doDispatch.js";
import type { WorkspaceSourceProviderRef } from "../workspaceSourceProvider.js";

const head = z.string().min(1);
const reservationSchema = z
  .object({
    targetId: z.string().min(1),
    head,
    origin: z.object({ ref: z.string().min(1), token: z.string().min(1) }).strict(),
  })
  .strict();

function workspaceParticipant(caller: VerifiedCaller): string {
  const invocation = caller.nativeInvocation;
  if (invocation) {
    // Every tool call in the same authenticated task reuses its working copy.
    return canonicalJson(["task", invocation.owner, invocation.task]);
  }
  if (caller.taskAuthority) return canonicalJson(["task-grant", caller.taskAuthority]);
  const userId = caller.subject?.userId;
  if (userId) return canonicalJson(["user", userId, caller.remoteDeviceKey ?? caller.runtime.id]);
  throw new Error("The verified caller has no workspace participant identity");
}

/** Called after the host authorizes the requested context for the verified caller. */
export async function openWorkspaceParticipantContext(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  caller: VerifiedCaller;
  ownerContextId: string;
  contextId: string;
  replayedWorkingHead?: string;
}): Promise<{ owner: WorkspaceSourceProviderRef; workingHead: string }> {
  const { dispatch, canonical, caller, ownerContextId, contextId } = input;
  if (!ownerContextId || !contextId)
    throw new Error("Workspace contexts require durable identities");
  const participantId = workspaceParticipant(caller);
  const owner = { ...canonical, objectKey: `work-${sha256HexSyncText(participantId)}` };
  const targetId = canonicalEntityId({
    kind: "do",
    source: owner.source,
    className: owner.className,
    key: owner.objectKey,
  });
  const reservation = reservationSchema.parse(
    await dispatch.dispatch(canonical, "reserveHistoryParticipant", {
      participantId,
      contextId: ownerContextId,
    })
  );
  if (reservation.targetId !== targetId)
    throw new Error("Workspace history returned a different participant owner");
  const current = head.parse(
    await dispatch.dispatch(owner, "connectHistoryParticipant", {
      participantId,
      origin: reservation.origin,
    })
  );
  const workingHead = head.parse(
    await dispatch.dispatch(owner, "openHistoryContext", {
      contextId,
      head: input.replayedWorkingHead ?? current,
    })
  );
  return { owner, workingHead };
}
