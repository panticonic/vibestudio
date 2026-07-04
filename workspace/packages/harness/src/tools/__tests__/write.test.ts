import { describe, it, expect } from "vitest";
import { createWriteTool } from "../write.js";
import { StubVcs } from "./stub-vcs.js";

const CWD = "/work/ctx";

describe("createWriteTool", () => {
  it("writes a new file", async () => {
    const vcs = new StubVcs();
    const tool = createWriteTool(CWD, vcs);
    const result = await tool.execute("call-1", { path: "out.txt", content: "hello" });
    expect(result.details.bytesWritten).toBe(5);
    expect(vcs.read("out.txt")).toBe("hello");
    // T2: invocation stamping is done by the shared ToolVcs seam, not hand-passed.
    expect(vcs.lastEditInput?.invocationId).toBe("call-1");
  });

  it("overwrites an existing file", async () => {
    const vcs = new StubVcs({ files: { ["out.txt"]: "old" } });
    const tool = createWriteTool(CWD, vcs);
    await tool.execute("call-1", { path: "out.txt", content: "new" });
    expect(vcs.read("out.txt")).toBe("new");
  });

  it("writes nested paths (content-addressed tree, no mkdir)", async () => {
    const vcs = new StubVcs();
    const tool = createWriteTool(CWD, vcs);
    await tool.execute("call-1", { path: "deep/sub/file.txt", content: "ok" });
    expect(vcs.read("deep/sub/file.txt")).toBe("ok");
  });
});
