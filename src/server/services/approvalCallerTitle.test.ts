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
  it("promotes the owning panel title for worker and DO callers", () => {
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
    expect(
      resolveApprovalCallerTitle(
        {
          entityCache,
          getTitle: (id) => (id === "panel:nav-chat" ? "Import Trello into Flowboard" : undefined),
        },
        "do:vibestudio/internal:EvalDO:run-1"
      )
    ).toBe("Import Trello into Flowboard");
  });

  it("uses the caller source label when there is no panel ancestor", () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(record("worker:background", "worker"));

    expect(
      resolveApprovalCallerTitle(
        {
          entityCache,
          getTitle: (id) => (id === "worker:background" ? "Background job" : undefined),
        },
        "worker:background"
      )
    ).toBe("Background job");
  });

  it("classifies extension callers even when they have no runtime entity record", () => {
    const requester = resolveApprovalRequester(
      { entityCache: new EntityCache(), getTitle: () => undefined },
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
      {
        entityCache,
        getTitle: (id) =>
          id === "panel:nav-chat"
            ? "Import Trello into Flowboard"
            : id === "do:workers/agent:AgentDO:session"
              ? "Research agent"
              : undefined,
      },
      {
        callerId: "do:vibestudio/internal:EvalDO:run-1",
        callerKind: "do",
        repoPath: "vibestudio/internal",
        effectiveVersion: "internal",
      }
    );

    expect(requester).toMatchObject({
      category: "eval",
      title: "Import Trello into Flowboard",
      panel: { id: "panel:nav-chat", title: "Import Trello into Flowboard" },
      stableIdentityKey: "do:workers/agent:AgentDO:session",
      eval: {
        ownerId: "do:workers/agent:AgentDO:session",
        subKey: "turn-17",
      },
    });
    expect(requester.breadcrumbs.map((crumb) => [crumb.category, crumb.label])).toEqual([
      ["panel", "Import Trello into Flowboard"],
      ["agent", "Research agent"],
      ["eval", "Eval turn-17"],
    ]);
  });
});
