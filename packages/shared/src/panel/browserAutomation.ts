/** Native browser activity stays scoped to the panel that caused it. No host paths cross this API. */
export type BrowserPopup = { panelId: string; url: string };
export type BrowserDownload = {
  id: string;
  url: string;
  filename: string;
  state: string;
  receivedBytes: number;
  totalBytes: number;
};
export type BrowserAutomationRequest =
  | { operation: "listDownloads" }
  | { operation: "downloadInfo"; id: string }
  | { operation: "downloadFinished"; id: string }
  | { operation: "readDownloadChunk"; id: string; offset: number; length: number }
  | { operation: "cancelDownload"; id: string };
export type BrowserDownloadChunk = { base64: string; eof: boolean };

/** Event-owned waiters; every subscription is released on completion or caller cancellation. */
export class BrowserActivity<T> {
  private readonly observers = new Map<string, Set<(value?: T, error?: Error) => void>>();
  private error: Error | null = null;
  wait(panelId: string, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const observers = this.observers.get(panelId) ?? new Set();
      const finish = (value?: T, error?: Error) => {
        observers.delete(finish);
        if (!observers.size) this.observers.delete(panelId);
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve(value!);
      };
      const cancel = () =>
        finish(
          undefined,
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Browser activity cancelled", { cause: signal.reason })
        );
      observers.add(finish);
      this.observers.set(panelId, observers);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  publish(panelId: string, value?: T, error?: Error): void {
    for (const observe of [...(this.observers.get(panelId) ?? [])]) observe(value, error);
  }
  close(error: Error): void {
    this.error = error;
    for (const panelId of [...this.observers.keys()]) this.publish(panelId, undefined, error);
  }
}
