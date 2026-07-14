import { describe, expect, it } from "vitest";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityKind, EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { resolveApprovalCallerTitle, resolveApprovalRequester } from "./approvalCallerTitle.js";

const INTERNAL_DIGEST = "d".repeat(64);

function record(
  id: string,
  kind: EntityKind,
  parentId?: string,
  repoPath = "workers/test",
  executionDigest = "hash-1"
): EntityRecord {
  return {
    id,
    kind,
    source: { repoPath },
    activeExecutionDigest: executionDigest,
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
        INTERNAL_DIGEST
      )
    );
    const titles = new Map([
      ["panel:nav-chat", "Agentic Chat"],
      ["do:vibestudio/internal:EvalDO:run-1", "EvalDO run-1"],
    ]);

    expect(
      resolveApprovalCallerTitle(
        { entityCache, getTitle: (id) => titles.get(id) },
        "do:vibestudio/internal:EvalDO:run-1"
      )
    ).toBe("Agentic Chat");
  });

  it("falls back to the caller title when there is no titled panel ancestor", () => {
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
        INTERNAL_DIGEST
      ),
      className: "EvalDO",
      stateArgs: { ownerPrincipalId: "do:workers/agent:AgentDO:session", subKey: "turn-17" },
    });
    const titles = new Map([
      ["panel:nav-chat", "Agentic Chat"],
      ["do:workers/agent:AgentDO:session", "Research Agent"],
    ]);

    const requester = resolveApprovalRequester(
      { entityCache, getTitle: (id) => titles.get(id) },
      {
        callerId: "do:vibestudio/internal:EvalDO:run-1",
        callerKind: "do",
        repoPath: "vibestudio/internal",
        executionDigest: INTERNAL_DIGEST,
      }
    );

    expect(requester).toMatchObject({
      category: "eval",
      title: "Agentic Chat",
      panel: { id: "panel:nav-chat", title: "Agentic Chat" },
      stableIdentityKey: `vibestudio/internal@${INTERNAL_DIGEST}`,
      eval: {
        ownerId: "do:workers/agent:AgentDO:session",
        subKey: "turn-17",
      },
    });
    expect(requester.breadcrumbs.map((crumb) => [crumb.category, crumb.label])).toEqual([
      ["panel", "Agentic Chat"],
      ["agent", "Research Agent"],
      ["eval", "Eval turn-17"],
    ]);
  });
});
