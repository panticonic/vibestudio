import { describe, it, expect } from "vitest";
import { createWriteTool } from "../write.js";
import { StubFs } from "./stub-fs.js";
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

  it("canonicalizes file-looking container-root paths", async () => {
    const vcs = new StubVcs();
    const tool = createWriteTool(CWD, vcs);
    const result = await tool.execute("call-file", {
      path: "projects/file-tools-smoke.txt",
      content: "marker",
    });

    expect(vcs.read("projects/file-tools-smoke/file-tools-smoke.txt")).toBe("marker");
    expect(result.details).toMatchObject({
      path: "projects/file-tools-smoke/file-tools-smoke.txt",
      storage: "vcs",
    });
    expect((result.content[0] as { text: string }).text).toContain(
      "projects/file-tools-smoke/file-tools-smoke.txt"
    );
  });

  it("writes ordinary non-repo paths to context-local scratch when runtime fs is available", async () => {
    const vcs = new StubVcs();
    const fs = new StubFs();
    const tool = createWriteTool(CWD, vcs, fs);
    const result = await tool.execute("call-1", {
      path: "tmp_dir_test_root/nested.txt",
      content: "scratch",
    });

    await expect(fs.readFile("tmp_dir_test_root/nested.txt", "utf8")).resolves.toBe("scratch");
    expect(vcs.read("tmp_dir_test_root/nested.txt")).toBeUndefined();
    expect(result.details).toMatchObject({
      path: "tmp_dir_test_root/nested.txt",
      storage: "scratch",
    });
  });

  it("routes a bare filename through VCS even when runtime fs is available", async () => {
    const vcs = new StubVcs();
    const fs = new StubFs();
    const tool = createWriteTool(CWD, vcs, fs);
    const result = await tool.execute("call-bare", { path: "note.md", content: "tracked" });

    expect(vcs.read("note.md")).toBe("tracked");
    await expect(fs.readFile("note.md", "utf8")).rejects.toThrow(/ENOENT/);
    expect(result.details).toMatchObject({ path: "note.md", storage: "vcs" });
  });

  it("preserves VCS routing and invocation provenance for source-repo paths", async () => {
    const vcs = new StubVcs();
    const fs = new StubFs();
    const tool = createWriteTool(CWD, vcs, fs);
    const result = await tool.execute("call-source", {
      path: "packages/demo/index.ts",
      content: "export {};",
    });

    expect(vcs.read("packages/demo/index.ts")).toBe("export {};");
    await expect(fs.readFile("packages/demo/index.ts", "utf8")).rejects.toThrow(/ENOENT/);
    expect(vcs.lastEditInput?.invocationId).toBe("call-source");
    expect(result.details.storage).toBe("vcs");
  });

  it("returns a recoverable scratch-path diagnostic for platform-ignored paths", async () => {
    const vcs = new StubVcs();
    const fs = new StubFs();
    const tool = createWriteTool(CWD, vcs, fs);
    const result = await tool.execute("call-ignored", {
      path: ".gad/probe.txt",
      content: "do not place this in platform metadata",
    });

    expect(result.details).toEqual({
      bytesWritten: 0,
      path: ".gad/probe.txt",
      storage: "none",
      diagnostic: "platform-ignored",
      suggestedScratchPath: ".tmp/probe.txt",
    });
    expect((result.content[0] as { text: string }).text).toMatch(/retry with \.tmp\/probe\.txt/i);
    expect(vcs.read(".gad/probe.txt")).toBeUndefined();
    await expect(fs.readFile(".gad/probe.txt", "utf8")).rejects.toThrow(/ENOENT/);
  });
});
