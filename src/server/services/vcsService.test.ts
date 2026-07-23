import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  vcsMethods,
  type VcsProvenanceEdge,
  type VcsSemanticNodeRef,
} from "@vibestudio/service-schemas/vcs";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import { createVcsService } from "./vcsService.js";

const EVENT = { kind: "event" as const, eventId: "event:one" };
const INTERNAL_AUTHORIZATION = {
  contextIntegrity: { class: "internal", latchEpoch: 0, externalKeys: [] },
} as unknown as NonNullable<ServiceContext["authorization"]>;

function workerContext(id = "worker:one"): ServiceContext {
  return {
    caller: createVerifiedCaller(id, "worker"),
    requestId: "request:one",
    authorization: INTERNAL_AUTHORIZATION,
  };
}

function shellContext(): ServiceContext {
  return { caller: createVerifiedCaller("shell", "shell"), authorization: INTERNAL_AUTHORIZATION };
}

function agentContext(channelId = "channel:own"): ServiceContext {
  return {
    caller: createVerifiedCaller("do:Agent:runtime", "agent", null, {
      entityId: "entity:agent",
      contextId: "context:agent",
      channelId,
      agentId: "agent:stable",
    }),
    authorization: INTERNAL_AUTHORIZATION,
  };
}

function service(options?: {
  context?: string | null;
  owned?: Array<{
    contextId: string;
    kind?: "lifecycle" | "lineage";
    ownerEntityId?: string | null;
  }>;
  result?: unknown;
  failure?: unknown;
  relayBinding?: { entityId: string; contextId: string; channelId: string };
  referencesReachable?:
    | boolean
    | ((
        contextIds: readonly string[],
        references: readonly { kind: string; value: unknown }[]
      ) => boolean | Promise<boolean>);
  semanticCall?: (method: string, request: { input: unknown }) => unknown | Promise<unknown>;
}) {
  const semanticCall = vi.fn(async (method: string, request: { input: unknown }) => {
    if (options && "failure" in options) throw options.failure;
    if (options?.semanticCall) return options.semanticCall(method, request);
    return options?.result ?? { contextId: "context:own" };
  });
  const semanticPublishCall = vi.fn(async (input: unknown) => {
    if (options && "failure" in options) throw options.failure;
    if (options?.semanticCall) return options.semanticCall("vcsPush", { input });
    return options?.result ?? { contextId: "context:own" };
  });
  const definition = createVcsService({
    workspaceVcs: {
      semanticCall,
      semanticPublishCall,
      referencesReachable: vi.fn(async (contextIds, references) =>
        typeof options?.referencesReachable === "function"
          ? options.referencesReachable(contextIds, references)
          : (options?.referencesReachable ?? true)
      ),
    } as unknown as WorkspaceVcs,
    entityCache: {
      resolveContext: () => options?.context ?? null,
      resolveActive: (id: string) =>
        options?.relayBinding
          ? ({ id, status: "active", agentBinding: options.relayBinding } as never)
          : null,
    },
    listOwnedContexts: async () => ({ contexts: options?.owned ?? [] }),
  });
  return { definition, semanticCall, semanticPublishCall };
}

describe("canonical vcsService", () => {
  it("exposes exactly the 18 public semantic methods", () => {
    const { definition } = service();
    expect(Object.keys(definition.methods).sort()).toEqual(Object.keys(vcsMethods).sort());
    expect(Object.keys(definition.methods)).toHaveLength(18);
  });

  it("forwards only input and the exact per-call causal edge", async () => {
    const { definition, semanticCall } = service();
    await definition.handler(shellContext(), "status", [{ contextId: "context:target" }]);
    expect(semanticCall).toHaveBeenCalledWith("vcsStatus", {
      input: { contextId: "context:target" },
      ingress: {
        causalParent: null,
        contextIntegrity: { class: "internal", externalKeys: [] },
      },
    });
  });

  it("preserves semantic failures unchanged", async () => {
    const failure = Object.assign(new Error("context changed"), { code: "RevisionChanged" });
    const { definition } = service({ failure });
    await expect(
      definition.handler(shellContext(), "status", [{ contextId: "context:target" }])
    ).rejects.toBe(failure);
  });

  it("does not transport an agent session or authorship snapshot on reads", async () => {
    const channelId = "channel:trusted";
    const { definition, semanticCall } = service();
    await definition.handler(agentContext(channelId), "status", [{ contextId: "context:agent" }]);
    expect(semanticCall).toHaveBeenCalledWith("vcsStatus", {
      input: { contextId: "context:agent" },
      ingress: {
        causalParent: null,
        contextIntegrity: { class: "internal", externalKeys: [] },
      },
    });
  });

  it("preserves a trusted relay's exact causal invocation", async () => {
    const trajectory = channelTrajectoryFor("channel:relay");
    const { definition, semanticCall } = service({
      relayBinding: {
        entityId: "entity:agent",
        contextId: "context:agent",
        channelId: "channel:relay",
      },
    });
    const ctx: ServiceContext = {
      caller: createVerifiedCaller("do:EvalDO:one", "do"),
      causalParent: {
        kind: "trajectory-invocation",
        ...trajectory,
        invocationId: "invocation:eval",
      },
      authorization: INTERNAL_AUTHORIZATION,
    };
    await definition.handler(ctx, "status", [{ contextId: "context:agent" }]);
    expect(semanticCall).toHaveBeenCalledWith(
      "vcsStatus",
      expect.objectContaining({
        ingress: expect.objectContaining({ causalParent: ctx.causalParent }),
      })
    );
  });

  it("rejects an agent-bound mutation without an exact causal invocation", async () => {
    const { definition, semanticCall } = service({
      relayBinding: {
        entityId: "entity:agent",
        contextId: "context:agent",
        channelId: "channel:agent",
      },
    });
    const ctx: ServiceContext = {
      caller: createVerifiedCaller("do:AgentDO:one", "do"),
      authorization: INTERNAL_AUTHORIZATION,
    };
    await expect(
      definition.handler(ctx, "discard", [
        {
          contextId: "context:agent",
          expectedWorkingHead: EVENT,
          commandId: "command:discard",
        },
      ])
    ).rejects.toMatchObject({
      code: "EACCES",
      errorData: { code: "Unauthorized", operation: "causal-ingress" },
    });
    expect(semanticCall).not.toHaveBeenCalled();
  });

  it("confines mutations to the caller's context", async () => {
    const { definition, semanticCall } = service({ context: "context:own" });
    await expect(
      definition.handler(workerContext(), "discard", [
        {
          contextId: "context:foreign",
          expectedWorkingHead: EVENT,
          commandId: "command:discard",
        },
      ])
    ).rejects.toThrow(/outside the caller's authority/);
    expect(semanticCall).not.toHaveBeenCalled();
  });

  it("allows the exact lifecycle owner to mutate its child context", async () => {
    const caller = workerContext();
    const { definition, semanticCall } = service({
      context: "context:own",
      owned: [
        {
          contextId: "context:child",
          kind: "lifecycle",
          ownerEntityId: caller.caller.runtime.id,
        },
      ],
    });
    await definition.handler(caller, "discard", [
      {
        contextId: "context:child",
        expectedWorkingHead: EVENT,
        commandId: "command:discard-child",
      },
    ]);
    expect(semanticCall).toHaveBeenCalledOnce();
  });

  it("keeps lineage and foreign lifecycle contexts non-writable", async () => {
    for (const child of [
      { contextId: "context:child", kind: "lineage" as const, ownerEntityId: null },
      {
        contextId: "context:child",
        kind: "lifecycle" as const,
        ownerEntityId: "worker:sibling",
      },
    ]) {
      const { definition, semanticCall } = service({
        context: "context:own",
        owned: [child],
      });
      await expect(
        definition.handler(workerContext(), "discard", [
          {
            contextId: "context:child",
            expectedWorkingHead: EVENT,
            commandId: `command:${child.kind}`,
          },
        ])
      ).rejects.toThrow(/outside the caller's authority/);
      expect(semanticCall).not.toHaveBeenCalled();
    }
  });

  it("allows a context owner to request protected publication", async () => {
    const { definition, semanticPublishCall } = service({ context: "context:own" });
    await definition.handler(workerContext(), "push", [
      {
        contextId: "context:own",
        commandId: "command:push",
        expectedCommittedEventId: "event:next",
        expectedMainEventId: "event:main",
      },
    ]);
    expect(semanticPublishCall).toHaveBeenCalledOnce();
  });

  it("allows an exactly attributed agent to request publication of its own context", async () => {
    const ctx = agentContext();
    ctx.causalParent = {
      kind: "trajectory-invocation",
      ...channelTrajectoryFor("channel:own"),
      invocationId: "invocation:push",
    };
    const { definition, semanticPublishCall } = service();
    await definition.handler(ctx, "push", [
      {
        contextId: "context:agent",
        commandId: "command:agent-push",
        expectedCommittedEventId: "event:next",
        expectedMainEventId: "event:main",
      },
    ]);
    expect(semanticPublishCall).toHaveBeenCalledOnce();
  });

  it("authorizes the primary context on status reads", async () => {
    const { definition, semanticCall } = service({ context: "context:own" });
    await expect(
      definition.handler(workerContext(), "status", [{ contextId: "context:foreign" }])
    ).rejects.toThrow(/outside the caller's reachable context graph/);
    expect(semanticCall).not.toHaveBeenCalled();
  });

  it("rejects exact state roots outside every caller-authorized context", async () => {
    const { definition, semanticCall } = service({
      context: "context:own",
      referencesReachable: false,
    });
    await expect(
      definition.handler(workerContext(), "compare", [
        {
          target: EVENT,
          sourceEventId: "event:foreign",
          view: "changes",
          limit: 20,
        },
      ])
    ).rejects.toMatchObject({
      code: "EACCES",
      errorData: { code: "Unauthorized", operation: "semantic-root-read" },
    });
    expect(semanticCall).not.toHaveBeenCalled();
  });

  it("lets an agent inspect its own channel trajectory before it has VCS commands", async () => {
    const trajectory = channelTrajectoryFor("channel:own");
    const ctx = agentContext("channel:own");
    ctx.causalParent = {
      kind: "trajectory-invocation",
      logId: trajectory.logId,
      head: trajectory.head,
      invocationId: "invocation:provenance",
    };
    const { definition, semanticCall } = service({ referencesReachable: false });

    await definition.handler(ctx, "inspect", [
      { node: { kind: "trajectory", logId: trajectory.logId, head: trajectory.head } },
    ]);

    expect(semanticCall).toHaveBeenCalledOnce();
  });

  it("does not treat a foreign trajectory as the agent's own", async () => {
    const own = channelTrajectoryFor("channel:own");
    const foreign = channelTrajectoryFor("channel:foreign");
    const ctx = agentContext("channel:own");
    ctx.causalParent = {
      kind: "trajectory-invocation",
      logId: own.logId,
      head: own.head,
      invocationId: "invocation:provenance",
    };
    const { definition, semanticCall } = service({ referencesReachable: false });

    await expect(
      definition.handler(ctx, "inspect", [
        { node: { kind: "trajectory", logId: foreign.logId, head: foreign.head } },
      ])
    ).rejects.toThrow(/outside the caller's reachable context graph/);
    expect(semanticCall).not.toHaveBeenCalled();
  });

  it("lets a non-privileged caller walk only its causally reachable intent chain", async () => {
    const appliedChange = {
      kind: "applied-change" as const,
      appliedChangeId: "applied-change:causal",
    };
    const change = { kind: "change" as const, changeId: "change:causal" };
    const workUnit = { kind: "work-unit" as const, workUnitId: "work-unit:causal" };
    const command = { kind: "command" as const, commandId: "command:causal" };
    const invocation = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:own",
      head: "main",
      invocationId: "invocation:causal",
    };
    const turn = {
      kind: "trajectory-turn" as const,
      logId: "trajectory:own",
      head: "main",
      turnId: "turn:causal",
    };
    const message = {
      kind: "trajectory-message" as const,
      logId: "trajectory:own",
      head: "main",
      messageId: "message:causal",
    };
    const chain: VcsSemanticNodeRef[] = [
      appliedChange,
      change,
      workUnit,
      command,
      invocation,
      turn,
      message,
    ];
    const key = (node: unknown) => JSON.stringify(node);
    const reachable = new Set(chain.map(key));
    const adjacency = new Map<string, VcsProvenanceEdge[]>([
      [key(appliedChange), [{ kind: "realizes-change", from: appliedChange, to: change }]],
      [key(change), [{ kind: "authored-change", from: workUnit, to: change }]],
      [key(workUnit), [{ kind: "caused-by", from: workUnit, to: command }]],
      [key(command), [{ kind: "caused-by", from: command, to: invocation }]],
      [key(invocation), [{ kind: "part-of-turn", from: invocation, to: turn }]],
      [key(turn), [{ kind: "triggered-by", from: turn, to: message }]],
      [key(message), []],
    ]);
    const { definition, semanticCall } = service({
      context: "context:own",
      referencesReachable: (contextIds, references) =>
        contextIds.length === 1 &&
        contextIds[0] === "context:own" &&
        references.every(({ value }) => reachable.has(key(value))),
      semanticCall: (method, request) => {
        const input = request.input as { node?: VcsSemanticNodeRef; root?: VcsSemanticNodeRef };
        if (method === "vcsInspect" && input.node) {
          return {
            root: input.node,
            node: { kind: input.node.kind },
            edges: [],
            hasMoreEdges: false,
          };
        }
        if (method === "vcsNeighbors" && input.root) {
          return {
            root: input.root,
            edges: adjacency.get(key(input.root)) ?? [],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected semantic method ${method}`);
      },
    });
    const caller = workerContext();

    for (const [index, node] of chain.entries()) {
      await expect(
        definition.handler(caller, "inspect", [{ node, edgeLimit: 20 }])
      ).resolves.toMatchObject({ root: node });
      const page = (await definition.handler(caller, "neighbors", [{ root: node, limit: 20 }])) as {
        edges: VcsProvenanceEdge[];
      };
      expect(page.edges).toEqual(adjacency.get(key(node)));
      if (index + 1 < chain.length) {
        expect(
          page.edges.some(
            (edge) =>
              key(edge.from) === key(chain[index + 1]) || key(edge.to) === key(chain[index + 1])
          )
        ).toBe(true);
      }
    }

    const siblingInvocation = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:own",
      head: "main",
      invocationId: "invocation:sibling",
    };
    await expect(
      definition.handler(caller, "inspect", [{ node: siblingInvocation, edgeLimit: 20 }])
    ).rejects.toMatchObject({
      code: "EACCES",
      errorData: { code: "Unauthorized", operation: "semantic-root-read" },
    });
    await expect(
      definition.handler(caller, "neighbors", [{ root: siblingInvocation, limit: 20 }])
    ).rejects.toMatchObject({
      code: "EACCES",
      errorData: { code: "Unauthorized", operation: "semantic-root-read" },
    });
    expect(semanticCall).toHaveBeenCalledTimes(chain.length * 2);
  });

  it("carries the verified caller only to the protected publication gate", async () => {
    const ctx = shellContext();
    const { definition, semanticPublishCall } = service();
    await definition.handler(ctx, "push", [
      {
        contextId: "context:own",
        commandId: "command:push",
        expectedCommittedEventId: "event:next",
        expectedMainEventId: "event:main",
      },
    ]);
    expect(semanticPublishCall).toHaveBeenCalledWith(
      {
        contextId: "context:own",
        commandId: "command:push",
        expectedCommittedEventId: "event:next",
        expectedMainEventId: "event:main",
      },
      null,
      ctx.caller,
      { class: "internal", externalKeys: [] }
    );
  });
});
