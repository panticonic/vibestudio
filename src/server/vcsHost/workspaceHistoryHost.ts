import { createHash } from "node:crypto";
import { compareUtf16CodeUnits, sha256HexSyncText } from "@vibestudio/content-addressing";
import {
  vcsStateNodeRefSchema,
  vcsStatusResultSchema,
  vcsWorkingMutationResultSchema,
  type VcsEditInput,
  type VcsStatusResult,
  type VcsTrajectorySenderRef,
  type VcsWorkingMutationResult,
} from "@vibestudio/service-schemas/vcs";
import { GadJsonRecordSchema } from "@vibestudio/service-schemas/workspaceSource";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { WorkspaceMaterializationRepositorySchema } from "@vibestudio/shared/vcs/workspaceProjection";
import { z } from "zod";
import type { DODispatch } from "../doDispatch.js";
import { getBytes, putBytes } from "../services/blobstoreService.js";
import type { CanonicalRefPublication } from "../services/protectedRefStore.js";
import { withBlobContentLock } from "../storage/blobRetentions.js";
import type { WorkspaceSourceProviderRef } from "../workspaceSourceProvider.js";

const head = z.string().min(1);
const reservationSchema = z
  .object({
    targetId: z.string().min(1),
    head,
    origin: z.object({ ref: z.string().min(1), token: z.string().min(1) }).strict(),
  })
  .strict();

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const blob = z.object({ contentHash: digest, base64: z.string() }).strict();
const causeSchema = z
  .object({
    parent: z
      .object({
        logId: z.string().min(1),
        head,
        invocationId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
const editPlan = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read-content"), contentHashes: z.array(digest).min(1) }).strict(),
  z
    .object({
      kind: z.literal("committed"),
      head,
      result: vcsWorkingMutationResultSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("planned"),
      command: z
        .object({
          commandId: z.string().min(1),
          method: z.literal("edit"),
          requestDigest: z.string().min(1),
          cause: causeSchema,
        })
        .strict(),
      application: GadJsonRecordSchema,
      blobs: z.array(blob),
      result: vcsWorkingMutationResultSchema.omit({ workingHead: true }),
    })
    .strict(),
]);
const appliedEdit = z.object({ head, value: vcsStateNodeRefSchema }).strict();
const workspaceProjection = z
  .object({
    head,
    state: vcsStateNodeRefSchema,
    repositories: z.array(WorkspaceMaterializationRepositorySchema),
  })
  .strict();

export async function readWorkspaceParticipantProjection(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  owner: WorkspaceSourceProviderRef;
  contextId: string;
}) {
  return workspaceProjection.parse(
    await input.dispatch.dispatch(input.owner, "readHistoryProjection", {
      contextId: input.contextId,
    })
  );
}

/** Read shared ancestry and edits from the verified participant's own context. */
export async function readWorkspaceParticipantStatus(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  owner: WorkspaceSourceProviderRef;
  caller: VerifiedCaller;
  contextId: string;
}): Promise<VcsStatusResult> {
  requireWorkspaceParticipantOwner(input);
  const status = vcsStatusResultSchema.parse(
    await input.dispatch.dispatch(input.owner, "readHistoryStatus", { contextId: input.contextId })
  );
  if (status.contextId !== input.contextId)
    throw new Error("Workspace status belongs to a different context");
  return status;
}

export async function readWorkspacePublishedRevision(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  eventId: string;
}) {
  return workspaceProjection.parse(
    await input.dispatch.dispatch(input.canonical, "readHistoryPublishedRevision", {
      eventId: input.eventId,
    })
  );
}

export async function readWorkspaceCanonicalMain(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
}): Promise<{ head: string; eventId: string }> {
  return z
    .object({ head, eventId: z.string().min(1) })
    .strict()
    .parse(await input.dispatch.dispatch(input.canonical, "readHistoryMain"));
}

/** Store every prepared blob before its owner can commit a reference to it. */
export async function putPreparedWorkspaceContent(
  blobsDir: string,
  blobs: readonly z.infer<typeof blob>[]
): Promise<string[]> {
  const seen = new Set<string>();
  const prepared = blobs.map(({ contentHash, base64 }) => {
    if (!digest.safeParse(contentHash).success) {
      throw new Error("semantic content preparation contains an invalid content identity");
    }
    if (seen.has(contentHash))
      throw new Error(`semantic content preparation repeats ${contentHash}`);
    seen.add(contentHash);
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64) {
      throw new Error(`semantic content preparation has invalid bytes for ${contentHash}`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== contentHash) {
      throw new Error(`semantic content preparation bytes do not match ${contentHash}`);
    }
    return bytes;
  });
  await Promise.all(prepared.map((bytes) => putBytes(blobsDir, bytes)));
  return [...seen].sort(compareUtf16CodeUnits);
}

/** Execute an edit with host-owned content, after admission has fixed the participant owner. */
export async function editWorkspaceParticipant(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  owner: WorkspaceSourceProviderRef;
  head: string;
  edit: VcsEditInput;
  cause: z.infer<typeof causeSchema>;
  triggerEvidence?: { text: string; sender: VcsTrajectorySenderRef } | null;
  blobsDir: string;
}): Promise<{ head: string; result: VcsWorkingMutationResult }> {
  const { dispatch, owner, edit, cause, blobsDir } = input;
  const requestPlan = async (receipt: { files: z.infer<typeof blob>[] } | null) =>
    editPlan.parse(
      await dispatch.dispatch(owner, "planHistoryEdit", {
        head: input.head,
        edit,
        cause,
        receipt,
        ...(input.triggerEvidence === undefined ? {} : { triggerEvidence: input.triggerEvidence }),
      })
    );
  const checkResult = (result: VcsWorkingMutationResult) => {
    if (
      result.commandId !== edit.commandId ||
      result.contextId !== edit.contextId ||
      result.workingHead.kind !== "application" ||
      result.applicationId !== result.workingHead.applicationId
    ) {
      throw new Error("Workspace edit returned a different application");
    }
  };
  let plan = await requestPlan(null);
  if (plan.kind === "read-content") {
    const files = await Promise.all(
      plan.contentHashes.map(async (contentHash) => {
        const bytes = await getBytes(blobsDir, contentHash);
        if (!bytes) throw new Error(`semantic content blob ${contentHash} is missing`);
        return { contentHash, base64: bytes.toString("base64") };
      })
    );
    plan = await requestPlan({ files });
  }
  if (plan.kind === "read-content") throw new Error("Workspace edit repeated its content request");
  if (plan.kind === "committed") {
    checkResult(plan.result);
    return { head: plan.head, result: plan.result };
  }
  if (
    plan.command.commandId !== edit.commandId ||
    canonicalJson(plan.command.cause) !== canonicalJson(cause) ||
    plan.result.commandId !== edit.commandId ||
    plan.result.contextId !== edit.contextId
  ) {
    throw new Error("Workspace edit plan belongs to a different command");
  }
  const prepared = plan;
  const applied = await withBlobContentLock(blobsDir, async () => {
    await putPreparedWorkspaceContent(blobsDir, prepared.blobs);
    return appliedEdit.parse(
      await dispatch.dispatch(owner, "applyHistoryApplication", {
        head: input.head,
        command: prepared.command,
        plan: prepared.application,
      })
    );
  });
  const result = { ...prepared.result, workingHead: applied.value };
  checkResult(result);
  return { head: applied.head, result };
}

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

export function requireWorkspaceParticipantOwner(input: {
  canonical: WorkspaceSourceProviderRef;
  owner: WorkspaceSourceProviderRef;
  caller: VerifiedCaller;
}): string {
  const participantId = workspaceParticipant(input.caller);
  const expected = { ...input.canonical, objectKey: `work-${sha256HexSyncText(participantId)}` };
  if (canonicalJson(input.owner) !== canonicalJson(expected)) {
    throw new Error("Workspace history belongs to a different participant");
  }
  return participantId;
}

const publicationApproval = z
  .object({
    publicationId: z.string().min(1),
    participantId: z.string().min(1),
    previousEventId: z.string().min(1),
    proposedEventId: z.string().min(1),
    publication: z.object({ previousHead: head, proposedHead: head }).strict(),
  })
  .strict();
const publicationReceipt = z
  .object({
    approval: publicationApproval,
    expiresAt: z.number().int().positive(),
    applied: z.boolean(),
  })
  .strict();
const publicationGrant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("applied"), head }).strict(),
  z
    .object({
      kind: z.literal("grant"),
      id: z.string().min(1),
      origin: reservationSchema.shape.origin,
    })
    .strict(),
]);

export async function readWorkspacePublicationApproval(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  publicationId: string;
}) {
  return publicationReceipt.nullable().parse(
    await input.dispatch.dispatch(input.canonical, "readHistoryPublicationApproval", {
      publicationId: input.publicationId,
    })
  );
}

export async function listAppliedWorkspacePublications(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
}) {
  return z
    .array(publicationReceipt.extend({ applied: z.literal(true) }))
    .parse(await input.dispatch.dispatch(input.canonical, "listHistoryAppliedPublications"));
}

async function readExactWorkspacePublicationApproval(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  approval: z.infer<typeof publicationApproval>;
}) {
  const receipt = await readWorkspacePublicationApproval({
    ...input,
    publicationId: input.approval.publicationId,
  });
  if (receipt && canonicalJson(receipt.approval) !== canonicalJson(input.approval)) {
    throw new Error("Workspace publication receipt names a different transition");
  }
  return receipt;
}

/** Startup recovery can project an already committed revision without authority to publish. */
export function observeAppliedWorkspacePublication(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  approval: z.infer<typeof publicationApproval>;
}): CanonicalRefPublication {
  const confirmed = async () =>
    (await readExactWorkspacePublicationApproval(input))?.applied === true;
  return {
    approved: confirmed,
    async authorize() {
      throw new Error("Publication recovery cannot issue approval");
    },
    async publish() {
      if (!(await confirmed())) throw new Error("Workspace publication has no applied revision");
    },
    async acknowledge() {
      await input.dispatch.dispatch(input.canonical, "acknowledgeHistoryPublication", {
        publicationId: input.approval.publicationId,
      });
    },
  };
}

/** The protected gate authorizes this exact native transition before it can publish. */
export function bindWorkspaceParticipantPublication(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  owner: WorkspaceSourceProviderRef;
  caller: VerifiedCaller;
  contextId: string;
  target: Omit<z.infer<typeof publicationApproval>, "participantId">;
}): CanonicalRefPublication {
  const { dispatch, canonical, owner, caller, contextId } = input;
  const participantId = requireWorkspaceParticipantOwner({ canonical, owner, caller });
  const approval = publicationApproval.parse({ ...input.target, participantId });
  const publicationId = { publicationId: approval.publicationId };
  const readApproval = () =>
    readExactWorkspacePublicationApproval({ dispatch, canonical, approval });
  return {
    async approved(): Promise<boolean> {
      const receipt = await readApproval();
      return receipt !== null && (receipt.applied || receipt.expiresAt > Date.now());
    },
    async authorize(): Promise<void> {
      await dispatch.dispatch(canonical, "authorizeHistoryPublication", approval);
    },
    async publish(): Promise<void> {
      const permit = publicationGrant.parse(
        await dispatch.dispatch(canonical, "grantHistoryPublication", publicationId)
      );
      if (permit.kind === "applied") {
        if (permit.head !== approval.publication.proposedHead || !(await readApproval())?.applied) {
          throw new Error("Workspace publication did not advance to its approved head");
        }
        return;
      }
      try {
        await dispatch.dispatch(owner, "publishApprovedHistory", {
          contextId,
          publication: approval.publication,
          proposedEventId: approval.proposedEventId,
          origin: permit.origin,
        });
      } catch (error) {
        if (!(await readApproval())?.applied) throw error;
      } finally {
        await dispatch
          .dispatch(canonical, "releaseHistoryGrant", { id: permit.id })
          .catch((error) =>
            console.warn(
              "[WorkspaceHistory] Could not release the publication grant",
              error instanceof Error ? error.message : String(error)
            )
          );
      }
      if (!(await readApproval())?.applied) {
        throw new Error("Workspace publication did not advance to its approved head");
      }
    },
    async acknowledge(): Promise<void> {
      await dispatch.dispatch(canonical, "acknowledgeHistoryPublication", publicationId);
    },
  };
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
