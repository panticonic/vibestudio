import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { shell, type DownloadItem, type Session, type WebContents } from "electron";
import type { EventService } from "@vibestudio/shared/eventsService";
import type {
  BrowserDataClient,
  BrowserDownloadRecord,
  BrowserDownloadState,
} from "@vibestudio/browser-data";
import { createDevLogger } from "@vibestudio/dev-log";
import type { ViewManager } from "../viewManager.js";
import { sanitizeFilenamePart } from "../safeFilename.js";

const log = createDevLogger("BrowserDownloads");

// All workspace sessions write into the same native filesystem namespace.
const reservedDownloadPaths = new Set<string>();

interface LiveDownload {
  item: DownloadItem;
  record: BrowserDownloadRecord;
}

/** Owns one environment's Electron downloads and persists metadata, never file contents. */
export class BrowserDownloadManager {
  private readonly records = new Map<string, BrowserDownloadRecord>();
  private readonly pendingApproval = new Set<DownloadItem>();
  private readonly live = new Map<string, LiveDownload>();
  private persistOperation: Promise<void> = Promise.resolve();
  private history:
    | Pick<BrowserDataClient, "listDownloadRecords" | "upsertDownloadRecord">
    | undefined;
  private stopped = false;

  constructor(
    private readonly deps: {
      browserSession: Session;
      environmentKey: string;
      hostId: string;
      downloadsDirectory: string;
      browserData?: Pick<BrowserDataClient, "listDownloadRecords" | "upsertDownloadRecord">;
      eventService: EventService;
      getViewManager(): Pick<ViewManager, "findViewIdByWebContentsId"> | null;
      requestSiteCapability(contents: WebContents, capability: "downloads"): Promise<boolean>;
    }
  ) {
    this.history = deps.browserData;
  }

  async attachHistory(
    store: Pick<BrowserDataClient, "listDownloadRecords" | "upsertDownloadRecord">
  ): Promise<void> {
    if (this.stopped) return;
    this.history = store;
    await this.load();
  }

  async start(): Promise<void> {
    this.deps.browserSession.on("will-download", this.onWillDownload);
    try {
      await this.load();
    } catch (error) {
      log.warn(`Download history unavailable: ${String(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.deps.browserSession.off("will-download", this.onWillDownload);
    for (const item of this.pendingApproval) item.cancel();
    this.pendingApproval.clear();
    for (const download of this.live.values()) download.item.cancel();
    this.live.clear();
    await this.persistOperation;
  }

  list(): BrowserDownloadRecord[] {
    return [...this.records.values()]
      .map((record) => ({ ...record }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  pause(id: string): void {
    const live = this.requireLive(id);
    live.item.pause();
    this.update(live, "paused");
  }

  resume(id: string): void {
    const live = this.requireLive(id);
    if (!live.item.canResume()) throw new Error("This download cannot be resumed");
    live.item.resume();
    this.update(live, "progressing");
  }

  cancel(id: string): void {
    const live = this.requireLive(id);
    live.item.cancel();
    this.update(live, "cancelled");
  }

  async open(id: string): Promise<void> {
    const record = this.requireRecord(id);
    if (record.state !== "completed") throw new Error("Download is not complete");
    const error = await shell.openPath(record.savePath);
    if (error) throw new Error(error);
  }

  reveal(id: string): void {
    shell.showItemInFolder(this.requireRecord(id).savePath);
  }

  private readonly onWillDownload = (
    _event: Electron.Event,
    item: DownloadItem,
    contents: WebContents
  ): void => {
    item.pause();
    if (this.stopped) {
      item.cancel();
      return;
    }
    this.pendingApproval.add(item);
    // Electron reads the destination when will-download returns, before an
    // asynchronous site approval can settle. Reserve it for the item's entire
    // lifetime, including approval, when no file may exist on disk yet.
    const savePath = availableDownloadPath(
      this.deps.downloadsDirectory,
      safeFilename(item.getFilename()),
      reservedDownloadPaths
    );
    item.setSavePath(savePath);
    reservedDownloadPaths.add(savePath);
    item.once("done", () => {
      reservedDownloadPaths.delete(savePath);
      this.pendingApproval.delete(item);
    });
    void this.deps
      .requestSiteCapability(contents, "downloads")
      .then((granted) => {
        this.pendingApproval.delete(item);
        if (this.stopped || !granted || contents.isDestroyed() || !item.canResume()) {
          item.cancel();
          return;
        }
        this.beginDownload(item, contents, savePath);
        item.resume();
      })
      .catch(() => item.cancel());
  };

  private beginDownload(item: DownloadItem, contents: WebContents, savePath: string): void {
    const id = randomUUID();
    const url = item.getURL();
    const panelId = this.deps.getViewManager()?.findViewIdByWebContentsId(contents.id) ?? undefined;
    let origin: string | undefined;
    try {
      origin = new URL(url).origin;
    } catch {
      // A non-web redirect chain is recorded without an origin.
    }
    const now = Date.now();
    const record: BrowserDownloadRecord = {
      id,
      environmentKey: this.deps.environmentKey,
      hostId: this.deps.hostId,
      ...(panelId ? { panelId } : {}),
      ...(origin ? { origin } : {}),
      url,
      filename: path.basename(savePath),
      savePath,
      receivedBytes: 0,
      totalBytes: Math.max(0, item.getTotalBytes()),
      state: "progressing",
      startedAt: now,
      updatedAt: now,
    };
    const live = { item, record };
    this.records.set(id, record);
    this.live.set(id, live);
    this.persist(record);

    item.on("updated", (_updateEvent, state) => {
      this.update(
        live,
        state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing"
      );
    });
    item.once("done", (_doneEvent, state) => {
      const terminal: BrowserDownloadState =
        state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      this.update(live, terminal);
      this.live.delete(id);
      this.notify(record);
    });
  }

  private update(live: LiveDownload, state: BrowserDownloadState): void {
    live.record.state = state;
    live.record.receivedBytes = Math.max(0, live.item.getReceivedBytes());
    live.record.totalBytes = Math.max(0, live.item.getTotalBytes());
    live.record.updatedAt = Date.now();
    this.persist(live.record);
  }

  private notify(record: BrowserDownloadRecord): void {
    const completed = record.state === "completed";
    this.deps.eventService.emit("notification:show", {
      id: `browser-download:${record.id}`,
      type: completed ? "success" : record.state === "cancelled" ? "info" : "error",
      title: completed ? "Download complete" : `Download ${record.state}`,
      message: record.filename,
      sourcePanelId: record.panelId,
      ttl: completed ? 0 : 8_000,
      ...(completed
        ? {
            actions: [
              {
                id: `browser-download-open:${record.id}`,
                label: "Open",
                command: { type: "browser.downloadOpen", downloadId: record.id },
              },
              {
                id: `browser-download-reveal:${record.id}`,
                label: "Show in folder",
                command: { type: "browser.downloadReveal", downloadId: record.id },
              },
            ],
          }
        : {}),
    });
  }

  private persist(record: BrowserDownloadRecord): void {
    const store = this.history;
    if (!store) return;
    const snapshot = { ...record };
    const write = () => store.upsertDownloadRecord(snapshot);
    this.persistOperation = this.persistOperation.then(write, write).catch((error: unknown) => {
      log.warn(
        `Could not persist download metadata: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  private async load(): Promise<void> {
    const records = (await this.history?.listDownloadRecords(this.deps.hostId)) ?? [];
    if (this.stopped) return;
    for (const record of records.slice(0, 500)) {
      if ((this.records.get(record.id)?.updatedAt ?? 0) > record.updatedAt) continue;
      if (record.environmentKey !== this.deps.environmentKey) continue;
      if (record.state === "progressing" || record.state === "paused") {
        record.state = "interrupted";
        record.updatedAt = Date.now();
        this.persist(record);
      }
      this.records.set(record.id, record);
    }
  }

  private requireLive(id: string): LiveDownload {
    const live = this.live.get(id);
    if (!live) throw new Error(`Active download was not found: ${id}`);
    return live;
  }

  private requireRecord(id: string): BrowserDownloadRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Download was not found: ${id}`);
    return record;
  }
}

function safeFilename(value: string): string {
  const name = sanitizeFilenamePart(path.basename(value), "_").trim();
  return name && name !== "." && name !== ".." ? name.slice(0, 240) : "download";
}

function availableDownloadPath(
  directory: string,
  filename: string,
  reservedPaths: ReadonlySet<string>
): string {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let candidate = path.join(directory, filename);
  for (let index = 1; reservedPaths.has(candidate) || existsSync(candidate); index += 1) {
    candidate = path.join(directory, `${stem} (${index})${extension}`);
  }
  return candidate;
}
