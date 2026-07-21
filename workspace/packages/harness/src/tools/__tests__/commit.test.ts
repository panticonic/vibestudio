import { describe, expect, it } from "vitest";
import { createCommitTool } from "../commit.js";
import { StubVcs } from "./stub-vcs.js";

const authority = { contextId: "context:test", commandId: "command:commit" };

describe("canonical commit tool", () => {
  it("commits the complete working application chain into one event", async () => {
    const vcs = new StubVcs({ files: { "packages/demo/a.ts": "a" } });
    await vcs.edit({
      contextId: "context:test",
      expectedWorkingHead: { kind: "event", eventId: "event:genesis" },
      commandId: "command:prepare",
      changes: [
        {
          kind: "text-edit",
          repositoryId: "repository:packages/demo",
          fileId: "file:packages/demo/a.ts",
          edits: [{ start: 0, end: 1, text: "b" }],
        },
      ],
    });
    const tool = createCommitTool(vcs, authority);
    const result = await tool.execute("invocation:1", { message: "Unify authorization" });

    expect(vcs.lastCommitInput).toMatchObject({
      contextId: "context:test",
      commandId: "command:commit",
      expectedWorkingHead: { kind: "application", applicationId: "application:1" },
      message: "Unify authorization",
    });
    expect(result.details.result.event).toMatchObject({
      kind: "event",
      eventId: expect.stringMatching(/^event:/),
    });
    expect(result.details.result.committedApplicationIds).toEqual(["application:1"]);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Protected main was not changed"),
    });
  });

  it("does not expose selective commit inputs", async () => {
    const vcs = new StubVcs();
    const tool = createCommitTool(vcs, authority);
    expect(tool.parameters.properties).not.toHaveProperty("workUnitIds");
    await tool.execute("invocation:2", { message: "Commit the chain" });
    expect(vcs.lastCommitInput).not.toHaveProperty("selection");
  });

  it("can close a fully-accounted integration with an exact source parent", async () => {
    const vcs = new StubVcs();
    const tool = createCommitTool(vcs, authority);
    await tool.execute("invocation:integration", {
      message: "Close the incremental integration",
      integratesEventId: "event:source",
    });
    expect(vcs.lastCommitInput).toMatchObject({
      commandId: "command:commit",
      integratesEventId: "event:source",
    });
  });
});
