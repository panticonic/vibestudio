/**
 * Panel chrome facts: what a panel's address *is*, how raw address input
 * parses, and how browser history/bookmark/search-engine rows normalize and
 * merge into ranked address candidates.
 *
 * What this module deliberately no longer owns is *omnibox presentation and
 * ranking*. Building the rows a user sees — the address bar's autocomplete
 * items, panel-path completion, the workspace source-tree walk behind it —
 * moved to the Base package `@workspace/omnibox-core`, which is the workspace's
 * single omnibox engine (`about/new`, the quickfire palette, the title bar and
 * the mobile address field all rank through it). Adding a second ranking path
 * here would recreate the divergence P6 removed; extend omnibox-core instead.
 */
import type { Panel, PanelNavigationState, PanelSnapshot } from "./types.js";
import { getCurrentSnapshot, getPanelHistoryState, getPanelRef } from "./panel/accessors.js";
import { tryParsePanelLocationLink, type PanelLocation } from "./panelLocation.js";

export type PanelSourceKind = "panel" | "browser";

export type PanelBuildCoordinate =
  | { kind: "main" }
  | { kind: "context"; contextId: string }
  | { kind: "content"; workspaceStateHash: string };

export interface PanelChromeState {
  panelId: string;
  title: string;
  kind: PanelSourceKind;
  source: string;
  contextId: string;
  displayAddress: string;
  editableAddress: string;
  browserUrl?: string;
  resolvedUrl?: string;
  favicon?: {
    pageUrl: string;
    updatedAt: number;
  };
  ref?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  mediaPlaying: boolean;
}

export interface BrowserAddressSuggestion {
  url: string;
  title?: string;
  visitCount?: number;
  typedCount?: number;
  lastVisit?: number;
  source: "history" | "session" | "bookmark" | "search-engine";
  engineId?: number;
  engineName?: string;
  keyword?: string;
  searchTemplate?: string;
}

export interface BrowserAddressOptions {
  query: string;
  suggestions: BrowserAddressSuggestion[];
}

export type AddressAction =
  | { type: "navigate-url"; url: string; recordAsTyped?: boolean }
  | { type: "panel-location"; location: PanelLocation; raw?: string }
  | { type: "search"; query: string; template: string; recordAsTyped: true }
  | {
      type: "keyword-search";
      engineId: number;
      query: string;
      template: string;
      recordAsTyped: true;
    }
  | { type: "panel-source"; source: string; ref?: string };

export interface TextMatchRange {
  start: number;
  end: number;
}

export interface TextMatchPart {
  text: string;
  highlighted: boolean;
}

export interface BrowserHistoryAddressRow {
  url?: unknown;
  title?: unknown;
  visit_count?: unknown;
  visitCount?: unknown;
  typed_count?: unknown;
  typedCount?: unknown;
  last_visit?: unknown;
  lastVisit?: unknown;
}

export interface BrowserBookmarkAddressRow {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  date_added?: unknown;
  dateAdded?: unknown;
}

export interface SearchEngineAddressRow {
  id?: unknown;
  name?: unknown;
  keyword?: unknown;
  search_url?: unknown;
  searchUrl?: unknown;
  is_default?: unknown;
  isDefault?: unknown;
}

export type AddressInputResult =
  | { type: "browser-url"; url: string }
  | { type: "panel-location"; location: PanelLocation }
  | { type: "panel-source"; source: string }
  | { type: "search"; query: string };

const BROWSER_SOURCE_PREFIX = "browser:";
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const PANEL_SOURCE_RE = /^(?:about|panels|packages|apps|templates|workers|skills|projects)\//;
/** Fallback engine when the browser has no default search engine configured. */
export const DEFAULT_SEARCH_TEMPLATE = "https://www.google.com/search?q=%s";

export type PanelUrlDisposition = "browser-panel" | "managed" | "external" | "refused";

export interface PanelUrlPolicyDecision {
  disposition: PanelUrlDisposition;
  scheme?: string;
  reason?: string;
}

const PANEL_URL_SCHEME_POLICY: Readonly<Record<string, Exclude<PanelUrlDisposition, "managed">>> = {
  "http:": "browser-panel",
  "https:": "browser-panel",
  "data:": "browser-panel",
  "blob:": "browser-panel",
  "file:": "refused",
  "javascript:": "refused",
};

/** Classify an absolute URL at the panel boundary using the shared scheme policy. */
export function classifyPanelUrl(rawUrl: string): PanelUrlPolicyDecision {
  const value = rawUrl.trim();
  if (!value) return { disposition: "refused", reason: "URL is empty" };

  if (tryParsePanelLocationLink(value) || /^vibestudio:/i.test(value)) {
    return { disposition: "managed", scheme: "vibestudio:" };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { disposition: "refused", reason: "URL must be absolute" };
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme === "about:") {
    return /^about:blank(?:[?#].*)?$/i.test(value)
      ? { disposition: "browser-panel", scheme }
      : {
          disposition: "refused",
          scheme,
          reason: "Only about:blank may be opened in a browser panel",
        };
  }

  const disposition = PANEL_URL_SCHEME_POLICY[scheme] ?? "external";
  if (disposition !== "refused") return { disposition, scheme };
  return {
    disposition,
    scheme,
    reason:
      scheme === "file:"
        ? "Local file URLs are not available to panels"
        : "JavaScript URLs are not allowed",
  };
}

export function isBrowserPanelSource(source: string): boolean {
  return source.startsWith(BROWSER_SOURCE_PREFIX);
}

export function isOpenPanelBrowserUrl(source: string): boolean {
  return classifyPanelUrl(source).disposition === "browser-panel";
}

export function browserUrlFromPanelSource(source: string): string | null {
  return isBrowserPanelSource(source) ? source.slice(BROWSER_SOURCE_PREFIX.length) : null;
}

export function panelSourceFromBrowserUrl(url: string): string {
  return `${BROWSER_SOURCE_PREFIX}${url}`;
}

export function getPanelSourceKind(source: string): PanelSourceKind {
  return isBrowserPanelSource(source) ? "browser" : "panel";
}

export function getPanelDisplayAddress(
  panel: Pick<Panel, "id" | "snapshot">,
  navigation?: PanelNavigationState
): string {
  const snapshot = getCurrentSnapshot(panel);
  const source = snapshot.source;
  const browserUrl = browserUrlFromPanelSource(source);
  if (browserUrl) return navigation?.url || snapshot.resolvedUrl || browserUrl;
  return source;
}

export function getPanelEditableAddress(
  panel: Pick<Panel, "id" | "snapshot">,
  navigation?: PanelNavigationState
): string {
  return getPanelDisplayAddress(panel, navigation);
}

export function parseAddressInput(input: string): AddressInputResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const location = tryParsePanelLocationLink(trimmed);
  if (location) return { type: "panel-location", location };

  if (PANEL_SOURCE_RE.test(trimmed) && !/\s/.test(trimmed)) {
    return { type: "panel-source", source: trimmed.replace(/^\/+/, "").replace(/\/+$/, "") };
  }

  if (SCHEME_RE.test(trimmed)) {
    if (classifyPanelUrl(trimmed).disposition === "browser-panel") {
      return { type: "browser-url", url: trimmed };
    }
    return { type: "search", query: trimmed };
  }

  if (!/\s/.test(trimmed) && looksLikeHostname(trimmed)) {
    return { type: "browser-url", url: `https://${trimmed}` };
  }

  return { type: "search", query: trimmed };
}

export function parsePanelBuildCoordinate(ref?: string): PanelBuildCoordinate {
  const value = ref?.trim();
  if (!value || value === "main") return { kind: "main" };
  if (/^ctx:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    return { kind: "context", contextId: value.slice(4) };
  }
  if (/^state:[0-9a-f]{64}$/.test(value)) {
    return { kind: "content", workspaceStateHash: value };
  }
  throw new Error(`Unsupported panel build coordinate: ${JSON.stringify(ref)}`);
}

function compactIdentity(value: string, prefix: string): string {
  const body = value.startsWith(`${prefix}:`) ? value.slice(prefix.length + 1) : value;
  return body.length > 10 ? `${body.slice(0, 10)}…` : body;
}

export function formatPanelBuildCoordinate(coordinate: PanelBuildCoordinate): string {
  switch (coordinate.kind) {
    case "main":
      return "main";
    case "context":
      return `context ${coordinate.contextId}`;
    case "content":
      return `content state ${compactIdentity(coordinate.workspaceStateHash, "state")}`;
  }
}

export function normalizeBrowserAddressSuggestions(
  rows: BrowserHistoryAddressRow[],
  source: BrowserAddressSuggestion["source"] = "history"
): BrowserAddressSuggestion[] {
  const seen = new Set<string>();
  const suggestions: BrowserAddressSuggestion[] = [];
  for (const row of rows) {
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof row.title === "string" ? row.title.trim() : "";
    suggestions.push({
      url,
      title: title || undefined,
      visitCount: readOptionalNumber(row.visitCount ?? row.visit_count),
      typedCount: readOptionalNumber(row.typedCount ?? row.typed_count),
      lastVisit: readOptionalNumber(row.lastVisit ?? row.last_visit),
      source,
    });
  }
  return suggestions;
}

export function normalizeBookmarkAddressSuggestions(
  rows: BrowserBookmarkAddressRow[]
): BrowserAddressSuggestion[] {
  const seen = new Set<string>();
  const suggestions: BrowserAddressSuggestion[] = [];
  for (const row of rows) {
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof row.title === "string" ? row.title.trim() : "";
    suggestions.push({
      url,
      title: title || undefined,
      lastVisit: readOptionalNumber(row.dateAdded ?? row.date_added),
      source: "bookmark",
    });
  }
  return suggestions;
}

export function normalizeSearchEngineAddressSuggestions(
  rows: SearchEngineAddressRow[]
): BrowserAddressSuggestion[] {
  const suggestions: BrowserAddressSuggestion[] = [];
  for (const row of rows) {
    const searchTemplate =
      typeof (row.searchUrl ?? row.search_url) === "string"
        ? String(row.searchUrl ?? row.search_url).trim()
        : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!searchTemplate || !name) continue;
    suggestions.push({
      url: searchTemplate,
      title: name,
      source: "search-engine",
      engineId: typeof row.id === "number" ? row.id : undefined,
      engineName: name,
      keyword: typeof row.keyword === "string" ? row.keyword.trim() || undefined : undefined,
      searchTemplate,
      typedCount: Number(row.isDefault ?? row.is_default) === 1 ? 1 : 0,
    });
  }
  return suggestions;
}

export function collectBrowserAddressSuggestionsFromPanels(
  panels: Panel[]
): BrowserAddressSuggestion[] {
  const rows: BrowserHistoryAddressRow[] = [];
  const visit = (panel: Panel) => {
    const snapshot = getCurrentSnapshot(panel);
    const url = browserUrlFromPanelSource(snapshot.source);
    if (url) {
      rows.push({
        url: panel.navigation?.url ?? snapshot.resolvedUrl ?? url,
        title: panel.navigation?.pageTitle ?? panel.title,
      });
    }
    for (const child of panel.children) visit(child);
  };
  for (const panel of panels) visit(panel);
  return normalizeBrowserAddressSuggestions(rows, "session");
}

export function mergeBrowserAddressSuggestions(
  groups: BrowserAddressSuggestion[][],
  query = "",
  limit = 50
): BrowserAddressSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  const byUrl = new Map<string, BrowserAddressSuggestion>();
  for (const group of groups) {
    for (const item of group) {
      if (item.source === "search-engine") {
        const key = `search-engine:${item.engineId ?? item.keyword ?? item.searchTemplate}`;
        if (!byUrl.has(key)) byUrl.set(key, item);
        continue;
      }
      if (!matchesBrowserAddressSuggestion(item, normalizedQuery)) continue;
      const key = canonicalizeUrlForAddress(item.url) ?? item.url;
      const existing = byUrl.get(key);
      if (
        !existing ||
        scoreBrowserAddressSuggestion(item) > scoreBrowserAddressSuggestion(existing)
      ) {
        byUrl.set(key, item);
      }
    }
  }
  return [...byUrl.values()]
    .sort(
      (a, b) =>
        scoreBrowserAddressSuggestion(b, normalizedQuery) -
        scoreBrowserAddressSuggestion(a, normalizedQuery)
    )
    .slice(0, limit);
}

function getRefDisplay(ref?: string): string | undefined {
  const value = ref?.trim();
  return value ? formatPanelBuildCoordinate(parsePanelBuildCoordinate(value)) : undefined;
}

export function buildPanelChromeState(args: {
  panel: Panel;
  navigation?: PanelNavigationState;
}): PanelChromeState {
  const navigation = args.navigation ?? args.panel.navigation ?? {};
  const snapshot: PanelSnapshot = getCurrentSnapshot(args.panel);
  const source = snapshot.source;
  const browserUrl = browserUrlFromPanelSource(source) ?? undefined;
  const kind = getPanelSourceKind(source);
  const displayAddress = getPanelDisplayAddress(args.panel, navigation);
  const history = getPanelHistoryState(args.panel);
  const ref = getPanelRef(args.panel)?.trim() || undefined;
  const refDisplay = getRefDisplay(ref);

  return {
    panelId: args.panel.id,
    title: navigation.pageTitle || args.panel.title,
    kind,
    source,
    contextId: snapshot.contextId,
    displayAddress:
      refDisplay && kind === "panel" ? `${displayAddress} @ ${refDisplay}` : displayAddress,
    editableAddress: getPanelEditableAddress(args.panel, navigation),
    browserUrl,
    resolvedUrl: navigation.url ?? snapshot.resolvedUrl ?? browserUrl,
    favicon: navigation.favicon,
    ref,
    isLoading: Boolean(navigation.isLoading),
    canGoBack: Boolean(navigation.canGoBack || history.canGoBack),
    canGoForward: Boolean(navigation.canGoForward || history.canGoForward),
    mediaPlaying: Boolean(navigation.mediaPlaying),
  };
}

export interface AddressProviderBrowserDataAdapter {
  searchHistoryForAutocomplete(query: string, limit: number): Promise<BrowserHistoryAddressRow[]>;
  getHistory(query: { limit: number }): Promise<BrowserHistoryAddressRow[]>;
  searchBookmarks(query: string): Promise<BrowserBookmarkAddressRow[]>;
  getSearchEngines(): Promise<SearchEngineAddressRow[]>;
}

export async function getSharedBrowserAddressOptions(args: {
  query: string;
  panels?: Panel[];
  sessionRows?: BrowserHistoryAddressRow[];
  browserData?: AddressProviderBrowserDataAdapter | null;
}): Promise<BrowserAddressOptions> {
  const sessionSuggestions = args.sessionRows
    ? normalizeBrowserAddressSuggestions(args.sessionRows, "session")
    : collectBrowserAddressSuggestionsFromPanels(args.panels ?? []);
  const browserData = args.browserData;
  if (!browserData) {
    return {
      query: args.query,
      suggestions: mergeBrowserAddressSuggestions([sessionSuggestions], args.query, 25),
    };
  }

  try {
    const trimmed = args.query.trim();
    const [historyRows, bookmarkRows, searchEngineRows] = await Promise.all([
      trimmed
        ? browserData.searchHistoryForAutocomplete(trimmed, 50)
        : browserData.getHistory({ limit: 50 }),
      trimmed ? browserData.searchBookmarks(trimmed) : Promise.resolve([]),
      browserData.getSearchEngines(),
    ]);
    return {
      query: args.query,
      suggestions: mergeBrowserAddressSuggestions(
        [
          sessionSuggestions,
          normalizeBrowserAddressSuggestions(historyRows),
          normalizeBookmarkAddressSuggestions(bookmarkRows),
          normalizeSearchEngineAddressSuggestions(searchEngineRows),
        ],
        args.query,
        50
      ),
    };
  } catch {
    return {
      query: args.query,
      suggestions: mergeBrowserAddressSuggestions([sessionSuggestions], args.query, 25),
    };
  }
}

function looksLikeHostname(value: string): boolean {
  if (value.includes("/")) {
    const [host] = value.split("/");
    return Boolean(host && looksLikeHostname(host));
  }
  if (value === "localhost") return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(value)) return true;
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i.test(value);
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function matchesBrowserAddressSuggestion(
  item: BrowserAddressSuggestion,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return true;
  return (
    item.url.toLowerCase().includes(normalizedQuery) ||
    Boolean(item.title?.toLowerCase().includes(normalizedQuery)) ||
    Boolean(item.keyword?.toLowerCase() === normalizedQuery.split(/\s+/, 1)[0])
  );
}

function scoreBrowserAddressSuggestion(
  item: BrowserAddressSuggestion,
  normalizedQuery = ""
): number {
  const haystacks = [item.url, item.title ?? ""].map((value) => value.toLowerCase());
  const exactBoost =
    normalizedQuery && haystacks.some((value) => value === normalizedQuery)
      ? 500_000_000_000_000
      : 0;
  const prefixBoost =
    normalizedQuery && haystacks.some((value) => value.startsWith(normalizedQuery))
      ? 100_000_000_000_000
      : 0;
  const substringBoost =
    normalizedQuery && haystacks.some((value) => value.includes(normalizedQuery))
      ? 10_000_000_000_000
      : 0;
  const sourceBoost =
    item.source === "session"
      ? 1_000_000_000_000
      : item.source === "bookmark"
        ? 500_000_000_000
        : item.source === "history"
          ? 100_000_000_000
          : 0;
  const typedBoost = (item.typedCount ?? 0) * 10_000_000_000;
  const visitBoost = (item.visitCount ?? 0) * 1_000_000;
  return (
    exactBoost +
    prefixBoost +
    substringBoost +
    sourceBoost +
    typedBoost +
    visitBoost +
    (item.lastVisit ?? 0)
  );
}

export function canonicalizeUrlForAddress(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    if (parsed.pathname === "/") parsed.pathname = "/";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function splitTextByMatchRanges(text: string, ranges?: TextMatchRange[]): TextMatchPart[] {
  if (!ranges?.length) return text ? [{ text, highlighted: false }] : [];
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, range.start)),
      end: Math.max(0, Math.min(text.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const parts: TextMatchPart[] = [];
  let cursor = 0;
  for (const range of normalized) {
    if (range.start < cursor) continue;
    if (range.start > cursor)
      parts.push({ text: text.slice(cursor, range.start), highlighted: false });
    parts.push({ text: text.slice(range.start, range.end), highlighted: true });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts;
}
