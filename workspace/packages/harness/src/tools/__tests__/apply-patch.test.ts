import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../apply-patch.js";
import { StubVcs } from "./stub-vcs.js";

const authority = { contextId: "context:test", commandId: "command:patch" };

describe("apply_patch", () => {
  it("advertises the complete managed repository path boundary", () => {
    const tool = createApplyPatchTool("/", new StubVcs(), authority);

    expect(tool.description).toContain("top-level section and repository name");
    expect(tool.description).toContain("projects/app/README.md");
    expect(tool.description).toContain("workspace-root files");
  });

  it("applies a multi-file content, presence, and mode transaction", async () => {
    const vcs = new StubVcs({
      files: {
        "meta/a.ts": "const a = 1;\nconst b = 2;\n",
        "meta/delete.ts": "obsolete\n",
        "meta/script.sh": "#!/bin/sh\n",
      },
    });
    const tool = createApplyPatchTool("/", vcs, authority);
    const result = await tool.execute("invocation:patch", {
      operations: [
        {
          kind: "replace",
          path: "meta/a.ts",
          mode: 0o600,
          replacements: [
            { oldText: "a = 1", newText: "a = 10" },
            { oldText: "b = 2", newText: "b = 20" },
          ],
        },
        { kind: "write", path: "meta/new.ts", content: "export {};\n" },
        { kind: "delete", path: "meta/delete.ts" },
        { kind: "chmod", path: "meta/script.sh", mode: 0o755 },
      ],
      intent: "Update the complete fixture atomically",
    } as never);

    expect(result.details).toMatchObject({
      status: "applied",
      paths: ["meta/a.ts", "meta/new.ts", "meta/delete.ts", "meta/script.sh"],
    });
    expect(vcs.read("meta/a.ts")).toBe("const a = 10;\nconst b = 20;\n");
    expect(vcs.modes.get("meta/a.ts")).toBe(0o600);
    expect(vcs.read("meta/new.ts")).toBe("export {};\n");
    expect(vcs.read("meta/delete.ts")).toBeUndefined();
    expect(vcs.modes.get("meta/script.sh")).toBe(0o755);
    expect(vcs.lastEditInput).toMatchObject({
      commandId: "command:patch",
      intentSummary: "Update the complete fixture atomically",
      changes: [
        { kind: "text-edit", mode: 0o600 },
        { kind: "file-create", mode: 0o644 },
        { kind: "file-delete" },
        { kind: "file-mode", mode: 0o755 },
      ],
    });
  });

  it("writes arbitrary binary bytes without UTF-8 conversion", async () => {
    const vcs = new StubVcs();
    const tool = createApplyPatchTool("/", vcs, authority);
    const base64 = Buffer.from([0, 255, 1, 254]).toString("base64");
    await tool.execute("invocation:binary", {
      operations: [{ kind: "write_binary", path: "meta/asset.bin", base64, mode: 0o600 }],
    } as never);

    expect(vcs.readBinary("meta/asset.bin")).toBe(base64);
    expect(vcs.modes.get("meta/asset.bin")).toBe(0o600);
  });

  it("rejects every operation before mutation when a precondition is stale", async () => {
    const vcs = new StubVcs({ files: { "meta/a.ts": "old", "meta/b.ts": "old" } });
    const tool = createApplyPatchTool("/", vcs, authority);
    await expect(
      tool.execute("invocation:stale", {
        operations: [
          { kind: "write", path: "meta/a.ts", content: "new" },
          {
            kind: "write",
            path: "meta/b.ts",
            content: "new",
            expectedHash: "f".repeat(64),
          },
        ],
      } as never)
    ).rejects.toMatchObject({ code: "PatchPreconditionFailed" });
    expect(vcs.lastEditInput).toBeUndefined();
    expect(vcs.read("meta/a.ts")).toBe("old");
  });

  it("rejects ambiguous replacements instead of choosing a site", async () => {
    const vcs = new StubVcs({ files: { "meta/a.ts": "same\nsame\n" } });
    const tool = createApplyPatchTool("/", vcs, authority);
    await expect(
      tool.execute("invocation:ambiguous", {
        operations: [
          {
            kind: "replace",
            path: "meta/a.ts",
            replacements: [{ oldText: "same", newText: "changed" }],
          },
        ],
      } as never)
    ).rejects.toMatchObject({ code: "PatchPreconditionFailed" });
    expect(vcs.lastEditInput).toBeUndefined();
  });
});
