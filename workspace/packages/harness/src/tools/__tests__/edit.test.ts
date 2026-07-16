import { describe, expect, it } from "vitest";
import { createEditTool } from "../edit.js";
import { StubFs } from "./stub-fs.js";
import { StubVcs } from "./stub-vcs.js";

const CWD = "/";
const authority = { contextId: "context:test", commandId: "command:edit" };

describe("canonical edit tool", () => {
  it("resolves exact file identity and records a guarded semantic change", async () => {
    const vcs = new StubVcs({ files: { "meta/a.ts": "const x = 1;\n" } });
    const tool = createEditTool(CWD, vcs, authority);
    const result = await tool.execute("invocation:1", {
      path: "meta/a.ts",
      oldText: "1",
      newText: "42",
    });

    expect(vcs.read("meta/a.ts")).toBe("const x = 42;\n");
    expect(vcs.lastEditInput).toMatchObject({
      contextId: "context:test",
      expectedWorkingHead: { kind: "event", eventId: "event:genesis" },
      commandId: "command:edit",
      changes: [
        {
          kind: "text-edit",
          repositoryId: "repository:meta",
          fileId: "file:meta/a.ts",
          edits: [{ start: 10, end: 11, text: "42" }],
        },
      ],
    });
    expect(result.details.storage).toBe("vcs");
  });

  it("reports ambiguous text without mutating", async () => {
    const vcs = new StubVcs({ files: { "meta/a.ts": "foo\nfoo\n" } });
    const tool = createEditTool(CWD, vcs, authority);
    const result = await tool.execute("invocation:2", {
      path: "meta/a.ts",
      oldText: "foo",
      newText: "bar",
    });
    expect(result.details).toMatchObject({ diagnostic: "ambiguous", matchCount: 2 });
    expect(vcs.lastEditInput).toBeUndefined();
  });

  it("keeps non-repository scratch edits on the scoped filesystem", async () => {
    const vcs = new StubVcs();
    const fs = new StubFs({ files: { ".tmp/note.txt": "before" } });
    const tool = createEditTool(CWD, vcs, authority, fs);
    const result = await tool.execute("invocation:3", {
      path: ".tmp/note.txt",
      oldText: "before",
      newText: "after",
    });
    await expect(fs.readFile(".tmp/note.txt", "utf8")).resolves.toBe("after");
    expect(result.details.storage).toBe("scratch");
  });
});
