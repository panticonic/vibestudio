import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { InvocationSnapshot } from "@vibestudio/rpc";
import { testAuthority } from "./serviceDispatcherTestUtils.js";
import { ServiceDispatcher, createVerifiedCaller } from "./serviceDispatcher.js";
import {
  fixedPreparedAuthoritySelection,
  preparedAuthorityState,
  selectedPreparedAuthoritySelection,
  type PreparedAuthoritySelection,
} from "./serviceDefinition.js";
import {
  fixedPreparedAuthorityRequirement,
  selectedPreparedAuthorityRequirement,
  type MethodAuthorityDescriptor,
} from "./typedServiceClient.js";

const ctx = { caller: createVerifiedCaller("app:compiler", "app") };
const operation = {
  service: "bounded",
  method: "inspect",
  args: [{ contextId: "ctx", path: "notes/a" }],
  use: "action" as const,
};
const requirement = {
  kind: "capability" as const,
  principal: "code" as const,
  capability: "filesystem.read",
};
const fileSelection = () =>
  fixedPreparedAuthoritySelection({
    capability: "filesystem.read",
    resourceKey: "notes/a",
    resource: { kind: "prefix" as const, prefix: "notes/" },
  });

function fixture(
  options: {
    selections?: PreparedAuthoritySelection[];
    prepared?: MethodAuthorityDescriptor["prepared"];
    additional?: MethodAuthorityDescriptor["additional"];
  } = {}
) {
  const dispatcher = new ServiceDispatcher();
  const prepare = vi.fn(async () =>
    preparedAuthorityState(options.selections ?? [], { snapshot: "one" })
  );
  const handler = vi.fn();
  const resolver = vi.fn(() => {
    throw new Error("must not assess grants");
  });
  const acquirer = { request: vi.fn(), acquire: vi.fn(), consume: vi.fn(), invalidate: vi.fn() };
  dispatcher.setAuthorityResolver(resolver);
  dispatcher.setAuthorityAcquirer(acquirer as never);
  dispatcher.registerService({
    name: "bounded",
    authority: { principals: ["code"] },
    handler,
    methods: {
      inspect: {
        website: { kind: "eligible", rationale: "Explicit fixture policy" },
        args: z.tuple([z.object({ contextId: z.string(), path: z.string() })]),
        tier: { tier: "open", session: "family", rationale: "Context-local discovery" },
        authority: {
          requirement,
          resource: { kind: "argument", index: 0, path: ["path"] },
          additional: options.additional,
          prepared: options.prepared ?? {
            resolver: "select",
            leaves: [
              {
                capability: "filesystem.read",
                tier: "gated",
                requirement: fixedPreparedAuthorityRequirement(requirement),
              },
            ],
          },
        },
      },
    },
    authorityPreparation: { select: prepare },
  });
  return { dispatcher, prepare, handler, resolver, acquirer };
}

describe("receiver authority plan compilation", () => {
  it("runs the bounded preparer for an open method even when it selects no extra authority", async () => {
    const f = fixture();
    const result = await f.dispatcher.compileAuthorityPlanOperation(ctx, operation);
    expect(result.leaves).toHaveLength(1);
    expect(result.leaves[0]).toMatchObject({
      capability: "service:bounded.inspect",
      tier: "open",
      resource: { kind: "exact", key: "notes/a" },
      capabilityDefinitionDigest: "-",
    });
    expect(f.prepare).toHaveBeenCalledWith(ctx, operation.args);
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.resolver).not.toHaveBeenCalled();
    for (const spy of Object.values(f.acquirer)) expect(spy).not.toHaveBeenCalled();
  });

  it("retains a receiver-selected gated resource envelope and its reviewed semantics", async () => {
    const f = fixture({ selections: [fileSelection()] });
    const result = await f.dispatcher.compileAuthorityPlanOperation(ctx, operation);
    expect(result.leaves[1]).toMatchObject({
      capability: "filesystem.read",
      tier: "gated",
      resource: { kind: "prefix", prefix: "notes/" },
      capabilityDefinitionDigest: "-",
      use: "action",
      review: { domain: "files", verb: "see" },
    });
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.resolver).not.toHaveBeenCalled();
  });

  it("includes every unconditional additional receiver leaf", async () => {
    const f = fixture({
      additional: [
        {
          capability: "filesystem.read",
          tier: "gated",
          requirement,
          resource: { kind: "literal", key: "notes/a" },
        },
      ],
    });
    expect(
      (await f.dispatcher.compileAuthorityPlanOperation(ctx, operation)).leaves[1]
    ).toMatchObject({
      capability: "filesystem.read",
      tier: "gated",
      resource: { kind: "exact", key: "notes/a" },
    });
  });

  it("rejects unrepresentable origin conditions rather than manufacturing standing authority", async () => {
    const f = fixture({
      additional: [
        {
          capability: "filesystem.read",
          tier: "gated",
          requirement,
          resource: { kind: "literal", key: "notes/a" },
          when: { origins: ["website"] },
        },
      ],
    });
    await expect(f.dispatcher.compileAuthorityPlanOperation(ctx, operation)).rejects.toThrow(
      "origin-conditional"
    );
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("validates canonical arguments before calling the preparer", async () => {
    const f = fixture();
    await expect(
      f.dispatcher.compileAuthorityPlanOperation(ctx, { ...operation, args: [] })
    ).rejects.toMatchObject({
      errorData: { code: "invalid-arguments", method: "bounded.inspect" },
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it.each([
    [
      "undeclared capability",
      () =>
        fixedPreparedAuthoritySelection({ capability: "filesystem.write", resourceKey: "notes/a" }),
      /undeclared capability/,
    ],
    [
      "out-of-envelope resource",
      () =>
        fixedPreparedAuthoritySelection({
          capability: "filesystem.read",
          resourceKey: "elsewhere/a",
          resource: { kind: "prefix", prefix: "notes/" },
        }),
      /envelope/,
    ],
    [
      "replacement fixed tier",
      () =>
        fixedPreparedAuthoritySelection({
          capability: "filesystem.read",
          resourceKey: "notes/a",
          tier: "critical",
        }),
      /fixed leaf tier/,
    ],
  ] as const)(
    "rejects %s through the shared receiver contract",
    async (_name, makeSelection, message) => {
      const f = fixture({ selections: [makeSelection()] });
      await expect(f.dispatcher.compileAuthorityPlanOperation(ctx, operation)).rejects.toThrow(
        message
      );
      expect(f.handler).not.toHaveBeenCalled();
      expect(f.resolver).not.toHaveBeenCalled();
    }
  );

  it("rejects a selected principal outside the declared receiver family", async () => {
    const f = fixture({
      prepared: {
        resolver: "select",
        leaves: [
          {
            capability: "filesystem.read",
            tier: "gated",
            requirement: selectedPreparedAuthorityRequirement(["code"]),
          },
        ],
      },
      selections: [
        selectedPreparedAuthoritySelection({
          capability: "filesystem.read",
          resourceKey: "notes/a",
          requirement: { ...requirement, principal: "user" },
        }),
      ],
    });
    await expect(f.dispatcher.compileAuthorityPlanOperation(ctx, operation)).rejects.toThrow(
      "out-of-contract requirement"
    );
  });

  it("preserves the original preparation error without publishing or acquiring", async () => {
    const f = fixture();
    const failure = new Error("receiver snapshot unavailable");
    f.prepare.mockRejectedValueOnce(failure);
    await expect(f.dispatcher.compileAuthorityPlanOperation(ctx, operation)).rejects.toBe(failure);
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.resolver).not.toHaveBeenCalled();
  });

  it("seals receiver provider and preparation facts separately from host grant identity", async () => {
    const capability = "workspace-service:mail";
    const selection = fixedPreparedAuthoritySelection({
      capability,
      resourceKey: "recipient:alice",
      receiverAuthority: {
        capabilityDefinitionDigest: "a".repeat(64),
        resourceType: "recipient",
        provider: "workers/mail",
        providerExecutionDigest: "b".repeat(64),
      },
      challenge: {
        title: "Send mail",
        description: "Deliver to Alice",
        deniedReason: "Mail was denied",
        resource: { type: "recipient", label: "Alice", value: "recipient:alice" },
        operation: {
          kind: "unknown" as const,
          verb: "send mail",
          object: { type: "recipient", label: "Alice", value: "recipient:alice" },
        },
        authorityVocabulary: {
          domain: "sharing" as const,
          verb: "act" as const,
          declaredBy: "workers/mail",
        },
      },
    });
    const f = fixture({
      prepared: {
        resolver: "select",
        leaves: [
          {
            capability,
            tier: "gated",
            requirement: fixedPreparedAuthorityRequirement({ ...requirement, capability }),
          },
        ],
      },
      selections: [selection],
    });
    const first = await f.dispatcher.compileAuthorityPlanOperation(ctx, operation);
    expect(first.leaves[1]).toMatchObject({
      capabilityDefinitionDigest: "a".repeat(64),
      provider: "workers/mail",
      providerEffectiveVersion: "-",
      review: { action: "send mail", domain: "sharing", declaredBy: "workers/mail" },
    });
    f.prepare.mockResolvedValueOnce(
      preparedAuthorityState(
        [
          {
            ...selection,
            receiverAuthority: {
              ...selection.receiverAuthority,
              providerExecutionDigest: "c".repeat(64),
            },
          },
        ],
        { snapshot: "one" }
      )
    );
    const second = await f.dispatcher.compileAuthorityPlanOperation(ctx, operation);
    expect(second.definitionDigest).not.toBe(first.definitionDigest);
    expect(second.leaves).toEqual(first.leaves);
    expect(f.resolver).not.toHaveBeenCalled();
    const caller = createVerifiedCaller("app:compiler", "app", undefined, null, {
      userId: "alice",
      handle: "alice",
    });
    f.dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) => ({
      ...testAuthority(caller, capability, resourceKey),
      grants: [],
    }));
    const snapshots: InvocationSnapshot[] = [];
    f.dispatcher.setAuthorityAcquirer({
      request: (input) => {
        snapshots.push(input.snapshot);
        return {
          acquisitionId: "acq:prepared",
          ownerRuntimeId: caller.runtime.id,
          snapshotDigest: input.snapshotDigest,
          capability: input.snapshot.capability,
          resourceKey: input.snapshot.resourceKey,
          tier: "gated",
          cardType: "permission.gated",
          renderedAction: "send mail",
          pending: true,
        };
      },
      acquire: vi.fn(),
      consume: vi.fn(),
      invalidate: vi.fn(),
    });
    f.dispatcher.markInitialized();
    await expect(
      f.dispatcher.dispatch({ caller }, operation.service, operation.method, operation.args)
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    f.prepare.mockResolvedValueOnce(
      preparedAuthorityState(
        [
          {
            ...selection,
            receiverAuthority: {
              ...selection.receiverAuthority,
              providerExecutionDigest: "c".repeat(64),
            },
          },
        ],
        { snapshot: "one" }
      )
    );
    await expect(
      f.dispatcher.dispatch({ caller }, operation.service, operation.method, operation.args)
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.preparedStateDigest).toBe(snapshots[1]!.preparedStateDigest);
    expect(snapshots[0]!.providerExecutionDigest).toBe("b".repeat(64));
    expect(snapshots[1]!.providerExecutionDigest).toBe("c".repeat(64));
  });
});
