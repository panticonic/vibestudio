import { describe, it, expect } from "vitest";
import { createEditTool } from "../edit.js";
import { StubFs } from "./stub-fs.js";
import { StubVcs } from "./stub-vcs.js";

const CWD = "/work/ctx";

describe("createEditTool", () => {
  it("replaces an exact match", async () => {
    const vcs = new StubVcs({ files: { ["a.ts"]: "const x = 1;\nconst y = 2;" } });
    const tool = createEditTool(CWD, vcs);
    const result = await tool.execute("call-1", {
      path: "a.ts",
      oldText: "const x = 1;",
      newText: "const x = 42;",
    });
    expect(result.details.diff).toContain("const x = 42;");
    expect(vcs.read("a.ts")).toContain("const x = 42;");
    // Provenance: the edit is tagged with the authoring tool-call id (the edge
    // into the agentic trajectory — file → edit → invocation → turn → session).
    expect(vcs.lastEditInput?.invocationId).toBe("call-1");
  });

  it("returns a recoverable diagnostic when there are multiple occurrences", async () => {
    const vcs = new StubVcs({ files: { ["a.ts"]: "foo\nfoo\nfoo" } });
    const tool = createEditTool(CWD, vcs);
    const result = await tool.execute("call-1", {
      path: "a.ts",
      oldText: "foo",
      newText: "bar",
    });
    expect(result.details).toMatchObject({
      diff: "",
      diagnostic: "ambiguous",
      matchCount: 3,
      candidateLines: [1, 2, 3],
    });
    expect(vcs.read("a.ts")).toBe("foo\nfoo\nfoo");
  });

  it("returns a recoverable diagnostic when text is not found", async () => {
    const vcs = new StubVcs({ files: { ["a.ts"]: "alpha" } });
    const tool = createEditTool(CWD, vcs);
    const result = await tool.execute("call-1", {
      path: "a.ts",
      oldText: "beta",
      newText: "gamma",
    });
    expect(result.details).toMatchObject({ diff: "", diagnostic: "not-found" });
    expect(vcs.read("a.ts")).toBe("alpha");
  });

  it("returns a recoverable diagnostic when the file is missing", async () => {
    const vcs = new StubVcs();
    const tool = createEditTool(CWD, vcs);
    const result = await tool.execute("call-1", {
      path: "missing.ts",
      oldText: "x",
      newText: "y",
    });
    expect(result.details).toMatchObject({ diff: "", diagnostic: "missing-file" });
  });

  it("treats no-op replacements as completed no-ops", async () => {
    const vcs = new StubVcs({ files: { ["a.ts"]: "const x = 1;" } });
    const tool = createEditTool(CWD, vcs);
    const result = await tool.execute("call-1", {
      path: "a.ts",
      oldText: "const x = 1;",
      newText: "const x = 1;",
    });

    expect((result.content[0] as { text: string }).text).toContain("No changes made");
    expect(result.details.diff).toBe("");
  });

  it("uses fuzzy match for smart quotes", async () => {
    const vcs = new StubVcs({
      files: { ["a.ts"]: "say \u201chello\u201d world" },
    });
    const tool = createEditTool(CWD, vcs);
    await tool.execute("call-1", {
      path: "a.ts",
      oldText: '"hello"',
      newText: '"goodbye"',
    });
    expect(vcs.read("a.ts")).toContain('"goodbye"');
  });

  it("edits ordinary non-repo scratch files through the scoped runtime fs", async () => {
    const vcs = new StubVcs();
    const fs = new StubFs({ files: { "scratch/note.txt": "hello world\n" } });
    const tool = createEditTool(CWD, vcs, fs);
    const result = await tool.execute("call-1", {
      path: "scratch/note.txt",
      oldText: "world",
      newText: "sandbox",
    });

    await expect(fs.readFile("scratch/note.txt", "utf8")).resolves.toBe("hello sandbox\n");
    expect(vcs.read("scratch/note.txt")).toBeUndefined();
    expect(result.details.storage).toBe("scratch");
  });

  it("edits a bare filename through VCS even when runtime fs is available", async () => {
    const vcs = new StubVcs({ files: { ["note.md"]: "hello world\n" } });
    const fs = new StubFs({ files: { "note.md": "scratch copy\n" } });
    const tool = createEditTool(CWD, vcs, fs);
    const result = await tool.execute("call-bare", {
      path: "note.md",
      oldText: "world",
      newText: "tracked",
    });

    expect(vcs.read("note.md")).toBe("hello tracked\n");
    await expect(fs.readFile("note.md", "utf8")).resolves.toBe("scratch copy\n");
    expect(result.details.storage).toBe("vcs");
  });

  it("keeps source-repo edits in VCS when runtime fs is also available", async () => {
    const vcs = new StubVcs({ files: { ["packages/demo/index.ts"]: "export const x = 1;" } });
    const fs = new StubFs();
    const tool = createEditTool(CWD, vcs, fs);
    const result = await tool.execute("call-source", {
      path: "packages/demo/index.ts",
      oldText: "1",
      newText: "2",
    });

    expect(vcs.read("packages/demo/index.ts")).toContain("= 2;");
    expect(vcs.lastEditInput?.invocationId).toBe("call-source");
    expect(result.details.storage).toBe("vcs");
  });

  it("uses the same canonical container-root shorthand as write", async () => {
    const canonicalPath = "projects/file-tools-smoke/file-tools-smoke.txt";
    const vcs = new StubVcs({ files: { [canonicalPath]: "old marker\n" } });
    const tool = createEditTool(CWD, vcs);

    await tool.execute("call-canonical", {
      path: "projects/file-tools-smoke.txt",
      oldText: "old",
      newText: "new",
    });

    expect(vcs.read(canonicalPath)).toBe("new marker\n");
  });
});
