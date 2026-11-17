import type { PanelConsoleHistoryEntry } from "./observation.js";

export interface PanelConsoleHistoryOptions {
  limit?: number;
  errorLimit?: number;
  levels?: Array<"debug" | "info" | "warning" | "error" | "unknown">;
  sources?: Array<"console" | "lifecycle">;
  contains?: string;
  since?: number;
  until?: number;
  beforeSeq?: number;
}

/** Apply the same observation filters in every panel CDP host. */
export function filterConsoleHistoryEntries(
  entries: PanelConsoleHistoryEntry[],
  options: PanelConsoleHistoryOptions
): PanelConsoleHistoryEntry[] {
  const levels = options.levels ? new Set(options.levels) : null;
  const sources = options.sources ? new Set(options.sources) : null;
  const contains = options.contains?.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (levels && !levels.has(entry.level)) return false;
    if (sources && !sources.has(entry.source ?? "console")) return false;
    if (options.since !== undefined && entry.timestamp < options.since) return false;
    if (options.until !== undefined && entry.timestamp > options.until) return false;
    if (options.beforeSeq !== undefined && (entry.seq ?? 0) >= options.beforeSeq) return false;
    if (!contains) return true;
    return [entry.message, entry.url, entry.sourceId, safeJson(entry.fields)]
      .join("\n")
      .toLocaleLowerCase()
      .includes(contains);
  });
}

function safeJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Entries stay chronological; the cursor selects the strictly older next page. */
export function pageConsoleHistory(
  entries: PanelConsoleHistoryEntry[],
  errors: PanelConsoleHistoryEntry[],
  options: PanelConsoleHistoryOptions
) {
  const limit = normalizeLimit(options.limit, entries.length);
  const errorLimit = normalizeLimit(options.errorLimit, errors.length);
  const pageEntries = limit > 0 ? entries.slice(-limit) : [];
  const hasOlder = entries.length > pageEntries.length;
  return {
    entries: pageEntries,
    errors: errorLimit > 0 ? errors.slice(-errorLimit) : [],
    page: { nextBeforeSeq: hasOlder ? (pageEntries[0]?.seq ?? null) : null, hasOlder },
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
