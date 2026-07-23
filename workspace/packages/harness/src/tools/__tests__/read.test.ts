import { describe, it, expect, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createReadTool } from "../read.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createReadTool", () => {
  it("reads a small text file", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const tool = createReadTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "hello.txt" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
    expect(result.details.path).toBe("hello.txt");
  });

  it("returns a bounded directory listing instead of failing the turn", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/skills/git/SKILL.md`]: "# Git",
        [`${CWD}/skills/README.md`]: "skills",
      },
    });
    const tool = createReadTool(CWD, fs);

    const result = await tool.execute("call-1", { path: "skills" });

    expect(result.details).toMatchObject({
      path: "skills",
      engine: "runtime-fs",
      directory: true,
    });
    expect((result.content[0] as { text: string }).text).toBe("README.md\ngit/");
  });

  it("returns a successful discovery diagnostic with nearby entries for a missing path", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/panel/index.ts`]: "export {};",
        [`${CWD}/panel/package.json`]: "{}",
      },
    });
    const tool = createReadTool(CWD, fs);

    const result = await tool.execute("call-1", {
      path: "panel/index.html",
    });

    expect(result.details).toMatchObject({
      path: "panel/index.html",
      missing: true,
      suggestions: expect.arrayContaining(["index.ts", "package.json"]),
    });
    expect((result.content[0] as { text: string }).text).toContain("Use ls/find");
  });

  it("resolves a unique workspace skill name when its guessed skills/ path is absent", async () => {
    const fs = new StubFs();
    const rpc = {
      call: vi.fn(async (_target: string, method: string) => {
        if (method === "extensions.invoke") {
          const error = new Error("ENOENT: guessed skill path is absent") as Error & {
            code: string;
          };
          error.code = "ENOENT";
          throw error;
        }
        if (method === "workspace.listSkills") {
          return [
            {
              name: "git-bridge",
              dirPath: "extensions/git-bridge",
              skillPath: "extensions/git-bridge/SKILL.md",
            },
          ];
        }
        if (method === "workspace.readSkill") return "# Git Bridge\n";
        throw new Error(`Unexpected RPC ${method}`);
      }),
      stream: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc: rpc as never });

    const result = await tool.execute("call-1", {
      path: "skills/git-bridge/SKILL.md",
    });

    expect(result.content[0]).toMatchObject({ type: "text", text: "# Git Bridge\n" });
    expect(result.details).toMatchObject({
      path: "extensions/git-bridge/SKILL.md",
      extensionFallback: "workspace-skill-alias:skills/git-bridge/SKILL.md",
    });
  });

  it("validates and executes the minimal serialized call", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const tool = createReadTool(CWD, fs);
    const input = { path: "hello.txt" };

    expect(Value.Check(tool.parameters, input)).toBe(true);
    const result = await tool.execute("call-1", input);
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
  });

  it("accepts file resource references returned by discovery tools", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const tool = createReadTool(CWD, fs);
    const input = { target: "file:hello.txt", kind: "file" as const };

    expect(Value.Check(tool.parameters, input)).toBe(true);
    const result = await tool.execute("call-1", input);
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
    expect(result.details.path).toBe("hello.txt");
  });

  it("respects offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const fs = new StubFs({ files: { [`${CWD}/big.txt`]: lines } });
    const tool = createReadTool(CWD, fs);
    const result = await tool.execute("call-1", {
      path: "big.txt",
      offset: 3,
      limit: 2,
    });
    const text = (result.content[0] as { text: string }).text;
    // Selected slice "line 3\nline 4" plus a continuation hint.
    expect(text).toContain("line 3");
    expect(text).toContain("line 4");
    expect(text).not.toContain("line 5\n");
  });

  it("returns a successful bounded diagnostic when offset is past EOF", async () => {
    const fs = new StubFs({ files: { [`${CWD}/small.txt`]: "one\ntwo" } });
    const tool = createReadTool(CWD, fs);

    const result = await tool.execute("call-1", {
      path: "small.txt",
      offset: 615,
    });

    expect((result.content[0] as { text: string }).text).toContain(
      "Offset 615 is beyond end of file (2 lines total)"
    );
    expect(result.details).toMatchObject({ path: "small.txt", engine: "runtime-fs" });
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

  it("does not impose a default deadline on a slow file extension read", async () => {
    vi.useFakeTimers();
    try {
      const fs = new StubFs();
      const rpc = {
        call: vi.fn().mockImplementation((_target: string, method: string) => {
          if (method !== "extensions.invoke") return Promise.resolve([]);
          return new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  content: [{ type: "text", text: "eventually available" }],
                  details: { path: "slow.txt", engine: "node-file" },
                }),
              100_000
            );
          });
        }),
        stream: vi.fn(async () => new Response()),
      };
      const tool = createReadTool(CWD, fs, { rpc });

      const resultPromise = tool.execute("call-1", { path: "slow.txt" });
      await vi.advanceTimersByTimeAsync(100_000);

      await expect(resultPromise).resolves.toMatchObject({
        content: [{ type: "text", text: "eventually available" }],
        details: { path: "slow.txt", engine: "node-file" },
      });
    } finally {
      vi.useRealTimers();
    }
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

    const result = await tool.execute("call-1", { path: "hello.txt" }, undefined, onUpdate);

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

    const result = await tool.execute("call-1", { path: "hello.txt" }, undefined, onUpdate);

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
            data: Buffer.from(pngBytes).toString("base64"),
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

    const result = await tool.execute("call-1", { path: "pic.png" });

    const last = result.content[result.content.length - 1] as { type: string; mimeType: string };
    expect(last.type).toBe("image");
    expect(last.mimeType).toBe("image/png");
    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "extensions.invoke",
      expect.arrayContaining(["@workspace-extensions/file-tools", "read"])
    );
  });

  it("returns a non-poisoning discovery result when a file is missing", async () => {
    const fs = new StubFs();
    const tool = createReadTool(CWD, fs);
    await expect(tool.execute("call-1", { path: "missing.txt" })).resolves.toMatchObject({
      details: { missing: true, path: "missing.txt" },
    });
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
            data: Buffer.from(pngBytes).toString("base64"),
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
    const result = await tool.execute("call-1", { path: "pic.png" });
    const last = result.content[result.content.length - 1] as { type: string; mimeType: string };
    expect(last.type).toBe("image");
    expect(last.mimeType).toBe("image/png");
  });

  it("aborts when signal is already aborted", async () => {
    const fs = new StubFs({ files: { [`${CWD}/foo.txt`]: "x" } });
    const tool = createReadTool(CWD, fs);
    const ac = new AbortController();
    ac.abort();
    await expect(tool.execute("call-1", { path: "foo.txt" }, ac.signal)).rejects.toThrow(/abort/i);
  });
});
