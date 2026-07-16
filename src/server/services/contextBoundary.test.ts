import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  CONTEXT_BOUNDARY_CAPABILITY,
  contextBoundaryResourceKey,
  prepareContextBoundaryAuthority,
  type ContextBoundaryDeps,
} from "./contextBoundary.js";

function subjectCaller(id = "panel:p1") {
  return createVerifiedCaller(id, "panel", {
    callerId: id,
    callerKind: "panel",
    repoPath: "panels/p",
    executionDigest: "a".repeat(64),
    delegations: [],
    requested: [],
  });
}

function makeDeps(
  opts: { exists?: (id: string) => boolean; owner?: string } = {}
): ContextBoundaryDeps {
  return {
    contextExists: opts.exists ?? (() => true),
    resolveContextOwnerLabel: () => opts.owner,
  };
}

const action = { kind: "runtime" as const, verb: "Create panel" };

describe("prepareContextBoundaryAuthority", () => {
  it("selects no leaf for same-context or fresh foreign actions", () => {
    expect(
      prepareContextBoundaryAuthority(makeDeps(), {
        subjectCaller: subjectCaller(),
        originContextId: "ctx-a",
        targetContextId: "ctx-a",
        action,
      })
    ).toEqual([]);
    expect(
      prepareContextBoundaryAuthority(makeDeps({ exists: () => false }), {
        subjectCaller: subjectCaller(),
        originContextId: "ctx-a",
        targetContextId: "ctx-fresh",
        action,
      })
    ).toEqual([]);
  });

  it("selects the exact reviewed leaf for an existing foreign context", () => {
    const caller = subjectCaller();
    const [selection] = prepareContextBoundaryAuthority(makeDeps({ owner: "Agent X" }), {
      subjectCaller: caller,
      originContextId: "ctx-a",
      targetContextId: "ctx-b",
      action,
    });
    expect(selection).toMatchObject({
      capability: CONTEXT_BOUNDARY_CAPABILITY,
      resourceKey: contextBoundaryResourceKey("ctx-b", "panel:p1"),
      authorizingCaller: caller,
      challenge: {
        title: "Open panel with different file access",
        description:
          "This lets the requester open a panel that can use files in the file context owned by Agent X. That file context belongs to another agent or panel.",
        details: [
          { label: "Owner", value: "Agent X" },
          { label: "File context", value: "ctx-b" },
        ],
      },
    });
  });

  it("treats a null origin as foreign and attributes review to the exact subject", () => {
    const caller = subjectCaller("panel:anchor");
    const [selection] = prepareContextBoundaryAuthority(makeDeps(), {
      subjectCaller: caller,
      originContextId: null,
      targetContextId: "ctx-b",
      action,
    });
    expect(selection?.authorizingCaller).toBe(caller);
    expect(selection?.resourceKey).toBe(contextBoundaryResourceKey("ctx-b", "panel:anchor"));
  });

  it("attributes a relayed operation to its authenticated agent principal", () => {
    const transportId = "do:product/eval:EvalDO:run-1";
    const caller = createVerifiedCaller(
      transportId,
      "do",
      {
        callerId: transportId,
        callerKind: "do",
        repoPath: "eval/run-1",
        executionDigest: "b".repeat(64),
        delegations: [],
        requested: [],
      },
      {
        entityId: "do:workers/agent:Agent:owner",
        contextId: "ctx-owner",
        channelId: "ch-1",
        agentId: "agent-owner",
        userId: "user-1",
      }
    );
    const [selection] = prepareContextBoundaryAuthority(makeDeps(), {
      subjectCaller: caller,
      originContextId: "ctx-owner",
      targetContextId: "ctx-foreign",
      action,
    });

    expect(selection?.resourceKey).toBe(
      contextBoundaryResourceKey("ctx-foreign", "do:workers/agent:Agent:owner")
    );
    expect(selection?.challenge?.dedupKey).toBe(
      "context-boundary:do:workers/agent:Agent:owner:ctx-foreign"
    );
  });

  it("makes severe context mutations intrinsically one-shot", () => {
    const [selection] = prepareContextBoundaryAuthority(makeDeps(), {
      subjectCaller: subjectCaller(),
      originContextId: "ctx-a",
      targetContextId: "ctx-b",
      action: { kind: "runtime", verb: "Destroy context", severity: "severe" },
    });

    expect(selection?.challenge?.allowedDecisions).toEqual(["once", "deny", "dismiss"]);
  });

  it("renders durable-object launches as background processes", () => {
    const [selection] = prepareContextBoundaryAuthority(makeDeps(), {
      subjectCaller: subjectCaller(),
      originContextId: "ctx-a",
      targetContextId: "ctx-b",
      action: { kind: "runtime", verb: "Create do" },
    });
    expect(selection?.challenge).toMatchObject({
      title: "Launch background process with different file access",
      description: expect.stringContaining("start a background process"),
    });
  });
});
