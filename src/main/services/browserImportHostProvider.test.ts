import { describe, expect, it, vi } from "vitest";
import type { BrowserImportProvider } from "@vibestudio/browser-data";
import {
  BrowserImportHostProvider,
  MAX_QUEUED_IMPORT_FRAMES,
} from "./browserImportHostProvider.js";

function batchProvider(onStoreComplete: () => void): BrowserImportProvider {
  return {
    listSources: vi.fn(async () => []),
    preview: vi.fn(async () => ({
      dataTypes: [],
      warnings: [],
      openTabCount: 0,
      localDataSetCount: 0,
    })),
    import: vi.fn(async (sourceId, _types, sink) => {
      await sink.store({
        jobId: "job",
        sourceId,
        dataType: "bookmarks",
        batchIndex: 0,
        idempotencyKey: "batch",
        items: Array.from({ length: (MAX_QUEUED_IMPORT_FRAMES + 2) * 50 }, (_, index) => ({
          index,
        })),
      });
      onStoreComplete();
      return { dataTypes: [], warnings: [] };
    }),
    listOpenTabs: vi.fn(async () => []),
  };
}

function queuedFrames(provider: BrowserImportHostProvider, operationId: string): number {
  return (
    (
      provider as unknown as {
        operations: Map<string, { frames: unknown[] }>;
      }
    ).operations.get(operationId)?.frames.length ?? 0
  );
}

describe("BrowserImportHostProvider", () => {
  it("backpressures the producer until bounded frames are consumed", async () => {
    let storeComplete = false;
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      async () =>
        batchProvider(() => {
          storeComplete = true;
        })
    );
    const operationId = provider.startImport("source", ["bookmarks"]);

    await vi.waitFor(() => {
      expect(queuedFrames(provider, operationId)).toBe(MAX_QUEUED_IMPORT_FRAMES);
    });
    expect(storeComplete).toBe(false);

    for (let index = 0; index < MAX_QUEUED_IMPORT_FRAMES + 2; index += 1) {
      await expect(provider.nextFrame(operationId)).resolves.toMatchObject({
        type: "batch",
      });
    }
    await expect(provider.nextFrame(operationId)).resolves.toMatchObject({
      type: "complete",
    });
    expect(storeComplete).toBe(true);
  });

  it("releases a backpressured producer when an import is cancelled", async () => {
    let storeComplete = false;
    const provider = new BrowserImportHostProvider(
      { hostId: "desktop", displayName: "Desktop" },
      async () =>
        batchProvider(() => {
          storeComplete = true;
        })
    );
    const operationId = provider.startImport("source", ["bookmarks"]);
    await vi.waitFor(() => {
      expect(queuedFrames(provider, operationId)).toBe(MAX_QUEUED_IMPORT_FRAMES);
    });

    provider.cancel(operationId);
    await expect(provider.nextFrame(operationId)).resolves.toEqual({
      type: "error",
      message: "Import cancelled",
    });
    await vi.waitFor(() => expect(storeComplete).toBe(true));
  });
});
