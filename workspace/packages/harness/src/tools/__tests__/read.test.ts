import { describe, it, expect, vi } from "vitest";
import type { VcsProvItem, VcsProvenanceForFileResult } from "@vibez1/shared/serviceSchemas/vcs";
import { createReadTool, type ReadProvenanceDeps } from "../read.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createReadTool", () => {
  it("reads a small text file", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const tool = createReadTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "hello.txt", provenance: "none" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
    expect(result.details.path).toBe("hello.txt");
  });

  it("respects offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const fs = new StubFs({ files: { [`${CWD}/big.txt`]: lines } });
    const tool = createReadTool(CWD, fs);
    const result = await tool.execute("call-1", {
      path: "big.txt",
      provenance: "none",
      offset: 3,
      limit: 2,
    });
    const text = (result.content[0] as { text: string }).text;
    // Selected slice "line 3\nline 4" plus a continuation hint.
    expect(text).toContain("line 3");
    expect(text).toContain("line 4");
    expect(text).not.toContain("line 5\n");
  });

  it("delegates text reads to the file extension when context rpc is available", async () => {
    const fs = new StubFs();
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string) => {
        if (method === "extensions.streamingMethods") return Promise.resolve([]);
        return Promise.resolve({
          content: [{ type: "text", text: "line 3\nline 4" }],
          details: { path: "big.txt", engine: "node-file" },
        });
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });

    const result = await tool.execute("call-1", {
      path: "big.txt",
      provenance: "none",
      offset: 3,
      limit: 2,
    });

    expect((result.content[0] as { text: string }).text).toBe("line 3\nline 4");
    expect(rpc.call).toHaveBeenCalledWith(
      "main",
      "extensions.invoke",
      [
        "@workspace-extensions/file-tools",
        "read",
        [{ path: "big.txt", cwd: CWD, offset: 3, limit: 2 }],
      ],
      {
        signal: expect.any(AbortSignal),
      }
    );
  });

  it("falls back to runtime fs when the file extension read stalls", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string) => {
        if (method === "extensions.invoke") return new Promise(() => {});
        return Promise.resolve([]);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onUpdate = vi.fn();
    const tool = createReadTool(CWD, fs, { rpc, fileToolsReadTimeoutMs: 10 });

    const result = await tool.execute(
      "call-1",
      { path: "hello.txt", provenance: "none" },
      undefined,
      onUpdate
    );

    expect((result.content[0] as { text: string }).text).toBe("hello\nworld");
    expect(result.details).toMatchObject({
      path: "hello.txt",
      engine: "runtime-fs",
      extensionFallback: "file-tools read timed out after 10ms",
    });
    expect(warn).toHaveBeenCalledWith(
      "[read] file-tools read timed out after 10ms; falling back to RuntimeFs"
    );
    expect(onUpdate).toHaveBeenCalledWith({
      content: [],
      details: {
        type: "console",
        content: "file-tools read timed out after 10ms; falling back to RuntimeFs read",
      },
    });
    warn.mockRestore();
  });

  it("records a readiness fallback without treating it as a stalled extension", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const notReady = Object.assign(new Error("Context folder is materializing"), {
      code: "ENOTREADY",
    });
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string, args: unknown[]) => {
        if (method === "extensions.invoke") {
          const [extensionName, extensionMethod] = args;
          if (extensionName === "@workspace-extensions/file-tools") return Promise.reject(notReady);
          if (
            extensionName === "@workspace-extensions/image-service" &&
            extensionMethod === "detectMimeType"
          ) {
            return Promise.resolve(null);
          }
        }
        return Promise.resolve([]);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onUpdate = vi.fn();
    const tool = createReadTool(CWD, fs, { rpc, fileToolsReadTimeoutMs: 10 });

    const result = await tool.execute(
      "call-1",
      { path: "hello.txt", provenance: "none" },
      undefined,
      onUpdate
    );

    expect((result.content[0] as { text: string }).text).toBe("hello\nworld");
    expect(result.details).toMatchObject({
      path: "hello.txt",
      engine: "runtime-fs",
      extensionFallback: "file-tools extension or context not ready",
    });
    expect(warn).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps image reads on the image-service path", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fs = new StubFs({ files: { [`${CWD}/pic.png`]: pngBytes } });
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string, args: unknown[]) => {
        if (method === "extensions.streamingMethods") return Promise.resolve([]);
        const [extensionName, extensionMethod] = args;
        expect(method).toBe("extensions.invoke");
        expect(extensionName).toBe("@workspace-extensions/image-service");
        if (extensionMethod === "detectMimeType") return Promise.resolve("image/png");
        if (extensionMethod === "resize") {
          return Promise.resolve({
            data: pngBytes,
            mimeType: "image/png",
            width: 8,
            height: 8,
            originalWidth: 8,
            originalHeight: 8,
            wasResized: false,
          });
        }
        return Promise.resolve(null);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });

    const result = await tool.execute("call-1", { path: "pic.png", provenance: "none" });

    const last = result.content[result.content.length - 1] as { type: string; mimeType: string };
    expect(last.type).toBe("image");
    expect(last.mimeType).toBe("image/png");
    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "extensions.invoke",
      expect.arrayContaining(["@workspace-extensions/file-tools", "read"])
    );
  });

  it("throws when file is missing", async () => {
    const fs = new StubFs();
    const tool = createReadTool(CWD, fs);
    await expect(
      tool.execute("call-1", { path: "missing.txt", provenance: "none" })
    ).rejects.toThrow(/not found/i);
  });

  it("returns ImageContent when the image service extension detects an image type", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fs = new StubFs({ files: { [`${CWD}/pic.png`]: pngBytes } });
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string, args: unknown[]) => {
        if (method === "extensions.streamingMethods") return Promise.resolve([]);
        const [extensionName, extensionMethod] = args;
        expect(method).toBe("extensions.invoke");
        expect(extensionName).toBe("@workspace-extensions/image-service");
        if (extensionMethod === "detectMimeType") return Promise.resolve("image/png");
        if (extensionMethod === "resize") {
          return Promise.resolve({
            data: pngBytes,
            mimeType: "image/png",
            width: 8,
            height: 8,
            originalWidth: 8,
            originalHeight: 8,
            wasResized: false,
          });
        }
        return Promise.resolve(null);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });
    const result = await tool.execute("call-1", { path: "pic.png", provenance: "none" });
    const last = result.content[result.content.length - 1] as { type: string; mimeType: string };
    expect(last.type).toBe("image");
    expect(last.mimeType).toBe("image/png");
  });

  it("aborts when signal is already aborted", async () => {
    const fs = new StubFs({ files: { [`${CWD}/foo.txt`]: "x" } });
    const tool = createReadTool(CWD, fs);
    const ac = new AbortController();
    ac.abort();
    await expect(
      tool.execute("call-1", { path: "foo.txt", provenance: "none" }, ac.signal)
    ).rejects.toThrow(/abort/i);
  });
});

describe("createReadTool provenance attachment (§7.5)", () => {
  const REPO_CWD = "/";
  const makeProvenance = (
    result: Partial<VcsProvenanceForFileResult> & { items?: VcsProvItem[] },
    calls: Array<Record<string, unknown>>
  ): ReadProvenanceDeps => ({
    provenanceForFile: async (input) => {
      calls.push(input);
      return {
        items: [],
        shown: 0,
        total: 0,
        suppressed: false,
        ...result,
      } as VcsProvenanceForFileResult;
    },
    head: "ctx:c1",
    sessionLogId: "branch:channel:ch",
    sessionHead: "branch:channel:ch",
  });

  it("appends the §7.5 block after content, exceptions first, with the K-of-M tail", async () => {
    const fs = new StubFs({ files: { ["/packages/foo/bar.ts"]: "line1\nline2" } });
    const calls: Array<Record<string, unknown>> = [];
    const items: VcsProvItem[] = [
      {
        line: '⚠ contradicts claim#7 "retries are caller-controlled" → provenance(claim#7)',
        handle: "claim#7",
        kind: "claim",
        exception: true,
        score: 0,
      },
      {
        line: 'last commit c:9f2e "clamp the retry budget" · 2 turns ago',
        handle: "commit:9f2e",
        kind: "commit",
        exception: false,
        score: 0.9,
      },
    ];
    const tool = createReadTool(REPO_CWD, fs, {
      provenance: makeProvenance({ items, shown: 2, total: 6, nextCursor: "2" }, calls),
    });
    const result = await tool.execute("inv-1", {
      path: "packages/foo/bar.ts",
      provenance: "moderate",
      recallKeywords: ["retry"],
    });
    // Content first, provenance block appended as a trailing text item.
    const block = (result.content[result.content.length - 1] as { text: string }).text;
    expect((result.content[0] as { text: string }).text).toContain("line1");
    expect(block).toContain("prov · packages/foo/bar.ts · 2 of 6 items");
    expect(block).toContain("● ⚠ contradicts claim#7");
    expect(block).toContain('+4 more → provenance("packages/foo/bar.ts")');
    // Threaded the repo, workspace-relative path, head, session, invocation, keywords.
    expect(calls[0]).toMatchObject({
      repoPath: "packages/foo",
      path: "packages/foo/bar.ts",
      head: "ctx:c1",
      tier: "moderate",
      sessionLogId: "branch:channel:ch",
      sessionHead: "branch:channel:ch",
      invocationId: "inv-1",
      recallKeywords: ["retry"],
    });
  });

  it("renders no block when suppressed", async () => {
    const fs = new StubFs({ files: { ["/packages/foo/bar.ts"]: "x" } });
    const calls: Array<Record<string, unknown>> = [];
    const tool = createReadTool(REPO_CWD, fs, {
      provenance: makeProvenance(
        {
          items: [
            { line: "claim#1 foo", handle: "claim#1", kind: "claim", exception: false, score: 1 },
          ],
          shown: 1,
          total: 1,
          suppressed: true,
        },
        calls
      ),
    });
    const result = await tool.execute("inv-1", { path: "packages/foo/bar.ts", provenance: "deep" });
    expect(result.content).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("calls at tier none (touch only, no block) but skips outside-repo and skills paths", async () => {
    const fs = new StubFs({
      files: {
        ["/packages/foo/bar.ts"]: "x",
        ["/skills/orient/SKILL.md"]: "y",
        ["/loose.txt"]: "z",
      },
    });
    const calls: Array<Record<string, unknown>> = [];
    const tool = createReadTool(REPO_CWD, fs, {
      provenance: makeProvenance({ items: [], shown: 0, total: 0 }, calls),
    });
    // §7.4: tier none still records the observed touch (empty items ⇒ no block).
    const noneResult = await tool.execute("i", { path: "packages/foo/bar.ts", provenance: "none" });
    expect(noneResult.content).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tier: "none", repoPath: "packages/foo" });
    // Documentation overlay + outside-any-repo reads never touch the DO.
    await tool.execute("i", { path: "skills/orient/SKILL.md", provenance: "moderate" });
    await tool.execute("i", { path: "loose.txt", provenance: "moderate" });
    expect(calls).toHaveLength(1);
  });

  it("does not record a provenance touch when the file read fails", async () => {
    const fs = new StubFs();
    const calls: Array<Record<string, unknown>> = [];
    const tool = createReadTool(REPO_CWD, fs, {
      provenance: makeProvenance({ items: [], shown: 0, total: 0 }, calls),
    });

    await expect(
      tool.execute("i", { path: "packages/foo/missing.ts", provenance: "moderate" })
    ).rejects.toThrow(/not found/i);

    expect(calls).toHaveLength(0);
  });

  it("never fails the read when the provenance call rejects", async () => {
    const fs = new StubFs({ files: { ["/packages/foo/bar.ts"]: "content" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tool = createReadTool(REPO_CWD, fs, {
      provenance: {
        provenanceForFile: async () => {
          throw new Error("DO down");
        },
        head: "ctx:c1",
        sessionLogId: "s",
        sessionHead: "s",
      },
    });
    const result = await tool.execute("i", { path: "packages/foo/bar.ts", provenance: "deep" });
    expect((result.content[0] as { text: string }).text).toContain("content");
    expect(result.content).toHaveLength(1);
    warn.mockRestore();
  });
});
