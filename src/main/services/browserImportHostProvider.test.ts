import { describe, expect, it, vi } from "vitest";
import type { BrowserImportProvider } from "@vibestudio/browser-data";
import {
  BrowserImportHostProvider,
  frameChunks,
  MAX_QUEUED_IMPORT_FRAMES,
} from "./browserImportHostProvider.js";

function batchProvider(onStoreComplete: () => void): BrowserImportProvider {
  return {
    listSources: vi.fn(async () => []),
    preview: vi.fn(async () => ({
      dataTypes: [],
      breakdowns: [],
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

describe("frameChunks", () => {
  it("splits by item count for small items", () => {
    const frames = frameChunks(Array.from({ length: 120 }, (_, index) => ({ index })));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toHaveLength(50);
    expect(frames[2]).toHaveLength(20);
  });

  it("splits by encoded size when items are large", () => {
    // A favicon-sized base64 payload: a handful of these must not share a frame
    // with 49 others, or the frame exceeds the websocket ingress cap.
    const heavy = { data: "A".repeat(1_500_000) };
    const frames = frameChunks(Array.from({ length: 8 }, () => heavy));
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(JSON.stringify(frame).length).toBeLessThan(16 * 1024 * 1024);
    }
  });

  it("never drops an item and never emits an empty frame", () => {
    const items = Array.from({ length: 37 }, (_, index) => ({
      index,
      pad: "x".repeat(index * 997),
    }));
    const frames = frameChunks(items);
    expect(frames.flat()).toEqual(items);
    expect(frames.every((frame) => frame.length > 0)).toBe(true);
  });

  it("keeps an oversized single item in its own frame rather than dropping it", () => {
    const frames = frameChunks([{ pad: "A".repeat(5_000_000) }, { small: true }]);
    expect(frames[0]).toHaveLength(1);
    expect(frames.flat()).toHaveLength(2);
  });

  it("handles an empty batch", () => {
    expect(frameChunks([])).toEqual([]);
  });
});

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
