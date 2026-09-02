import { describe, expect, it } from "vitest";
import { operationSubstanceForAuthority } from "./approvals.js";

describe("operationSubstanceForAuthority", () => {
  it("keeps provider meaning while appending trusted invocation and grant scope facts", () => {
    expect(
      operationSubstanceForAuthority({
        provided: {
          kind: "custom",
          summary: "Import the archived cards",
          detail: "Replaces the retained board snapshot.",
          facts: [{ label: "Cards", value: "12" }],
        },
        fallbackSummary: "manage Task Board",
        service: "workers/task-board-store:TaskBoardStore",
        method: "importSnapshot",
        capability: "workspace-service:task-board",
        resourceKey: "do:workers/task-board-store:TaskBoardStore:default",
        digest: "prepared-digest",
      })
    ).toEqual({
      kind: "custom",
      summary: "Import the archived cards",
      detail:
        "Replaces the retained board snapshot.\n\nAllow once permits only this call. Longer choices permit later calls using the same authority target for the stated lifetime.",
      facts: [
        { label: "Cards", value: "12" },
        {
          label: "Operation",
          value: "workers/task-board-store:TaskBoardStore.importSnapshot",
        },
        { label: "Authority", value: "workspace-service:task-board" },
        {
          label: "Authority target",
          value: "do:workers/task-board-store:TaskBoardStore:default",
        },
      ],
      digest: "prepared-digest",
    });
  });
});
