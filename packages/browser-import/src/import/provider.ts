import { createHash, randomUUID } from "node:crypto";
import type {
  BrowserImportDataType,
  BrowserImportProvider,
  BrowserImportSource,
  FormFillType,
  FormFillValueInput,
  ImportBatchSink,
  ImportCategoryProgress,
  ImportedBrowserOpenTab,
  ImportPreviewSink,
  ImportPreviewSummary,
  ImportSummary,
  PageFavicon,
} from "@vibestudio/browser-data";
import type {
  BrowserFamily,
  DetectedBrowser,
  DetectedProfile,
  ImportedAutofillEntry,
  ImportedCookie,
  ImportedPassword,
} from "../types.js";
import { createCryptoProvider } from "../crypto/index.js";
import { detectBrowsers } from "../detection/index.js";
import { getReader } from "../readers/index.js";
import { readOpenTabs } from "../readers/openTabs.js";

const IMPORT_BATCH_SIZE = 250;
const MAX_FAVICON_BYTES = 128 * 1024;

interface ProviderSource {
  browser: DetectedBrowser;
  source: BrowserImportSource;
}

interface ReadResult {
  items: unknown[];
  skipped: number;
  warnings: string[];
}

export class LocalBrowserImportProvider implements BrowserImportProvider {
  private readonly sources = new Map<string, ProviderSource>();

  async listSources(signal: AbortSignal): Promise<BrowserImportSource[]> {
    this.throwIfAborted(signal);
    const discovered = detectBrowsers().sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.sources.clear();
    for (const browser of discovered) {
      const sourceId = this.sourceId(browser);
      const source: BrowserImportSource = {
        sourceId,
        browser: browser.name,
        displayName: browser.displayName,
        status: browser.tccBlocked ? "blocked" : "readable",
        localDataSetCount: browser.profiles.length,
        supportedDataTypes: [
          "bookmarks",
          "history",
          "cookies",
          "passwords",
          "formFill",
          "searchEngines",
          "favicons",
        ],
        warnings: browser.tccBlocked
          ? [
              `${browser.displayName} data is blocked by operating-system privacy controls on this device.`,
            ]
          : [],
      };
      this.sources.set(sourceId, { browser, source });
    }
    return [...this.sources.values()].map(({ source }) => source);
  }

  async preview(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    sink: ImportPreviewSink,
    signal: AbortSignal
  ): Promise<ImportPreviewSummary> {
    const source = await this.resolveSource(sourceId, signal);
    const progress: ImportCategoryProgress[] = [];
    const warnings = [...source.source.warnings];
    for (const dataType of dataTypes) {
      this.throwIfAborted(signal);
      const result = await this.readAcrossDataSets(source.browser, dataType, signal);
      warnings.push(...result.warnings);
      const category = this.progress(
        dataType,
        result.items.length,
        result.items.length,
        0,
        result.skipped,
        0
      );
      progress.push(category);
      await sink.progress(category);
      await sink.sample(dataType, this.maskedSamples(dataType, result.items));
    }
    return {
      dataTypes: progress,
      openTabCount: (await this.listOpenTabs(sourceId, signal)).length,
      localDataSetCount: source.browser.profiles.length,
      warnings,
    };
  }

  async import(
    sourceId: string,
    dataTypes: BrowserImportDataType[],
    sink: ImportBatchSink,
    signal: AbortSignal
  ): Promise<ImportSummary> {
    const source = await this.resolveSource(sourceId, signal);
    const jobId = randomUUID();
    const progress: ImportCategoryProgress[] = [];
    const warnings = [...source.source.warnings];
    for (const dataType of dataTypes) {
      this.throwIfAborted(signal);
      const result = await this.readAcrossDataSets(source.browser, dataType, signal);
      warnings.push(...result.warnings);
      let stored = 0;
      for (let start = 0, batchIndex = 0; start < result.items.length; start += IMPORT_BATCH_SIZE) {
        this.throwIfAborted(signal);
        const items = result.items.slice(start, start + IMPORT_BATCH_SIZE);
        await sink.store({
          jobId,
          sourceId,
          dataType,
          batchIndex,
          idempotencyKey: `${jobId}:${dataType}:${batchIndex}`,
          items,
        });
        stored += items.length;
        await sink.progress(
          this.progress(
            dataType,
            stored,
            result.items.length,
            stored,
            result.skipped,
            0
          )
        );
        batchIndex += 1;
      }
      const category = this.progress(
        dataType,
        result.items.length,
        result.items.length,
        result.items.length,
        result.skipped,
        0
      );
      progress.push(category);
      await sink.progress(category);
    }
    return { dataTypes: progress, warnings };
  }

  async listOpenTabs(sourceId: string, signal: AbortSignal): Promise<ImportedBrowserOpenTab[]> {
    const source = await this.resolveSource(sourceId, signal);
    const tabs: ImportedBrowserOpenTab[] = [];
    for (const [profileIndex, profile] of this.orderedProfiles(source.browser).entries()) {
      this.throwIfAborted(signal);
      const profileTabs = readOpenTabs({ browser: source.browser.name, profile });
      for (const tab of profileTabs) {
        tabs.push({
          tabId: this.opaqueId(
            `${sourceId}\x00${profileIndex}\x00${tab.windowIndex}\x00${tab.tabIndex}\x00${tab.url}`
          ),
          url: tab.url,
          ...(tab.title ? { title: tab.title } : {}),
          active: tab.active,
          ...(tab.pinned !== undefined ? { pinned: tab.pinned } : {}),
          ...(tab.lastAccessed !== undefined ? { lastAccessed: tab.lastAccessed } : {}),
        });
      }
    }
    return tabs;
  }

  private async readAcrossDataSets(
    browser: DetectedBrowser,
    dataType: BrowserImportDataType,
    signal: AbortSignal
  ): Promise<ReadResult> {
    const cryptoProvider = await createCryptoProvider().catch(() => undefined);
    const reader = await getReader(browser.family, {
      browser: browser.name,
      cryptoProvider,
    });
    const items: unknown[] = [];
    const warnings: string[] = [];
    let skipped = 0;
    for (const profile of this.orderedProfiles(browser)) {
      this.throwIfAborted(signal);
      try {
        switch (dataType) {
          case "bookmarks":
            items.push(...(await reader.readBookmarks(profile.path)));
            break;
          case "history":
            items.push(...(await reader.readHistory(profile.path)));
            break;
          case "cookies": {
            const cookies = await reader.readCookies(profile.path);
            const readable = cookies.filter((cookie) => cookie.value !== "");
            skipped += cookies.length - readable.length;
            items.push(...readable.map((cookie) => this.cookieInput(cookie)));
            break;
          }
          case "passwords": {
            const passwords = await reader.readPasswords(profile.path);
            const result = await this.decryptPasswords(
              browser.family,
              profile,
              passwords,
              cryptoProvider
            );
            items.push(...result.items);
            skipped += result.skipped;
            warnings.push(...result.warnings);
            break;
          }
          case "formFill": {
            const values = await reader.readAutofill(profile.path);
            for (const value of values) {
              const mapped = this.formFillValue(value);
              if (mapped) items.push(mapped);
              else skipped += 1;
            }
            break;
          }
          case "searchEngines":
            items.push(...(await reader.readSearchEngines(profile.path)));
            break;
          case "favicons": {
            const icons = await reader.readFavicons(profile.path);
            for (const icon of icons) {
              const favicon = this.pageFavicon(icon);
              if (favicon) items.push(favicon);
              else skipped += 1;
            }
            break;
          }
        }
      } catch (error) {
        warnings.push(
          `${browser.displayName}: one local data set could not provide ${dataType}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    return { items, skipped, warnings };
  }

  private async decryptPasswords(
    family: BrowserFamily,
    profile: DetectedProfile,
    passwords: ImportedPassword[],
    cryptoProvider: Awaited<ReturnType<typeof createCryptoProvider>> | undefined
  ): Promise<{ items: ImportedPassword[]; skipped: number; warnings: string[] }> {
    if (family !== "firefox") {
      const items = passwords.filter((password) => password.password !== "");
      return {
        items,
        skipped: passwords.length - items.length,
        warnings:
          items.length === passwords.length
            ? []
            : ["Some passwords could not be decrypted on this device."],
      };
    }
    if (!cryptoProvider) {
      return {
        items: [],
        skipped: passwords.length,
        warnings: ["Firefox password decryption is unavailable on this device."],
      };
    }
    const items: ImportedPassword[] = [];
    let skipped = 0;
    for (const password of passwords) {
      try {
        items.push({
          ...password,
          username: await cryptoProvider.decryptFirefoxLogin(
            password.username,
            `${profile.path}/key4.db`
          ),
          password: await cryptoProvider.decryptFirefoxLogin(
            password.password,
            `${profile.path}/key4.db`
          ),
        });
      } catch {
        skipped += 1;
      }
    }
    return {
      items,
      skipped,
      warnings:
        skipped > 0
          ? [
              `${skipped} Firefox password${skipped === 1 ? "" : "s"} could not be decrypted; a master-password prompt may be required.`,
            ]
          : [],
    };
  }

  private cookieInput(cookie: ImportedCookie) {
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      hostOnly: cookie.hostOnly,
      path: cookie.path || "/",
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(cookie.expirationDate === undefined
        ? {}
        : { expirationDate: cookie.expirationDate }),
      sourceScheme: cookie.sourceScheme,
      sourcePort: cookie.sourcePort,
    };
  }

  private formFillValue(entry: ImportedAutofillEntry): FormFillValueInput | null {
    const field = entry.fieldName.trim().toLocaleLowerCase().replace(/_/g, "-");
    const type = this.formFillType(field);
    const value = entry.value.trim();
    if (!type || !value || this.isExcludedFormValue(field)) return null;
    return {
      type,
      value,
      aliases: [field],
      createdAt: entry.dateCreated,
      updatedAt: entry.dateLastUsed ?? entry.dateCreated,
      useCount: entry.timesUsed,
    };
  }

  private formFillType(field: string): FormFillType | null {
    const exact = new Set<FormFillType>([
      "name",
      "given-name",
      "additional-name",
      "family-name",
      "honorific-prefix",
      "honorific-suffix",
      "email",
      "tel",
      "organization",
      "street-address",
      "address-line1",
      "address-line2",
      "address-line3",
      "address-level1",
      "address-level2",
      "postal-code",
      "country",
      "country-name",
    ]);
    if (exact.has(field as FormFillType)) return field as FormFillType;
    if (/^(first|given)(-?name)?$/.test(field)) return "given-name";
    if (/^(last|family|sur)(-?name)?$/.test(field)) return "family-name";
    if (/^(full-?)?name$/.test(field)) return "name";
    if (/e-?mail|email-?address/.test(field)) return "email";
    if (/^(phone|mobile|telephone|phone-number)$/.test(field)) return "tel";
    if (/company|organisation|organization/.test(field)) return "organization";
    if (/^(zip|zip-code|postcode)$/.test(field)) return "postal-code";
    if (/^(city|town)$/.test(field)) return "address-level2";
    if (/^(state|province|region)$/.test(field)) return "address-level1";
    if (/^country(-name)?$/.test(field)) return "country-name";
    if (/^(address|street)$/.test(field)) return "street-address";
    if (/^(address-?1|address-line-?1)$/.test(field)) return "address-line1";
    if (/^(address-?2|address-line-?2)$/.test(field)) return "address-line2";
    return null;
  }

  private isExcludedFormValue(field: string): boolean {
    return /(card|cc-|credit|cvc|cvv|password|passwd|otp|one-time|token|secret)/.test(field);
  }

  private pageFavicon(icon: {
    url: string;
    data: Buffer;
    mimeType: string;
  }): PageFavicon | null {
    if (icon.mimeType !== "image/png" || icon.data.byteLength > MAX_FAVICON_BYTES) return null;
    try {
      const page = new URL(icon.url);
      if (page.protocol !== "http:" && page.protocol !== "https:") return null;
      const bytes = new Uint8Array(icon.data);
      return {
        pageUrl: page.href,
        origin: page.origin,
        png16: bytes,
        png32: bytes,
        mimeType: "image/png",
        updatedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  private maskedSamples(dataType: BrowserImportDataType, items: unknown[]): unknown[] {
    return items.slice(0, 5).map((item) => {
      if (dataType === "cookies") {
        const cookie = item as { domain?: unknown; name?: unknown };
        return { domain: cookie.domain, name: cookie.name };
      }
      if (dataType === "passwords") {
        const password = item as { url?: unknown; username?: unknown };
        return { url: password.url, hasUsername: Boolean(password.username) };
      }
      if (dataType === "formFill") {
        return { type: (item as { type?: unknown }).type };
      }
      if (dataType === "favicons") {
        return { pageUrl: (item as { pageUrl?: unknown }).pageUrl };
      }
      return item;
    });
  }

  private progress(
    dataType: BrowserImportDataType,
    itemsProcessed: number,
    totalItems: number,
    stored: number,
    skipped: number,
    errors: number
  ): ImportCategoryProgress {
    return { dataType, itemsProcessed, totalItems, stored, skipped, errors };
  }

  private orderedProfiles(browser: DetectedBrowser): DetectedProfile[] {
    return [...browser.profiles].sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.id.localeCompare(b.id) ||
        a.path.localeCompare(b.path)
    );
  }

  private async resolveSource(sourceId: string, signal: AbortSignal): Promise<ProviderSource> {
    this.throwIfAborted(signal);
    let source = this.sources.get(sourceId);
    if (!source) {
      await this.listSources(signal);
      source = this.sources.get(sourceId);
    }
    if (!source) throw new Error("Browser import source is no longer available");
    if (source.source.status !== "readable") {
      throw new Error(`${source.source.displayName} is blocked on this device`);
    }
    return source;
  }

  private sourceId(browser: DetectedBrowser): string {
    return `source_${this.opaqueId(`${browser.name}\x00${browser.dataDir}`)}`;
  }

  private opaqueId(value: string): string {
    return createHash("sha256").update(value).digest("base64url");
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException("Cancelled", "AbortError");
    }
  }
}
