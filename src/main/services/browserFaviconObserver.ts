import { nativeImage } from "electron";
import type { WebContents } from "electron";
import type { BrowserDataClient, FaviconHandle } from "@vibestudio/browser-data";
import { createDevLogger } from "@vibestudio/dev-log";

const log = createDevLogger("BrowserFavicon");
const MAX_ICON_BYTES = 256 * 1024;

export interface BrowserFaviconObserver {
  attach(
    panelId: string,
    contents: WebContents,
    onStored: (favicon: FaviconHandle) => void
  ): () => void;
}

/** Validates and canonicalizes page icons before any shell renderer can use them. */
export class CanonicalBrowserFaviconObserver implements BrowserFaviconObserver {
  constructor(private readonly store: Pick<BrowserDataClient, "putPageFavicon">) {}

  attach(
    panelId: string,
    contents: WebContents,
    onStored: (favicon: FaviconHandle) => void
  ): () => void {
    let generation = 0;
    const onUpdated = (_event: Electron.Event, candidates: string[]) => {
      const pageUrl = contents.getURL();
      const candidate = candidates.find((value) => /^https?:\/\//i.test(value));
      if (!candidate || !/^https?:\/\//i.test(pageUrl)) return;
      const current = ++generation;
      void this.capture(contents, pageUrl, candidate)
        .then((updatedAt) => {
          if (current !== generation || contents.isDestroyed()) return;
          onStored({ pageUrl, updatedAt });
        })
        .catch((error: unknown) => {
          log.warn(
            `Ignored favicon for ${panelId}: ${error instanceof Error ? error.message : String(error)}`
          );
        });
    };
    contents.on("page-favicon-updated", onUpdated);
    return () => {
      generation += 1;
      if (!contents.isDestroyed()) contents.off("page-favicon-updated", onUpdated);
    };
  }

  private async capture(
    contents: WebContents,
    pageUrl: string,
    sourceUrl: string
  ): Promise<number> {
    const response = await contents.session.fetch(sourceUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`unsupported MIME type ${contentType}`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ICON_BYTES) {
      throw new Error("icon exceeds byte limit");
    }
    const bytes = await readBoundedBody(response, MAX_ICON_BYTES);
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw new Error("icon could not be decoded");
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0 || size.width > 4096 || size.height > 4096) {
      throw new Error("icon dimensions are invalid");
    }
    const updatedAt = Date.now();
    await this.store.putPageFavicon({
      pageUrl,
      origin: new URL(pageUrl).origin,
      sourceUrl,
      png16: image.resize({ width: 16, height: 16, quality: "best" }).toPNG(),
      png32: image.resize({ width: 32, height: 32, quality: "best" }).toPNG(),
      mimeType: "image/png",
      updatedAt,
    });
    return updatedAt;
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("icon exceeds byte limit");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
