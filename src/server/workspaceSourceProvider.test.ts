import { describe, expect, it, vi } from "vitest";
import {
  nativeInvocationId,
  nativeInvocationIdentity,
  type NativeInvocationSource,
} from "@vibestudio/service-schemas/nativeInvocation";
import type { RpcCausalParent } from "@vibestudio/rpc";
import {
  channelTrajectoryFor,
  commandIdForTrajectoryInvocation,
} from "@vibestudio/trajectory-identity";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { resolveExactCausalInvocation } from "./workspaceSourceProvider.js";

function setup(operation?: NativeInvocationSource["operation"]) {
  const binding = {
    entityId: "do:workers/agent:Agent:one",
    contextId: "context:one",
    channelId: "channel:one",
  };
  const source: NativeInvocationSource = {
    owner: {
      runtimeId: binding.entityId,
      authoritySessionId: "lifetime:one",
      contextId: binding.contextId,
      incarnation: "storage:one",
      channelId: binding.channelId,
      source: "workers/agent",
      effectiveVersion: "state:one",
      className: "Agent",
      objectKey: "one",
      executionDigest: "a".repeat(64),
    },
    task: { conversationId: 0, taskId: 12, kind: "pi.tool", version: 1 },
    operation: operation ?? {
      kind: "tool",
      assistantEntryId: 9,
      callId: "model-call:one",
      name: "eval",
      argumentsDigest: "b".repeat(64),
    },
  };
  const parent: RpcCausalParent = {
    kind: "trajectory-invocation",
    ...channelTrajectoryFor(binding.channelId),
    invocationId: nativeInvocationId(source),
    nativeInvocation: nativeInvocationIdentity(source),
  };
  const entity: EntityRecord = {
    id: binding.entityId,
    authoritySessionId: source.owner.authoritySessionId,
    kind: "do",
    contextId: binding.contextId,
    source: { repoPath: source.owner.source, effectiveVersion: source.owner.effectiveVersion },
    activeExecutionDigest: source.owner.executionDigest,
    className: source.owner.className,
    key: source.owner.objectKey,
    agentBinding: binding,
    status: "active",
    createdAt: 1,
    cleanupComplete: false,
    ownerUserId: "runtime-owner",
  };
  const origin = {
    conversationId: 0,
    submissionId: 3,
    entryId: 5,
    channelRef: {
      source: "workers/pubsub-channel",
      className: "PubSubChannel",
      objectKey: "channel:original",
    },
    eventSequence: 1,
    envelopeId: "original-user-envelope",
    messageId: "inner:user-message",
    receiverParticipantId: binding.entityId,
  };
  const originalEvent = {
    id: 1,
    messageId: origin.envelopeId,
    senderId: "user:user-1",
    type: "agentic.trajectory.v1/event",
    payload: {
      kind: "message.completed",
      actor: { kind: "user", id: "user:user-1" },
      causality: { messageId: origin.messageId },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: "user",
        blocks: [{ type: "text", content: "Original task" }],
        outcome: "completed",
      },
    },
  };
  const inspect = vi.fn(
    async (): Promise<unknown> => ({
      source,
      executor: structuredClone(source.owner),
      status: "waiting",
      abortRequested: false,
      originatingInput: origin,
    })
  );
  const getEnvelope = vi.fn(async (): Promise<unknown> => originalEvent);
  const entities = { resolveActive: vi.fn((): EntityRecord | null => entity) };
  const resolve = () =>
    resolveExactCausalInvocation(parent, { binding, entities, inspect, getEnvelope });
  return {
    binding,
    source,
    parent,
    entity,
    origin,
    originalEvent,
    inspect,
    getEnvelope,
    entities,
    resolve,
  };
}

describe("native exact causal invocation", () => {
  it("authenticates the actual task and accepted original sender before any channel journal retention", async () => {
    const state = setup();
    await expect(state.resolve()).resolves.toEqual({
      active: true,
      owningUserId: "runtime-owner",
      initiatingUserId: "user-1",
      nativeInvocation: nativeInvocationIdentity(state.source),
    });
    expect(state.inspect).toHaveBeenCalledWith(
      state.parent.nativeInvocation,
      state.parent.invocationId
    );
    expect(state.getEnvelope).toHaveBeenCalledWith(
      state.origin.channelRef,
      state.origin.envelopeId
    );
    expect(commandIdForTrajectoryInvocation(state.parent)).toBe(
      commandIdForTrajectoryInvocation({ ...state.parent })
    );
  });
  it("authenticates direct tool task coordinates without treating them as model-generated calls", async () => {
    const state = setup({
      kind: "direct-tool",
      directEntryId: 9,
      callId: "actual-direct",
      name: "eval",
      argumentsDigest: "b".repeat(64),
    });
    await expect(state.resolve()).resolves.toMatchObject({ active: true });
    state.inspect.mockResolvedValue({
      source: {
        ...state.source,
        operation: {
          kind: "tool",
          assistantEntryId: 9,
          callId: "actual-direct",
          name: "eval",
          argumentsDigest: "b".repeat(64),
        },
      },
      executor: structuredClone(state.source.owner),
      status: "waiting",
      abortRequested: false,
      originatingInput: state.origin,
    });
    await expect(state.resolve()).rejects.toThrow("conflicts with its owning task");
  });
  it("keeps explicit cancellation cleanup owned until the native task is terminal", async () => {
    const state = setup();
    state.inspect.mockResolvedValue({
      source: state.source,
      executor: structuredClone(state.source.owner),
      status: "running",
      abortRequested: true,
      originatingInput: state.origin,
    });
    await expect(state.resolve()).resolves.toMatchObject({ active: true });
  });
  it("verifies nested host-retained extension causes through their actual source owner", async () => {
    const state = setup();
    await expect(
      resolveExactCausalInvocation(state.parent, {
        binding: null,
        entities: state.entities,
        inspect: state.inspect,
        getEnvelope: state.getEnvelope,
      })
    ).resolves.toMatchObject({ active: true, initiatingUserId: "user-1" });
  });
  it.each(["terminal", "completing"])("refuses live authority from a %s task", async (status) => {
    const state = setup();
    state.inspect.mockResolvedValue({
      source: state.source,
      executor: structuredClone(state.source.owner),
      status,
      abortRequested: false,
      originatingInput: state.origin,
    });
    await expect(state.resolve()).resolves.toMatchObject({ active: false });
  });
  it("refuses absent actual task facts", async () => {
    const state = setup();
    state.inspect.mockResolvedValue(null);
    await expect(state.resolve()).resolves.toBeNull();
    expect(state.getEnvelope).not.toHaveBeenCalled();
  });
  it("requires a native task locator without falling back to journal state", async () => {
    const state = setup();
    delete state.parent.nativeInvocation;
    await expect(state.resolve()).rejects.toThrow("requires its exact native task locator");
    expect(state.inspect).not.toHaveBeenCalled();
  });
  it.each(["task", "operation", "lifetime"] as const)(
    "rejects a spoofed %s locator before owner inspection",
    async (field) => {
      const state = setup();
      const locator = structuredClone(state.parent.nativeInvocation!);
      if (field === "task")
        state.parent.nativeInvocation = {
          ...locator,
          task: { ...locator.task, taskId: locator.task.taskId + 1 },
        };
      if (field === "operation" && locator.operation.kind === "tool")
        state.parent.nativeInvocation = {
          ...locator,
          operation: { ...locator.operation, callId: "forged" },
        };
      if (field === "lifetime")
        state.parent.nativeInvocation = {
          ...locator,
          owner: { ...locator.owner, authoritySessionId: "forged" },
        };
      await expect(state.resolve()).rejects.toThrow("different invocation identity");
      expect(state.inspect).not.toHaveBeenCalled();
    }
  );
  it("rejects copied task identity from another presenting agent or trajectory", async () => {
    const state = setup();
    await expect(
      resolveExactCausalInvocation(state.parent, {
        binding: { ...state.binding, entityId: "another-agent" },
        entities: state.entities,
        inspect: state.inspect,
        getEnvelope: state.getEnvelope,
      })
    ).rejects.toThrow("presenting agent");
    state.parent.logId = "different-trajectory";
    await expect(state.resolve()).rejects.toThrow("bound trajectory");
  });
  it.each(["authoritySessionId", "contextId", "executionDigest", "effectiveVersion"] as const)(
    "rejects a different runtime %s",
    async (field) => {
      const state = setup();
      if (field === "executionDigest") state.entity.activeExecutionDigest = "c".repeat(64);
      else if (field === "effectiveVersion") state.entity.source.effectiveVersion = "other";
      else state.entity[field] = "other";
      await expect(state.resolve()).rejects.toThrow(/retired or different runtime/);
    }
  );
  it("rechecks retirement and image replacement during actual task inspection", async () => {
    const state = setup();
    state.inspect.mockImplementation(async () => {
      state.entities.resolveActive.mockReturnValue(null);
      return null;
    });
    await expect(state.resolve()).rejects.toThrow("retired or different runtime image");
  });
  it("propagates original actual-task inspection failure", async () => {
    const state = setup();
    const failure = new Error("native storage failed");
    state.inspect.mockRejectedValue(failure);
    await expect(state.resolve()).rejects.toBe(failure);
  });
  it("preserves actual current-protocol task authority across an executable image upgrade", async () => {
    const state = setup();
    const original = structuredClone(state.source);
    state.entity.activeExecutionDigest = "c".repeat(64);
    state.entity.source.effectiveVersion = "state:replacement";
    state.inspect.mockResolvedValue({
      source: original,
      executor: {
        ...original.owner,
        executionDigest: state.entity.activeExecutionDigest,
        effectiveVersion: state.entity.source.effectiveVersion,
      },
      status: "waiting",
      abortRequested: false,
      originatingInput: state.origin,
    });
    await expect(state.resolve()).resolves.toMatchObject({
      active: true,
      nativeInvocation: nativeInvocationIdentity(original),
      initiatingUserId: "user-1",
    });
    expect(state.source).toEqual(original);
  });
  it("keeps actual task channel authority when the primary presentation binding changes", async () => {
    const state = setup();
    state.binding.channelId = "channel:new-primary";
    state.entity.agentBinding = {
      ...state.entity.agentBinding!,
      channelId: state.binding.channelId,
    };
    await expect(state.resolve()).resolves.toMatchObject({
      active: true,
      nativeInvocation: nativeInvocationIdentity(state.source),
      initiatingUserId: "user-1",
    });
  });
  it("keeps the same task authority after real cursor association and a restored owner image", async () => {
    const state = setup();
    await expect(state.resolve()).resolves.toMatchObject({
      active: true,
      initiatingUserId: "user-1",
    });
    state.origin.eventSequence = 7;
    state.originalEvent.id = 7;
    state.entities.resolveActive.mockReturnValue(structuredClone(state.entity));
    await expect(state.resolve()).resolves.toMatchObject({
      active: true,
      initiatingUserId: "user-1",
    });
  });
});

describe("native original human authority", () => {
  it("grants no human authority without an actual placed originating input", async () => {
    const state = setup();
    state.inspect.mockResolvedValue({
      source: state.source,
      executor: structuredClone(state.source.owner),
      status: "running",
      abortRequested: false,
      originatingInput: null,
    });
    await expect(state.resolve()).resolves.toMatchObject({ initiatingUserId: null });
    expect(state.getEnvelope).not.toHaveBeenCalled();
  });
  it("does not mint human authority from a code sender's nested human actor or owner metadata", async () => {
    const state = setup();
    state.originalEvent.senderId = "code:headless";
    Object.assign(state.originalEvent, { senderMetadata: { ownerUserId: "forged-user" } });
    await expect(state.resolve()).resolves.toMatchObject({
      initiatingUserId: null,
      owningUserId: "runtime-owner",
    });
  });
  it("does not invent a runtime account from an external sender", async () => {
    const state = setup();
    delete state.entity.ownerUserId;
    state.originalEvent.senderId = "external:integration";
    await expect(state.resolve()).resolves.toMatchObject({
      initiatingUserId: null,
      owningUserId: null,
    });
  });
  it.each(["messageId", "type"])("refuses a substituted original envelope %s", async (field) => {
    const state = setup();
    Object.assign(state.originalEvent, { [field]: "different" });
    await expect(state.resolve()).rejects.toThrow("no exact canonical channel event");
  });
  it("refuses a substituted original message identity or empty user sender", async () => {
    const state = setup();
    state.originalEvent.payload.causality.messageId = "different";
    await expect(state.resolve()).rejects.toThrow("no exact canonical channel event");
    state.originalEvent.payload.causality.messageId = state.origin.messageId;
    state.originalEvent.senderId = "user:";
    await expect(state.resolve()).rejects.toThrow("no canonical human sender");
  });
  it("rechecks the task owner after the canonical original envelope read", async () => {
    const state = setup();
    state.getEnvelope.mockImplementation(async () => {
      state.entity.authoritySessionId = "replaced-lifetime";
      return state.originalEvent;
    });
    await expect(state.resolve()).rejects.toThrow("retired or different runtime image");
  });
  it("refuses originating input placed after the model's actual cutoff", async () => {
    const state = setup({
      kind: "model",
      purpose: "generation",
      attempt: 0,
      cutoff: 4,
      requestDigest: "b".repeat(64),
    });
    await expect(state.resolve()).rejects.toThrow("does not belong to the invoking task");
  });
  it("refuses an input assigned to a different actual receiver", async () => {
    const state = setup();
    state.origin.receiverParticipantId = "different-agent";
    await expect(state.resolve()).rejects.toThrow("does not belong to the invoking task");
  });
  it("propagates original channel-owner read failures", async () => {
    const state = setup();
    const failure = new Error("channel owner unavailable");
    state.getEnvelope.mockRejectedValue(failure);
    await expect(state.resolve()).rejects.toBe(failure);
  });
});
