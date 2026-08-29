import type {
  ImportedBookmark,
  ImportedHistoryEntry,
  ImportedPassword,
} from "@vibestudio/browser-data";

export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

export type ArchiveImportDataType = "bookmarks" | "history" | "passwords";

export interface ArchiveImportLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxJsonRows: number;
  maxCsvRows: number;
  maxBookmarkNodes: number;
  maxFolderDepth: number;
}

export const DEFAULT_ARCHIVE_IMPORT_LIMITS: Readonly<ArchiveImportLimits> = Object.freeze({
  maxEntries: 1_024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxJsonRows: 500_000,
  maxCsvRows: 500_000,
  maxBookmarkNodes: 500_000,
  maxFolderDepth: 64,
});

export type ArchiveImportErrorCode =
  | "unsafe_entry_name"
  | "duplicate_entry"
  | "entry_limit_exceeded"
  | "entry_size_exceeded"
  | "total_size_exceeded"
  | "invalid_text_encoding"
  | "invalid_json"
  | "unsupported_json_schema"
  | "invalid_csv"
  | "row_limit_exceeded"
  | "bookmark_limit_exceeded"
  | "folder_depth_exceeded";

export interface ArchiveImportError {
  code: ArchiveImportErrorCode;
  entryIndex?: number;
  message: string;
}

export interface ArchiveImportWarning {
  code: "unsupported_entry" | "invalid_record" | "unsupported_url";
  entryIndex?: number;
  count: number;
  message: string;
}

export interface ArchiveImportResult {
  bookmarks: ImportedBookmark[];
  history: ImportedHistoryEntry[];
  passwords: ImportedPassword[];
  supportedDataTypes: ArchiveImportDataType[];
  datasetCount: number;
  profileCount: number;
  warnings: ArchiveImportWarning[];
  errors: ArchiveImportError[];
}

export type RecognizedBrowserExport = "safari" | "chrome" | "generic" | "unknown";

export interface BrowserExportInspection {
  browser: RecognizedBrowserExport;
  displayName: string;
  localDataSetCount: number;
  profileCount: number;
  supportedDataTypes: ArchiveImportDataType[];
  warnings: ArchiveImportWarning[];
  errors: ArchiveImportError[];
}

export interface ParsedBrowserExport extends BrowserExportInspection {
  items: {
    bookmarks: ImportedBookmark[];
    history: ImportedHistoryEntry[];
    passwords: ImportedPassword[];
  };
}

type MutableResult = ArchiveImportResult & { profiles: Set<string> };
type JsonObject = Record<string, unknown>;

const ERROR_MESSAGES: Record<ArchiveImportErrorCode, string> = {
  unsafe_entry_name: "The archive contains an unsafe entry name.",
  duplicate_entry: "The archive contains duplicate entry names.",
  entry_limit_exceeded: "The archive contains too many entries.",
  entry_size_exceeded: "An archive entry exceeds the size limit.",
  total_size_exceeded: "The archive exceeds the total size limit.",
  invalid_text_encoding: "An archive entry is not valid UTF-8 text.",
  invalid_json: "An archive entry contains invalid JSON.",
  unsupported_json_schema: "A JSON entry uses an unsupported schema.",
  invalid_csv: "A CSV entry is malformed.",
  row_limit_exceeded: "An archive entry contains too many records.",
  bookmark_limit_exceeded: "An archive entry contains too many bookmark nodes.",
  folder_depth_exceeded: "A bookmark hierarchy exceeds the depth limit.",
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const probeDecoder = new TextDecoder("utf-8");

export function parseBrowserImportArchive(
  entries: readonly ArchiveEntry[],
  limitOverrides: Partial<ArchiveImportLimits> = {},
  selectedDataTypes: readonly ArchiveImportDataType[] = ["bookmarks", "history", "passwords"]
): ArchiveImportResult {
  const limits = { ...DEFAULT_ARCHIVE_IMPORT_LIMITS, ...limitOverrides };
  const result: MutableResult = {
    bookmarks: [],
    history: [],
    passwords: [],
    supportedDataTypes: [],
    datasetCount: 0,
    profileCount: 0,
    warnings: [],
    errors: [],
    profiles: new Set<string>(),
  };

  if (entries.length > limits.maxEntries) {
    result.errors.push(error("entry_limit_exceeded"));
    return finalize(result);
  }

  const names = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const canonicalName = canonicalEntryName(entry.name);
    if (canonicalName === undefined) {
      result.errors.push(error("unsafe_entry_name", index));
      continue;
    }
    if (names.has(canonicalName)) {
      result.errors.push(error("duplicate_entry", index));
      continue;
    }
    names.add(canonicalName);
    if (entry.bytes.byteLength > limits.maxEntryBytes) {
      result.errors.push(error("entry_size_exceeded", index));
      continue;
    }
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      result.errors.push(error("total_size_exceeded", index));
      break;
    }
    parseEntry(entry.bytes, canonicalName, index, limits, result, selectedDataTypes);
  }
  return finalize(result);
}

/** Inspect formats and counts without retaining any imported record values. */
export function inspectBrowserExport(
  entries: readonly ArchiveEntry[],
  limits: Partial<ArchiveImportLimits> = {}
): BrowserExportInspection {
  const resolved = { ...DEFAULT_ARCHIVE_IMPORT_LIMITS, ...limits };
  const supportedDataTypes: ArchiveImportDataType[] = [];
  const warnings: ArchiveImportWarning[] = [];
  const errors: ArchiveImportError[] = [];
  const profiles = new Set<string>();
  const canonicalNames = new Set<string>();
  let localDataSetCount = 0;
  let totalBytes = 0;
  if (entries.length > resolved.maxEntries) errors.push(error("entry_limit_exceeded"));
  else {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const name = canonicalEntryName(entry.name);
      if (!name) {
        errors.push(error("unsafe_entry_name", index));
        continue;
      }
      if (canonicalNames.has(name)) {
        errors.push(error("duplicate_entry", index));
        continue;
      }
      canonicalNames.add(name);
      if (entry.bytes.byteLength > resolved.maxEntryBytes) {
        errors.push(error("entry_size_exceeded", index));
        continue;
      }
      totalBytes += entry.bytes.byteLength;
      if (totalBytes > resolved.maxTotalBytes) {
        errors.push(error("total_size_exceeded", index));
        break;
      }
      const firstLine = decodeFirstLineProbe(entry.bytes);
      const text = decodeProbe(entry.bytes)
        .replace(/^\uFEFF/, "")
        .trimStart();
      let type: ArchiveImportDataType | undefined;
      if (looksLikeNetscapeBookmarks(text)) type = "bookmarks";
      else if (looksLikeCsv(firstLine)) type = "passwords";
      else if (text.startsWith("{") || text.startsWith("[")) {
        // Recognition examines structural key names only. Record fields and values are not retained.
        const structuralHead = text.slice(0, 64 * 1024);
        if (/"roots"\s*:|"type"\s*:\s*"folder"/.test(structuralHead)) type = "bookmarks";
        else if (
          /"(?:Browser History|Safari History|history|items|visits)"\s*:/.test(structuralHead) ||
          (/^\s*\[/.test(structuralHead) &&
            /"(?:time_usec|lastVisitTime|last_visited|visitTime)"\s*:/.test(structuralHead))
        ) {
          type = "history";
          profiles.add(profileKey(name));
        }
      }
      if (type) {
        localDataSetCount += 1;
        if (!supportedDataTypes.includes(type)) supportedDataTypes.push(type);
        profiles.add(profileKey(name));
      } else {
        warnings.push({
          code: "unsupported_entry",
          entryIndex: index,
          count: 1,
          message: "An archive entry has an unsupported format.",
        });
      }
    }
  }
  const identity = identifyExport(entries, supportedDataTypes);
  return {
    ...identity,
    localDataSetCount,
    profileCount: profiles.size || (localDataSetCount > 0 ? 1 : 0),
    supportedDataTypes,
    warnings,
    errors,
  };
}

/** Parse only explicitly selected categories; unselected sensitive rows are never decoded into records. */
export function parseSelectedBrowserExport(
  entries: readonly ArchiveEntry[],
  selectedDataTypes: readonly ArchiveImportDataType[],
  limits: Partial<ArchiveImportLimits> = {}
): ParsedBrowserExport {
  const inspection = inspectBrowserExport(entries, limits);
  const parsed = parseBrowserImportArchive(entries, limits, selectedDataTypes);
  return {
    browser: inspection.browser,
    displayName: inspection.displayName,
    localDataSetCount: inspection.localDataSetCount,
    profileCount: inspection.profileCount,
    supportedDataTypes: inspection.supportedDataTypes,
    warnings: parsed.warnings,
    errors: parsed.errors,
    items: {
      bookmarks: parsed.bookmarks,
      history: parsed.history,
      passwords: parsed.passwords,
    },
  };
}

/** Convenience API for trusted consumers that intentionally select every supported category. */
export function recognizeBrowserExport(
  entries: readonly ArchiveEntry[],
  limits: Partial<ArchiveImportLimits> = {}
): ParsedBrowserExport {
  return parseSelectedBrowserExport(entries, ["bookmarks", "history", "passwords"], limits);
}

function parseEntry(
  bytes: Uint8Array,
  name: string,
  index: number,
  limits: ArchiveImportLimits,
  result: MutableResult,
  selectedDataTypes: readonly ArchiveImportDataType[]
): void {
  // Detect credentials from the header before decoding the entry. A public-only
  // import therefore never materializes unselected credential rows as strings.
  const firstLine = decodeFirstLineProbe(bytes);
  if (looksLikeCsv(firstLine) && !selectedDataTypes.includes("passwords")) return;
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    result.errors.push(error("invalid_text_encoding", index));
    return;
  }
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (looksLikeNetscapeBookmarks(trimmed)) {
    if (!selectedDataTypes.includes("bookmarks")) return;
    const parsed = parseNetscapeBookmarks(trimmed, limits, index, result);
    if (parsed !== undefined) {
      addDataset(result, "bookmarks", parsed);
      result.profiles.add(profileKey(name));
    }
    return;
  }
  if (looksLikeCsv(trimmed)) {
    if (!selectedDataTypes.includes("passwords")) return;
    const parsed = parsePasswordCsv(trimmed, limits, index, result);
    if (parsed !== undefined) {
      addDataset(result, "passwords", parsed);
      result.profiles.add(profileKey(name));
    }
    return;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    parseJsonEntry(trimmed, name, index, limits, result, selectedDataTypes);
    return;
  }
  addWarning(result, "unsupported_entry", index, 1);
}

function decodeFirstLineProbe(bytes: Uint8Array): string {
  const cap = Math.min(bytes.byteLength, 16 * 1024);
  let end = cap;
  for (let index = 0; index < cap; index += 1) {
    const byte = bytes[index];
    if (byte === 10 || byte === 13) {
      end = index;
      break;
    }
  }
  return probeDecoder.decode(bytes.subarray(0, end));
}

function decodeProbe(bytes: Uint8Array): string {
  return probeDecoder.decode(bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1024)));
}

function parseJsonEntry(
  text: string,
  name: string,
  index: number,
  limits: ArchiveImportLimits,
  result: MutableResult,
  selectedDataTypes: readonly ArchiveImportDataType[]
): void {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    result.errors.push(error("invalid_json", index));
    return;
  }

  const bookmarkRoot = chromeBookmarkRoot(value);
  if (bookmarkRoot !== undefined) {
    if (!selectedDataTypes.includes("bookmarks")) return;
    const before = result.bookmarks.length;
    if (!walkChromeBookmarks(bookmarkRoot, [], result, limits, index)) return;
    addDataset(result, "bookmarks", result.bookmarks.length - before);
    return;
  }

  const rows = historyRows(value);
  if (rows !== undefined) {
    if (!selectedDataTypes.includes("history")) return;
    if (rows.length > limits.maxJsonRows) {
      result.errors.push(error("row_limit_exceeded", index));
      return;
    }
    const before = result.history.length;
    let invalid = 0;
    for (const row of rows) {
      const record = parseHistoryRecord(row);
      if (record) result.history.push(record);
      else invalid += 1;
    }
    if (invalid > 0) addWarning(result, "invalid_record", index, invalid);
    addDataset(result, "history", result.history.length - before);
    result.profiles.add(profileKey(name));
    return;
  }
  result.errors.push(error("unsupported_json_schema", index));
}

function identifyExport(
  entries: readonly ArchiveEntry[],
  supportedDataTypes: readonly ArchiveImportDataType[]
): Pick<BrowserExportInspection, "browser" | "displayName"> {
  const names = entries.map((entry) => entry.name.toLocaleLowerCase("en-US"));
  const safari = names.some(
    (name) =>
      name.startsWith("safari/") || name.includes("/safari/") || name.includes("readinglist")
  );
  if (safari) return { browser: "safari", displayName: "Safari export" };
  const chrome = names.some(
    (name) =>
      name.includes("takeout/") ||
      name.includes("chrome/") ||
      name.endsWith("bookmarks.json") ||
      name.includes("browserhistory")
  );
  if (chrome) return { browser: "chrome", displayName: "Google Chrome export" };
  if (supportedDataTypes.length > 0) return { browser: "generic", displayName: "Browser export" };
  return { browser: "unknown", displayName: "Unknown browser export" };
}

function looksLikeNetscapeBookmarks(text: string): boolean {
  const head = text.slice(0, 4_096).toLowerCase();
  return (
    head.includes("netscape-bookmark-file-1") ||
    (head.includes("<dl") && head.includes("<a ") && head.includes("href="))
  );
}

function parseNetscapeBookmarks(
  html: string,
  limits: ArchiveImportLimits,
  index: number,
  result: MutableResult
): number | undefined {
  const tokens =
    html.match(/<\/?DL\b[^>]*>|<H3\b[^>]*>[\s\S]*?<\/H3\s*>|<A\b[^>]*>[\s\S]*?<\/A\s*>/gi) ?? [];
  const folders: string[] = [];
  let pendingFolder: string | undefined;
  let count = 0;
  for (const token of tokens) {
    if (/^<H3\b/i.test(token)) {
      pendingFolder = decodeHtml(stripTags(token));
      continue;
    }
    if (/^<DL\b/i.test(token)) {
      if (pendingFolder) {
        folders.push(pendingFolder);
        pendingFolder = undefined;
        if (folders.length > limits.maxFolderDepth) {
          result.errors.push(error("folder_depth_exceeded", index));
          return undefined;
        }
      }
      continue;
    }
    if (/^<\/DL/i.test(token)) {
      folders.pop();
      pendingFolder = undefined;
      continue;
    }
    const openTag = token.match(/^<A\b([^>]*)>/i);
    if (!openTag) continue;
    count += 1;
    if (count > limits.maxBookmarkNodes) {
      result.errors.push(error("bookmark_limit_exceeded", index));
      return undefined;
    }
    const attributes = parseHtmlAttributes(openTag[1] ?? "");
    const url = attributes.get("href");
    if (!url || !isSupportedUrl(url)) {
      addWarning(result, "unsupported_url", index, 1);
      continue;
    }
    const seconds = finiteNumber(attributes.get("add_date"));
    result.bookmarks.push({
      title: decodeHtml(stripTags(token)),
      url,
      dateAdded: seconds === undefined ? 0 : seconds * 1_000,
      folder: [...folders],
    });
  }
  return result.bookmarks.length;
}

function parseHtmlAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const expression = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of source.matchAll(expression)) {
    const key = match[1];
    if (key) attributes.set(key.toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

function looksLikeCsv(text: string): boolean {
  const firstLine = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
  const normalized = firstLine.toLowerCase();
  return (
    normalized.includes("password") && normalized.includes("username") && normalized.includes("url")
  );
}

function parsePasswordCsv(
  text: string,
  limits: ArchiveImportLimits,
  index: number,
  result: MutableResult
): number | undefined {
  const rows = parseCsv(text, limits.maxCsvRows + 1);
  if (rows === undefined) {
    result.errors.push(error("invalid_csv", index));
    return undefined;
  }
  if (rows.length - 1 > limits.maxCsvRows) {
    result.errors.push(error("row_limit_exceeded", index));
    return undefined;
  }
  const header = rows[0]?.map(normalizeHeader);
  if (!header) return undefined;
  const urlIndex = findHeader(header, ["url", "website", "origin"]);
  const usernameIndex = findHeader(header, ["username", "user name"]);
  const passwordIndex = findHeader(header, ["password"]);
  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) {
    result.errors.push(error("invalid_csv", index));
    return undefined;
  }
  let invalid = 0;
  const before = result.passwords.length;
  for (const row of rows.slice(1)) {
    if (row.every((cell) => cell.length === 0)) continue;
    const url = row[urlIndex] ?? "";
    const username = row[usernameIndex] ?? "";
    const password = row[passwordIndex] ?? "";
    if (!isSupportedUrl(url) || password.length === 0) {
      invalid += 1;
      continue;
    }
    result.passwords.push({ url, username, password });
  }
  if (invalid > 0) addWarning(result, "invalid_record", index, invalid);
  return result.passwords.length - before;
}

function parseCsv(source: string, stopAfterRows: number): string[][] | undefined {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let offset = 0; offset < source.length; offset += 1) {
    const character = source[offset];
    if (quoted) {
      if (character === '"' && source[offset + 1] === '"') {
        cell += '"';
        offset += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"' && cell.length === 0) quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[offset + 1] === "\n") offset += 1;
      row.push(cell);
      rows.push(row);
      if (rows.length > stopAfterRows) return rows;
      row = [];
      cell = "";
    } else cell += character;
  }
  if (quoted) return undefined;
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function chromeBookmarkRoot(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  if (isObject(value["roots"])) return value["roots"];
  if (value["type"] === "folder" && Array.isArray(value["children"])) return value;
  return undefined;
}

function walkChromeBookmarks(
  node: unknown,
  folders: string[],
  result: MutableResult,
  limits: ArchiveImportLimits,
  index: number,
  counter = { value: 0 }
): boolean {
  if (!isObject(node)) return true;
  counter.value += 1;
  if (counter.value > limits.maxBookmarkNodes) {
    result.errors.push(error("bookmark_limit_exceeded", index));
    return false;
  }
  if (folders.length > limits.maxFolderDepth) {
    result.errors.push(error("folder_depth_exceeded", index));
    return false;
  }
  if (node["type"] === "url") {
    const url = stringValue(node["url"]);
    if (!url || !isSupportedUrl(url)) {
      addWarning(result, "unsupported_url", index, 1);
      return true;
    }
    result.bookmarks.push({
      title: stringValue(node["name"]) ?? "",
      url,
      dateAdded: chromeTime(node["date_added"]) ?? 0,
      folder: folders,
    });
    return true;
  }
  const children = node["children"];
  if (Array.isArray(children)) {
    const name = stringValue(node["name"]);
    const nextFolders = name ? [...folders, name] : folders;
    for (const child of children) {
      if (!walkChromeBookmarks(child, nextFolders, result, limits, index, counter)) return false;
    }
    return true;
  }
  // Chrome's `roots` object is a named collection of root folder nodes.
  for (const child of Object.values(node)) {
    if (isObject(child) && !walkChromeBookmarks(child, folders, result, limits, index, counter)) {
      return false;
    }
  }
  return true;
}

function historyRows(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return undefined;
  for (const key of ["Browser History", "Safari History", "history", "items", "visits"]) {
    const rows = value[key];
    if (Array.isArray(rows)) return rows;
  }
  return undefined;
}

function parseHistoryRecord(value: unknown): ImportedHistoryEntry | undefined {
  if (!isObject(value)) return undefined;
  const url = stringValue(value["url"] ?? value["URL"]);
  if (!url || !isSupportedUrl(url)) return undefined;
  const time = historyTime(
    value["time_usec"] ??
      value["lastVisitTime"] ??
      value["last_visited"] ??
      value["visitTime"] ??
      value["date"]
  );
  if (time === undefined) return undefined;
  return {
    url,
    title: stringValue(value["title"] ?? value["Title"] ?? value["displayTitle"]) ?? "",
    visitCount: finiteNumber(value["visitCount"] ?? value["visit_count"]) ?? 1,
    lastVisitTime: time,
  };
}

function canonicalEntryName(name: string): string | undefined {
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name)
  ) {
    return undefined;
  }
  const pieces = name.normalize("NFC").split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) return undefined;
  return pieces.join("/").toLocaleLowerCase("en-US");
}

function profileKey(name: string): string {
  const parts = name.split("/");
  const profileIndex = parts.findIndex((part) => part === "profiles" || part === "profile");
  return profileIndex >= 0 && parts[profileIndex + 1]
    ? parts.slice(0, profileIndex + 2).join("/")
    : "default";
}

function addDataset(result: MutableResult, type: ArchiveImportDataType, count: number): void {
  result.datasetCount += 1;
  if (count > 0 && !result.supportedDataTypes.includes(type)) result.supportedDataTypes.push(type);
}

function finalize(result: MutableResult): ArchiveImportResult {
  result.profileCount = result.profiles.size || (result.datasetCount > 0 ? 1 : 0);
  const { profiles: _profiles, ...publicResult } = result;
  return publicResult;
}

function error(code: ArchiveImportErrorCode, entryIndex?: number): ArchiveImportError {
  return {
    code,
    ...(entryIndex === undefined ? {} : { entryIndex }),
    message: ERROR_MESSAGES[code],
  };
}

function addWarning(
  result: MutableResult,
  code: ArchiveImportWarning["code"],
  entryIndex: number,
  count: number
): void {
  const existing = result.warnings.find(
    (warning) => warning.code === code && warning.entryIndex === entryIndex
  );
  if (existing) existing.count += count;
  else {
    const messages: Record<ArchiveImportWarning["code"], string> = {
      unsupported_entry: "An archive entry has an unsupported format.",
      invalid_record: "Some records were skipped because they were invalid.",
      unsupported_url: "Some records were skipped because their URL scheme is unsupported.",
    };
    result.warnings.push({ code, entryIndex, count, message: messages[code] });
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function historyTime(value: unknown): number | undefined {
  if (typeof value === "string" && !/^\s*[+-]?[\d.]+\s*$/.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  const number = finiteNumber(value);
  if (number === undefined) return undefined;
  if (number > 10_000_000_000_000) return Math.floor(number / 1_000); // microseconds since Unix epoch
  if (number > 10_000_000_000) return number; // milliseconds since Unix epoch
  return number * 1_000; // seconds since Unix epoch
}

function chromeTime(value: unknown): number | undefined {
  const microseconds = finiteNumber(value);
  if (microseconds === undefined) return undefined;
  const milliseconds = microseconds / 1_000 - 11_644_473_600_000;
  return milliseconds >= 0 ? Math.floor(milliseconds) : undefined;
}

function isSupportedUrl(value: string): boolean {
  try {
    return ["http:", "https:", "ftp:", "file:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();
}

function findHeader(header: readonly string[], alternatives: readonly string[]): number {
  return header.findIndex((value) => alternatives.includes(value));
}

function stripTags(value: string): string {
  return value
    .replace(/^<[^>]+>/, "")
    .replace(/<\/[^>]+>\s*$/, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
    nbsp: "\u00a0",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X"))
      return safeCodePoint(Number.parseInt(body.slice(2), 16), entity);
    if (body.startsWith("#")) return safeCodePoint(Number.parseInt(body.slice(1), 10), entity);
    return named[body.toLowerCase()] ?? entity;
  });
}

function safeCodePoint(value: number, fallback: string): string {
  try {
    return Number.isInteger(value) ? String.fromCodePoint(value) : fallback;
  } catch {
    return fallback;
  }
}
