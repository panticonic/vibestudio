import { describe, expect, it, vi } from "vitest";
import {
  nativeInvocationId,
  nativeInvocationIdentity,
  type NativeInvocationSource,
} from "@vibestudio/service-schemas/nativeInvocation";
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
  const coordinates = channelTrajectoryFor(binding.channelId);
  const parent = {
    kind: "trajectory-invocation" as const,
    logId: coordinates.logId,
    head: coordinates.head,
    invocationId: nativeInvocationId(source),
  };
  const row = {
    log_id: parent.logId,
    head: parent.head,
    invocation_id: parent.invocationId,
    turn_id: "native-turn:one",
    initiating_user_id: "user-1",
    status: "started",
    terminal_outcome: null,
    started_events: 1,
    terminal_events: 0,
    started_event_id: "started:one",
  };
  const event = {
    logId: parent.logId,
    head: parent.head,
    envelopeId: "started:one",
    seq: 1,
    actor: { kind: "agent" as const, id: "agent:one" },
    payloadKind: "invocation.started",
    payload: { protocol: "agentic", name: "eval", nativeSource: source },
    causality: { invocationId: parent.invocationId },
    appendedAt: "2026-10-02T10:00:00Z",
    prevHash: "previous",
    hash: "hash",
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
    eventSequence: 7,
    envelopeId: "ik:original-user-envelope",
    messageId: "inner:user-message",
    receiverParticipantId: binding.entityId,
  };
  const originalEvent = {
    ...event,
    logId: origin.channelRef.objectKey,
    head: "main",
    seq: origin.eventSequence,
    envelopeId: origin.envelopeId,
    actor: { kind: "user" as const, id: "user:user-1", participantId: "user:user-1" },
    payloadKind: "message.completed",
    causality: { messageId: origin.messageId },
    payload: {
      protocol: "agentic.trajectory.v1",
      role: "user",
      blocks: [{ type: "text", content: "Original task" }],
      outcome: "completed",
    },
  };
  Object.assign(event.payload, { originatingInput: origin });
  const inspectInvocationState = vi.fn(async () => ({ rows: [row] }));
  const getLogEvent = vi.fn(async (input: { envelopeId: string }) =>
    input.envelopeId === origin.envelopeId ? originalEvent : event
  );
  const inspect = vi.fn(
    async (): Promise<unknown> => ({
      source,
      status: "waiting",
      abortRequested: false,
      originatingInput: origin,
    })
  );
  const entities = { resolveActive: vi.fn((): EntityRecord | null => entity) };
  const resolve = () =>
    resolveExactCausalInvocation({ inspectInvocationState, getLogEvent }, parent, {
      binding,
      entities,
      inspect,
    });
  return {
    binding,
    origin,
    originalEvent,
    source,
    parent,
    row,
    event,
    entity,
    inspectInvocationState,
    getLogEvent,
    inspect,
    entities,
    resolve,
  };
}

describe("native exact causal invocation", () => {
  it("authenticates genuine direct tool coordinates without treating their source as a model-generated call", async () => {
    const state = setup({
      kind: "direct-tool",
      directEntryId: 9,
      callId: "actual-direct",
      name: "eval",
      argumentsDigest: "b".repeat(64),
    });
    await expect(state.resolve()).resolves.toEqual({
      active: true,
      owningUserId: "runtime-owner",
      initiatingUserId: "user-1",
      nativeInvocation: nativeInvocationIdentity(state.source),
    });
    expect(
      nativeInvocationId({
        ...state.source,
        operation: { kind: "tool", assistantEntryId: 9, callId: "actual-direct" },
      })
    ).not.toBe(state.parent.invocationId);
    expect(
      nativeInvocationId({
        ...state.source,
        operation: { kind: "direct-tool", directEntryId: 10, callId: "actual-direct" },
      })
    ).not.toBe(state.parent.invocationId);
    state.inspect.mockImplementation(async () => ({
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
      status: "waiting",
      abortRequested: false,
      originatingInput: state.origin,
    }));
    await expect(state.resolve()).rejects.toThrow("conflicts with its owning task");
  });
  it("joins the exact published start to its genuine waiting native task and keeps deterministic command identity", async () => {
    const state = setup();
    await expect(state.resolve()).resolves.toEqual({
      active: true,
      owningUserId: "runtime-owner",
      initiatingUserId: "user-1",
      nativeInvocation: nativeInvocationIdentity(state.source),
    });
    expect(state.getLogEvent).toHaveBeenCalledWith({
      logId: state.parent.logId,
      head: state.parent.head,
      envelopeId: "started:one",
    });
    expect(state.inspect).toHaveBeenCalledWith(state.source, state.parent.invocationId);
    expect(commandIdForTrajectoryInvocation(state.parent)).toBe(
      commandIdForTrajectoryInvocation({ ...state.parent })
    );
    expect(
      nativeInvocationId({
        ...state.source,
        owner: { ...state.source.owner, authoritySessionId: "new-lifetime" },
      })
    ).not.toBe(state.parent.invocationId);
  });

  it("keeps explicit cancellation cleanup owned until the actual operation settles", async () => {
    const state = setup();
    state.inspect.mockResolvedValue({
      source: state.source,
      status: "running",
      abortRequested: true,
      originatingInput: state.origin,
    });
    await expect(state.resolve()).resolves.toMatchObject({ active: true });
  });

  it("verifies a nested host-retained extension cause through the actual source owner's binding", async () => {
    const state = setup();
    await expect(
      resolveExactCausalInvocation(
        { inspectInvocationState: state.inspectInvocationState, getLogEvent: state.getLogEvent },
        state.parent,
        { binding: null, entities: state.entities, inspect: state.inspect }
      )
    ).resolves.toEqual({
      active: true,
      owningUserId: "runtime-owner",
      initiatingUserId: "user-1",
      nativeInvocation: nativeInvocationIdentity(state.source),
    });
    expect(state.inspect).toHaveBeenCalledWith(state.source, state.parent.invocationId);
  });

  it.each(["progress", "output"])(
    "keeps a published %s update causally live without a terminal",
    async (status) => {
      const state = setup();
      state.row.status = status;
      await expect(state.resolve()).resolves.toMatchObject({ active: true });
    }
  );

  it("does not grant a terminal published invocation a live task", async () => {
    const state = setup();
    state.row.status = "completed";
    state.row.terminal_events = 1;
    await expect(state.resolve()).resolves.toEqual({
      active: false,
      owningUserId: "runtime-owner",
      initiatingUserId: "user-1",
      nativeInvocation: nativeInvocationIdentity(state.source),
    });
  });

  it("refuses absent task facts and terminal native ownership despite an unclosed publication", async () => {
    const state = setup();
    state.inspect.mockResolvedValueOnce(null);
    await expect(state.resolve()).resolves.toBeNull();
    state.inspect.mockResolvedValueOnce({
      source: state.source,
      status: "terminal",
      abortRequested: false,
      originatingInput: state.origin,
    });
    await expect(state.resolve()).resolves.toMatchObject({ active: false });
  });

  it("refuses mismatching source facts and exact entry coordinates", async () => {
    const state = setup();
    state.inspect.mockResolvedValueOnce({
      source: {
        ...state.source,
        operation: { ...state.source.operation, argumentsDigest: "c".repeat(64) },
      },
      status: "running",
      abortRequested: false,
      originatingInput: state.origin,
    });
    await expect(state.resolve()).rejects.toThrow("conflicts with its owning task");
    state.event.causality.invocationId = "other";
    await expect(state.resolve()).resolves.toBeNull();
  });

  it.each(["authoritySessionId", "contextId", "executionDigest", "effectiveVersion"] as const)(
    "rejects a changed %s without dispatching owner inspection",
    async (field) => {
      const state = setup();
      if (field === "executionDigest") state.entity.activeExecutionDigest = "c".repeat(64);
      else if (field === "effectiveVersion") state.entity.source.effectiveVersion = "state:other";
      else state.entity[field] = "other";
      await expect(state.resolve()).rejects.toThrow("retired or different runtime image");
      expect(state.inspect).not.toHaveBeenCalled();
    }
  );

  it("rejects retirement racing owner inspection", async () => {
    const state = setup();
    state.inspect.mockImplementation(async () => {
      state.entities.resolveActive.mockReturnValue(null);
      return { source: state.source, status: "running", abortRequested: false };
    });
    await expect(state.resolve()).rejects.toThrow("retired or different runtime image");
  });

  it("propagates original owner inspection failure and never manufactures attribution", async () => {
    const state = setup();
    const original = new Error("native storage failed");
    state.inspect.mockRejectedValue(original);
    await expect(state.resolve()).rejects.toBe(original);
  });

  it("rejects copied source identity on another bound owner", async () => {
    const state = setup();
    state.binding.entityId = "do:workers/other:Other:one";
    await expect(state.resolve()).rejects.toThrow("does not belong to the bound agent");
    expect(state.inspect).not.toHaveBeenCalled();
  });
});

describe("native original human authority", () => {
  it("joins the original placed input's outer channel event, independently of current channel and legacy turns", async () => {
    const state = setup();
    state.row.initiating_user_id = "unrelated-old-turn-author";
    await expect(state.resolve()).resolves.toMatchObject({ initiatingUserId: "user-1" });
    expect(state.getLogEvent).toHaveBeenCalledWith({
      logId: "channel:original",
      head: "main",
      envelopeId: "ik:original-user-envelope",
    });
  });
  it("cannot mint human authority from a legacy turn or later transcript without an actual originating input", async () => {
    const state = setup();
    Object.assign(state.event.payload, { originatingInput: null });
    state.inspect.mockResolvedValue({
      source: state.source,
      status: "running",
      abortRequested: false,
      originatingInput: null,
    });
    await expect(state.resolve()).resolves.toMatchObject({ initiatingUserId: null });
    expect(state.getLogEvent).toHaveBeenCalledTimes(1);
  });
  it("refuses a published input coordinate that differs from the actual admitted input", async () => {
    const state = setup();
    Object.assign(state.event.payload, {
      originatingInput: { ...state.origin, messageId: "different-message" },
    });
    await expect(state.resolve()).rejects.toThrow("Published native input conflicts");
  });
  it("does not invent a runtime owner from input metadata on a bootstrap entity", async () => {
    const state = setup();
    delete state.entity.ownerUserId;
    Object.assign(state.originalEvent.actor, {
      kind: "external",
      id: "code:headless",
      participantId: "code:headless",
      metadata: { type: "headless", ownerUserId: "forged-owner" },
    });
    await expect(state.resolve()).resolves.toMatchObject({
      active: true,
      owningUserId: null,
      initiatingUserId: null,
    });
  });
  it("keeps an ordinary agent-authored original input as code despite user-looking text", async () => {
    const state = setup();
    Object.assign(state.originalEvent.actor, {
      kind: "agent",
      id: "do:parent:Agent:one",
      participantId: "do:parent:Agent:one",
    });
    await expect(state.resolve()).resolves.toMatchObject({ initiatingUserId: null });
  });
  it("admits a headless client input without minting canonical human authority", async () => {
    const state = setup();
    Object.assign(state.originalEvent.actor, {
      kind: "external",
      id: "do:vibestudio/internal:EvalDO:headless-client",
      participantId: "do:vibestudio/internal:EvalDO:headless-client",
      metadata: { type: "headless" },
    });
    await expect(state.resolve()).resolves.toMatchObject({
      active: true,
      owningUserId: "runtime-owner",
      initiatingUserId: null,
      nativeInvocation: nativeInvocationIdentity(state.source),
    });
  });
  it.each(["seq", "envelopeId", "payloadKind", "logId", "head"])(
    "refuses a mismatching original %s before admitting human authority",
    async (field) => {
      const state = setup();
      Object.assign(state.originalEvent, { [field]: field === "seq" ? 8 : "different" });
      await expect(state.resolve()).rejects.toThrow("no exact canonical channel event");
    }
  );
  it("refuses a changed original message identity and a forged human sender", async () => {
    const state = setup();
    state.originalEvent.causality.messageId = "different-inner-message";
    await expect(state.resolve()).rejects.toThrow("no exact canonical channel event");
    state.originalEvent.causality.messageId = state.origin.messageId;
    state.originalEvent.actor.id = "unbound-code";
    await expect(state.resolve()).rejects.toThrow("no canonical human sender");
  });
  it("rechecks the actual native owner after the original channel read", async () => {
    const state = setup();
    state.getLogEvent.mockImplementation(async (input) => {
      if (input.envelopeId === state.origin.envelopeId) {
        state.entity.authoritySessionId = "replaced-lifetime";
        return state.originalEvent;
      }
      return state.event;
    });
    await expect(state.resolve()).rejects.toThrow("retired or different runtime image");
  });
});
