import { randomUUID } from "node:crypto";
import type {
  BrowserCookieInput,
  BrowserImportDataType,
  BrowserImportProvider,
  BrowserImportSource,
  FormFillValueInput,
  ImportCategoryProgress,
  ImportedPassword,
  ImportedBrowserOpenTab,
  ImportPreviewSummary,
  ImportSummary,
} from "@vibestudio/browser-data";
import type { BrowserVaultNativeClient } from "./browserVaultNativeClient.js";
import type {
  BrowserSensitiveImportDataType,
  SensitiveBrowserImportCount,
  SensitiveBrowserImportInput,
  SensitiveBrowserImportLedger,
  SensitiveBrowserImportStatus,
} from "./sensitiveBrowserImportLedger.js";

export type BrowserPublicImportDataType = Exclude<
  BrowserImportDataType,
  "cookies" | "passwords" | "formFill"
>;
export type { BrowserSensitiveImportDataType, SensitiveBrowserImportStatus };

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

interface SensitiveImportOperation {
  requestKey: string;
  abort: AbortController;
  promise: Promise<void>;
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
    if (
      current.length > 0 &&
      (current.length >= FRAME_ITEM_LIMIT || currentBytes + size > FRAME_BYTE_BUDGET)
    ) {
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
const SENSITIVE_IMPORT_FAILURE_MESSAGE =
  "Protected browser data could not be imported. Check that the selected browser profile is available, then try again.";
const PUBLIC_IMPORT_FAILURE_MESSAGE =
  "Browser data could not be imported. Check that the selected browser profile is available, then try again.";
const IMPORT_PREVIEW_FAILURE_MESSAGE =
  "Browser data could not be reviewed. Check that the selected browser profile is available, then try again.";
const IMPORT_PREVIEW_WARNING =
  "Some browser data could not be read. Review the available counts before importing.";

/**
 * Trusted machine-local endpoint for the shared import engine. Raw source paths
 * stay inside this process; callers receive only opaque sources and bounded
 * public frames, while protected records go directly to the host vault.
 */
export class BrowserImportHostProvider {
  private providerPromise: Promise<BrowserImportProvider> | null = null;
  private readonly operations = new Map<string, ImportOperation>();
  private readonly sensitiveOperations = new Map<string, SensitiveImportOperation>();
  private stopping = false;

  constructor(
    private readonly host: {
      hostId: string;
      displayName: string;
      location?: "server" | "device";
    },
    options: {
      createProvider?: () => Promise<BrowserImportProvider>;
      browserVault?: Pick<
        BrowserVaultNativeClient,
        "addCookiesBatch" | "addPasswordsBatch" | "addFormFillBatch"
      >;
      sensitiveImportLedger: SensitiveBrowserImportLedger;
    }
  ) {
    this.createProvider =
      options.createProvider ??
      (async () => {
        const { LocalBrowserImportProvider } = await import("@vibestudio/browser-import");
        return new LocalBrowserImportProvider();
      });
    this.browserVault = options.browserVault;
    this.sensitiveImportLedger = options.sensitiveImportLedger;
    queueMicrotask(() => this.resumeSensitiveImports());
  }

  private readonly createProvider: () => Promise<BrowserImportProvider>;
  private readonly browserVault:
    | Pick<BrowserVaultNativeClient, "addCookiesBatch" | "addPasswordsBatch" | "addFormFillBatch">
    | undefined;
  private readonly sensitiveImportLedger: SensitiveBrowserImportLedger;

  summary() {
    return {
      hostId: this.host.hostId,
      displayName: this.host.displayName,
      platform: normalizedPlatform(),
      location: this.host.location ?? ("device" as const),
      connected: true,
    };
  }

  async listSources(signal?: AbortSignal): Promise<BrowserImportSource[]> {
    try {
      return await (await this.provider()).listSources(signal ?? new AbortController().signal);
    } catch (error) {
      console.error("[BrowserImportHostProvider] Browser source discovery failed", error);
      throw new Error(
        "Browser profiles could not be discovered. Check operating-system browser-data access, then try again."
      );
    }
  }

  async preview(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    signal?: AbortSignal
  ): Promise<ImportPreviewSummary> {
    try {
      const preview = await (
        await this.provider()
      ).preview(
        sourceId,
        dataTypes,
        { progress: () => {}, sample: () => {} },
        signal ?? new AbortController().signal
      );
      return {
        ...preview,
        // Reader warnings may embed native profile paths or record fragments.
        // Counts and breakdowns remain useful; only diagnostic text stays in
        // the trusted host.
        warnings: preview.warnings.length > 0 ? [IMPORT_PREVIEW_WARNING] : [],
      };
    } catch (error) {
      console.error("[BrowserImportHostProvider] Browser import preview failed", error);
      throw new Error(IMPORT_PREVIEW_FAILURE_MESSAGE);
    }
  }

  startImport(sourceId: string, dataTypes: BrowserPublicImportDataType[]): string {
    if (!dataTypes.every(isPublicImportDataType)) {
      throw new Error("Sensitive browser data must use the sealed vault import operation");
    }
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

  startSensitiveImport(
    sourceId: string,
    dataTypes: BrowserSensitiveImportDataType[],
    operationId: string
  ): SensitiveBrowserImportStatus {
    const normalizedDataTypes = normalizeSensitiveDataTypes(dataTypes);
    const requestKey = JSON.stringify([sourceId, normalizedDataTypes]);
    const input = { sourceId, dataTypes: normalizedDataTypes };
    const status = this.sensitiveImportLedger.begin(operationId, input);
    const existing = this.sensitiveOperations.get(operationId);
    if (existing) {
      if (existing.requestKey !== requestKey) {
        throw new Error(`Sensitive browser import operation ${operationId} has different inputs`);
      }
      return status;
    }
    if (status.state === "running") this.launchSensitiveImport(operationId, input);
    return status;
  }

  observeSensitiveImport(operationId: string): SensitiveBrowserImportStatus {
    return this.sensitiveImportLedger.observe(operationId);
  }

  cancelSensitiveImport(operationId: string): SensitiveBrowserImportStatus {
    const status = this.sensitiveImportLedger.cancel(operationId);
    this.sensitiveOperations
      .get(operationId)
      ?.abort.abort(new DOMException("Import cancelled", "AbortError"));
    return status;
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
    try {
      return await (
        await this.provider()
      ).listOpenTabs(sourceId, signal ?? new AbortController().signal);
    } catch (error) {
      console.error("[BrowserImportHostProvider] Browser tab discovery failed", error);
      throw new Error(
        "Open browser tabs could not be read. Check that the selected browser is available, then try again."
      );
    }
  }

  stop(): void {
    this.stopping = true;
    for (const operation of this.operations.values()) {
      operation.abort.abort(new Error("Desktop import provider stopped"));
      this.fail(operation, "Desktop import provider stopped");
    }
    this.operations.clear();
    for (const operation of this.sensitiveOperations.values()) {
      operation.abort.abort(new Error("Desktop import provider stopped"));
    }
    this.sensitiveOperations.clear();
  }

  private async run(
    operation: ImportOperation,
    sourceId: string,
    dataTypes: BrowserPublicImportDataType[]
  ): Promise<void> {
    try {
      const read = await (
        await this.provider()
      ).openImport(sourceId, dataTypes, operation.abort.signal);
      const summary = await read.consume({
        store: async (batch) => {
          if (!isPublicImportDataType(batch.dataType)) {
            throw new Error("Sensitive browser data cannot be emitted as an import frame");
          }
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
      });
      if (!summary.dataTypes.every((progress) => isPublicImportDataType(progress.dataType))) {
        throw new Error("Sensitive browser data cannot be emitted in an import summary");
      }
      await this.push(operation, { type: "complete", summary });
    } catch (error) {
      if (!operation.abort.signal.aborted) {
        // Source adapters can report native filesystem paths. Frames cross the
        // workspace boundary, so retain the diagnostic in the host log and
        // expose only stable product guidance.
        console.error("[BrowserImportHostProvider] Browser import failed", error);
      }
      this.fail(
        operation,
        operation.abort.signal.aborted ? "Import cancelled" : PUBLIC_IMPORT_FAILURE_MESSAGE
      );
    }
  }

  private async runSensitiveImport(
    sourceId: string,
    dataTypes: BrowserSensitiveImportDataType[],
    operationId: string,
    signal: AbortSignal
  ): Promise<SensitiveBrowserImportCount[]> {
    const vault = this.browserVault;
    if (!vault) throw new Error("The host browser vault is unavailable");
    const stored = new Map<BrowserSensitiveImportDataType, number>();
    const storedBatches = new Set<string>();
    const read = await (await this.provider()).openImport(sourceId, dataTypes, signal);
    const summary = await read.consume({
      store: async (batch) => {
        if (!isSensitiveImportDataType(batch.dataType)) {
          throw new Error(`Unexpected non-sensitive import batch: ${batch.dataType}`);
        }
        if (!dataTypes.includes(batch.dataType)) {
          throw new Error(`Unexpected sensitive import batch: ${batch.dataType}`);
        }
        if (batch.sourceId !== sourceId) {
          throw new Error("Sensitive import batch source does not match the requested source");
        }
        const batchKey = `${batch.dataType}:${batch.batchIndex}`;
        if (storedBatches.has(batchKey)) {
          throw new Error(`Duplicate sensitive import batch: ${batchKey}`);
        }
        storedBatches.add(batchKey);
        let count: number;
        switch (batch.dataType) {
          case "cookies":
            await vault.addCookiesBatch({
              jobId: operationId,
              batchIndex: batch.batchIndex,
              cookies: batch.items as BrowserCookieInput[],
            });
            count = batch.items.length;
            break;
          case "passwords":
            count = await vault.addPasswordsBatch(batch.items as ImportedPassword[], {
              sourceId,
            });
            break;
          case "formFill":
            count = await vault.addFormFillBatch(batch.items as FormFillValueInput[], {
              sourceId,
            });
            break;
        }
        stored.set(batch.dataType, (stored.get(batch.dataType) ?? 0) + count);
      },
      progress: (progress) => {
        if (!isSensitiveImportDataType(progress.dataType)) {
          throw new Error(`Unexpected non-sensitive import progress: ${progress.dataType}`);
        }
        this.sensitiveImportLedger.progress(
          operationId,
          { sourceId, dataTypes },
          {
            dataType: progress.dataType,
            read: progress.itemsProcessed,
            stored: stored.get(progress.dataType) ?? 0,
            skipped: progress.skipped,
            errors: progress.errors,
          }
        );
      },
    });
    const counts = summary.dataTypes.map((progress) => {
      if (!isSensitiveImportDataType(progress.dataType)) {
        throw new Error(`Unexpected non-sensitive import summary: ${progress.dataType}`);
      }
      if (!dataTypes.includes(progress.dataType)) {
        throw new Error(`Unexpected sensitive import summary: ${progress.dataType}`);
      }
      return {
        dataType: progress.dataType,
        read: progress.itemsProcessed,
        stored: stored.get(progress.dataType) ?? 0,
        skipped: progress.skipped,
        errors: progress.errors,
      };
    });
    if (
      counts.length !== dataTypes.length ||
      new Set(counts.map((count) => count.dataType)).size !== dataTypes.length ||
      dataTypes.some((dataType) => !counts.some((count) => count.dataType === dataType))
    ) {
      throw new Error("Sensitive browser import summary does not cover every requested category");
    }
    return counts;
  }

  private launchSensitiveImport(operationId: string, input: SensitiveBrowserImportInput): void {
    if (this.sensitiveOperations.has(operationId)) return;
    const abort = new AbortController();
    const operation: SensitiveImportOperation = {
      requestKey: JSON.stringify([input.sourceId, input.dataTypes]),
      abort,
      promise: Promise.resolve(),
    };
    operation.promise = this.runSensitiveImport(
      input.sourceId,
      input.dataTypes,
      operationId,
      abort.signal
    )
      .then((counts) => {
        this.sensitiveImportLedger.complete(operationId, input, counts);
      })
      .catch((error) => {
        const status = this.sensitiveImportLedger.observe(operationId);
        if (!this.stopping && status.state === "running") {
          // The native importer may include profile paths or source-record
          // fragments in its diagnostic. Keep that evidence in the trusted
          // host log; the durable status crosses the workspace boundary and
          // therefore carries only one stable, actionable product message.
          console.error(
            `[BrowserImportHostProvider] Sensitive import ${operationId} failed`,
            error
          );
          this.sensitiveImportLedger.fail(operationId, SENSITIVE_IMPORT_FAILURE_MESSAGE);
        }
      })
      .finally(() => {
        if (this.sensitiveOperations.get(operationId) === operation) {
          this.sensitiveOperations.delete(operationId);
        }
      });
    this.sensitiveOperations.set(operationId, operation);
  }

  private resumeSensitiveImports(): void {
    if (this.stopping) return;
    for (const { operationId, input } of this.sensitiveImportLedger.running()) {
      this.launchSensitiveImport(operationId, input);
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

const SENSITIVE_IMPORT_DATA_TYPES: readonly BrowserSensitiveImportDataType[] = [
  "cookies",
  "passwords",
  "formFill",
];

function isSensitiveImportDataType(
  dataType: BrowserImportDataType
): dataType is BrowserSensitiveImportDataType {
  return SENSITIVE_IMPORT_DATA_TYPES.includes(dataType as BrowserSensitiveImportDataType);
}

function isPublicImportDataType(
  dataType: BrowserImportDataType
): dataType is BrowserPublicImportDataType {
  return !isSensitiveImportDataType(dataType);
}

function normalizeSensitiveDataTypes(
  dataTypes: readonly BrowserSensitiveImportDataType[]
): BrowserSensitiveImportDataType[] {
  const selected = new Set(dataTypes);
  if (selected.size !== dataTypes.length || selected.size === 0) {
    throw new Error("Sensitive browser import data types must be non-empty and unique");
  }
  return SENSITIVE_IMPORT_DATA_TYPES.filter((dataType) => selected.has(dataType));
}

function normalizedPlatform(): "darwin" | "linux" | "win32" {
  return process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
}
