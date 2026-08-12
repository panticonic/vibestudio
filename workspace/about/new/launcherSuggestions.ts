import type { BrowserAddressSuggestion } from "@vibestudio/shared/panelChrome";
import type { LaunchablePanel } from "./launchablePanels";

export type LauncherMode = "all" | "panels" | "history" | "chat";

export interface LauncherInput {
  mode: LauncherMode;
  prefix: "" | ">" | "@" | "/";
  query: string;
}

export interface PanelUsageEntry {
  count: number;
  lastUsed: number;
}

export type PanelUsage = Record<string, PanelUsageEntry>;

export type LauncherSuggestion =
  | { id: string; kind: "panel"; panel: LaunchablePanel; score: number }
  | { id: string; kind: "history"; browser: BrowserAddressSuggestion; score: number }
  | { id: string; kind: "url"; url: string; score: number }
  | { id: string; kind: "chat"; prompt: string; score: number };

const MATCH_EXACT = 3_000_000_000_000;
const MATCH_PREFIX = 2_000_000_000_000;
const MATCH_SUBSTRING = 1_000_000_000_000;
const PROMPT_PRIORITY = 2_250_000_000_000;
const URL_PRIORITY = 4_000_000_000_000;
const DEFAULT_LAUNCHER_SUGGESTION_LIMIT = 20;
const IDLE_PANEL_SUGGESTION_FLOOR = 4;

export function parseLauncherInput(input: string): LauncherInput {
  const first = input[0];
  const prefix = first === ">" || first === "@" || first === "/" ? first : "";
  const mode: LauncherMode =
    prefix === ">" ? "panels" : prefix === "@" ? "history" : prefix === "/" ? "chat" : "all";
  return { mode, prefix, query: prefix ? input.slice(1).trimStart() : input };
}

export function isLikelyAgentPrompt(input: string): boolean {
  const query = input.trim();
  if (!query) return false;
  if (query.includes("\n")) return true;
  const words = query.split(/\s+/);
  return (
    words.length >= 4 ||
    (words.length >= 2 && /[?!.,:]$/.test(query)) ||
    /^(please|can you|could you|would you|help me|explain|write|create|build|fix|investigate)\b/i.test(
      query
    )
  );
}

function textMatchScore(query: string, ...values: Array<string | undefined>): number {
  if (!query) return 0;
  const normalized = query.toLowerCase();
  const candidates = values.filter(Boolean).map((value) => value!.toLowerCase());
  if (candidates.some((value) => value === normalized)) return MATCH_EXACT;
  if (candidates.some((value) => value.startsWith(normalized))) return MATCH_PREFIX;
  if (candidates.some((value) => value.includes(normalized))) return MATCH_SUBSTRING;
  return -1;
}

function usageScore(count: number, lastUsed: number): number {
  // Frequency dominates within a match tier; recency breaks close ties without
  // allowing an often-used weak substring to outrank an exact destination.
  return Math.log2(Math.max(0, count) + 1) * 10_000_000_000 + Math.min(lastUsed, 9_999_999_999);
}

function browserUsage(browser: BrowserAddressSuggestion): number {
  return usageScore(
    (browser.visitCount ?? 0) + (browser.typedCount ?? 0) * 2,
    browser.lastVisit ?? 0
  );
}

export function buildLauncherSuggestions(input: {
  value: string;
  panels: LaunchablePanel[];
  panelUsage: PanelUsage;
  browserSuggestions: BrowserAddressSuggestion[];
  browserUrl: string | null;
  limit?: number;
}): LauncherSuggestion[] {
  const parsed = parseLauncherInput(input.value);
  const query = parsed.query.trim();
  const candidates: LauncherSuggestion[] = [];

  if (parsed.mode === "chat") {
    if (query)
      candidates.push({ id: `chat:${query}`, kind: "chat", prompt: query, score: URL_PRIORITY });
    return candidates;
  }

  if (parsed.mode === "all" || parsed.mode === "panels") {
    for (const panel of input.panels) {
      const match = textMatchScore(query, panel.title, panel.path);
      if (match < 0) continue;
      const usage = input.panelUsage[panel.path];
      candidates.push({
        id: `panel:${panel.path}`,
        kind: "panel",
        panel,
        score: match + usageScore(usage?.count ?? 0, usage?.lastUsed ?? 0),
      });
    }
  }

  if (parsed.mode === "all" || parsed.mode === "history") {
    for (const browser of input.browserSuggestions) {
      const match = textMatchScore(query, browser.title, browser.url);
      if (match < 0) continue;
      candidates.push({
        id: `history:${browser.url}`,
        kind: "history",
        browser,
        score: match + browserUsage(browser),
      });
    }
  }

  if (parsed.mode === "all" && input.browserUrl) {
    candidates.push({
      id: `url:${input.browserUrl}`,
      kind: "url",
      url: input.browserUrl,
      score: URL_PRIORITY,
    });
  }

  if (parsed.mode === "all" && query && !input.browserUrl) {
    candidates.push({
      id: `chat:${query}`,
      kind: "chat",
      prompt: query,
      score: isLikelyAgentPrompt(query) ? PROMPT_PRIORITY : 1,
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .filter(
      (candidate, index, all) =>
        candidate.kind !== "history" ||
        !all.some(
          (other, otherIndex) =>
            otherIndex < index &&
            other.kind === "url" &&
            other.url.replace(/\/$/, "") === candidate.browser.url.replace(/\/$/, "")
        )
    )
    .slice(0, input.limit ?? DEFAULT_LAUNCHER_SUGGESTION_LIMIT);
}

/**
 * Build the empty-query launcher in explicit tiers.
 *
 * Workspace panels are the primary destinations. About pages only fill a
 * small sparse-catalog floor, after which browser history may use the remaining
 * result budget. Each tier retains the normal durable usage ranking.
 */
export function buildIdleLauncherSuggestions(input: {
  value: string;
  panels: LaunchablePanel[];
  aboutPanels: LaunchablePanel[];
  panelUsage: PanelUsage;
  browserSuggestions: BrowserAddressSuggestion[];
  browserUrl: string | null;
  limit?: number;
}): LauncherSuggestion[] {
  const limit = input.limit ?? DEFAULT_LAUNCHER_SUGGESTION_LIMIT;
  const panelSuggestions = (panels: LaunchablePanel[], panelLimit: number) =>
    buildLauncherSuggestions({
      value: input.value,
      panels,
      panelUsage: input.panelUsage,
      browserSuggestions: [],
      browserUrl: null,
      limit: panelLimit,
    });
  const primaryPanels = panelSuggestions(input.panels, limit);
  const panelFloor = Math.min(limit, IDLE_PANEL_SUGGESTION_FLOOR);
  const fallbackPanels = panelSuggestions(
    input.aboutPanels,
    Math.max(0, panelFloor - primaryPanels.length)
  );
  const remaining = Math.max(0, limit - primaryPanels.length - fallbackPanels.length);
  const otherDestinations = buildLauncherSuggestions({
    value: input.value,
    panels: [],
    panelUsage: input.panelUsage,
    browserSuggestions: input.browserSuggestions,
    browserUrl: input.browserUrl,
    limit: remaining,
  });

  return [...primaryPanels, ...fallbackPanels, ...otherDestinations];
}

export const LAUNCHER_GROUP_LABELS: Record<LauncherSuggestion["kind"], string> = {
  url: "Web address",
  panel: "Panels",
  history: "Recent pages",
  chat: "Ask an agent",
};

export interface LauncherGroup<T> {
  kind: LauncherSuggestion["kind"];
  label: string;
  items: T[];
}

/**
 * Bucket a ranked list by kind for display.
 *
 * Groups appear in order of their best-ranked member, so the strongest match
 * stays first overall and `groups.flatMap(g => g.items)` — the order the
 * keyboard walks — always matches what is on screen. Pass `order` when there is
 * no query to rank against: browsing a launcher with nothing typed should lead
 * with the workspace's own panels rather than whatever page was visited most.
 */
export function groupLauncherSuggestions<T extends { kind: LauncherSuggestion["kind"] }>(
  suggestions: T[],
  order?: LauncherSuggestion["kind"][]
): LauncherGroup<T>[] {
  const groups: LauncherGroup<T>[] = [];
  const byKind = new Map<LauncherSuggestion["kind"], LauncherGroup<T>>();
  for (const suggestion of suggestions) {
    let group = byKind.get(suggestion.kind);
    if (!group) {
      group = { kind: suggestion.kind, label: LAUNCHER_GROUP_LABELS[suggestion.kind], items: [] };
      byKind.set(suggestion.kind, group);
      groups.push(group);
    }
    group.items.push(suggestion);
  }
  if (!order) return groups;
  const rank = (kind: LauncherSuggestion["kind"]) => {
    const index = order.indexOf(kind);
    return index < 0 ? order.length : index;
  };
  return groups.sort((a, b) => rank(a.kind) - rank(b.kind));
}

function completionValue(suggestion: LauncherSuggestion): string | null {
  if (suggestion.kind === "panel") return suggestion.panel.title;
  if (suggestion.kind === "history") return suggestion.browser.url;
  if (suggestion.kind === "url") return suggestion.url;
  return null;
}

/** Returns the full accepted input when the selected destination extends the query. */
export function autocompleteForSuggestion(
  rawInput: string,
  suggestion: LauncherSuggestion | undefined
): { value: string; suffix: string } | null {
  if (!suggestion) return null;
  const parsed = parseLauncherInput(rawInput);
  const completion = completionValue(suggestion);
  if (!completion) return null;
  const query = parsed.query.trim();
  if (!query || !completion.toLowerCase().startsWith(query.toLowerCase())) return null;
  const suffix = completion.slice(query.length);
  if (!suffix) return null;
  return { value: `${parsed.prefix}${completion}`, suffix };
}
