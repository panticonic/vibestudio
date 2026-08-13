import { describe, expect, it } from "vitest";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityKind, EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { resolveApprovalCallerTitle, resolveApprovalRequester } from "./approvalCallerTitle.js";

function record(
  id: string,
  kind: EntityKind,
  parentId?: string,
  repoPath = "workers/test",
  effectiveVersion = "hash-1"
): EntityRecord {
  return {
    id,
    kind,
    source: { repoPath, effectiveVersion },
    contextId: "ctx-1",
    key: id,
    parentId,
    createdAt: 1,
    status: "active",
    cleanupComplete: true,
  };
}

describe("resolveApprovalCallerTitle", () => {
  it("uses the owning panel source label for worker and DO callers", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(record("panel:nav-chat", "panel"));
    entityCache._onActivate(record("do:workers/agent:Agent:session", "do", "panel:nav-chat"));
    entityCache._onActivate(
      record(
        "do:vibestudio/internal:EvalDO:run-1",
        "do",
        "do:workers/agent:Agent:session",
        "vibestudio/internal",
        "internal"
      )
    );
    expect(resolveApprovalCallerTitle({ entityCache }, "do:vibestudio/internal:EvalDO:run-1")).toBe(
      "test"
    );
  });

  it("uses the caller source label when there is no panel ancestor", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(record("worker:background", "worker"));

    expect(resolveApprovalCallerTitle({ entityCache }, "worker:background")).toBe("test");
  });

  it("classifies extension callers even when they have no runtime entity record", () => {
    const requester = resolveApprovalRequester(
      { entityCache: new EntityCache() },
      {
        callerId: "extension:@workspace-extensions/git-bridge",
        callerKind: "extension",
        repoPath: "extensions/git-bridge",
        effectiveVersion: "hash-1",
      }
    );

    expect(requester.category).toBe("extension");
  });

  it("builds a structured requester with panel breadcrumbs and eval metadata", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(record("panel:nav-chat", "panel"));
    entityCache._onActivate({
      ...record("do:workers/agent:AgentDO:session", "do", "panel:nav-chat"),
      className: "AgentDO",
    });
    entityCache._onActivate({
      ...record(
        "do:vibestudio/internal:EvalDO:run-1",
        "do",
        "do:workers/agent:AgentDO:session",
        "vibestudio/internal",
        "internal"
      ),
      className: "EvalDO",
      stateArgs: { ownerPrincipalId: "do:workers/agent:AgentDO:session", subKey: "turn-17" },
    });
    const requester = resolveApprovalRequester(
      { entityCache },
      {
        callerId: "do:vibestudio/internal:EvalDO:run-1",
        callerKind: "do",
        repoPath: "vibestudio/internal",
        effectiveVersion: "internal",
      }
    );

    expect(requester).toMatchObject({
      category: "eval",
      title: "test",
      panel: { id: "panel:nav-chat", title: "test" },
      stableIdentityKey: "do:workers/agent:AgentDO:session",
      eval: {
        ownerId: "do:workers/agent:AgentDO:session",
        subKey: "turn-17",
      },
    });
    expect(requester.breadcrumbs.map((crumb) => [crumb.category, crumb.label])).toEqual([
      ["panel", "test"],
      ["agent", "test"],
      ["eval", "Eval turn-17"],
    ]);
  });
});
