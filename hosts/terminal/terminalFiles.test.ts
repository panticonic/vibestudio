import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { createTerminalFiles, TERMINAL_UPLOAD_MAX_BYTES } from "./terminalFiles.js";

const roots: string[] = [];
async function fixture(call = vi.fn()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-file-gesture-"));
  roots.push(root);
  const owner = new AbortController();
  const files = createTerminalFiles({ call } as unknown as Pick<RpcClient, "call">, owner.signal);
  return { root, call, owner, files };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("trusted terminal file gestures", () => {
  it("uploads exact binary bytes to the captured workspace context through ordinary fs", async () => {
    const { root, call, files } = await fixture();
    const source = path.join(root, "local.bin");
    await fs.writeFile(source, new Uint8Array([0, 255, 42]));
    expect(
      await files.upload({
        contextId: "ctx-a",
        localPath: source,
        workspacePath: "uploads/local.bin",
      })
    ).toEqual({ path: "uploads/local.bin", size: 3 });
    expect(call.mock.calls[0]?.slice(0, 3)).toEqual([
      "main",
      expect.objectContaining({ name: "fs.writeFile" }),
      ["ctx-a", "uploads/local.bin", new Uint8Array([0, 255, 42])],
    ]);
  });

  it("reads exactly the one regular file the person named, for an attachment", async () => {
    const { root, call, files } = await fixture();
    const source = path.join(root, "photo.bin");
    await fs.writeFile(source, new Uint8Array([9, 8, 7]));
    const read = await files.read({ localPath: source });
    expect(read).toEqual({ path: source, size: 3, bytes: new Uint8Array([9, 8, 7]) });
    // A directory is not a file the person attached, and the read never touches the workspace.
    await expect(files.read({ localPath: root })).rejects.toThrow("regular file");
    const huge = path.join(root, "huge");
    const handle = await fs.open(huge, "w");
    await handle.truncate(TERMINAL_UPLOAD_MAX_BYTES + 1);
    await handle.close();
    await expect(files.read({ localPath: huge })).rejects.toThrow("8 MB");
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects over-budget local files before allocating or transmitting them", async () => {
    const { root, call, files } = await fixture();
    const source = path.join(root, "large");
    const file = await fs.open(source, "w");
    await file.truncate(TERMINAL_UPLOAD_MAX_BYTES + 1);
    await file.close();
    await expect(
      files.upload({ contextId: "ctx", localPath: source, workspacePath: "large" })
    ).rejects.toThrow("8 MB");
    expect(call).not.toHaveBeenCalled();
  });

  it("downloads complete identity-checked binary content and never overwrites a local file", async () => {
    const bytes = Buffer.from([0, 128, 255]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const call = vi.fn(async () => ({
      base64: bytes.toString("base64"),
      contentHash: hash,
      totalBytes: 3,
      maxBytes: 51200,
      start: 0,
      end: 3,
      truncated: false,
    }));
    const { root, files } = await fixture(call);
    const destination = path.join(root, "download.bin");
    expect(
      await files.download({
        contextId: "ctx-b",
        workspacePath: "chat-exports/chat.md",
        localPath: destination,
      })
    ).toEqual({ path: destination, size: 3 });
    expect(await fs.readFile(destination)).toEqual(bytes);
    await expect(files.saveText({ localPath: destination, text: "replace" })).rejects.toMatchObject(
      { code: "EEXIST" }
    );
    expect(await fs.readFile(destination)).toEqual(bytes);
    expect(await fs.readdir(root)).toEqual(["download.bin"]);
  });

  it("rejects changed identity between real continuation pages without writing a destination", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        base64: "YQ==",
        contentHash: "a".repeat(64),
        totalBytes: 2,
        start: 0,
        end: 1,
        truncated: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        base64: "Yg==",
        contentHash: "b".repeat(64),
        totalBytes: 2,
        start: 1,
        end: 2,
        truncated: false,
      });
    const { root, files } = await fixture(call);
    await expect(
      files.download({
        contextId: "ctx",
        workspacePath: "changing",
        localPath: path.join(root, "output"),
      })
    ).rejects.toThrow("changed");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("preserves the authoritative cancellation reason and creates no local scratch", async () => {
    const { root, files, owner, call } = await fixture();
    const reason = new Error("workspace switched");
    owner.abort(reason);
    await expect(
      files.saveText({ localPath: path.join(root, "output"), text: "secret" })
    ).rejects.toBe(reason);
    await expect(
      files.download({
        contextId: "ctx",
        workspacePath: "export",
        localPath: path.join(root, "output"),
      })
    ).rejects.toBe(reason);
    expect(call).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects pages beyond the declared content before requesting a continuation", async () => {
    const call = vi.fn(async () => ({
      base64: "YWI=",
      contentHash: "a".repeat(64),
      totalBytes: 1,
      start: 0,
      end: 2,
      truncated: true,
      nextOffset: 2,
    }));
    const { root, files } = await fixture(call);
    await expect(
      files.download({
        contextId: "ctx",
        workspacePath: "invalid",
        localPath: path.join(root, "output"),
      })
    ).rejects.toThrow("inconsistent file page");
    expect(call).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("streams complete downloads and exports larger than the attachment budget", async () => {
    const bytes = Buffer.alloc(TERMINAL_UPLOAD_MAX_BYTES + 1, 97);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const call = vi.fn(async (...args: unknown[]) => {
      const [, , { offset, limit }] = args[2] as [
        string,
        string,
        { offset: number; limit: number },
      ];
      const end = Math.min(bytes.length, offset + limit);
      return {
        base64: bytes.subarray(offset, end).toString("base64"),
        contentHash: hash,
        totalBytes: bytes.length,
        start: offset,
        end,
        truncated: end < bytes.length,
        ...(end < bytes.length ? { nextOffset: end } : {}),
      };
    });
    const { root, files } = await fixture(call);
    const destination = path.join(root, "complete.md");
    await expect(
      files.download({ contextId: "ctx", workspacePath: "export.md", localPath: destination })
    ).resolves.toEqual({ path: destination, size: bytes.length });
    expect(
      createHash("sha256")
        .update(await fs.readFile(destination))
        .digest("hex")
    ).toBe(hash);
    expect(call.mock.calls.length).toBeGreaterThan(1);
    const localExport = path.join(root, "local.md");
    await expect(
      files.saveText({ localPath: localExport, text: bytes.toString("utf8") })
    ).resolves.toEqual({ path: localExport, size: bytes.length });
    expect(
      createHash("sha256")
        .update(await fs.readFile(localExport))
        .digest("hex")
    ).toBe(hash);
    expect((await fs.readdir(root)).sort()).toEqual(["complete.md", "local.md"]);
  });

  it("cancels an active continuation and retires its partial local file", async () => {
    let continuationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      continuationStarted = resolve;
    });
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        base64: "YQ==",
        contentHash: createHash("sha256").update("ab").digest("hex"),
        totalBytes: 2,
        start: 0,
        end: 1,
        truncated: true,
        nextOffset: 1,
      })
      .mockImplementationOnce((...args: unknown[]) => {
        const { signal } = args[3] as { signal: AbortSignal };
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          continuationStarted();
        });
      });
    const { root, files, owner } = await fixture(call);
    const download = files.download({
      contextId: "ctx",
      workspacePath: "export",
      localPath: path.join(root, "output"),
    });
    const reason = new Error("transfer cancelled");
    try {
      await started;
      owner.abort(reason);
      await expect(download).rejects.toBe(reason);
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      owner.abort(reason);
      await download.catch(() => undefined);
    }
  });
});
