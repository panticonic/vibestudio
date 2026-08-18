import { createHash, randomUUID } from "node:crypto";
import type {
  BrowserImportDataType,
  BrowserImportProvider,
  BrowserImportSource,
  FormFillValueInput,
  ImportBatchSink,
  ImportCategoryBreakdown,
  ImportCategoryProgress,
  ImportedBrowserOpenTab,
  ImportPreviewSink,
  ImportPreviewSummary,
  ImportSummary,
  PageFavicon,
} from "@vibestudio/browser-data";
import {
  browserCookiePartitionStorageKey,
  isPersistableFormFillType,
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
import { classifyAutofillFieldName } from "../normalize/autofill.js";
import { getReader } from "../readers/index.js";
import { readOpenTabs } from "../readers/openTabs.js";
import { profileSessionState } from "../readers/profileSession.js";
import { computeCategoryBreakdown } from "./breakdown.js";
import { normalizeFavicon } from "../normalize/favicon.js";

const IMPORT_BATCH_SIZE = 250;

interface ProviderSource {
  browser: DetectedBrowser;
  source: BrowserImportSource;
}

interface ReadResult {
  items: unknown[];
  skipped: number;
  warnings: string[];
}

export function importedFormFillValue(entry: ImportedAutofillEntry): FormFillValueInput {
  const type = classifyAutofillFieldName(entry.fieldName);
  return {
    fieldName: entry.fieldName,
    ...(type === undefined ? {} : { type }),
    value: entry.value,
    aliases: [entry.fieldName],
    createdAt: entry.dateCreated,
    updatedAt: entry.dateLastUsed ?? entry.dateCreated,
    useCount: entry.timesUsed,
  };
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
    const breakdowns: ImportCategoryBreakdown[] = [];
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
      breakdowns.push(computeCategoryBreakdown(dataType, result.items));
      await sink.progress(category);
      await sink.sample(dataType, this.maskedSamples(dataType, result.items));
    }
    return {
      dataTypes: progress,
      breakdowns,
      openTabCount: (await this.listOpenTabs(sourceId, signal)).length,
      localDataSetCount: source.browser.profiles.length,
      warnings,
    };
  }

  async openImport(sourceId: string, dataTypes: BrowserImportDataType[], signal: AbortSignal) {
    return {
      consume: (sink: ImportBatchSink) => this.consumeImport(sourceId, dataTypes, sink, signal),
    };
  }

  private async consumeImport(
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
          this.progress(dataType, stored, result.items.length, stored, result.skipped, 0)
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
    // Window ordinals run across profiles in read order so the panel can label
    // groups "Window 1..N" without ever seeing a profile path or window handle.
    const ordinalByWindow = new Map<string, number>();
    // Every profile the browser has ever used keeps a session store, so reading
    // all of them merges long-closed windows into "open tabs". Classify each
    // profile instead: when something is running, only that is genuinely open;
    // otherwise report what a launch would restore, and what merely sits saved.
    const profiles = this.orderedProfiles(source.browser).map((profile) => ({
      profile,
      sessionState: profileSessionState(source.browser.family, profile),
    }));
    const readable = profiles.some((entry) => entry.sessionState === "open")
      ? profiles.filter((entry) => entry.sessionState === "open")
      : profiles;
    for (const [profileIndex, { profile, sessionState }] of readable.entries()) {
      this.throwIfAborted(signal);
      const profileTabs = readOpenTabs({ browser: source.browser.name, profile });
      for (const tab of profileTabs) {
        const windowKey = `${profileIndex}\x00${tab.windowIndex}`;
        let windowOrdinal = ordinalByWindow.get(windowKey);
        if (windowOrdinal === undefined) {
          windowOrdinal = ordinalByWindow.size + 1;
          ordinalByWindow.set(windowKey, windowOrdinal);
        }
        tabs.push({
          tabId: this.opaqueId(
            `${sourceId}\x00${profileIndex}\x00${tab.windowIndex}\x00${tab.tabIndex}\x00${tab.url}`
          ),
          url: tab.url,
          ...(tab.title ? { title: tab.title } : {}),
          active: tab.active,
          ...(tab.pinned !== undefined ? { pinned: tab.pinned } : {}),
          ...(tab.lastAccessed !== undefined ? { lastAccessed: tab.lastAccessed } : {}),
          windowId: this.opaqueId(`${sourceId}\x00${windowKey}`),
          windowOrdinal,
          sessionState,
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
    const seenCookieKeys = new Set<string>();
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
            const now = Date.now() / 1_000;
            let unreadable = 0;
            let expired = 0;
            let unsupportedIsolation = 0;
            let shadowed = 0;
            for (const cookie of cookies) {
              if (cookie.valueStatus === "unavailable") {
                unreadable += 1;
                continue;
              }
              if (cookie.unsupportedIsolation) {
                unsupportedIsolation += 1;
                continue;
              }
              if (cookie.expirationDate !== undefined && cookie.expirationDate <= now) {
                expired += 1;
                continue;
              }
              const key = `${cookie.name}\x00${cookie.domain.toLocaleLowerCase()}\x00${
                cookie.path || "/"
              }\x00${browserCookiePartitionStorageKey(cookie.partitionKey)}`;
              // Profiles are ordered default-first. A single Vibestudio
              // environment is one cookie jar, so the active/default profile
              // wins deterministic key collisions instead of being overwritten
              // later by an abandoned profile.
              if (seenCookieKeys.has(key)) {
                shadowed += 1;
                continue;
              }
              seenCookieKeys.add(key);
              items.push(this.cookieInput(cookie));
            }
            skipped += unreadable + expired + unsupportedIsolation + shadowed;
            if (unreadable > 0) {
              warnings.push(
                `${browser.displayName}: ${unreadable} encrypted cookie value${
                  unreadable === 1 ? "" : "s"
                } could not be decrypted.`
              );
            }
            if (expired > 0) {
              warnings.push(
                `${browser.displayName}: ${expired} expired cookie${expired === 1 ? "" : "s"} ignored.`
              );
            }
            if (unsupportedIsolation > 0) {
              warnings.push(
                `${browser.displayName}: ${unsupportedIsolation} cookie${
                  unsupportedIsolation === 1 ? "" : "s"
                } from private, container, opaque, or insecure partitioned source contexts could not be represented in Chromium.`
              );
            }
            if (shadowed > 0) {
              warnings.push(
                `${browser.displayName}: ${shadowed} cookie${
                  shadowed === 1 ? "" : "s"
                } from a lower-priority profile were superseded by a higher-priority profile.`
              );
            }
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
            let nonPersistable = 0;
            for (const value of values) {
              const imported = importedFormFillValue(value);
              if (imported.type !== undefined && !isPersistableFormFillType(imported.type)) {
                nonPersistable += 1;
                continue;
              }
              items.push(imported);
            }
            skipped += nonPersistable;
            if (nonPersistable > 0) {
              warnings.push(
                `${browser.displayName}: ${nonPersistable} transient credential or security-code field${
                  nonPersistable === 1 ? " was" : "s were"
                } not imported into reusable form history.`
              );
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
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
      sourceScheme: cookie.sourceScheme,
      sourcePort: cookie.sourcePort,
    };
  }

  private pageFavicon(icon: {
    url: string;
    data: Buffer;
    mimeType: string;
    sourceUrl?: string;
  }): PageFavicon | null {
    return normalizeFavicon(icon);
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
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Cancelled", "AbortError");
    }
  }
}
