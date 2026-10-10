import type {
  BrowserImportDataType,
  BrowserImportProvider,
  BrowserImportRead,
  BrowserImportSource,
  ImportBatchSink,
  ImportedBrowserOpenTab,
  ImportPreviewSink,
  ImportPreviewSummary,
  ImportSummary,
} from "./environment.js";

type ProviderClient = import("@vibestudio/shared/typedServiceClient").TypedServiceClient<
  typeof import("@vibestudio/service-schemas/browserEnvironment").browserEnvironmentMethods
>;

/** Adapts one authenticated device/server endpoint to the common import provider. */
export class RemoteBrowserImportProvider implements BrowserImportProvider {
  constructor(
    private readonly hostId: string,
    private readonly client: ProviderClient
  ) {}

  listSources(_signal: AbortSignal): Promise<BrowserImportSource[]> {
    return this.client.listImportSources(this.hostId);
  }

  async preview(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    sink: ImportPreviewSink,
    _signal: AbortSignal
  ): Promise<ImportPreviewSummary> {
    const summary = await this.client.previewImportSource(this.hostId, sourceId, dataTypes);
    for (const progress of summary.dataTypes) await sink.progress(progress);
    return summary;
  }

  async openImport(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    signal: AbortSignal
  ): Promise<BrowserImportRead> {
    const { browserEnvironmentMethods } =
      await import("@vibestudio/service-schemas/browserEnvironment");
    const args = browserEnvironmentMethods.startImportRead.args.parse([
      this.hostId,
      sourceId,
      dataTypes,
    ]);
    const operationId = await this.client.startImportRead(...args);
    const cancel = () => void this.client.cancelImportRead(operationId).catch(() => {});
    signal.addEventListener("abort", cancel, { once: true });
    return {
      consume: async (sink: ImportBatchSink): Promise<ImportSummary> => {
        try {
          for (;;) {
            if (signal.aborted) throw signal.reason;
            const frame = await this.client.nextImportFrame(operationId);
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
      },
    };
  }

  listOpenTabs(sourceId: string, _signal: AbortSignal): Promise<ImportedBrowserOpenTab[]> {
    return this.client.listImportOpenTabs(this.hostId, sourceId);
  }
}
