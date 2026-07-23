import { createHash, randomUUID } from "node:crypto";
import { ipcMain, nativeImage, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { BrowserPermissionController } from "./browserPermissionController.js";
import type { ViewManager } from "../viewManager.js";

const SHOW_CHANNEL = "vibestudio:website-notification:show";
const CLOSE_CHANNEL = "vibestudio:website-notification:close";
const EVENT_CHANNEL = "vibestudio:website-notification:event";
const MAX_PER_MINUTE = 5;
const MAX_ICON_BYTES = 128 * 1024;

type WebsiteNotificationOptions = {
  body?: string;
  tag?: string;
  silent?: boolean;
  iconUrl?: string;
};

type LiveNotification = {
  id: string;
  panelId: string;
  origin: string;
  contents: WebContents;
  cleanup: () => void;
};

/** Narrow, sender-attributed bridge from document Notifications to shell chrome. */
export class WebsiteNotificationBridge {
  private readonly live = new Map<string, LiveNotification>();
  private readonly rate = new Map<string, number[]>();
  private started = false;

  constructor(
    private readonly deps: {
      permissions: BrowserPermissionController;
      eventService: EventService;
      getViewManager(): ViewManager | null;
    }
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    ipcMain.handle(SHOW_CHANNEL, this.onShow);
    ipcMain.handle(CLOSE_CHANNEL, this.onClose);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    ipcMain.removeHandler(SHOW_CHANNEL);
    ipcMain.removeHandler(CLOSE_CHANNEL);
    for (const notification of this.live.values()) {
      notification.cleanup();
      this.sendLifecycle(notification, "close");
      this.deps.eventService.emit("notification:dismiss", { id: notification.id });
    }
    this.live.clear();
    this.rate.clear();
  }

  handleAction(id: string, actionId: string): void {
    const notification = this.live.get(id);
    if (!notification) return;
    if (actionId === "website-open") this.sendLifecycle(notification, "click");
    this.close(notification);
  }

  private readonly onShow = async (
    event: IpcMainInvokeEvent,
    rawTitle: unknown,
    rawOptions: unknown
  ): Promise<string> => {
    const attribution = this.attribute(event);
    if (!attribution) throw new Error("Website notification sender is not a browser panel");
    await this.deps.permissions.refresh();
    if (!this.deps.permissions.isGranted(attribution.origin, "notifications")) {
      throw new Error("Website notifications are not allowed for this site");
    }

    const title = boundedString(rawTitle, "title", 1, 160);
    const options = notificationOptions(rawOptions);
    const iconDataUrl = options.iconUrl
      ? await this.fetchIcon(attribution.contents, options.iconUrl).catch(() => undefined)
      : undefined;
    this.consumeRateLimit(attribution.origin);
    const id = notificationId(attribution.origin, options.tag);
    const prior = this.live.get(id);
    if (prior) this.close(prior);
    const onDestroyed = () => this.close(notification);
    const onNavigation = (
      _event: Electron.Event,
      _url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ) => {
      if (isMainFrame) this.close(notification);
    };
    const notification: LiveNotification = {
      id,
      ...attribution,
      cleanup: () => {
        if (attribution.contents.isDestroyed()) return;
        attribution.contents.off("destroyed", onDestroyed);
        attribution.contents.off("did-start-navigation", onNavigation);
      },
    };
    this.live.set(id, notification);
    attribution.contents.once("destroyed", onDestroyed);
    attribution.contents.on("did-start-navigation", onNavigation);

    this.deps.eventService.emit("notification:show", {
      id,
      type: "info",
      title,
      ...(options.body ? { message: options.body } : {}),
      ttl: 0,
      sourcePanelId: attribution.panelId,
      ...(iconDataUrl ? { iconDataUrl } : {}),
      details: [
        { label: "Origin", value: attribution.origin, mono: true },
        { label: "Page", value: attribution.contents.getURL(), mono: true },
      ],
      actions: [
        {
          id: "website-open",
          label: "Open",
          variant: "solid",
          command: { type: "panel.focus", panelId: attribution.panelId },
        },
      ],
    });
    return id;
  };

  private readonly onClose = (event: IpcMainInvokeEvent, id: unknown): void => {
    if (typeof id !== "string") return;
    const notification = this.live.get(id);
    if (!notification || notification.contents.id !== event.sender.id) return;
    this.close(notification);
  };

  private attribute(
    event: IpcMainInvokeEvent
  ): { panelId: string; origin: string; contents: WebContents } | null {
    const manager = this.deps.getViewManager();
    const panelId = manager?.findViewIdByWebContentsId(event.sender.id);
    if (!panelId || !this.deps.permissions.ownsContents(event.sender)) return null;
    const url = webUrl(event.sender.getURL());
    if (!url) return null;
    return { panelId, origin: url.origin, contents: event.sender };
  }

  private consumeRateLimit(origin: string): void {
    const cutoff = Date.now() - 60_000;
    const recent = (this.rate.get(origin) ?? []).filter((time) => time > cutoff);
    if (recent.length >= MAX_PER_MINUTE) {
      throw new Error("This site is sending notifications too quickly");
    }
    recent.push(Date.now());
    this.rate.set(origin, recent);
  }

  private async fetchIcon(contents: WebContents, rawUrl: string): Promise<string> {
    const url = new URL(rawUrl, contents.getURL());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Website notification icon must use HTTP(S)");
    }
    const response = await contents.session.fetch(url.href);
    if (!response.ok) throw new Error(`Website notification icon returned HTTP ${response.status}`);
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    if (!mime.startsWith("image/")) throw new Error("Website notification icon is not an image");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) {
      throw new Error("Website notification icon is too large");
    }
    const bytes = await readBoundedBody(response, MAX_ICON_BYTES);
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw new Error("Website notification icon could not be decoded");
    const size = image.getSize();
    if (size.width > 4096 || size.height > 4096) {
      throw new Error("Website notification icon dimensions are too large");
    }
    return image.resize({ width: 32, height: 32, quality: "best" }).toDataURL();
  }

  private close(notification: LiveNotification): void {
    if (this.live.get(notification.id) !== notification) return;
    this.live.delete(notification.id);
    notification.cleanup();
    this.deps.eventService.emit("notification:dismiss", { id: notification.id });
    this.sendLifecycle(notification, "close");
  }

  private sendLifecycle(notification: LiveNotification, type: "show" | "click" | "close"): void {
    if (notification.contents.isDestroyed()) return;
    if (webUrl(notification.contents.getURL())?.origin !== notification.origin) return;
    notification.contents.send(EVENT_CHANNEL, { id: notification.id, type });
  }
}

function notificationOptions(value: unknown): WebsiteNotificationOptions {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Notification options must be an object");
  }
  const options = value as Record<string, unknown>;
  return {
    ...(options["body"] !== undefined
      ? { body: boundedString(options["body"], "body", 0, 500) }
      : {}),
    ...(options["tag"] !== undefined ? { tag: boundedString(options["tag"], "tag", 0, 100) } : {}),
    ...(typeof options["silent"] === "boolean" ? { silent: options["silent"] } : {}),
    ...(options["icon"] !== undefined
      ? { iconUrl: boundedString(options["icon"], "icon URL", 1, 2_048) }
      : {}),
  };
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`Notification ${label} must be ${minimum}-${maximum} characters`);
  }
  return value;
}

function notificationId(origin: string, tag: string | undefined): string {
  const originHash = createHash("sha256").update(origin).digest("base64url").slice(0, 16);
  const suffix = tag
    ? createHash("sha256").update(tag).digest("base64url").slice(0, 16)
    : randomUUID();
  return `website:${originHash}:${suffix}`;
}

function webUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("Website notification icon is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
