import { mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import {
  BrowserActivity,
  type BrowserAutomationRequest,
  type BrowserDownload,
} from "@vibestudio/shared/panel/browserAutomation";
import type { CdpConnection } from "./browser/cdpConnection.js";

type OwnedDownload = {
  panelId: string;
  record: BrowserDownload;
  path: string;
  approved: boolean;
  terminal: boolean;
  error?: Error;
};
/** Owns browser-private download staging, approval, completion and retirement. */
export class HeadlessBrowserDownloads {
  private readonly records = new Map<string, OwnedDownload>();
  private readonly completed = new BrowserActivity<BrowserDownload>();
  private readonly nativeCompleted = new BrowserActivity<BrowserDownload>();
  private readonly subscriptions: Array<() => void> = [];
  private directory = "";
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();
  constructor(
    private readonly cdp: CdpConnection,
    private readonly deps: {
      ownerForFrame(
        frameId: string
      ): { panelId: string; url: string; signal?: AbortSignal } | undefined;
      approve(panelId: string, url: string, signal: AbortSignal): Promise<boolean>;
      activity(panelId: string, payload: { download?: BrowserDownload; error?: string }): void;
    }
  ) {}
  private readonly lifetime = new AbortController();
  async start(profileDir: string): Promise<void> {
    this.directory = await mkdtemp(path.join(profileDir, "downloads-"));
    this.subscriptions.push(
      this.cdp.onEvent((event) => {
        if (event.method === "Browser.downloadWillBegin") {
          const work = this.begin(
            event.params as {
              guid: string;
              frameId: string;
              url: string;
              suggestedFilename: string;
            }
          );
          this.pending.add(work);
          void work.then(
            () => this.pending.delete(work),
            (error) => {
              this.pending.delete(work);
              this.deps.activity(
                this.deps.ownerForFrame((event.params as { frameId: string }).frameId)?.panelId ??
                  "",
                { error: String(error) }
              );
            }
          );
        } else if (event.method === "Browser.downloadProgress")
          this.progress(
            event.params as {
              guid: string;
              state: string;
              receivedBytes: number;
              totalBytes: number;
            }
          );
      })
    );
    this.subscriptions.push(
      this.cdp.onClose(() => {
        const error = new Error("Download browser disconnected");
        this.lifetime.abort(error);
        this.completed.close(error);
        this.nativeCompleted.close(error);
      })
    );
    await this.cdp.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: this.directory,
      eventsEnabled: true,
    });
  }
  async configureContext(browserContextId: string): Promise<void> {
    await this.cdp.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      browserContextId,
      downloadPath: this.directory,
      eventsEnabled: true,
    });
  }
  private async begin(p: {
    guid: string;
    frameId: string;
    url: string;
    suggestedFilename: string;
  }): Promise<void> {
    const owner = this.deps.ownerForFrame(p.frameId);
    if (!owner || this.stopped || !/^[a-zA-Z0-9-]+$/.test(p.guid)) {
      await this.cdp.send("Browser.cancelDownload", { guid: p.guid });
      return;
    }
    const download: OwnedDownload = {
      panelId: owner.panelId,
      record: {
        id: p.guid,
        url: p.url,
        filename: p.suggestedFilename,
        state: "progressing",
        receivedBytes: 0,
        totalBytes: 0,
      },
      path: path.join(this.directory, p.guid),
      approved: false,
      terminal: false,
    };
    this.records.set(p.guid, download);
    try {
      // Chromium stages in a private, host-owned directory. No bytes or host path
      // are exposed to callers until the originating site's approval completes.
      if (
        !(await this.deps.approve(
          owner.panelId,
          owner.url,
          owner.signal
            ? AbortSignal.any([owner.signal, this.lifetime.signal])
            : this.lifetime.signal
        ))
      )
        throw new Error("Download permission denied");
      this.lifetime.signal.throwIfAborted();
      download.approved = true;
      this.deps.activity(owner.panelId, { download: { ...download.record } });
      if (download.terminal) this.settle(download);
    } catch (error) {
      download.error = error instanceof Error ? error : new Error(String(error));
      this.deps.activity(owner.panelId, { error: download.error.message });
      this.settle(download);
      if (!download.terminal && !this.lifetime.signal.aborted) {
        await this.cdp.send("Browser.cancelDownload", { guid: p.guid });
        if (!download.terminal) await this.nativeCompleted.wait(p.guid, this.lifetime.signal);
      }
      if (download.terminal) await rm(download.path, { force: true });
    }
  }
  private progress(p: {
    guid: string;
    state: string;
    receivedBytes: number;
    totalBytes: number;
  }): void {
    const download = this.records.get(p.guid);
    if (!download) return;
    download.record.receivedBytes = p.receivedBytes;
    download.record.totalBytes = p.totalBytes;
    download.record.state = p.state === "canceled" ? "cancelled" : p.state;
    download.terminal = p.state === "completed" || p.state === "canceled";
    if (download.terminal) {
      this.nativeCompleted.publish(p.guid, { ...download.record });
      if (download.approved) this.settle(download);
    }
  }
  private settle(download: OwnedDownload): void {
    const error =
      download.error ??
      (download.record.state === "completed"
        ? undefined
        : new Error(`Download ${download.record.state}`));
    this.completed.publish(download.record.id, error ? undefined : { ...download.record }, error);
  }
  async operation(
    panelId: string,
    request: BrowserAutomationRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (this.stopped) throw new Error("Download provider stopped");
    if (request.operation === "listDownloads")
      return [...this.records.values()]
        .filter((d) => d.panelId === panelId && d.approved)
        .map((d) => ({ ...d.record }));
    const download = this.records.get(request.id);
    if (!download || download.panelId !== panelId || !download.approved)
      throw new Error("Download does not belong to this panel");
    if (request.operation === "downloadInfo") return { ...download.record };
    if (request.operation === "cancelDownload") {
      await this.cdp.send("Browser.cancelDownload", { guid: request.id });
      return;
    }
    if (request.operation === "downloadFinished") {
      if (!download.terminal) return this.completed.wait(request.id, signal);
      if (download.error) throw download.error;
      if (download.record.state !== "completed")
        throw new Error(`Download ${download.record.state}`);
      return { ...download.record };
    }
    if (download.record.state !== "completed") throw new Error("Download is not complete");
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isInteger(request.length) ||
      request.length < 1 ||
      request.length > 262144
    )
      throw new Error("Invalid download byte range");
    const file = await open(download.path, "r");
    try {
      const buffer = Buffer.alloc(request.length);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, request.offset);
      signal.throwIfAborted();
      return {
        base64: buffer.subarray(0, bytesRead).toString("base64"),
        eof: request.offset + bytesRead >= (await file.stat()).size,
      };
    } finally {
      await file.close();
    }
  }
  private stopWork: Promise<void> | undefined;
  stop(): Promise<void> {
    return (this.stopWork ??= this.retire());
  }
  private async retire(): Promise<void> {
    this.stopped = true;
    const error = new Error("Download provider stopped");
    this.lifetime.abort(error);
    this.completed.close(error);
    const results = await Promise.allSettled(
      [...this.records.values()]
        .filter((d) => !d.terminal)
        .map(async (download) => {
          await this.cdp.send("Browser.cancelDownload", { guid: download.record.id });
          if (!download.terminal)
            await this.nativeCompleted.wait(download.record.id, new AbortController().signal);
        })
    );
    const approvals = await Promise.allSettled(this.pending);
    this.nativeCompleted.close(error);
    for (const release of this.subscriptions.splice(0)) release();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    const failures = [...results, ...approvals].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Download retirement failed"
      );
  }
}
