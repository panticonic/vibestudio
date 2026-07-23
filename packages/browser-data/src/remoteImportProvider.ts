import type {
  BrowserImportDataType,
  BrowserImportProvider,
  BrowserImportSource,
  ImportBatchSink,
  ImportedBrowserOpenTab,
  ImportPreviewSink,
  ImportPreviewSummary,
  ImportSummary,
} from "./environment.js";

type ProviderFrame =
  | { type: "heartbeat" }
  | {
      type: "batch";
      dataType: BrowserImportDataType;
      batchIndex: number;
      items: unknown[];
    }
  | { type: "progress"; progress: ImportSummary["dataTypes"][number] }
  | { type: "complete"; summary: ImportSummary }
  | { type: "error"; message: string };

/** Adapts the authenticated desktop endpoint to the common import provider. */
export class RemoteBrowserImportProvider implements BrowserImportProvider {
  constructor(
    private readonly call: <T>(method: string, ...args: unknown[]) => Promise<T>
  ) {}

  listSources(_signal: AbortSignal): Promise<BrowserImportSource[]> {
    return this.call("listImportSources");
  }

  async preview(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    sink: ImportPreviewSink,
    _signal: AbortSignal
  ): Promise<ImportPreviewSummary> {
    const summary = await this.call<ImportPreviewSummary>(
      "previewImportSource",
      sourceId,
      dataTypes
    );
    for (const progress of summary.dataTypes) await sink.progress(progress);
    return summary;
  }

  async import(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    sink: ImportBatchSink,
    signal: AbortSignal
  ): Promise<ImportSummary> {
    const operationId = await this.call<string>("startImportRead", sourceId, dataTypes);
    const cancel = () => void this.call("cancelImportRead", operationId).catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw signal.reason;
        const frame = await this.call<ProviderFrame>("nextImportFrame", operationId);
        switch (frame.type) {
          case "heartbeat":
            break;
          case "batch":
            await sink.store({
              jobId: operationId,
              sourceId,
              dataType: frame.dataType,
              batchIndex: frame.batchIndex,
              idempotencyKey: `${operationId}:${frame.dataType}:${frame.batchIndex}`,
              items: frame.items,
            });
            break;
          case "progress":
            await sink.progress(frame.progress);
            break;
          case "complete":
            return frame.summary;
          case "error":
            throw new Error(frame.message);
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
    }
  }

  listOpenTabs(sourceId: string, _signal: AbortSignal): Promise<ImportedBrowserOpenTab[]> {
    return this.call("listImportOpenTabs", sourceId);
  }
}
