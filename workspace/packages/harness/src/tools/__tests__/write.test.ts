import { describe, expect, it } from "vitest";
import { createWriteTool } from "../write.js";
import { StubFs } from "./stub-fs.js";
import { StubVcs } from "./stub-vcs.js";

const CWD = "/";
const authority = { contextId: "context:test", commandId: "command:write" };

describe("canonical write tool", () => {
  it("creates a new repository file through a state-checked change", async () => {
    const vcs = new StubVcs();
    const tool = createWriteTool(CWD, vcs, authority);
    const result = await tool.execute("invocation:1", {
      path: "meta/out.txt",
      content: "hello",
    });
    expect(vcs.read("meta/out.txt")).toBe("hello");
    expect(vcs.lastEditInput).toMatchObject({
      commandId: "command:write",
      expectedWorkingHead: { kind: "event", eventId: "event:genesis" },
      changes: [
        {
          kind: "file-create",
          repositoryId: "repository:meta",
          path: "out.txt",
        },
      ],
    });
    expect(result.details.storage).toBe("vcs");
  });

  it("guards an overwrite with the exact state and file identity", async () => {
    const vcs = new StubVcs({ files: { "meta/out.txt": "old" } });
    const tool = createWriteTool(CWD, vcs, authority);
    await tool.execute("invocation:2", { path: "meta/out.txt", content: "new" });
    expect(vcs.lastEditInput).toMatchObject({
      expectedWorkingHead: { kind: "event", eventId: "event:genesis" },
      changes: [
        {
          kind: "text-edit",
          repositoryId: "repository:meta",
          fileId: "file:meta/out.txt",
          edits: [{ start: 0, end: 3, text: "new" }],
        },
      ],
    });
  });

  it("writes non-repository scratch paths directly", async () => {
    const vcs = new StubVcs();
    const fs = new StubFs();
    const tool = createWriteTool(CWD, vcs, authority, fs);
    const result = await tool.execute("invocation:3", { path: ".tmp/out.txt", content: "scratch" });
    await expect(fs.readFile(".tmp/out.txt", "utf8")).resolves.toBe("scratch");
    expect(result.details.storage).toBe("scratch");
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("can expose its schema unbound but refuses a semantic mutation", async () => {
    const vcs = new StubVcs();
    const tool = createWriteTool(CWD, vcs, {
      contextId: "context:test",
      commandId: () => {
        throw new Error("no bound trajectory invocation");
      },
    });

    expect(tool.parameters.properties).toHaveProperty("path");
    await expect(
      tool.execute("untrusted-tool-call-id", { path: "meta/out.txt", content: "hello" })
    ).rejects.toThrow(/no bound trajectory invocation/);
    expect(vcs.lastEditInput).toBeUndefined();
  });
});
