import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HeadlessBrowserDownloads } from "./browserDownloads";
import type { CdpConnection } from "./browser/cdpConnection";
describe("headless download ownership", () => {
  it("exposes approved byte ranges only to the owning panel and cleans private staging", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "download-owner-"));
    let listener: (event: { method: string; params: unknown }) => void = () => {};
    const send = vi.fn(async () => ({}));
    const cdp = {
      send,
      onEvent: (cb: typeof listener) => {
        listener = cb;
        return () => {};
      },
      onClose: () => () => {},
    } as unknown as CdpConnection;
    const activity = vi.fn();
    const manager = new HeadlessBrowserDownloads(cdp, {
      ownerForFrame: () => ({ panelId: "panel", url: "https://source.example" }),
      approve: async () => true,
      activity,
    });
    try {
      await manager.start(root);
      listener({
        method: "Browser.downloadWillBegin",
        params: {
          guid: "file-1",
          frameId: "frame",
          url: "https://source.example/file",
          suggestedFilename: "file.bin",
        },
      });
      await vi.waitFor(() => expect(activity).toHaveBeenCalled());
      const [directory] = await readdir(root);
      await writeFile(path.join(root, directory!, "file-1"), Buffer.from([0, 255, 65]));
      listener({
        method: "Browser.downloadProgress",
        params: { guid: "file-1", state: "completed", receivedBytes: 3, totalBytes: 3 },
      });
      const signal = new AbortController().signal;
      await expect(
        manager.operation("other", { operation: "downloadInfo", id: "file-1" }, signal)
      ).rejects.toThrow("belong");
      expect(
        await manager.operation(
          "panel",
          { operation: "readDownloadChunk", id: "file-1", offset: 0, length: 2 },
          signal
        )
      ).toEqual({ base64: "AP8=", eof: false });
      expect(
        JSON.stringify(
          await manager.operation("panel", { operation: "downloadInfo", id: "file-1" }, signal)
        )
      ).not.toContain(root);
      await manager.stop();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await manager.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("joins native cancellation after permission denial before retiring staging", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "download-denied-"));
    let listener: (event: { method: string; params: unknown }) => void = () => {};
    let finishNative: (() => void) | undefined;
    const send = vi.fn(async (method: string) => {
      if (method === "Browser.cancelDownload")
        finishNative = () =>
          listener({
            method: "Browser.downloadProgress",
            params: { guid: "denied", state: "canceled", receivedBytes: 0, totalBytes: 3 },
          });
      return {};
    });
    const cdp = {
      send,
      onEvent: (cb: typeof listener) => {
        listener = cb;
        return () => {};
      },
      onClose: () => () => {},
    } as unknown as CdpConnection;
    const activity = vi.fn();
    const manager = new HeadlessBrowserDownloads(cdp, {
      ownerForFrame: () => ({ panelId: "panel", url: "https://source.example" }),
      approve: async () => false,
      activity,
    });
    try {
      await manager.start(root);
      listener({
        method: "Browser.downloadWillBegin",
        params: {
          guid: "denied",
          frameId: "frame",
          url: "https://source.example/file",
          suggestedFilename: "file.bin",
        },
      });
      await vi.waitFor(() => expect(finishNative).toBeTypeOf("function"));
      expect(activity).toHaveBeenCalledWith("panel", { error: "Download permission denied" });
      expect(
        await manager.operation(
          "panel",
          { operation: "listDownloads" },
          new AbortController().signal
        )
      ).toEqual([]);
      let retired = false;
      const retirement = manager.stop().then(() => {
        retired = true;
      });
      await Promise.resolve();
      expect(retired).toBe(false);
      finishNative!();
      await retirement;
      expect(await readdir(root)).toEqual([]);
    } finally {
      await manager.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
