import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DownloadItem, Session, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventService } from "@vibestudio/shared/eventsService";
import { BrowserDownloadManager } from "./browserDownloadManager";

vi.mock("electron", () => ({ shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }));

class Download extends EventEmitter {
  getFilename = () => "report.pdf";
  getURL = () => "https://example.com/report.pdf";
  getTotalBytes = () => 100;
  getReceivedBytes = () => 0;
  isPaused = () => false;
  canResume = () => true;
  pause = vi.fn();
  resume = vi.fn();
  setSavePath = vi.fn();
  cancel = vi.fn(() => this.emit("done", {}, "cancelled"));
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(requestSiteCapability = vi.fn(async () => true)) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-downloads-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const session = new EventEmitter();
  const manager = new BrowserDownloadManager({
    browserSession: session as Session,
    environmentKey: "test",
    hostId: "desktop",
    downloadsDirectory: directory,
    browserData: {
      listDownloadRecords: vi.fn(async () => []),
      upsertDownloadRecord: vi.fn(async () => {}),
    },
    eventService: { emit: vi.fn() } as unknown as EventService,
    getViewManager: () => null,
    requestSiteCapability,
  });
  await manager.start();
  cleanups.push(() => manager.stop());
  const start = () => {
    const item = new Download();
    session.emit(
      "will-download",
      {},
      item as unknown as DownloadItem,
      {
        id: 1,
        isDestroyed: () => false,
      } as WebContents
    );
    return item;
  };
  return { directory, manager, start };
}

describe("browser download destinations", () => {
  it("assigns distinct destinations synchronously while site approval is pending", async () => {
    let approve!: (allowed: boolean) => void;
    const permission = new Promise<boolean>((resolve) => {
      approve = resolve;
    });
    const { directory, manager, start } = await setup(vi.fn(() => permission));
    const first = start();
    const second = start();
    expect(first.setSavePath).toHaveBeenCalledWith(path.join(directory, "report.pdf"));
    expect(second.setSavePath).toHaveBeenCalledWith(path.join(directory, "report (1).pdf"));
    expect(first.resume).not.toHaveBeenCalled();
    approve(true);
    await permission;
    expect(first.resume).toHaveBeenCalledOnce();
    expect(
      manager
        .list()
        .map((record) => record.filename)
        .sort()
    ).toEqual(["report (1).pdf", "report.pdf"]);
    expect(first.setSavePath).toHaveBeenCalledOnce();
  });

  it("keeps active destinations reserved and skips files already on disk", async () => {
    const { directory, start } = await setup();
    await writeFile(path.join(directory, "report.pdf"), "existing file");
    const first = start();
    await Promise.resolve();
    const second = start();
    expect(first.setSavePath).toHaveBeenCalledWith(path.join(directory, "report (1).pdf"));
    expect(second.setSavePath).toHaveBeenCalledWith(path.join(directory, "report (2).pdf"));
  });

  it("releases a denied download's destination without creating a download record", async () => {
    const { directory, manager, start } = await setup(vi.fn(async () => false));
    const first = start();
    await Promise.resolve();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(manager.list()).toEqual([]);
    const second = start();
    expect(second.setSavePath).toHaveBeenCalledWith(path.join(directory, "report.pdf"));
    await Promise.resolve();
  });
});
