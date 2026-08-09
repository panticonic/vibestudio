import type { LaunchablePanel } from "./launchablePanels";

export interface PanelUsageEntry {
  count: number;
  lastUsed: number;
}

export type PanelUsage = Record<string, PanelUsageEntry>;

interface CachedPanelUsage {
  version: 1;
  panels: PanelUsage;
}

export const PANEL_USAGE_CACHE_KEY = "vibestudio:new-panel-usage";

function isPanelUsageEntry(value: unknown): value is PanelUsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["count"] === "number" &&
    Number.isFinite(entry["count"]) &&
    entry["count"] >= 0 &&
    typeof entry["lastUsed"] === "number" &&
    Number.isFinite(entry["lastUsed"]) &&
    entry["lastUsed"] >= 0
  );
}

export function parsePanelUsage(raw: string | null): PanelUsage {
  if (!raw) return {};
  try {
    const cached = JSON.parse(raw) as Partial<CachedPanelUsage>;
    if (cached.version !== 1 || !cached.panels || typeof cached.panels !== "object") return {};
    return Object.fromEntries(
      Object.entries(cached.panels).filter(
        ([path, entry]) =>
          (path.startsWith("panels/") || path.startsWith("about/")) && isPanelUsageEntry(entry)
      )
    ) as PanelUsage;
  } catch {
    return {};
  }
}

export function serializePanelUsage(panels: PanelUsage): string {
  return JSON.stringify({ version: 1, panels } satisfies CachedPanelUsage);
}

export function recordPanelUsage(usage: PanelUsage, path: string, usedAt: number): PanelUsage {
  const current = usage[path];
  return {
    ...usage,
    [path]: { count: (current?.count ?? 0) + 1, lastUsed: usedAt },
  };
}

function matchScore(panel: LaunchablePanel, query: string): number {
  if (!query) return 0;
  const title = panel.title.toLowerCase();
  const path = panel.path.toLowerCase();
  if (title === query || path === query) return 3_000_000_000_000_000;
  if (title.startsWith(query) || path.startsWith(query)) return 2_000_000_000_000_000;
  return 1_000_000_000_000_000;
}

export function rankLaunchablePanels(
  panels: LaunchablePanel[],
  query: string,
  usage: PanelUsage,
  limit: number
): LaunchablePanel[] {
  const normalizedQuery = query.trim().toLowerCase();
  return panels
    .filter(
      (panel) =>
        !normalizedQuery ||
        panel.title.toLowerCase().includes(normalizedQuery) ||
        panel.path.toLowerCase().includes(normalizedQuery)
    )
    .sort((a, b) => {
      const aUsage = usage[a.path];
      const bUsage = usage[b.path];
      const aScore =
        matchScore(a, normalizedQuery) +
        (aUsage?.count ?? 0) * 1_000_000_000_000 +
        (aUsage?.lastUsed ?? 0);
      const bScore =
        matchScore(b, normalizedQuery) +
        (bUsage?.count ?? 0) * 1_000_000_000_000 +
        (bUsage?.lastUsed ?? 0);
      return bScore - aScore || a.title.localeCompare(b.title);
    })
    .slice(0, limit);
}
