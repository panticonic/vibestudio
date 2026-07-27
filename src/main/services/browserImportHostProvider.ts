import { randomUUID } from "node:crypto";
import type {
  BrowserImportDataType,
  BrowserImportProvider,
  BrowserImportSource,
  ImportCategoryProgress,
  ImportedBrowserOpenTab,
  ImportPreviewSummary,
  ImportSummary,
} from "@vibestudio/browser-data";

export type BrowserImportProviderFrame =
  | { type: "heartbeat" }
  | {
      type: "batch";
      dataType: BrowserImportDataType;
      batchIndex: number;
      items: unknown[];
    }
  | { type: "progress"; progress: ImportCategoryProgress }
  | { type: "complete"; summary: ImportSummary }
  | { type: "error"; message: string };

interface ImportOperation {
  abort: AbortController;
  frames: BrowserImportProviderFrame[];
  waiters: Array<(frame: BrowserImportProviderFrame) => void>;
  capacityWaiters: Array<() => void>;
  terminalQueued: boolean;
  terminalDelivered: boolean;
  nextBatchIndex: number;
}

const FRAME_ITEM_LIMIT = 50;
/**
 * Frames are JSON over a websocket with a 16 MiB ingress cap
 * (`RPC_WEBSOCKET_MAX_PAYLOAD_BYTES`). An item count alone does not bound a
 * frame: favicon items carry base64 rasters that are orders of magnitude larger
 * than a bookmark. Exceeding the cap closes the connection mid-import, which
 * looks like a silent stall, so frames are bounded by encoded size as well.
 */
const FRAME_BYTE_BUDGET = 4 * 1024 * 1024;

/** Split items into frames bounded by both count and encoded size. */
export function frameChunks(items: readonly unknown[]): unknown[][] {
  const frames: unknown[][] = [];
  let current: unknown[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const size = estimateEncodedBytes(item);
    if (current.length > 0 && (current.length >= FRAME_ITEM_LIMIT || currentBytes + size > FRAME_BYTE_BUDGET)) {
      frames.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length > 0) frames.push(current);
  return frames;
}

function estimateEncodedBytes(item: unknown): number {
  try {
    return JSON.stringify(item)?.length ?? 0;
  } catch {
    return FRAME_BYTE_BUDGET;
  }
}
export const MAX_QUEUED_IMPORT_FRAMES = 8;
const LONG_POLL_MS = 20_000;

/**
 * Trusted desktop endpoint for the shared import engine. Raw source paths stay
 * inside this process; callers receive only opaque sources and bounded frames.
 */
export class BrowserImportHostProvider {
  private providerPromise: Promise<BrowserImportProvider> | null = null;
  private readonly operations = new Map<string, ImportOperation>();

  constructor(
    private readonly host: {
      hostId: string;
      displayName: string;
    },
    private readonly createProvider: () => Promise<BrowserImportProvider> = async () => {
      const { LocalBrowserImportProvider } = await import("@vibestudio/browser-import");
      return new LocalBrowserImportProvider();
    }
  ) {}

  summary() {
    return {
      hostId: this.host.hostId,
      displayName: this.host.displayName,
      platform: normalizedPlatform(),
      location: "desktop" as const,
      connected: true,
    };
  }

  async listSources(signal?: AbortSignal): Promise<BrowserImportSource[]> {
    return (await this.provider()).listSources(signal ?? new AbortController().signal);
  }

  async preview(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    signal?: AbortSignal
  ): Promise<ImportPreviewSummary> {
    return (await this.provider()).preview(
      sourceId,
      dataTypes,
      { progress: () => {}, sample: () => {} },
      signal ?? new AbortController().signal
    );
  }

  startImport(sourceId: string, dataTypes: BrowserImportDataType[]): string {
    const operationId = randomUUID();
    const operation: ImportOperation = {
      abort: new AbortController(),
      frames: [],
      waiters: [],
      capacityWaiters: [],
      terminalQueued: false,
      terminalDelivered: false,
      nextBatchIndex: 0,
    };
    this.operations.set(operationId, operation);
    void this.run(operation, sourceId, dataTypes);
    return operationId;
  }

  async nextFrame(operationId: string): Promise<BrowserImportProviderFrame> {
    const operation = this.requireOperation(operationId);
    const queued = operation.frames.shift();
    if (queued) this.releaseCapacity(operation);
    const frame =
      queued ??
      (await new Promise<BrowserImportProviderFrame>((resolve) => {
        const timer = setTimeout(() => {
          const index = operation.waiters.indexOf(deliver);
          if (index >= 0) operation.waiters.splice(index, 1);
          resolve({ type: "heartbeat" });
        }, LONG_POLL_MS);
        const deliver = (next: BrowserImportProviderFrame) => {
          clearTimeout(timer);
          resolve(next);
        };
        operation.waiters.push(deliver);
      }));
    if (frame.type === "complete" || frame.type === "error") {
      operation.terminalDelivered = true;
      this.operations.delete(operationId);
    }
    return frame;
  }

  cancel(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) return;
    operation.abort.abort(new DOMException("Import cancelled", "AbortError"));
    this.fail(operation, "Import cancelled");
  }

  async listOpenTabs(sourceId: string, signal?: AbortSignal): Promise<ImportedBrowserOpenTab[]> {
    return (await this.provider()).listOpenTabs(sourceId, signal ?? new AbortController().signal);
  }

  stop(): void {
    for (const operation of this.operations.values()) {
      operation.abort.abort(new Error("Desktop import provider stopped"));
      this.fail(operation, "Desktop import provider stopped");
    }
    this.operations.clear();
  }

  private async run(
    operation: ImportOperation,
    sourceId: string,
    dataTypes: BrowserImportDataType[]
  ): Promise<void> {
    try {
      const summary = await (
        await this.provider()
      ).import(
        sourceId,
        dataTypes,
        {
          store: async (batch) => {
            for (const items of frameChunks(batch.items)) {
              await this.push(operation, {
                type: "batch",
                dataType: batch.dataType,
                batchIndex: operation.nextBatchIndex++,
                items,
              });
            }
          },
          progress: (progress) => this.push(operation, { type: "progress", progress }),
        },
        operation.abort.signal
      );
      await this.push(operation, { type: "complete", summary });
    } catch (error) {
      this.fail(
        operation,
        operation.abort.signal.aborted
          ? "Import cancelled"
          : error instanceof Error
            ? error.message
            : String(error)
      );
    }
  }

  private async push(operation: ImportOperation, frame: BrowserImportProviderFrame): Promise<void> {
    while (
      !operation.terminalQueued &&
      operation.waiters.length === 0 &&
      operation.frames.length >= MAX_QUEUED_IMPORT_FRAMES
    ) {
      await new Promise<void>((resolve) => operation.capacityWaiters.push(resolve));
    }
    if (operation.terminalQueued) return;
    if (frame.type === "complete" || frame.type === "error") {
      operation.terminalQueued = true;
    }
    const waiter = operation.waiters.shift();
    if (waiter) waiter(frame);
    else operation.frames.push(frame);
  }

  private fail(operation: ImportOperation, message: string): void {
    if (operation.terminalQueued) return;
    operation.terminalQueued = true;
    operation.frames.length = 0;
    const waiter = operation.waiters.shift();
    const frame = { type: "error" as const, message };
    if (waiter) waiter(frame);
    else operation.frames.push(frame);
    this.releaseCapacity(operation);
  }

  private releaseCapacity(operation: ImportOperation): void {
    for (const resolve of operation.capacityWaiters.splice(0)) resolve();
  }

  private requireOperation(operationId: string): ImportOperation {
    const operation = this.operations.get(operationId);
    if (!operation || operation.terminalDelivered) {
      throw new Error(`Desktop import operation not found: ${operationId}`);
    }
    return operation;
  }

  private provider(): Promise<BrowserImportProvider> {
    this.providerPromise ??= this.createProvider();
    return this.providerPromise;
  }
}

function normalizedPlatform(): "darwin" | "linux" | "win32" {
  return process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
}
