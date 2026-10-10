import { z } from "zod";
import type { NativeInvocationIdentity } from "@vibestudio/rpc";
export type { NativeInvocationIdentity } from "@vibestudio/rpc";
import { stableSha256Hex } from "@vibestudio/content-addressing";

const identity = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const recordId = z.number().int().positive().safe();

/** Immutable attribution published by the actual task's mutation capability. */
export const nativeInvocationSourceSchema = z
  .object({
    owner: z
      .object({
        runtimeId: identity,
        authoritySessionId: identity,
        contextId: identity,
        incarnation: identity,
        channelId: identity,
        source: identity,
        effectiveVersion: identity,
        className: identity,
        objectKey: identity,
        executionDigest: digest,
      })
      .strict(),
    task: z
      .object({
        conversationId: z.number().int().nonnegative().safe(),
        taskId: recordId,
        kind: identity,
        version: z.number().int().positive().safe(),
      })
      .strict(),
    operation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("direct-tool"),
          directEntryId: recordId,
          callId: identity,
          name: identity,
          argumentsDigest: digest,
        })
        .strict(),
      z
        .object({
          kind: z.literal("tool"),
          assistantEntryId: recordId,
          callId: identity,
          name: identity,
          argumentsDigest: digest,
        })
        .strict(),
      z
        .object({
          kind: z.literal("model"),
          purpose: z.enum(["generation", "compaction"]),
          attempt: z.number().int().nonnegative().safe(),
          cutoff: recordId,
          requestDigest: digest,
        })
        .strict(),
    ]),
  })
  .strict();

export type NativeInvocationSource = z.infer<typeof nativeInvocationSourceSchema>;

/** Original coordinates retained in canonical authority receipts. */
export const nativeInvocationIdentitySchema = z
  .object({
    owner: z.object({ runtimeId: identity, authoritySessionId: identity }).strict(),
    task: z
      .object({ conversationId: z.number().int().nonnegative().safe(), taskId: recordId })
      .strict(),
    operation: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("direct-tool"), directEntryId: recordId, callId: identity })
        .strict(),
      z.object({ kind: z.literal("tool"), assistantEntryId: recordId, callId: identity }).strict(),
      z
        .object({
          kind: z.literal("model"),
          purpose: z.enum(["generation", "compaction"]),
          attempt: z.number().int().nonnegative().safe(),
          cutoff: recordId,
        })
        .strict(),
    ]),
  })
  .strict() satisfies z.ZodType<NativeInvocationIdentity>;

export function nativeInvocationIdentity(source: NativeInvocationSource): NativeInvocationIdentity {
  return {
    owner: {
      runtimeId: source.owner.runtimeId,
      authoritySessionId: source.owner.authoritySessionId,
    },
    task: { conversationId: source.task.conversationId, taskId: source.task.taskId },
    operation:
      source.operation.kind === "tool"
        ? {
            kind: "tool",
            assistantEntryId: source.operation.assistantEntryId,
            callId: source.operation.callId,
          }
        : source.operation.kind === "direct-tool"
          ? {
              kind: "direct-tool",
              directEntryId: source.operation.directEntryId,
              callId: source.operation.callId,
            }
          : {
              kind: "model",
              purpose: source.operation.purpose,
              attempt: source.operation.attempt,
              cutoff: source.operation.cutoff,
            },
  };
}

/** The source remains immutable; current lifecycle is read from its owning native task. */
export const nativeOriginatingInputSchema = z
  .object({
    conversationId: z.number().int().nonnegative().safe(),
    submissionId: recordId,
    entryId: recordId,
    channelRef: z.object({ source: identity, className: identity, objectKey: identity }).strict(),
    eventSequence: z.number().int().nonnegative().safe(),
    envelopeId: identity,
    messageId: identity,
    receiverParticipantId: identity,
  })
  .strict();
export type NativeOriginatingInput = z.infer<typeof nativeOriginatingInputSchema>;

export const nativeInvocationInspectionSchema = z
  .object({
    source: nativeInvocationSourceSchema,
    /** Original attribution and current executor are separate facts. */
    executor: nativeInvocationSourceSchema.shape.owner,
    status: z.enum(["pending", "running", "waiting", "completing", "terminal"]),
    abortRequested: z.boolean(),
    originatingInput: nativeOriginatingInputSchema.nullable(),
  })
  .strict();
export type NativeInvocationInspection = z.infer<typeof nativeInvocationInspectionSchema>;

export const nativeInvocationInspectionInputSchema = z
  .object({
    taskId: recordId,
    invocationId: identity,
  })
  .strict();

/** Task/call identities are scoped by the host's real create-to-retire authority lifetime. */
export function nativeInvocationId(source: NativeInvocationIdentity): string {
  return `invocation:native:${stableSha256Hex([
    "vibestudio/native-invocation/v1",
    source.owner.runtimeId,
    source.owner.authoritySessionId,
    source.task.conversationId,
    source.task.taskId,
    source.operation.kind === "tool"
      ? ["tool", source.operation.assistantEntryId, source.operation.callId]
      : source.operation.kind === "direct-tool"
        ? ["direct-tool", source.operation.directEntryId, source.operation.callId]
        : ["model", source.operation.purpose, source.operation.attempt, source.operation.cutoff],
  ])}`;
}
